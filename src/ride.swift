// ride.swift — CoreBluetooth probe for an indoor smart trainer (FTMS) and a BLE heart-rate strap.
// Build:  swiftc -O -swift-version 5 -o build/ride src/ride.swift \
//           -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker src/Info.plist
// Usage:  ./build/ride --scan 8
//         ./build/ride --scan 8 --watch 20
//         ./build/ride --scan 8 --watch 30 --erg 120
import Foundation
import CoreBluetooth

let SVC_FTMS = CBUUID(string: "1826")
let CH_CP    = CBUUID(string: "2AD9")   // Fitness Machine Control Point (write + indicate)
let CH_IBD   = CBUUID(string: "2AD2")   // Indoor Bike Data (notify)
let CH_FEAT  = CBUUID(string: "2ACC")   // Fitness Machine Feature (read)
let CH_POWR  = CBUUID(string: "2AD4")   // Supported Power Range (read)
let SVC_HRS  = CBUUID(string: "180D")
let CH_HRM   = CBUUID(string: "2A37")   // Heart Rate Measurement (notify)
let CH_HRPOS = CBUUID(string: "2A38")   // Body Sensor Location (read)

func now() -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f.string(from: Date())
}
func log(_ s: String) { FileHandle.standardOutput.write(("\(now()) \(s)\n").data(using: .utf8)!) }

struct Args {
    var scan: Double = 8
    var watch: Double = 25
    var erg: Int? = nil
    var trainerMatch: String? = nil
    var hrMatch: String? = nil
    var json = false
    var stopOnExit = true
    var raw = false
}

func parseArgs() -> Args {
    var a = Args(); let v = Array(CommandLine.arguments.dropFirst()); var i = 0
    func num(_ s: String) -> Double { Double(s) ?? 0 }
    while i < v.count {
        switch v[i] {
        case "--scan": i += 1; a.scan = i < v.count ? num(v[i]) : 8
        case "--watch": i += 1; a.watch = i < v.count ? num(v[i]) : 25
        case "--erg": i += 1; a.erg = i < v.count ? Int(v[i]) : nil
        case "--trainer": i += 1; a.trainerMatch = i < v.count ? v[i] : nil
        case "--hr": i += 1; a.hrMatch = i < v.count ? v[i] : nil
        case "--json": a.json = true
        case "--no-stop": a.stopOnExit = false
        case "--raw": a.raw = true
        case "--help", "-h":
            print("ride --scan <s> [--watch <s>] [--erg <watts>] [--trainer <substr>] [--hr <substr>] [--json] [--raw] [--no-stop]")
            exit(0)
        default: break
        }
        i += 1
    }
    return a
}

final class Ride: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    let args: Args
    var central: CBCentralManager!
    var trainer: CBPeripheral?
    var strap: CBPeripheral?
    var cp: CBCharacteristic?
    var ibd: CBCharacteristic?
    var hrm: CBCharacteristic?
    var controlAcquired = false
    var pendingErg: Int?
    var seen = Set<UUID>()
    var discoveredTrainer = false
    var discoveredStrap = false
    var lastIbdAt = Date.distantPast
    var ended = false

    init(args: Args) { self.args = args; super.init() }

    func start() {
        central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: true])
        DispatchQueue.main.asyncAfter(deadline: .now() + args.scan) { [weak self] in
            guard let self else { return }
            log("—— scan window closed ——")
            if self.trainer == nil && self.strap == nil {
                log("no matching device found. state=\(self.stateName())")
                exit(3)
            }
            if self.trainer == nil { log("note: no trainer (FTMS) found; heart rate only") }
            if self.strap == nil { log("note: no heart-rate strap found") }
            DispatchQueue.main.asyncAfter(deadline: .now() + self.args.watch) { self.finish() }
        }
    }

    func stateName() -> String {
        switch central.state {
        case .poweredOn: return "poweredOn"
        case .poweredOff: return "poweredOff"
        case .unauthorized: return "unauthorized (Bluetooth permission denied for this binary)"
        case .unsupported: return "unsupported"
        case .resetting: return "resetting"
        case .unknown: return "unknown"
        @unknown default: return "?"
        }
    }

    func finish() {
        guard !ended else { return }
        ended = true
        if args.stopOnExit, controlAcquired, let p = trainer, let c = cp {
            log("sending Stop/Pause + resistance 0")
            write(p, c, [0x08, 0x01])
            write(p, c, [0x04, 0x00])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { exit(0) }
    }

    // MARK: central

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        log("central state: \(stateName())")
        guard c.state == .poweredOn else {
            if c.state == .unauthorized || c.state == .unsupported { exit(2) }
            return
        }
        log("scanning \(Int(args.scan))s for FTMS(1826) + HRS(180D) …")
        c.scanForPeripherals(withServices: [SVC_FTMS, SVC_HRS],
                             options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let adv = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let names = adv.map { $0.uuidString.lowercased() }
        let isTrainer = adv.contains(SVC_FTMS)
        let isStrap = adv.contains(SVC_HRS)
        if seen.insert(p.identifier).inserted {
            log("[dev] name=\(p.name ?? "?") id=\(p.identifier.uuidString) rssi=\(RSSI) adv=[\(names.joined(separator: ","))]")
        }
        if isTrainer, trainer == nil, matches(p.name, args.trainerMatch) {
            log("→ connecting trainer: \(p.name ?? p.identifier.uuidString)")
            trainer = p; p.delegate = self; c.connect(p)
        }
        if isStrap, strap == nil {
            log("→ connecting strap: \(p.name ?? p.identifier.uuidString)")
            strap = p; p.delegate = self; c.connect(p)
        }
    }

    func matches(_ name: String?, _ needle: String?) -> Bool {
        guard let needle, !needle.isEmpty else { return true }
        return (name ?? "").localizedCaseInsensitiveContains(needle)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        log("connected: \(p.name ?? p.identifier.uuidString)")
        p.discoverServices([SVC_FTMS, SVC_HRS])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        log("connect failed: \(p.name ?? "?") \(error?.localizedDescription ?? "")")
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        log("disconnected: \(p.name ?? "?") \(error?.localizedDescription ?? "")")
        if p == trainer { trainer = nil; controlAcquired = false }
        if p == strap { strap = nil }
    }

    // MARK: peripheral

    func peripheral(_ p: CBPeripheral, didDiscoverServices e: Error?) {
        for s in p.services ?? [] { log("  service \(s.uuid.uuidString) on \(p.name ?? "?")"); p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] {
            let props = ch.properties
            log("    char \(ch.uuid.uuidString) \(propNames(props))")
            if ch.uuid == CH_IBD {
                ibd = ch; p.setNotifyValue(true, for: ch)
            } else if ch.uuid == CH_CP {
                cp = ch; p.setNotifyValue(true, for: ch)   // indications carry the responses
            } else if ch.uuid == CH_HRM {
                hrm = ch; p.setNotifyValue(true, for: ch)
            } else if ch.uuid == CH_FEAT || ch.uuid == CH_POWR {
                p.readValue(for: ch)
            }
        }
        if p == trainer, cp != nil, bootstrapped == false { bootstrapped = true; requestControl(p) }
    }
    var bootstrapped = false

    func propNames(_ p: CBCharacteristicProperties) -> String {
        var out: [String] = []
        if p.contains(.read) { out.append("read") }
        if p.contains(.write) { out.append("write") }
        if p.contains(.writeWithoutResponse) { out.append("writeNR") }
        if p.contains(.notify) { out.append("notify") }
        if p.contains(.indicate) { out.append("indicate") }
        return out.joined(separator: "|")
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard let d = ch.value else { return }
        switch ch.uuid {
        case CH_HRM: decodeHR(d)
        case CH_IBD: decodeIBD(d)
        case CH_CP:  decodeCP([UInt8](d))
        case CH_FEAT: log("  feature raw=\(hex([UInt8](d)))")
        case CH_POWR: decodePowerRange([UInt8](d))
        default: break
        }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        if let error { log("  write error \(ch.uuid.uuidString): \(error.localizedDescription)") }
    }

    // MARK: decode

    func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

    func decodeHR(_ d: Data) {
        let b = [UInt8](d); guard b.count >= 2 else { return }
        let flags = b[0]
        let wide = flags & 0x01 != 0
        var i = 1
        var bpm = 0
        if wide, b.count >= 3 { bpm = Int(b[1]) | Int(b[2]) << 8; i = 3 } else { bpm = Int(b[1]); i = 2 }
        let contact = (flags >> 1) & 0x03
        var rr: [Double] = []
        if flags & 0x10 != 0 {
            while i + 1 < b.count { rr.append(Double(UInt16(b[i]) | UInt16(b[i + 1]) << 8) / 1024.0 * 1000.0); i += 2 }
        }
        log("[hr ] \(bpm) bpm  contact=\(contact)\(rr.isEmpty ? "" : String(format: "  rr=%.0fms", rr.last!))")
    }

    func u16(_ b: [UInt8], _ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
    func u24(_ b: [UInt8], _ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 | Int(b[i + 2]) << 16 }
    func s16(_ b: [UInt8], _ i: Int) -> Int { Int(Int16(bitPattern: UInt16(b[i]) | UInt16(b[i + 1]) << 8)) }

    func decodeIBD(_ d: Data) {
        let b = [UInt8](d); guard b.count >= 4 else { return }
        let flags = u16(b, 0)
        var i = 2
        // Instantaneous Speed is present only when bit0 ("More Data") is 0.
        // pycycling documents this quirk explicitly; the Think XX02 sends 0x0044 with speed+power+cadence.
        var speed = 0.0
        if flags & 0x0001 == 0 { speed = Double(u16(b, i)) / 100.0; i += 2 }
        var power: Int? = nil, cadence: Int? = nil, resistance: Int? = nil, hr: Int? = nil, elapsed: Int? = nil
        // NOTE: bit0 ("More Data") is NOT a gate here. Field-presence bits alone are authoritative —
        // the Think XX02 sends flags=0x0044 with 8 bytes (speed+cadence+power) while bit0 stays 0.
        do {
            if flags & 0x0002 != 0 { i += 2 }                // avg speed
            if flags & 0x0004 != 0, i + 1 < b.count { cadence = Int(Double(u16(b, i)) * 0.5); i += 2 }
            if flags & 0x0008 != 0 { i += 2 }                // avg cadence
            if flags & 0x0010 != 0 { i += 3 }                // total distance (u24)
            if flags & 0x0020 != 0, i + 1 < b.count { resistance = Int(Double(u16(b, i)) / 10.0); i += 2 }
            if flags & 0x0040 != 0, i + 1 < b.count { power = s16(b, i); i += 2 }
            if flags & 0x0080 != 0 { i += 2 }                // avg power
            if flags & 0x0100 != 0 { i += 5 }                // energy: u16 + u16 + u8
            if flags & 0x0200 != 0, i < b.count { hr = Int(b[i]); i += 1 }
            if flags & 0x0400 != 0 { i += 1 }                // MET
            if flags & 0x0800 != 0, i + 1 < b.count { elapsed = u16(b, i); i += 2 }
            if flags & 0x1000 != 0 { i += 2 }                // remaining
        }
        if args.raw { log("[raw] \(hex(b))") }
        lastIbdAt = Date()
        var parts = [String(format: "%.1fkm/h", speed)]
        if let p = power { parts.append("\(p)W") }
        if let c = cadence { parts.append("\(c)rpm") }
        if let r = resistance { parts.append("res=\(r)") }
        if let h = hr { parts.append("hr=\(h)") }
        if let e = elapsed { parts.append("t=\(e)s") }
        if i > b.count { parts.append("⚠︎overrun(flags=\(String(flags, radix: 16)))") }
        log("[ibd] \(parts.joined(separator: " "))")
    }

    func decodePowerRange(_ b: [UInt8]) {
        guard b.count >= 6 else { return }
        log("  supported power: \(s16(b, 0))…\(s16(b, 2)) W, step \(u16(b, 4)) W")
    }

    func decodeCP(_ b: [UInt8]) {
        guard b.count >= 3, b[0] == 0x80 else { log("  cp raw=\(hex(b))"); return }
        let op = b[1], code = b[2]
        let names: [UInt8: String] = [0x00: "requestControl", 0x01: "reset", 0x02: "targetSpeed",
                                     0x03: "targetInclination", 0x04: "targetResistance",
                                      0x05: "targetPower", 0x06: "targetHR", 0x07: "startResume",
                                      0x08: "stopPause", 0x09: "targetCadence"]
        let codes: [UInt8: String] = [0x01: "success", 0x02: "op-not-supported", 0x03: "invalid-param",
                                      0x04: "operation-failed", 0x05: "control-not-permitted"]
        log("  cp \(names[op] ?? "op\(op)") → \(codes[code] ?? "code\(code)")")
        if op == 0x00 && code == 0x01 {
            controlAcquired = true
            log("  ✔ control acquired")
            if args.erg != nil { if let p = trainer, let c = cp { log("→ Start/Resume (0x07)"); write(p, c, [0x07]) } }
            if let w = args.erg ?? pendingErg { pendingErg = nil; setPower(w) }
        }
    }

    // MARK: control

    func requestControl(_ p: CBPeripheral) {
        guard let c = cp else { return }
        log("→ Request Control (0x00)")
        write(p, c, [0x00])
    }

    func setPower(_ watts: Int) {
        guard let p = trainer, let c = cp, controlAcquired else { log("  cannot set power yet"); return }
        let w = Int16(clamping: watts)
        let lo = UInt8(truncatingIfNeeded: w), hi = UInt8(truncatingIfNeeded: w >> 8)
        log("→ Set Target Power \(watts) W (0x05)")
        write(p, c, [0x05, lo, hi])
    }

    func write(_ p: CBPeripheral, _ c: CBCharacteristic, _ bytes: [UInt8]) {
        p.writeValue(Data(bytes), for: c, type: .withResponse)
    }
}

let args = parseArgs()
let ride = Ride(args: args)
ride.start()
RunLoop.main.run()
