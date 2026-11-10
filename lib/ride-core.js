/**
 * dsh-ride — safety and command semantics, as a pure module.
 *
 * No IO, no ctx, no child_process, no Date.now(): every time value is passed in
 * and every timer is handed back to the caller. That is what makes the rules
 * testable without a trainer, a radio or a Harness runtime.
 *
 * The semantics here are a line-for-line translation of what the host half used
 * to do inline; the messages are user-visible and are kept verbatim.
 */

/** Rider and bike constants. Nothing here is a safe default for a specific person; it is a start. */
export const DEFAULT_SETTINGS = Object.freeze({
  weightKg: 75,
  ftp: 200,
  maxHr: 180,
  hrCeilingPct: 92,
  cda: 0.51,
  crr: 0.004,
  defaultGrade: 0,
  minPower: 40,
  maxPower: 250,
  maxStep: 50,
  maxDuration: 90,
});

export const RANGES = {
  weightKg: [30, 200],
  ftp: [50, 600],
  maxHr: [100, 220],
  hrCeilingPct: [80, 100],
  cda: [0.2, 0.8],
  crr: [0.001, 0.02],
  defaultGrade: [-5, 10],
  minPower: [0, 400],
  maxPower: [50, 600],
  maxStep: [10, 200],
  maxDuration: [5, 240],
};

/**
 * Every watchdog threshold, named. Nothing below this comment is allowed to spell a
 * millisecond literal: a number that decides whether the trainer lets go has to be
 * visible in one place, so "why did it stop at 20 s" has one answer.
 *
 * Units: ms unless the name says otherwise.
 */
export const WATCHDOG = Object.freeze({
  tickMs: 1_000,             // watchdogTick cadence
  heartbeatMs: 5_000,        // no event at all from the sidecar
  heartbeatKillMs: 7_000,    // 5 s + the 2 ticks the brief asks for before SIGTERM
  metricsStaleMs: 10_000,    // sidecar alive but Indoor Bike Data stopped
  cadenceZeroMs: 20_000,     // ERG target > 0 and 0 rpm for this long
  leaseTtlMs: 30_000,        // host did not renew the control lease
  hrCeilingSustainMs: 20_000,// at/above ceiling before the first derate
  hrDerateThrottleMs: 30_000,// minimum gap between two derates
  hrDerateMax: 2,            // two 10 % derates, then the ladder is at the bottom
  hrBottomSustainMs: 30_000, // at the bottom and still at/above ceiling → stop
  hrMaxSustainMs: 10_000,    // at/above maxHr before the hard stop (kept from M3)
});

/** Control lease: how often the host re-asserts the target, and how long it stays valid. */
export const LEASE = Object.freeze({ renewMs: 10_000, ttlMs: WATCHDOG.leaseTtlMs });

/** ERG ramp: proposal-side rate limit, in watts per second. */
export const RAMP = Object.freeze({ wattsPerSecond: 10, tickMs: 1_000 });

/**
 * Validate a partial settings patch; unknown keys are ignored, out-of-range keys are rejected.
 * @param {Record<string, unknown>} input
 * @returns {{ok: true, value: Record<string, number>} | {ok: false, reason: string}}
 */
export function validateSettings(input) {
  const next = {};
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return { ok: false, reason: `${key} 必须在 ${min}…${max} 之间` };
    }
    next[key] = Math.round(value * 1000) / 1000;
  }
  if (next.maxPower !== undefined && next.minPower !== undefined && next.minPower >= next.maxPower) {
    return { ok: false, reason: 'minPower 必须小于 maxPower' };
  }
  return { ok: true, value: next };
}

/**
 * ERG target guard. Out-of-envelope and over-step targets are rejected outright —
 * never silently pulled to the boundary, so "ok" always means "this is what the
 * trainer was told".
 * @param {unknown} watts
 * @param {{settings: typeof DEFAULT_SETTINGS, currentTarget?: number|null}} context
 * @returns {{ok: true, watts: number} | {ok: false, reason: string}}
 */
export function clampPower(watts, { settings, currentTarget = null }) {
  const wanted = Math.round(Number(watts));
  if (!Number.isFinite(wanted)) return { ok: false, reason: 'watts must be a number' };
  if (wanted < settings.minPower || wanted > settings.maxPower) {
    return { ok: false, reason: `目标 ${wanted} W 超出信封 ${settings.minPower}–${settings.maxPower} W，已拒绝（不会自动夹到边界，避免你以为设定生效了）` };
  }
  if (currentTarget !== null && Math.abs(wanted - currentTarget) > settings.maxStep) {
    return { ok: false, reason: `一次调整 ${currentTarget} → ${wanted} W 超过 ${settings.maxStep} W，请分步下发` };
  }
  return { ok: true, watts: wanted };
}

/**
 * One ramp slice: the same envelope as `clampPower`, with one deliberate difference —
 * a slice below `minPower` is allowed while a ramp climbs from a standstill. The floor
 * is about the ERG target you *ask for* (a 10 W ERG target is meaningless), not about
 * the interpolation between two in-envelope endpoints: 0 → 50 W at 10 W/s passes
 * through 10/20/30 W on its way, and refusing those would mean the first write of every
 * session had to jump straight to 40 W. The step and ceiling checks are unchanged, so a
 * slice still cannot jump.
 * @param {unknown} watts
 * @param {{settings: typeof DEFAULT_SETTINGS, currentTarget?: number|null}} context
 * @returns {{ok: true, watts: number} | {ok: false, reason: string}}
 */
export function clampRampStep(watts, { settings, currentTarget = null }) {
  const wanted = Math.round(Number(watts));
  if (!Number.isFinite(wanted)) return { ok: false, reason: 'watts must be a number' };
  const floor = wanted < settings.minPower ? { ...settings, minPower: wanted } : settings;
  return clampPower(wanted, { settings: floor, currentTarget });
}

/**
 * Grade guard: −10…15 %, one decimal.
 * @param {unknown} pct
 * @returns {{ok: true, grade: number} | {ok: false, reason: string}}
 */
export function clampGrade(pct) {
  const wanted = Math.round(Number(pct) * 10) / 10;
  if (!Number.isFinite(wanted)) return { ok: false, reason: 'grade must be a number' };
  if (wanted < -10 || wanted > 15) return { ok: false, reason: `坡度 ${wanted}% 超出 −10…15%，已拒绝` };
  return { ok: true, grade: wanted };
}

/**
 * Power (1–6, %FTP) and heart-rate (1–5, %HRmax) zones. Zone 0 means "no reading".
 * @param {{power: number, hr: number, settings: typeof DEFAULT_SETTINGS}} input
 */
export function zones({ power, hr, settings }) {
  const pct = settings.ftp > 0 ? (power / settings.ftp) * 100 : 0;
  const powerZone = power === 0 ? 0 : pct < 55 ? 1 : pct < 76 ? 2 : pct < 91 ? 3 : pct < 106 ? 4 : pct < 121 ? 5 : 6;
  const hrPct = settings.maxHr > 0 ? (hr / settings.maxHr) * 100 : 0;
  const hrZone = hr === 0 ? 0 : hrPct < 60 ? 1 : hrPct < 70 ? 2 : hrPct < 80 ? 3 : hrPct < 90 ? 4 : 5;
  return { powerZone, ftpPct: Math.round(pct), hrZone, hrPct: Math.round(hrPct) };
}

/**
 * Moving/coasting summary over the rows inside the window.
 * `coastingSec` is "seconds since the last pedal stroke" once you have pedalled,
 * and the whole window length while you have not pedalled at all.
 * @param {{t: number, p: number, c: number, s: number, hr: number}[]} rows
 * @param {number} windowMs
 * @param {number} now
 */
export function summarize(rows, windowMs, now) {
  const from = now - windowMs;
  const inside = rows.filter((row) => row.t >= from);
  if (inside.length === 0) return null;
  const moving = inside.filter((row) => row.p > 0);
  const avg = (list, key) => Math.round(list.reduce((sum, row) => sum + row[key], 0) / list.length);
  const lastMoving = [...inside].reverse().find((row) => row.p > 0);
  return {
    seconds: Math.round((now - inside[0].t) / 1000),
    avgPower: moving.length === 0 ? 0 : avg(moving, 'p'),
    maxPower: inside.reduce((max, row) => Math.max(max, row.p), 0),
    avgHr: avg(inside.filter((row) => row.hr > 0), 'hr') || 0,
    maxHr: inside.reduce((max, row) => Math.max(max, row.hr), 0),
    pedalingSec: moving.length,
    coastingSec: lastMoving === undefined ? inside.length : Math.round((now - lastMoving.t) / 1000),
  };
}

/**
 * One tick of the heart-rate guard. Pure: it decides, it does not command, and it
 * carries its own timers in and out so the host stays the only place with state.
 *
 * Behaviour — a ladder, not a single threshold (audit #6):
 *  - hr >= maxHr, sustained 10 s, in erg        → `stop`  (alert: 心率红线; kept from M3,
 *                                                 more conservative than the doc's 30 s)
 *  - hr >= ceiling, sustained 20 s, in erg, target set, >= 30 s since the last
 *    derate, at most 2 derates                   → `derate` to max(minPower, round(target*0.9))
 *  - at the bottom (2 derates used up, or target already at minPower) and still
 *    at/above ceiling for 30 s                   → `stop`  (never silent any more)
 *  - otherwise                                  → `none`
 * `alert` in the result is `undefined` when the current alert should stay as it
 * is, `null` when it should be cleared, and the new alert object otherwise.
 * `code` is returned beside the alert (not inside it) so the alert payload the M3
 * tests pin stays byte-identical; the host attaches it to `snapshot.alert`.
 *
 * @param {{
 *   state: {hr: number, mode: string, target: number|null, alert: object|null},
 *   settings: typeof DEFAULT_SETTINGS,
 *   now: number,
 *   timers: {hrHighSince?: number, hrHardSince?: number, lastDerateAt?: number, derateCount?: number, hrBottomSince?: number},
 * }} input
 * @returns {{action: 'none'|'derate'|'stop', code?: string, alert: object|null|undefined, timers: object, watts?: number, reason?: string}}
 */
export function watchdogDecision({ state, settings, now, timers }) {
  const next = {
    hrHighSince: timers.hrHighSince ?? 0,
    hrHardSince: timers.hrHardSince ?? 0,
    lastDerateAt: timers.lastDerateAt ?? 0,
    derateCount: timers.derateCount ?? 0,
    hrBottomSince: timers.hrBottomSince ?? 0,
  };
  const maxHr = settings.maxHr;
  const hr = state.hr;
  if (!hr || maxHr <= 0) {
    next.hrHighSince = 0;
    next.hrHardSince = 0;
    next.hrBottomSince = 0;
    return { action: 'none', alert: undefined, timers: next };
  }
  const ceiling = maxHr * (settings.hrCeilingPct / 100);

  if (hr >= maxHr) {
    if (next.hrHardSince === 0) next.hrHardSince = now;
    if (state.mode === 'erg' && now - next.hrHardSince >= WATCHDOG.hrMaxSustainMs) {
      next.hrHardSince = 0;
      next.derateCount = 0;
      next.hrBottomSince = 0;
      return {
        action: 'stop',
        code: 'hr_max',
        alert: { level: 'critical', message: '心率红线：已停机并回到坡度 0', at: now },
        timers: next,
        reason: `watchdog: HR ${hr} >= maxHr ${maxHr}`,
      };
    }
    return {
      action: 'none',
      code: 'hr_max',
      alert: { level: 'critical', message: `心率 ${hr} 已达最大 ${maxHr}`, at: now },
      timers: next,
    };
  }
  next.hrHardSince = 0;

  if (hr >= ceiling) {
    if (next.hrHighSince === 0) next.hrHighSince = now;
    const alert = {
      level: 'warn',
      message: `心率 ${hr} 超过红线 ${Math.round(ceiling)}（${settings.hrCeilingPct}% HRmax）`,
      at: now,
    };
    if (state.mode === 'erg' && state.target !== null) {
      // Bottom of the ladder: two derates used up, or already at the floor. From here
      // the only honest action left is to stop, so this timer exists to make sure
      // something happens instead of the old silent `watts < target` fall-through.
      const atBottom = next.derateCount >= WATCHDOG.hrDerateMax || state.target <= settings.minPower;
      if (atBottom) {
        if (next.hrBottomSince === 0) next.hrBottomSince = now;
        const sustainedMs = now - next.hrBottomSince;
        if (sustainedMs >= WATCHDOG.hrBottomSustainMs) {
          next.hrBottomSince = 0;
          next.derateCount = 0;
          return {
            action: 'stop',
            code: 'hr_bottom',
            alert: { level: 'critical', message: '心率一直在红线以上、降载已到底：已停机并回到坡度 0', at: now },
            timers: next,
            reason: `watchdog: HR ${hr} 在红线 ${Math.round(ceiling)} 以上已 ${Math.round(sustainedMs / 1000)} s，降载到底`,
          };
        }
        return { action: 'none', code: 'hr_bottom', alert, timers: next };
      }
      if (now - next.hrHighSince >= WATCHDOG.hrCeilingSustainMs
        && now - next.lastDerateAt >= WATCHDOG.hrDerateThrottleMs) {
        const watts = Math.max(settings.minPower, Math.round(state.target * 0.9));
        if (watts < state.target) {
          next.lastDerateAt = now;
          next.derateCount += 1;
          return {
            action: 'derate',
            code: 'hr_ceiling',
            alert,
            timers: next,
            watts,
            reason: `watchdog: HR ${hr} >= ${Math.round(ceiling)}，自动降载`,
          };
        }
      }
    }
    return { action: 'none', code: 'hr_ceiling', alert, timers: next };
  }
  next.hrHighSince = 0;
  next.hrBottomSince = 0;
  // Only the heart-rate's own alert may be cleared here. Since M4a the snapshot alert
  // can also belong to a lease / heartbeat / metrics / cadence / duration watchdog, and
  // a normal heart rate must not quietly wipe a critical line off the HUD.
  const owned = state.alert !== null
    && state.alert !== undefined
    && (state.alert.code === undefined || String(state.alert.code).startsWith('hr_'));
  const clear = owned && hr < ceiling - 5;
  return { action: 'none', alert: clear ? null : undefined, timers: next };
}

/**
 * Proposal-side rate limit: the ERG target is approached in steps, never written in
 * one jump. Symmetric — a step is at most `min(wattsPerSecond * tickMs / 1000, maxStep)`
 * watts in either direction, one step per `tickMs`, and the last step lands exactly on
 * `toWatts`. Returning absolute `afterMs` offsets (not deltas) keeps the host free to
 * schedule the whole ramp with plain timeouts and abort it as one object.
 *
 * Boundaries, spelled out because they are the ones a reviewer will ask about:
 *  - `to === from`      → `[]` (nothing to do, no timer at all)
 *  - `to` not a number  → `[]`
 *  - `to < from`        → the same rate limit downwards (mirrors the sidecar's
 *                         `min(10, max(-10, delta))` in lease.swift, so host and
 *                         sidecar never disagree about how fast a target may move)
 *
 * @param {number} fromWatts
 * @param {number} toWatts
 * @param {{wattsPerSecond?: number, tickMs?: number, maxStep?: number}} [options]
 * @returns {{afterMs: number, watts: number}[]}
 */
export function rampSteps(fromWatts, toWatts, options = {}) {
  const {
    wattsPerSecond = RAMP.wattsPerSecond,
    tickMs = RAMP.tickMs,
    maxStep = Infinity,
  } = options;
  const from = Math.round(Number(fromWatts) || 0);
  const to = Math.round(Number(toWatts));
  if (!Number.isFinite(to) || to === from) return [];
  const perTick = Math.max(1, Math.round((Number(wattsPerSecond) * Number(tickMs)) / 1000));
  const stepCap = Math.max(1, Math.min(perTick, Math.round(Number(maxStep) || perTick)));
  const delta = to - from;
  const direction = delta > 0 ? 1 : -1;
  const steps = [];
  let current = from;
  let index = 0;
  while (current !== to) {
    index += 1;
    const magnitude = Math.min(stepCap, Math.abs(to - current));
    current += direction * magnitude;
    steps.push({ afterMs: index * tickMs, watts: current });
  }
  return steps;
}

/**
 * Is the control lease past its deadline? Only meaningful while the host believes it
 * is holding an ERG target: `sim`, `stop` and `follow` have no lease to lose.
 *
 * @param {{mode: string, target: number|null, now: number, leaseRenewedAt: number, ttlMs?: number}} input
 */
export function leaseExpired({ mode, target, now, leaseRenewedAt, ttlMs = LEASE.ttlMs }) {
  if (mode !== 'erg' || target === null || target === undefined) return false;
  if (!Number.isFinite(leaseRenewedAt) || leaseRenewedAt <= 0) return true;
  return now - leaseRenewedAt > ttlMs;
}

const NO_FAULT = Object.freeze({
  heartbeat: false, kill: false, metrics: false, cadence: false, lease: false, duration: false,
});

/**
 * One tick of the four safety watchdogs, as a pure function: it decides, it does not
 * command, and it takes its own timers in and out (same shape as `watchdogDecision`,
 * which keeps owning the heart-rate ladder).
 *
 * Watchdogs, thresholds and the reset that re-arms them:
 *
 *  1. `lease_expired`     now - leaseRenewedAt > WATCHDOG.leaseTtlMs (30 s), in erg with a
 *                         target. Reset: a renewal or any new setpoint refreshes
 *                         `leaseRenewedAt` (`fired.lease` clears because the condition is
 *                         false again).
 *  2. `bridge_heartbeat`  now - lastEventAt > WATCHDOG.heartbeatMs (5 s) for ANY sidecar
 *                         event. First tick stops; once past WATCHDOG.heartbeatKillMs (7 s
 *                         = 5 s + 2 ticks) it also asks for one SIGTERM. Reset: any event
 *                         refreshes `lastEventAt`, which clears both flags.
 *  3. `metrics_stale`     now - lastMetricsAt > WATCHDOG.metricsStaleMs (10 s) while in erg.
 *                         Reset: fresh metrics, or leaving erg.
 *  4. `cadence_zero`      0 rpm with an ERG target > 0 for WATCHDOG.cadenceZeroMs (20 s).
 *                         Reset: any pedal stroke (cadence > 0) or leaving erg.
 *  5. `max_duration`      elapsedSec > maxDuration * 60. Reset: elapsed falls back under the
 *                         threshold (a new ride, or the rider raises maxDuration).
 *
 * `fired` is what makes them idempotent: a condition that stays true acts exactly once
 * until its reset condition has been seen.
 *
 * At most one `stop` is emitted per tick even when several watchdogs are true (a dead
 * sidecar also stops the metrics stream); the first one in the order lease → heartbeat →
 * metrics → cadence → duration wins, because that is the most specific diagnosis.
 *
 * @param {{
 *   state: {mode: string, target: number|null, cadence: number, elapsedSec: number,
 *           lastEventAt: number, lastMetricsAt: number, leaseRenewedAt: number},
 *   settings: typeof DEFAULT_SETTINGS,
 *   now: number,
 *   timers?: {fired?: Record<string, boolean>, cadenceSince?: number, heartbeatSince?: number, metricsSince?: number},
 * }} input
 * @returns {{actions: {kind: 'stop'|'kill', code: string, reason: string, wire?: string}[], alert: object|undefined, timers: object}}
 */
export function safetyDecision({ state, settings, now, timers = {} }) {
  const fired = { ...NO_FAULT, ...(timers.fired ?? {}) };
  const next = {
    fired,
    cadenceSince: timers.cadenceSince ?? 0,
    heartbeatSince: timers.heartbeatSince ?? 0,
    metricsSince: timers.metricsSince ?? 0,
  };
  const mode = state.mode;
  const target = state.target ?? null;
  const actions = [];
  const alerts = [];
  let stopped = false;

  const stop = (code, reason, alert) => {
    alerts.push(alert);
    if (stopped) return;
    stopped = true;
    actions.push({ kind: 'stop', code, reason });
  };
  const seconds = (ms) => Math.round(ms / 1000);

  // 1. control lease: the host stopped renewing, so nobody is holding this target.
  if (leaseExpired({ mode, target, now, leaseRenewedAt: state.leaseRenewedAt })) {
    if (!fired.lease) {
      fired.lease = true;
      const ageMs = Math.max(0, now - state.leaseRenewedAt);
      stop('lease_expired', `lease_expired: ${seconds(ageMs)} s 未续约（租约 ${seconds(LEASE.ttlMs)} s）`, {
        level: 'critical',
        code: 'lease_expired',
        message: `控制租约已过期（${seconds(ageMs)} s 未续约）：已停机并回到坡度 0`,
        at: now,
      });
      actions[actions.length - 1].wire = 'stop';
    }
  } else {
    fired.lease = false;
  }

  // 2. sidecar heartbeat: alive but not talking. exit already has its own restart path.
  const eventAge = state.lastEventAt > 0 ? now - state.lastEventAt : 0;
  if (state.lastEventAt > 0 && eventAge > WATCHDOG.heartbeatMs) {
    if (next.heartbeatSince === 0) next.heartbeatSince = now;
    if (!fired.heartbeat) {
      fired.heartbeat = true;
      stop('bridge_heartbeat', `bridge_heartbeat: 边车 ${seconds(eventAge)} s 没有任何事件`, {
        level: 'critical',
        code: 'bridge_heartbeat',
        message: `边车 ${seconds(eventAge)} s 没有事件（进程僵死），已停机并回到坡度 0`,
        at: now,
      });
    }
    if (!fired.kill && eventAge > WATCHDOG.heartbeatKillMs) {
      fired.kill = true;
      actions.push({
        kind: 'kill',
        code: 'bridge_kill',
        reason: `bridge_kill: 边车 ${seconds(eventAge)} s 无事件且未退出，SIGTERM`,
      });
      alerts.push({
        level: 'critical',
        code: 'bridge_kill',
        message: `边车 ${seconds(eventAge)} s 无事件，已发送 SIGTERM`,
        at: now,
      });
    }
  } else {
    next.heartbeatSince = 0;
    fired.heartbeat = false;
    fired.kill = false;
  }

  // 3. stale data: the sidecar is talking, the trainer is not.
  const metricsAge = state.lastMetricsAt > 0 ? now - state.lastMetricsAt : 0;
  if (mode === 'erg' && metricsAge > WATCHDOG.metricsStaleMs) {
    if (next.metricsSince === 0) next.metricsSince = now;
    if (!fired.metrics) {
      fired.metrics = true;
      stop('metrics_stale', `metrics_stale: ${seconds(metricsAge)} s 没有新的 metrics`, {
        level: 'critical',
        code: 'metrics_stale',
        message: `数据已 ${seconds(metricsAge)} s 没有更新：已停机并回到坡度 0`,
        at: now,
      });
    }
  } else {
    next.metricsSince = 0;
    fired.metrics = false;
  }

  // 4. cadence zero with a live target: the rider got off, or the chain dropped.
  if (mode === 'erg' && target !== null && target > 0 && (state.cadence ?? 0) === 0) {
    if (next.cadenceSince === 0) next.cadenceSince = now;
    const quietMs = now - next.cadenceSince;
    if (!fired.cadence && quietMs >= WATCHDOG.cadenceZeroMs) {
      fired.cadence = true;
      stop('cadence_zero', `cadence_zero: 踏频 0 rpm、目标 ${target} W，已 ${seconds(quietMs)} s`, {
        level: 'warn',
        code: 'cadence_zero',
        message: `踏频已 0 rpm ${seconds(quietMs)} s（目标 ${target} W）：可能已下车或掉链，已停机`,
        at: now,
      });
    }
  } else {
    next.cadenceSince = 0;
    fired.cadence = false;
  }

  // 5. maxDuration: the envelope's time dimension.
  const limitSec = Number(settings?.maxDuration) > 0 ? Number(settings.maxDuration) * 60 : 0;
  if (limitSec > 0 && state.elapsedSec > limitSec) {
    if (!fired.duration) {
      fired.duration = true;
      stop('max_duration', `max_duration: 已骑 ${state.elapsedSec} s，上限 ${Math.round(limitSec)} s`, {
        level: 'warn',
        code: 'max_duration',
        message: `到点收工：已骑 ${Math.round(state.elapsedSec / 60)} 分钟（上限 ${settings.maxDuration} 分钟），已停机`,
        at: now,
      });
    }
  } else {
    fired.duration = false;
  }

  const critical = alerts.filter((alert) => alert.level === 'critical');
  const alert = critical.length > 0 ? critical[critical.length - 1] : alerts[alerts.length - 1];
  return { actions, alert, timers: next };
}
