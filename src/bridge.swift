// bridge.swift — JSON-Lines sidecar: FTMS smart trainer + BLE heart-rate strap.
//
// Policy lives here, on purpose. The DSH plugin may propose a target, but only the process
// that owns the radio can refuse one: this sidecar holds a 30 s control lease and it is the
// one that lets go when the lease runs out. A host that is disabled, restarting, or stuck in
// a long turn cannot leave the trainer holding an old ERG target, because the deadline is
// enforced by the native side itself (design doc §4.2: DSH 侧只能"提议"，原生产物负责"不允许").
//
// Reads one JSON command per line on stdin, writes one JSON event per line on stdout.
// No UI, no host-side strategy: the radio, the lease and the ramp, nothing else.
//
// Build:
//   swiftc -O -swift-version 5 -o build/ride-bridge-m4b src/lease.swift src/bridge.swift \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker src/Info.plist
//   (production path stays bin/ride-bridge; M4b writes build/ride-bridge-m4b so the host
//    side of the lease — T3 — and this side can be switched together.)
//
// Self-check (pure state machine, returns before CBCentralManager is constructed):
//   ./build/ride-bridge-m4b --selftest-lease
//
// Commands:
//   {"t":"connect"} {"t":"erg","watts":120} {"t":"grade","pct":2.5} {"t":"sim","pct":2.5}
//   {"t":"inclination","pct":2.5} {"t":"resistance","level":3}
//   {"t":"lease"} {"t":"lease","ttl":30} {"t":"lease","watts":120}
//   {"t":"stop","hard":false} {"t":"end"} {"t":"status"} {"t":"quit"}
//
// Events (unchanged): hello | device | ready | metrics | control | error | warn | mode | bye
// Events (new in M4b): lease | lease_expired | ramp
// Metrics (new fields): leaseUntil, leaseTtl, rampTarget, rampWritten
//
// Lease rules:
//   * Every setpoint command — erg, grade/sim, inclination, resistance — starts or renews
//     the lease (deadline = now + TTL). `erg` both sets the target and renews, so a sidecar
//     used without the host still gets one 30 s window per command.
//   * {"t":"lease"} only renews (ttl clamped to 5…120 s; optional watts re-issues the same
//     target idempotently). Reply: {"t":"lease","until":<epochMs>,"ttl":<s>}.
//   * stop / end / an explicit zero clear the lease and never produce lease_expired.
//   * A 100 ms safety tick (independent of the 3 s rescan tick) checks the deadline. When it
//     passes with a live setpoint the sidecar releases exactly once: endSession(false)
//     (grade 0, simulation drag kept) + {"t":"lease_expired"} + {"t":"mode","mode":"sim",
//     "grade":0}, then clears the deadline so the same expiry cannot fire twice.
//
// Ramp rules (see lease.swift):
//   ERG targets are approached at 10 W/s: at most one 10 W step per 1000 ms, and only after
//   the previous control-point write is acknowledged (didWriteValueFor / CP indication) or
//   300 ms pass, so the CP write queue never fills. A new target redirects the single ramp;
//   stop/end aborts it. Each step may emit {"t":"ramp","from","to","now"} at most once per
//   second.
import Foundation
import CoreBluetooth

let SVC_FTMS = CBUUID(string: "1826")
let CH_CP    = CBUUID(string: "2AD9")
let CH_IBD   = CBUUID(string: "2AD2")
let SVC_HRS  = CBUUID(string: "180D")
let CH_HRM   = CBUUID(string: "2A37")

func emit(_ obj: [String: Any]) {
    var o = obj
    if o["ts"] == nil { o["ts"] = Int(Date().timeIntervalSince1970 * 1000) }
    guard let data = try? JSONSerialization.data(withJSONObject: o, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

func epochMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

final class Bridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var trainer: CBPeripheral?
    var strap: CBPeripheral?
    var cp: CBCharacteristic?
    var ibd: CBCharacteristic?
    var hrm: CBCharacteristic?
    var controlAcquired = false
    var wantControl = false
    var pendingPower: Int?
    var pendingGrade: Double?
    var simUnsupported = false
    var lastCp: [String: Any]?

    /// Lease + ramp state. Pure: no radio, no timers, no clock of its own.
    var core = LeaseRampCore()
    /// 100 ms tick: lease cut-off latency and ramp step scheduling (the 3 s tick below only
    /// rescans and publishes a heartbeat).
    var safetyTimer: DispatchSourceTimer?
    /// Completion deadline for the control-point write of the current ramp step.
    var rampTimeout: DispatchWorkItem?
    var rampGen = 0
    /// FTMS Start/Resume is sent once per ERG run, not on every ramp step.
    var ergResumed = false

    var power = 0, cadence = 0
    var speed = 0.0, resistance = 0
    var hr = 0, rr = 0
    var lastEmit = Date.distantPast
    var lastIbd = Date.distantPast
    var lastHr = Date.distantPast
    var stopping = false
    var scanTimer: DispatchSourceTimer?

    func start() {
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        emit(["t": "hello", "v": 1])
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 1, repeating: 3)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        scanTimer = t

        let s = DispatchSource.makeTimerSource(queue: .main)
        s.schedule(deadline: .now() + 0.1, repeating: 0.1, leeway: .milliseconds(20))
        s.setEventHandler { [weak self] in self?.safetyTick() }
        s.resume()
        safetyTimer = s
    }

    func tick() {
        // re-scan if something dropped, and publish a heartbeat even when silent
        if central.state == .poweredOn, (trainer == nil || strap == nil), !stopping {
            central.scanForPeripherals(withServices: [SVC_FTMS, SVC_HRS],
                                       options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        }
        if Date().timeIntervalSince(lastEmit) > 1.0 { publish() }
    }

    // MARK: lease + ramp scheduler

    /// Runs ten times a second: the lease check comes first (a release must win over a
    /// pending ramp step), then at most one ramp step is scheduled.
    func safetyTick() {
        let now = epochMs()
        if let expiry = core.checkLease(now) {
            releaseAfterExpiry(expiry)
            return
        }
        guard let next = core.nextRampStep(nowMs: now) else { return }
        writePowerStep(next, nowMs: now)
    }

    /// The one path that lets go. endSession(false) keeps the simulation drag, so the
    /// flywheel spins down like a real bike instead of coasting for minutes.
    func releaseAfterExpiry(_ expiry: LeaseExpiry) {
        pendingPower = nil
        pendingGrade = nil
        ergResumed = false
        rampTimeout?.cancel()
        rampTimeout = nil
        endSession(false)
        emit(["t": "lease_expired",
              "afterMs": expiry.afterDeadlineMs,
              "sinceRenewMs": expiry.sinceRenewMs,
              "ttl": Double(expiry.ttlMs) / 1000.0,
              "was": expiry.wasMode,
              "watts": expiry.wasErgWatts,
              "grade": expiry.wasGrade,
              "resistance": expiry.wasResistance])
        emit(["t": "mode", "mode": "sim", "grade": 0])
    }

    /// One ramp step: at most 10 W, written only when no earlier step is outstanding.
    func writePowerStep(_ watts: Int, nowMs now: Int64) {
        guard let p = trainer, let c = cp, controlAcquired else { return }
        let from = core.lastWrittenWatts
        let to = core.rampTargetWatts
        if !ergResumed {
            p.writeValue(Data([0x07]), for: c, type: .withResponse)   // Start/Resume, once
            ergResumed = true
        }
        let v = Int16(clamping: watts)
        p.writeValue(Data([0x05, UInt8(truncatingIfNeeded: v), UInt8(truncatingIfNeeded: v >> 8)]),
                     for: c, type: .withResponse)
        core.didStartWrite(watts: watts, nowMs: now)

        rampGen += 1
        let gen = rampGen
        rampTimeout?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, gen == self.rampGen, self.core.inflight else { return }
            self.rampTimeout = nil
            self.core.didFinishWrite()
        }
        rampTimeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: item)

        if core.takeRampEmitSlot(nowMs: now) {
            emit(["t": "ramp", "from": from, "to": to, "now": watts])
        }
    }

    /// Indication/response for the control point: the previous step may now be considered
    /// acknowledged (the 300 ms timer is the fallback for silent firmware).
    func finishRampStepIfCurrent(_ gen: Int) {
        guard gen == rampGen, core.inflight else { return }
        rampTimeout?.cancel()
        rampTimeout = nil
        core.didFinishWrite()
    }

    func publish() {
        lastEmit = Date()
        emit([
            "t": "metrics",
            "power": power, "cadence": cadence, "speed": (speed * 10).rounded() / 10,
            "resistance": resistance,
            "hr": hr, "rr": rr,
            "control": controlAcquired,
            "simUnsupported": simUnsupported,
            "lastCp": lastCp ?? NSNull(),
            "trainer": trainer.map { ["id": $0.identifier.uuidString, "name": $0.name ?? ""] } ?? NSNull(),
            "strap": strap.map { ["id": $0.identifier.uuidString, "name": $0.name ?? ""] } ?? NSNull(),
            // M4b additions; existing field semantics above are unchanged.
            "leaseUntil": core.leaseUntilMs ?? NSNull(),
            "leaseTtl": core.ttlSeconds,
            "rampTarget": core.rampTargetWatts,
            "rampWritten": core.lastWrittenWatts,
        ])
    }

    // MARK: central

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            emit(["t": "ready", "role": "central"])
            c.scanForPeripherals(withServices: [SVC_FTMS, SVC_HRS], options: nil)
        case .unauthorized:
            emit(["t": "error", "code": "BLUETOOTH_DENIED", "message": "Bluetooth permission denied for this process"])
        case .poweredOff:
            emit(["t": "error", "code": "BLUETOOTH_OFF", "message": "Bluetooth is off"])
        default: break
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let adv = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        if adv.contains(SVC_FTMS), trainer == nil {
            trainer = p; p.delegate = self; c.connect(p)
            emit(["t": "device", "role": "trainer", "name": p.name ?? "", "id": p.identifier.uuidString, "rssi": RSSI.intValue])
        }
        if adv.contains(SVC_HRS), strap == nil {
            strap = p; p.delegate = self; c.connect(p)
            emit(["t": "device", "role": "strap", "name": p.name ?? "", "id": p.identifier.uuidString, "rssi": RSSI.intValue])
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([SVC_FTMS, SVC_HRS])
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        if p == trainer {
            trainer = nil; cp = nil; ibd = nil; controlAcquired = false
            power = 0; cadence = 0; speed = 0; resistance = 0
            core.abortRampAfterDisconnect(nowMs: epochMs())
            ergResumed = false
            rampTimeout?.cancel()
            if !stopping {
                emit(["t": "error", "code": "TRAINER_DISCONNECTED", "message": error?.localizedDescription ?? "disconnected"])
                c.scanForPeripherals(withServices: [SVC_FTMS], options: nil)
            }
        }
        if p == strap {
            strap = nil; hrm = nil; hr = 0; rr = 0
            if !stopping { emit(["t": "error", "code": "STRAP_DISCONNECTED", "message": error?.localizedDescription ?? "disconnected"]) }
        }
        publish()
    }

    // MARK: peripheral

    func peripheral(_ p: CBPeripheral, didDiscoverServices e: Error?) {
        for s in p.services ?? [] { p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] {
            switch ch.uuid {
            case CH_IBD: ibd = ch; p.setNotifyValue(true, for: ch)
            case CH_CP:  cp = ch; p.setNotifyValue(true, for: ch)
            case CH_HRM: hrm = ch; p.setNotifyValue(true, for: ch)
            default: break
            }
        }
        if p == trainer, cp != nil {
            emit(["t": "ready", "role": "trainer", "name": p.name ?? "", "controlPoint": true])
            if wantControl { requestControl() }
        }
        if p == strap, hrm != nil { emit(["t": "ready", "role": "strap", "name": p.name ?? ""]) }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard let d = ch.value else { return }
        switch ch.uuid {
        case CH_HRM: decodeHR([UInt8](d))
        case CH_IBD: decodeIBD([UInt8](d))
        case CH_CP: decodeCP([UInt8](d))
        default: break
        }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        guard ch.uuid == CH_CP else { return }
        if let e = error {
            emit(["t": "warn", "code": "CP_WRITE_FAILED", "message": e.localizedDescription])
        }
        finishRampStepIfCurrent(rampGen)
    }

    // MARK: decode

    func u16(_ b: [UInt8], _ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
    func s16(_ b: [UInt8], _ i: Int) -> Int { Int(Int16(bitPattern: UInt16(b[i]) | UInt16(b[i + 1]) << 8)) }

    func decodeHR(_ b: [UInt8]) {
        guard b.count >= 2 else { return }
        let flags = b[0]
        var i = 1
        if flags & 0x01 != 0, b.count >= 3 { hr = Int(b[1]) | Int(b[2]) << 8; i = 3 } else { hr = Int(b[1]); i = 2 }
        var lastRR = 0
        if flags & 0x10 != 0 {
            while i + 1 < b.count { lastRR = Int(UInt16(b[i]) | UInt16(b[i + 1]) << 8); i += 2 }
        }
        if lastRR > 0 { rr = Int(Double(lastRR) / 1024.0 * 1000.0) }
        lastHr = Date()
    }

    func decodeIBD(_ b: [UInt8]) {
        guard b.count >= 4 else { return }
        let flags = u16(b, 0)
        var i = 2
        // bit0 == 0 → Instantaneous Speed present (pycycling documents this quirk)
        if flags & 0x0001 == 0 { speed = Double(u16(b, i)) / 100.0; i += 2 }
        if flags & 0x0002 != 0 { i += 2 }
        if flags & 0x0004 != 0, i + 1 < b.count { cadence = Int(Double(u16(b, i)) * 0.5); i += 2 }
        if flags & 0x0008 != 0 { i += 2 }
        if flags & 0x0010 != 0 { i += 3 }
        if flags & 0x0020 != 0, i + 1 < b.count { resistance = s16(b, i); i += 2 }
        if flags & 0x0040 != 0, i + 1 < b.count { power = s16(b, i); i += 2 }
        if flags & 0x0080 != 0 { i += 2 }
        if flags & 0x0100 != 0 { i += 5 }
        if flags & 0x0200 != 0, i < b.count { if hr == 0 { hr = Int(b[i]) }; i += 1 }
        if flags & 0x0400 != 0 { i += 1 }
        if flags & 0x0800 != 0 { i += 2 }
        if flags & 0x1000 != 0 { i += 2 }
        lastIbd = Date()
        if Date().timeIntervalSince(lastEmit) > 0.45 { publish() }
    }

    func decodeCP(_ b: [UInt8]) {
        guard b.count >= 3, b[0] == 0x80 else { return }
        let op = b[1], code = b[2]
        if code == 0x01, op == 0x00 {
            controlAcquired = true
            emit(["t": "control", "acquired": true])
            if let w = pendingPower { pendingPower = nil; setPower(w) }
            if let g = pendingGrade { pendingGrade = nil; setSim(g) }
        } else {
            lastCp = ["op": Int(op), "code": Int(code), "ok": code == 0x01]
            emit(["t": "control", "op": Int(op), "code": Int(code), "ok": code == 0x01])
            if op == 0x11, code == 0x02, !simUnsupported {
                simUnsupported = true
                emit(["t": "warn", "code": "SIM_UNSUPPORTED", "message": "trainer rejected 0x11; falling back to 0x03 inclination (no drag)"])
                if let g = pendingGrade { pendingGrade = nil; writeInclination(g) }
            }
        }
    }

    // MARK: commands

    func requestControl() {
        guard let p = trainer, let c = cp else { emit(["t": "error", "code": "NO_TRAINER", "message": "trainer not connected"]); return }
        if controlAcquired { return }
        p.writeValue(Data([0x00]), for: c, type: .withResponse)
    }

    /// The ERG target is already recorded in `core` (handle()); this only nudges the ramp
    /// scheduler and keeps the legacy "request control, then apply the pending target" path.
    func setPower(_ watts: Int) {
        guard trainer != nil, cp != nil else { emit(["t": "error", "code": "NO_TRAINER", "message": "trainer not connected"]); return }
        guard controlAcquired else { wantControl = true; pendingPower = watts; requestControl(); return }
        safetyTick()
    }

    /// Explicit `erg 0`: no ramp, write 0 W now. It is an intentional zero, not an expiry.
    func writeErgZero() {
        pendingPower = nil
        guard let p = trainer, let c = cp, controlAcquired else { return }
        p.writeValue(Data([0x07]), for: c, type: .withResponse)
        p.writeValue(Data([0x05, 0x00, 0x00]), for: c, type: .withResponse)
        core.didFinishWrite()
    }

    /// Simulation mode, the way qdomyos-zwift and pycycling both do it:
    /// opcode 0x11 carries wind, grade, rolling resistance and aerodynamic drag, so the trainer
    /// simulates a bike (drag + virtual mass) instead of just adding a resistance offset.
    /// That drag is what makes the flywheel spin down when the rider stops.
    func setSim(_ pct: Double, crr: Double = 0.004, cda: Double = 0.51) {
        ergResumed = false
        guard let p = trainer, let c = cp else { emit(["t": "error", "code": "NO_TRAINER", "message": "trainer not connected"]); return }
        guard controlAcquired else { wantControl = true; pendingGrade = pct; requestControl(); return }
        p.writeValue(Data([0x07]), for: c, type: .withResponse)   // Start/Resume first
        if simUnsupported {
            writeInclination(pct)
            return
        }
        var buf: [UInt8] = [0x11]
        buf += [0x00, 0x00]                                        // wind 0.000 m/s
        let g = Int16(clamping: Int((pct * 100).rounded()))        // 0.01 %
        buf += [UInt8(truncatingIfNeeded: g), UInt8(truncatingIfNeeded: g >> 8)]
        buf.append(UInt8(clamping: Int((crr * 10000).rounded())))  // 0.0001
        buf.append(UInt8(clamping: Int((cda * 100).rounded())))    // 0.01 kg/m
        p.writeValue(Data(buf), for: c, type: .withResponse)
    }

    /// Opcode 0x03 fallback for firmware that rejects 0x11. No drag, so coasting is poor.
    func writeInclination(_ pct: Double) {
        guard let p = trainer, let c = cp else { return }
        let v = Int16(clamping: Int((pct * 10).rounded()))
        p.writeValue(Data([0x03, UInt8(truncatingIfNeeded: v), UInt8(truncatingIfNeeded: v >> 8)]), for: c, type: .withResponse)
    }

    func setResistance(_ level: Int) {
        guard let p = trainer, let c = cp, controlAcquired else { emit(["t": "error", "code": "NO_CONTROL", "message": "control not acquired"]); return }
        p.writeValue(Data([0x04, UInt8(clamping: level)]), for: c, type: .withResponse)
    }

    /// End a session without leaving the trainer unbraked.
    ///
    /// A plain FTMS Stop plus resistance 0 makes a heavy flywheel coast for minutes, which reads
    /// as "resistance too light, the wheel is spinning wildly". Grade 0 keeps the simulation
    /// (drag + virtual mass) alive, so the wheel spins down the way a real bike does.
    /// `hard` is the emergency path: Stop/Pause, then grade 0.
    func endSession(_ hard: Bool = false) {
        guard let p = trainer, let c = cp else { return }
        if hard {
            p.writeValue(Data([0x08, 0x01]), for: c, type: .withResponse)   // Stop/Pause
        }
        setSim(0)
        power = 0; cadence = 0; speed = 0
        publish()
    }

    func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let t = obj["t"] as? String else { return }
        switch t {
        case "connect": wantControl = false; central.scanForPeripherals(withServices: [SVC_FTMS, SVC_HRS], options: nil)
        case "erg":
            guard let w = (obj["watts"] as? NSNumber)?.intValue else { break }
            core.onErg(watts: w, nowMs: epochMs())
            pendingGrade = nil                                  // last command wins on acquire
            if w <= 0 {
                ergResumed = false
                rampTimeout?.cancel()
                writeErgZero()
            } else {
                setPower(w)
            }
        case "grade", "sim":
            if let g = (obj["pct"] as? NSNumber)?.doubleValue {
                let crr = (obj["crr"] as? NSNumber)?.doubleValue ?? 0.004
                let cda = (obj["cda"] as? NSNumber)?.doubleValue ?? 0.51
                core.onSim(pct: g, nowMs: epochMs())
                pendingPower = nil
                rampTimeout?.cancel()
                setSim(g, crr: crr, cda: cda)
            }
        case "inclination":
            if let g = (obj["pct"] as? NSNumber)?.doubleValue {
                core.onInclination(pct: g, nowMs: epochMs())
                pendingPower = nil
                rampTimeout?.cancel()
                ergResumed = false
                writeInclination(g)
            }
        case "resistance":
            if let l = (obj["level"] as? NSNumber)?.intValue {
                core.onResistance(level: l, nowMs: epochMs())
                pendingPower = nil
                rampTimeout?.cancel()
                ergResumed = false
                setResistance(l)
            }
        case "lease":
            let ttl = (obj["ttl"] as? NSNumber)?.doubleValue
            let watts = (obj["watts"] as? NSNumber)?.intValue
            let reply = core.onLease(ttlSeconds: ttl, watts: watts, nowMs: epochMs())
            emit(["t": "lease", "until": reply.untilMs, "ttl": reply.ttlSeconds])
            if let w = watts {
                pendingGrade = nil
                if w <= 0 {
                    ergResumed = false
                    writeErgZero()
                } else {
                    setPower(w)
                }
            }
        case "stop":
            core.zeroAll(nowMs: epochMs())
            pendingPower = nil; pendingGrade = nil; ergResumed = false
            rampTimeout?.cancel()
            if (obj["hard"] as? Bool) == true { endSession(true) } else { endSession(false) }
            emit(["t": "mode", "mode": "sim", "grade": 0])
        case "end":
            core.zeroAll(nowMs: epochMs())
            pendingPower = nil; pendingGrade = nil; ergResumed = false
            rampTimeout?.cancel()
            endSession(false)
            emit(["t": "mode", "mode": "sim", "grade": 0])
        case "status": publish()
        case "quit":
            core.zeroAll(nowMs: epochMs())
            endSession(false)
            emit(["t": "bye"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { exit(0) }
        default: break
        }
    }
}

let bridge = Bridge()

@main
struct RideBridgeMain {
    static func main() {
        // Pure state machine, handled before any radio exists: no CBCentralManager, no scan,
        // no TCC prompt. This is the only mode the fleet task allows to run.
        if CommandLine.arguments.contains("--selftest-lease") {
            FileHandle.standardError.write(Data("selftest: BLE not initialized\n".utf8))
            exit(runLeaseSelftest())
        }

        FileHandle.standardError.write(Data("BLE init\n".utf8))
        bridge.start()

        signal(SIGTERM) { _ in
            DispatchQueue.main.async { bridge.endSession(false); exit(0) }
        }
        signal(SIGINT) { _ in
            DispatchQueue.main.async { bridge.endSession(false); exit(0) }
        }

        FileHandle.standardInput.readabilityHandler = { fh in
            let data = fh.availableData
            if data.isEmpty { DispatchQueue.main.async { bridge.endSession(false); exit(0) } }   // parent closed stdin
            guard let text = String(data: data, encoding: .utf8) else { return }
            // Commands arrive on a FileHandle queue; state lives on the main queue together
            // with the timers and the CoreBluetooth delegate callbacks. Dispatching instead
            // of mutating `core` from two threads is what keeps the lease state coherent.
            for line in text.split(separator: "\n") {
                let command = String(line)
                DispatchQueue.main.async { bridge.handle(command) }
            }
        }

        RunLoop.main.run()
    }
}
