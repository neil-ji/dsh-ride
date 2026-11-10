// lease.swift — control lease + ERG power ramp, as a pure state machine.
//
// This file imports only Foundation: no CoreBluetooth, no timers, no I/O, no clock of its
// own. Every entry point takes `nowMs` (epoch milliseconds) as an argument, so the whole
// safety policy — when control expires, and how fast ERG may step — runs without a radio,
// a trainer, or a TCC prompt. That is what `--selftest-lease` exercises.
//
// bridge.swift owns the clock (a 100 ms safety tick), the control-point writes, the serial
// write acknowledgement and the JSONL framing; this file decides *what* may happen.
//
// Policy in numbers (design doc §4.2: the host may propose, the native side refuses):
//   lease TTL       30 s default, clamped to 5…120 s, changed with {"t":"lease","ttl":n}
//   lease check     100 ms tick (Bridge.safetyTick), independent of the 3 s rescan tick
//   ramp rate       10 W/s: one <=10 W step, at most one per 1000 ms, and the first step
//                   after a (re)start waits one full interval so the average is <=10 W/s too
//   write ack       indication/response for the control point, or a 300 ms timeout in
//                   bridge.swift — only then may the next step be written (serial writes)
//   ramp event      at most one {"t":"ramp"} per 1000 ms

import Foundation

/// What a lease expiry looked like, captured before the state is zeroed, so the event can
/// say honestly what was released.
struct LeaseExpiry {
    let atMs: Int64
    let deadlineMs: Int64
    let afterDeadlineMs: Int64      // how late the check fired: 0…tick interval
    let sinceRenewMs: Int64         // time since the last renewal (~TTL + the late check)
    let ttlMs: Int64
    let wasErgWatts: Int
    let wasGrade: Double
    let wasResistance: Int

    var wasMode: String {
        if wasErgWatts != 0 { return "erg" }
        if wasGrade != 0 { return "sim" }
        if wasResistance != 0 { return "resistance" }
        return "none"
    }
}

struct LeaseReply {
    let untilMs: Int64
    let ttlSeconds: Double
}

struct LeaseRampCore {
    static let defaultTtlSeconds: Double = 30
    static let minTtlSeconds: Double = 5
    static let maxTtlSeconds: Double = 120

    static let rampWattsPerSecond = 10
    static let rampStepWatts = 10
    static let rampIntervalMs: Int64 = 1000
    static let rampEmitIntervalMs: Int64 = 1000
    static let maxErgWatts = 2000

    private(set) var ttlMs: Int64
    private(set) var deadlineMs: Int64?
    private(set) var lastRenewMs: Int64?
    private(set) var ergTargetWatts = 0
    private(set) var simGrade = 0.0
    private(set) var resistanceLevel = 0

    /// The last wattage actually written to the control point (0 = idle baseline).
    private(set) var lastWrittenWatts = 0
    /// True between "write issued" and "acknowledged or timed out": no second write may go.
    private(set) var inflight = false
    private(set) var lastWriteStartMs: Int64?
    private(set) var lastRampEmitMs: Int64?
    private(set) var leaseExpiries = 0

    init(ttlSeconds: Double = LeaseRampCore.defaultTtlSeconds) {
        ttlMs = LeaseRampCore.clampTtlMs(ttlSeconds)
    }

    static func clampTtlMs(_ seconds: Double) -> Int64 {
        let s = min(max(seconds, minTtlSeconds), maxTtlSeconds)
        return Int64((s * 1000).rounded())
    }

    var ttlSeconds: Double { Double(ttlMs) / 1000.0 }
    var leaseUntilMs: Int64? { deadlineMs }
    var isLeased: Bool { deadlineMs != nil }
    var hasActiveSetpoint: Bool { ergTargetWatts != 0 || simGrade != 0 || resistanceLevel != 0 }
    var rampTargetWatts: Int { ergTargetWatts }
    var rampActive: Bool { ergTargetWatts != lastWrittenWatts }

    // MARK: lease

    private mutating func arm(_ nowMs: Int64) {
        deadlineMs = nowMs + ttlMs
        lastRenewMs = nowMs
    }

    /// Explicit zero: clears the lease, the ramp and every setpoint. Not an expiry.
    mutating func zeroAll(nowMs: Int64) {
        ergTargetWatts = 0
        simGrade = 0
        resistanceLevel = 0
        deadlineMs = nil
        lastRenewMs = nil
        abortRamp(nowMs: nowMs)
    }

    mutating func onErg(watts: Int, nowMs: Int64) {
        let w = min(max(watts, 0), Self.maxErgWatts)
        guard w > 0 else { zeroAll(nowMs: nowMs); return }
        if ergTargetWatts == 0 {
            // Starting a ramp from the idle baseline: hold the first step for one interval
            // so even the first second does not exceed 10 W/s on average.
            lastWrittenWatts = 0
            inflight = false
            lastWriteStartMs = nowMs
        }
        ergTargetWatts = w
        simGrade = 0
        resistanceLevel = 0
        arm(nowMs)
    }

    mutating func onSim(pct: Double, nowMs: Int64) {
        guard pct != 0 else { zeroAll(nowMs: nowMs); return }
        ergTargetWatts = 0
        simGrade = pct
        resistanceLevel = 0
        abortRamp(nowMs: nowMs)
        arm(nowMs)
    }

    mutating func onInclination(pct: Double, nowMs: Int64) {
        // Same lease semantics as sim: it is still a control-point setpoint.
        onSim(pct: pct, nowMs: nowMs)
    }

    mutating func onResistance(level: Int, nowMs: Int64) {
        let l = min(max(level, 0), 100)
        guard l > 0 else { zeroAll(nowMs: nowMs); return }
        ergTargetWatts = 0
        simGrade = 0
        resistanceLevel = l
        abortRamp(nowMs: nowMs)
        arm(nowMs)
    }

    /// `{"t":"lease"}`: renew only. Optional ttl changes the window (clamped 5…120 s) and
    /// takes effect immediately; optional watts re-issues the same target idempotently.
    mutating func onLease(ttlSeconds: Double?, watts: Int?, nowMs: Int64) -> LeaseReply {
        if let t = ttlSeconds { ttlMs = Self.clampTtlMs(t) }
        if let w = watts {
            if w <= 0 {
                ergTargetWatts = 0
                simGrade = 0
                resistanceLevel = 0
            } else if w != ergTargetWatts {
                let target = min(w, Self.maxErgWatts)
                if ergTargetWatts == 0 {
                    lastWrittenWatts = 0
                    inflight = false
                    lastWriteStartMs = nowMs
                }
                ergTargetWatts = target
                simGrade = 0
                resistanceLevel = 0
            }
        }
        arm(nowMs)
        return LeaseReply(untilMs: deadlineMs ?? nowMs, ttlSeconds: Double(ttlMs) / 1000.0)
    }

    /// The one place that can let go. Returns nil while the lease is alive, already expired
    /// (deadline cleared by a previous call), or when there is nothing to release.
    mutating func checkLease(_ nowMs: Int64) -> LeaseExpiry? {
        guard let deadline = deadlineMs, nowMs > deadline else { return nil }
        guard hasActiveSetpoint else {
            // Nothing to release: a bare renewal whose window lapsed is simply dropped, so
            // metrics never reports a leaseUntil that is already in the past.
            deadlineMs = nil
            lastRenewMs = nil
            return nil
        }
        let exp = LeaseExpiry(
            atMs: nowMs,
            deadlineMs: deadline,
            afterDeadlineMs: nowMs - deadline,
            sinceRenewMs: lastRenewMs.map { nowMs - $0 } ?? (nowMs - deadline),
            ttlMs: ttlMs,
            wasErgWatts: ergTargetWatts,
            wasGrade: simGrade,
            wasResistance: resistanceLevel)
        deadlineMs = nil
        lastRenewMs = nil
        ergTargetWatts = 0
        simGrade = 0
        resistanceLevel = 0
        abortRamp(nowMs: nowMs)
        leaseExpiries += 1
        return exp
    }

    /// The radio went away: the in-flight step and its baseline are meaningless now, so the
    /// next ERG ramp restarts from 0 W. The target and the lease stay armed on purpose — a
    /// host that never comes back still has to be released by the deadline.
    mutating func abortRampAfterDisconnect(nowMs: Int64) {
        inflight = false
        lastWrittenWatts = 0
        lastWriteStartMs = nowMs
    }

    // MARK: ramp

    /// Next wattage to write, or nil when nothing is pending, a write is still in flight, or
    /// the 1000 ms step interval has not elapsed.
    mutating func nextRampStep(nowMs: Int64) -> Int? {
        guard !inflight, ergTargetWatts != lastWrittenWatts else { return nil }
        if let last = lastWriteStartMs, nowMs - last < Self.rampIntervalMs { return nil }
        let delta = ergTargetWatts - lastWrittenWatts
        let step = min(Self.rampStepWatts, max(-Self.rampStepWatts, delta))
        return lastWrittenWatts + step
    }

    mutating func didStartWrite(watts: Int, nowMs: Int64) {
        lastWrittenWatts = watts
        inflight = true
        lastWriteStartMs = nowMs
    }

    mutating func didFinishWrite() {
        inflight = false
    }

    /// Rate-limits the `ramp` event independently of the step rate.
    mutating func takeRampEmitSlot(nowMs: Int64) -> Bool {
        if let last = lastRampEmitMs, nowMs - last < Self.rampEmitIntervalMs { return false }
        lastRampEmitMs = nowMs
        return true
    }

    private mutating func abortRamp(nowMs: Int64) {
        lastWrittenWatts = 0
        inflight = false
        lastWriteStartMs = nowMs
    }
}

// MARK: - selftest rig

private struct SelftestStep {
    let at: Int64
    let from: Int
    let to: Int
    let watts: Int
}

/// Drives the core with injected time and a simulated control-point acknowledgement
/// (300 ms after each write, the same budget bridge.swift gives the radio).
private struct SelftestRig {
    var core: LeaseRampCore
    var now: Int64 = 0
    var ackAt: Int64 = -1
    var steps: [SelftestStep] = []
    var rampEmits: [Int64] = []
    var releases: [(at: Int64, expiry: LeaseExpiry)] = []

    init(core: LeaseRampCore = LeaseRampCore()) {
        self.core = core
    }

    mutating func tick() {
        now += 100
        if core.inflight, ackAt >= 0, now >= ackAt {
            core.didFinishWrite()
            ackAt = -1
        }
        if let exp = core.checkLease(now) {
            releases.append((now, exp))
            return
        }
        guard !core.inflight else { return }      // serial writes: never two in flight
        guard let w = core.nextRampStep(nowMs: now) else { return }
        let from = core.lastWrittenWatts
        let to = core.rampTargetWatts
        steps.append(SelftestStep(at: now, from: from, to: to, watts: w))
        core.didStartWrite(watts: w, nowMs: now)
        ackAt = now + 300
        if core.takeRampEmitSlot(nowMs: now) { rampEmits.append(now) }
    }

    mutating func advance(_ ms: Int64) {
        let end = now + ms
        while now < end { tick() }
    }
}

// MARK: - --selftest-lease

/// Pure state-machine checks. Prints one JSON line per decision plus one per assertion and
/// returns 0 only when every assertion held. Never constructs a CBCentralManager.
func runLeaseSelftest() -> Int32 {
    var failures: [String] = []
    var checks = 0

    func line(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        var out = data
        out.append(0x0A)
        FileHandle.standardOutput.write(out)
    }

    func expect(_ id: String, _ ok: Bool, _ detail: String) {
        checks += 1
        if !ok { failures.append(id) }
        line(["t": "selftest", "check": id, "ok": ok, "detail": detail])
    }

    func header(_ name: String, _ desc: String) {
        line(["t": "selftest", "case": name, "desc": desc])
    }

    // A — erg 200, no renewal, advance 31 s: exactly one release, target 0.
    header("A", "erg 200, no renewal, advance 31 s -> exactly one lease_expired, target 0")
    var a = SelftestRig()
    a.core.onErg(watts: 200, nowMs: a.now)
    line(["t": "selftest", "case": "A", "now": a.now, "action": "erg",
          "watts": 200, "leaseUntil": a.core.leaseUntilMs ?? -1, "ttl": a.core.ttlSeconds])
    a.advance(31_000)
    expect("A.release_count", a.releases.count == 1, "expected 1 release, got \(a.releases.count)")
    if let r = a.releases.first {
        line(["t": "selftest", "case": "A", "event": "lease_expired", "at": r.at,
              "afterMs": r.expiry.afterDeadlineMs, "sinceRenewMs": r.expiry.sinceRenewMs,
              "ttl": Double(r.expiry.ttlMs) / 1000.0, "was": r.expiry.wasMode,
              "wasWatts": r.expiry.wasErgWatts, "targetAfter": a.core.ergTargetWatts])
        expect("A.after_ms", r.expiry.afterDeadlineMs > 0 && r.expiry.afterDeadlineMs <= 200,
               "afterMs=\(r.expiry.afterDeadlineMs) (100 ms tick, expected 0<after<=200)")
        expect("A.target_zero", a.core.ergTargetWatts == 0 && a.core.lastWrittenWatts == 0,
               "target=\(a.core.ergTargetWatts) written=\(a.core.lastWrittenWatts)")
        expect("A.lease_cleared", a.core.leaseUntilMs == nil,
               "leaseUntil=\(String(describing: a.core.leaseUntilMs))")
        expect("A.ramp_stopped", a.steps.allSatisfy { $0.at <= r.at },
               "last step at=\(a.steps.last?.at ?? -1), release at=\(r.at)")
    }
    a.advance(10_000)
    expect("A.idempotent", a.releases.count == 1,
           "still 1 release after +10 s, got \(a.releases.count)")

    // B — erg 200, renew every 10 s, advance 60 s: zero releases.
    header("B", "erg 200, renew every 10 s, advance 60 s -> zero releases")
    var b = SelftestRig()
    b.core.onErg(watts: 200, nowMs: b.now)
    for _ in 1...6 {
        b.advance(10_000)
        let reply = b.core.onLease(ttlSeconds: nil, watts: nil, nowMs: b.now)
        line(["t": "selftest", "case": "B", "event": "renew", "at": b.now,
              "until": reply.untilMs, "ttl": reply.ttlSeconds])
    }
    expect("B.no_release", b.releases.isEmpty, "releases=\(b.releases.count)")
    expect("B.still_leased", b.core.leaseUntilMs != nil && b.core.ergTargetWatts == 200,
           "until=\(String(describing: b.core.leaseUntilMs)) target=\(b.core.ergTargetWatts)")

    // C — erg 200, stop after 0.5 s, advance 60 s: zero releases (explicit zero).
    header("C", "erg 200, stop at 0.5 s, advance 60 s -> zero releases")
    var c = SelftestRig()
    c.core.onErg(watts: 200, nowMs: c.now)
    c.advance(500)
    c.core.zeroAll(nowMs: c.now)
    line(["t": "selftest", "case": "C", "now": c.now, "action": "stop",
          "leaseUntil": String(describing: c.core.leaseUntilMs)])
    c.advance(59_500)
    expect("C.no_release", c.releases.isEmpty, "releases=\(c.releases.count)")
    expect("C.target_zero", c.core.ergTargetWatts == 0 && c.core.lastWrittenWatts == 0,
           "target=\(c.core.ergTargetWatts) written=\(c.core.lastWrittenWatts)")
    expect("C.lease_cleared", c.core.leaseUntilMs == nil,
           "leaseUntil=\(String(describing: c.core.leaseUntilMs))")

    // D — 0 -> 50 W at 10 W/s: five 10 W steps, serial, monotonic.
    header("D", "0 -> 50 W at 10 W/s: 5 steps, <=10 W each, serial and monotonic")
    var d = SelftestRig()
    d.core.onErg(watts: 50, nowMs: d.now)
    d.advance(6_000)
    for s in d.steps {
        line(["t": "selftest", "case": "D", "event": "write", "at": s.at,
              "from": s.from, "to": s.to, "watts": s.watts])
    }
    let dWatts = d.steps.map { $0.watts }
    let dDeltas = d.steps.map { $0.watts - $0.from }
    let dGaps = zip(d.steps.dropFirst(), d.steps).map { pair in pair.0.at - pair.1.at }
    expect("D.step_count", d.steps.count == 5,
           "steps=\(d.steps.count) watts=\(dWatts) at=\(d.steps.map { $0.at })")
    expect("D.step_size", dDeltas.allSatisfy { $0 > 0 && $0 <= 10 }, "deltas=\(dDeltas)")
    expect("D.monotonic", dWatts == [10, 20, 30, 40, 50], "watts=\(dWatts)")
    expect("D.serial_gap", dGaps.allSatisfy { $0 >= 1_000 }, "gaps=\(dGaps)")
    expect("D.rate", Double(dWatts.last ?? 0) / (Double(d.steps.last?.at ?? 1) / 1000.0) <= 10.0,
           "\(dWatts.last ?? 0) W in \(Double(d.steps.last?.at ?? 0) / 1000.0) s")
    expect("D.final", d.core.lastWrittenWatts == 50 && d.core.ergTargetWatts == 50,
           "written=\(d.core.lastWrittenWatts) target=\(d.core.ergTargetWatts)")
    expect("D.ramp_events", d.rampEmits.count == d.steps.count,
           "ramp events=\(d.rampEmits.count) of \(d.steps.count) steps at \(d.rampEmits)")

    // E — new target mid-ramp: one ramp, redirected, never above the new target.
    header("E", "erg 200 then erg 60 at t=3 s: single ramp redirects, no overshoot")
    var e = SelftestRig()
    e.core.onErg(watts: 200, nowMs: e.now)
    e.advance(3_000)
    let writtenAtRedirect = e.core.lastWrittenWatts
    e.core.onErg(watts: 60, nowMs: e.now)
    e.advance(4_000)
    let after = Array(e.steps.suffix(from: max(0, e.steps.count - 3)))
    for s in after {
        line(["t": "selftest", "case": "E", "event": "write", "at": s.at,
              "from": s.from, "to": s.to, "watts": s.watts])
    }
    expect("E.redirect", writtenAtRedirect == 30, "written at redirect=\(writtenAtRedirect)")
    expect("E.no_overshoot", e.steps.allSatisfy { $0.watts <= 200 } &&
           e.steps.suffix(3).allSatisfy { $0.watts <= 60 },
           "tail=\(e.steps.suffix(3).map { $0.watts })")
    expect("E.final", e.core.lastWrittenWatts == 60 && e.core.ergTargetWatts == 60,
           "written=\(e.core.lastWrittenWatts) target=\(e.core.ergTargetWatts)")

    // F — TTL clamp and the 30 s default.
    header("F", "ttl clamp 5…120 s, default stays 30 s")
    var f = LeaseRampCore()
    let r1 = f.onLease(ttlSeconds: 1, watts: nil, nowMs: 1_000)
    let r2 = f.onLease(ttlSeconds: 999, watts: nil, nowMs: 2_000)
    expect("F.min_clamp", r1.ttlSeconds == 5, "ttl(1) -> \(r1.ttlSeconds)")
    expect("F.max_clamp", r2.ttlSeconds == 120, "ttl(999) -> \(r2.ttlSeconds)")
    expect("F.default_ttl", LeaseRampCore().ttlSeconds == 30,
           "default=\(LeaseRampCore().ttlSeconds)")

    // G — grade arms the lease; grade 0 clears it without an expiry.
    header("G", "grade 2.5 % arms the lease; grade 0 clears it (no release)")
    var g = SelftestRig()
    g.core.onSim(pct: 2.5, nowMs: g.now)
    expect("G.grade_arms", g.core.leaseUntilMs == 30_000,
           "leaseUntil=\(String(describing: g.core.leaseUntilMs))")
    g.advance(31_000)
    expect("G.grade_expires", g.releases.count == 1, "releases=\(g.releases.count)")
    var g2 = SelftestRig()
    g2.core.onSim(pct: 2.5, nowMs: g2.now)
    g2.core.onSim(pct: 0, nowMs: g2.now)
    g2.advance(60_000)
    expect("G.grade_zero_no_release", g2.releases.isEmpty, "releases=\(g2.releases.count)")

    // H — a lease with nothing to control lapses silently (no release, deadline cleared).
    header("H", "lease with no setpoint: lapses silently, deadline cleared, no release")
    var h = SelftestRig()
    _ = h.core.onLease(ttlSeconds: nil, watts: nil, nowMs: h.now)
    h.advance(31_000)
    expect("H.no_release", h.releases.isEmpty, "releases=\(h.releases.count)")
    expect("H.lease_cleared", h.core.leaseUntilMs == nil,
           "leaseUntil=\(String(describing: h.core.leaseUntilMs))")

    line(["t": "selftest", "result": failures.isEmpty ? "pass" : "fail",
          "checks": checks, "failed": failures.count, "failures": failures])
    FileHandle.standardError.write(Data("selftest: \(checks) checks, \(failures.count) failed\n".utf8))
    return failures.isEmpty ? 0 : 1
}
