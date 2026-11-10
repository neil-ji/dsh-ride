/**
 * dsh-ride — Host half.
 *
 * Owns wiring, not rules: spawns the Swift `ride-bridge` sidecar, keeps a
 * snapshot of the last metrics, exposes the agent-facing tools, and serves the
 * snapshot to the Client HUD over the Harness' own HTTP server.
 *
 * The safety rules themselves live in `lib/ride-core.js`, which has no IO, no
 * ctx and no clock. Everything below is the seam between that module and the
 * runtime: file IO, the child process, the timers, the tools and the endpoints.
 *
 * M4a adds the host half of the control lease (a 10 s renewal timer that does not
 * depend on a model turn), a 10 W/s ERG ramp, and the four safety watchdogs
 * (sidecar heartbeat, stale metrics, zero cadence, expired lease). Thresholds are
 * not spelled here: they come from WATCHDOG / LEASE / RAMP in lib/ride-core.js.
 */

import childProcess from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  LEASE,
  RAMP,
  RANGES,
  WATCHDOG,
  clampGrade,
  clampPower,
  clampRampStep,
  leaseExpired,
  rampSteps,
  safetyDecision,
  summarize,
  validateSettings,
  watchdogDecision,
  zones,
} from './lib/ride-core.js';

export const name = 'dsh-ride';
export const inject = ['tools'];

const STALE_MS = 6000;

const SETTINGS_PATH = join(homedir(), '.dsh', 'ride', 'config.json');
const SESSION_PATH = join(homedir(), '.dsh', 'ride', 'session.json');

/** Append-only audit trail; one JSON object per line, day-stamped. */
function auditPath() {
  const day = new Date().toISOString().slice(0, 10);
  return join(homedir(), '.dsh', 'ride', `audit-${day}.jsonl`);
}

/** Audit writes in flight. Only a test seam (`flushAudit`) reads this. */
const auditPending = new Set();

function logAudit(record) {
  const job = (async () => {
    try {
      await mkdir(dirname(auditPath()), { recursive: true });
      await appendFile(auditPath(), `${JSON.stringify(record)}\n`, 'utf8');
    } catch { /* an audit line is worth less than a working trainer */ }
  })();
  auditPending.add(job);
  job.then(() => auditPending.delete(job));
  return job;
}

/**
 * Await every audit line that has been decided but not yet reached the disk. Test
 * seam only: it makes "exactly one line" assertions deterministic without a sleep.
 */
export const flushAudit = () => Promise.all([...auditPending]);

/** How long a saved ride intent stays worth restoring. Older than this and we start clean. */
const RESTORE_TTL_MS = 12 * 60 * 60 * 1000;

async function loadIntent(now) {
  try {
    const raw = JSON.parse(await readFile(SESSION_PATH, 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    if (raw.mode !== 'erg' && raw.mode !== 'sim') return null;
    if (!Number.isFinite(raw.at) || now - raw.at > RESTORE_TTL_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

async function saveIntent(intent) {
  try {
    await mkdir(dirname(SESSION_PATH), { recursive: true });
    await writeFile(SESSION_PATH, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
  } catch { /* best effort: a lost intent only costs one manual set */ }
}

async function loadSettings() {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
    return validateSettings({ ...DEFAULT_SETTINGS, ...raw }).value;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Register the sidecar, the tools and the HTTP snapshot.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{spawnImpl?: Function, now?: () => number, binPath?: string, logger?: object,
 *          timers?: {setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function}}} [deps]
 *   Test seams only. Omitted, the real sidecar binary is spawned, the real clock is read
 *   and the real timers are used.
 * @returns {{tick: Function, snapshot: Function, applyCommand: Function}} test seam
 */
export function apply(ctx, deps = {}) {
  const clock = deps.now ?? Date.now;
  const logger = deps.logger ?? ctx.logger;
  const spawnImpl = deps.spawnImpl ?? childProcess.spawn;
  const bin = deps.binPath ?? fileURLToPath(new URL('./bin/ride-bridge', import.meta.url));
  /** Injected so a test can drive a virtual clock; production uses the globals. */
  const timers = deps.timers ?? { setInterval, clearInterval, setTimeout, clearTimeout };

  const state = {
    bridge: 'starting',          // starting | up | down
    trainer: null,
    strap: null,
    power: 0,
    cadence: 0,
    speed: 0,
    hr: 0,
    rr: 0,
    control: false,
    target: null,                // last accepted ERG target, W
    grade: 0,                    // last accepted simulation grade, %
    mode: 'follow',              // follow | erg | sim
    startedAt: null,
    lastMetricsAt: 0,
    lastEventAt: 0,              // last event of ANY kind from the sidecar (heartbeat watchdog)
    leaseRenewedAt: 0,           // last time we re-asserted the ERG target (lease watchdog)
    leaseExpiredAt: 0,           // when the lease watchdog last had to let go
    lastError: null,
    lastWarn: null,
    simUnsupported: false,
    lastRestore: null,
    alert: null,
    lastCp: null,
    ramping: null,               // {from, to, now, etaMs} while a ramp is in flight
  };

  let settings = { ...DEFAULT_SETTINGS };
  let intent = null;
  let restorePending = true;
  const history = [];
  const HISTORY_MAX = 900;   // ~15 min at 1 Hz
  let lastSampleAt = 0;

  let child = null;
  let disposed = false;
  let tries = 0;
  let timer = null;

  const remember = (patch) => {
    intent = { ...(intent ?? {}), ...patch, at: clock() };
    saveIntent(intent);
  };

  /**
   * One audit line per *decision*. `dispatch` calls this for every write it makes; the
   * ERG path also calls it once when it accepts a target, because the first wire write
   * only happens one ramp step later and an accepted command has to be traceable even
   * if the ramp is cancelled before its first step.
   */
  const auditDecision = (meta) => {
    const ts = meta.ts ?? clock();
    logAudit({
      ts,
      iso: new Date(ts).toISOString(),
      actor: meta.actor ?? 'agent',
      reason: meta.reason ?? '',
      cmd: meta.cmd ?? null,
      from: meta.from ?? null,
      to: meta.to ?? null,
      ok: meta.ok ?? true,
      ...(meta.extra ?? {}),
    });
  };

  /**
   * The only place that writes to the sidecar (audit #11). Three bypasses used to write
   * directly through `send()`: the reconnect restore, the sim re-send after a cda/crr
   * edit, and the watchdogs' own commands. Every write carries its actor, so "who put
   * the trainer at 250 W at 20:41" is one grep.
   *
   * dispatch does not clamp — clamping already happened in clampPower / clampGrade /
   * the restore path. It writes, books and throws.
   *
   * `meta.audit === false` marks a ramp continuation (wire step 2..n of a decision that
   * was already booked). A failed write is audited either way.
   */
  const dispatch = (cmd, meta = {}) => {
    const ts = clock();
    const record = {
      ts,
      iso: new Date(ts).toISOString(),
      actor: meta.actor ?? 'agent',
      reason: meta.reason ?? '',
      cmd: cmd?.t ?? null,
      from: meta.from ?? null,
      to: meta.to ?? null,
      ok: true,
      ...(meta.extra ?? {}),
    };
    try {
      if (!child?.stdin?.writable) throw new Error('边车 stdin 不可写（进程不在）');
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    } catch (error) {
      logAudit({ ...record, ok: false, error: String(error?.message ?? error) });
      throw error;
    }
    if (meta.audit !== false) logAudit(record);
    return record;
  };

  // ---------------------------------------------------------------------------
  // ERG ramp: proposal-side rate limit. 10 W/s, one write per step, abortable.
  // The sidecar has its own authoritative limit (T4); this only guarantees that the
  // proposal never asks for +100 W in one write.
  // ---------------------------------------------------------------------------
  let rampGen = 0;
  let ramp = null;

  const abortRamp = (why) => {
    if (ramp === null) return;
    rampGen += 1;
    for (const id of ramp.timerIds) timers.clearTimeout(id);
    ramp = null;
    state.ramping = null;
    if (why) logger?.debug?.(`ride: ramp aborted (${why})`);
  };

  const startRamp = ({ from, to, actor, reason }) => {
    abortRamp('replaced');
    const steps = rampSteps(from, to, {
      wattsPerSecond: RAMP.wattsPerSecond,
      tickMs: RAMP.tickMs,
      maxStep: settings.maxStep,
    });
    if (steps.length === 0) {
      state.ramping = null;
      return null;
    }
    const gen = ++rampGen;
    ramp = {
      gen,
      from,
      to,
      lastWritten: from,
      index: 0,
      steps,
      timerIds: [],
      actor,
      reason,
    };
    state.ramping = { from, to, now: from, etaMs: steps[steps.length - 1].afterMs };
    for (const step of steps) {
      const id = timers.setTimeout(() => {
        if (ramp === null || ramp.gen !== gen) return;
        const previous = ramp.lastWritten;
        // Still sliced through the envelope: maxStep is the per-step cap, so a 10 W
        // slice passes even when maxStep is at its floor of 10.
        const verdict = clampRampStep(step.watts, { settings, currentTarget: previous });
        if (!verdict.ok) {
          logger?.warn?.(`ride: ramp step rejected (${verdict.reason})`);
          abortRamp('step rejected');
          return;
        }
        try {
          dispatch({ t: 'erg', watts: verdict.watts }, {
            actor: ramp.actor,
            reason: `${ramp.reason}（斜坡 ${verdict.watts}/${ramp.to} W）`,
            from: { target: previous },
            to: { target: verdict.watts },
            audit: false,
          });
        } catch (error) {
          logger?.warn?.(`ride: ramp step failed: ${String(error?.message ?? error)}`);
          abortRamp('write failed');
          return;
        }
        ramp.lastWritten = verdict.watts;
        ramp.index += 1;
        // Every step is an erg write, so it renews the lease on the wire too.
        state.leaseRenewedAt = clock();
        const done = ramp.index >= ramp.steps.length;
        state.ramping = done
          ? null
          : { from: ramp.from, to: ramp.to, now: verdict.watts, etaMs: (ramp.steps.length - ramp.index) * RAMP.tickMs };
        if (done) ramp = null;
      }, step.afterMs);
      ramp.timerIds.push(id);
    }
    return ramp;
  };

  const ingest = (evt) => {
    // Any event at all counts as a heartbeat: the watchdog is about a wedged process,
    // not about which event it is.
    state.lastEventAt = clock();
    switch (evt.t) {
      case 'hello':
        state.bridge = 'up';
        break;
      case 'device':
        if (evt.role === 'trainer') { state.trainer = { name: evt.name, rssi: evt.rssi ?? null }; restorePending = true; }
        if (evt.role === 'strap') state.strap = { name: evt.name, rssi: evt.rssi ?? null };
        break;
      case 'metrics': {
        state.power = evt.power ?? 0;
        state.cadence = evt.cadence ?? 0;
        state.speed = evt.speed ?? 0;
        state.hr = evt.hr ?? 0;
        state.rr = evt.rr ?? 0;
        state.control = Boolean(evt.control);
        state.trainer = evt.trainer ?? null;
        state.strap = evt.strap ?? null;
        const now = clock();
        if (now - lastSampleAt >= 1000) {
          lastSampleAt = now;
          history.push({ t: lastSampleAt, p: state.power, c: state.cadence, s: state.speed, hr: state.hr });
          if (history.length > HISTORY_MAX) history.shift();
        }
        state.simUnsupported = Boolean(evt.simUnsupported);
        state.lastCp = evt.lastCp ?? null;
        state.lastMetricsAt = now;
        if (state.power > 0 && state.startedAt === null) state.startedAt = now;
        if (state.power === 0 && state.startedAt !== null && now - state.lastMetricsAt > 0) { /* keep elapsed */ }
        break;
      }
      case 'control':
        if (evt.acquired === true) state.control = true;
        break;
      case 'mode':
        state.mode = evt.mode ?? state.mode;
        state.grade = evt.grade ?? state.grade;
        break;
      case 'ready':
        if (evt.role === 'trainer' && restorePending) {
          restorePending = false;
          if (intent !== null) {
            const restoredAt = clock();
            if (intent.mode === 'sim') {
              const grade = clampGrade(intent.grade ?? 0);
              if (grade.ok) {
                state.target = null;
                state.mode = 'sim';
                state.grade = grade.grade;
                state.leaseRenewedAt = 0;
                try {
                  dispatch({ t: 'sim', pct: grade.grade, crr: settings.crr, cda: settings.cda }, {
                    actor: 'host-restore',
                    reason: '重连后恢复坡度',
                    from: { mode: null, grade: null },
                    to: { mode: 'sim', grade: grade.grade },
                  });
                } catch (error) {
                  logger?.warn?.(`ride: restore failed: ${String(error?.message ?? error)}`);
                }
              }
            } else {
              const watts = clampPower(intent.watts, { settings, currentTarget: null });
              if (watts.ok) {
                state.mode = 'erg';
                state.target = watts.watts;
                state.grade = 0;                 // ERG 模式下没有坡度可谈（与 M3 一致）
                state.leaseRenewedAt = restoredAt;
                // One line for the decision; the ramp's steps are its continuation.
                auditDecision({
                  actor: 'host-restore',
                  reason: '重连后恢复 ERG 目标',
                  cmd: 'erg',
                  from: { mode: null, target: null },
                  to: { mode: 'erg', target: watts.watts },
                  extra: { ramp: { from: 0, to: watts.watts } },
                });
                startRamp({ from: 0, to: watts.watts, actor: 'host-restore', reason: '重连后恢复 ERG 目标' });
              }
            }
            state.lastRestore = { mode: intent.mode, grade: intent.grade ?? null, watts: intent.watts ?? null, at: restoredAt };
            logger?.info?.(`ride: restored ${intent.mode} after reconnect`);
          }
        }
        break;
      case 'error':
        state.lastError = { code: evt.code, message: evt.message, at: clock() };
        break;
      case 'warn':
        state.lastWarn = { code: evt.code, message: evt.message, at: clock() };
        break;
      default:
        break;
    }
  };

  const start = () => {
    if (disposed) return;
    state.bridge = 'starting';
    // The heartbeat clock starts with the process: a sidecar that is born silent is a
    // watchdog case too, so lastEventAt must not stay at 0 (which means "never seen").
    state.lastEventAt = clock();
    state.lastMetricsAt = clock();
    // A fresh process gets a fresh chance to be killed for going quiet.
    if (safetyTimers?.fired) {
      safetyTimers.fired.heartbeat = false;
      safetyTimers.fired.kill = false;
    }
    child = spawnImpl(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        try { ingest(JSON.parse(line)); } catch { /* ignore malformed line */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => logger?.debug?.(`ride-bridge: ${String(chunk).trim()}`));
    child.on('exit', (code) => {
      state.bridge = 'down';
      state.control = false;
      state.trainer = null;
      state.strap = null;
      // Nothing can be written down a dead pipe, so stop claiming to hold a target.
      // The intent file keeps what to restore when the device comes back.
      abortRamp('sidecar exit');
      state.target = null;
      state.grade = 0;
      state.mode = 'sim';
      state.leaseRenewedAt = 0;
      if (disposed) return;
      tries += 1;
      const delay = Math.min(30_000, 2_000 * tries);
      logger?.warn?.(`ride-bridge exited (${code}); restarting in ${delay}ms`);
      timer = timers.setTimeout(start, delay);
    });
    try {
      dispatch({ t: 'connect' }, { actor: 'host', reason: '启动/重启后连接设备' });
    } catch { /* spawn failed; the exit handler owns the retry */ }
  };

  Promise.all([loadSettings(), loadIntent(clock())])
    .then(([loaded, saved]) => { settings = loaded; intent = saved; })
    .catch(() => { /* fall back to defaults */ })
    .finally(() => { start(); });

  const snapshot = () => {
    const now = clock();
    return {
      bridge: state.bridge,
      connected: { trainer: state.trainer, strap: state.strap },
      power: state.power,
      cadence: state.cadence,
      speed: state.speed,
      hr: state.hr,
      rr: state.rr,
      control: state.control,
      target: state.target,
      grade: state.grade,
      mode: state.mode,
      elapsedSec: state.startedAt === null ? 0 : Math.round((now - state.startedAt) / 1000),
      stale: now - state.lastMetricsAt > STALE_MS,
      lastError: state.lastError,
      lastWarn: state.lastWarn,
      simUnsupported: state.simUnsupported,
      lastCp: state.lastCp,
      settings,
      zones: zones({ power: state.power, hr: state.hr, settings }),
      lastRestore: state.lastRestore ?? null,
      alert: state.alert ?? null,
      ramping: state.ramping ?? null,
      lease: {
        renewedAt: state.leaseRenewedAt,
        ageSec: state.leaseRenewedAt > 0 ? Math.round((now - state.leaseRenewedAt) / 1000) : null,
        expired: state.leaseExpiredAt > 0 || leaseExpired({
          mode: state.mode,
          target: state.target,
          now,
          leaseRenewedAt: state.leaseRenewedAt,
        }),
        expiredAt: state.leaseExpiredAt > 0 ? state.leaseExpiredAt : null,
      },
      envelope: { minPower: settings.minPower, maxPower: settings.maxPower, maxStep: settings.maxStep },
      last60s: summarize(history, 60_000, now),
      last10min: summarize(history, 600_000, now),
    };
  };

  /**
   * One code path for both the agent tool and the page button. Everything with physical
   * consequences (clamping, intent, audit) happens exactly once, here.
   * @param {{mode?: string, watts?: number, grade?: number, reason?: string}} input
   * @param {'agent'|'user'|'watchdog'} actor
   * @param {{wire?: 'stop'|'end'}} [options]  watchdog lease expiry asks the sidecar for
   *   `{"t":"stop"}`; everything else keeps the M3 `{"t":"end"}`. Both end the session the
   *   same way in the sidecar (src/bridge.swift: stop → endSession(false), end → endSession(false)).
   */
  const applyCommand = async (input, actor, options = {}) => {
    const mode = String(input?.mode ?? '');
    const reason = String(input?.reason ?? '').slice(0, 200);
    const before = { mode: state.mode, target: state.target, grade: state.grade };
    const after = () => ({ mode: state.mode, target: state.target, grade: state.grade });
    let audited = false;
    let result;

    if (mode === 'stop') {
      abortRamp('stop');
      state.target = null;
      state.grade = 0;
      state.mode = 'sim';
      state.leaseRenewedAt = 0;            // nothing left to renew
      state.leaseExpiredAt = 0;            // a fresh stop is a fresh decision
      if (options.dropControl === true) state.control = false;
      remember({ mode: 'sim', grade: 0, watts: null });
      const wire = options.wire === 'stop' ? 'stop' : 'end';
      try {
        dispatch({ t: wire }, {
          actor, reason, from: before, to: after(), ...(options.code ? { extra: { code: options.code } } : {}),
        });
        audited = true;
        result = { ok: true, mode: 'sim', grade: 0, note: '已结束控制并回到坡度 0，飞轮会自然减速' };
      } catch (error) {
        audited = true;
        result = { ok: false, reason: `边车不可用：${String(error?.message ?? error)}` };
      }
    } else if (mode === 'sim') {
      const verdict = clampGrade(input?.grade);
      if (!verdict.ok) {
        result = { ok: false, reason: verdict.reason };
      } else {
        abortRamp('sim');
        state.target = null;
        state.grade = verdict.grade;
        state.mode = 'sim';
        state.leaseRenewedAt = 0;
        state.leaseExpiredAt = 0;
        remember({ mode: 'sim', grade: verdict.grade });
        try {
          dispatch({ t: 'sim', pct: verdict.grade, crr: settings.crr, cda: settings.cda }, {
            actor, reason, from: before, to: after(),
          });
          audited = true;
          result = { ok: true, mode: 'sim', grade: verdict.grade, note: '已切到坡度模拟' };
        } catch (error) {
          audited = true;
          result = { ok: false, reason: `边车不可用：${String(error?.message ?? error)}` };
        }
      }
    } else if (mode === 'erg') {
      const verdict = clampPower(input?.watts, { settings, currentTarget: state.target });
      if (!verdict.ok) {
        result = { ok: false, reason: verdict.reason };
      } else {
        const from = ramp !== null ? ramp.lastWritten : (state.target ?? 0);
        state.target = verdict.watts;
        state.mode = 'erg';
        state.leaseRenewedAt = clock();
        state.leaseExpiredAt = 0;
        remember({ mode: 'erg', watts: verdict.watts });
        auditDecision({
          actor,
          reason,
          cmd: 'erg',
          from: before,
          to: after(),
          extra: { ramp: { from, to: verdict.watts } },
        });
        audited = true;
        startRamp({ from, to: verdict.watts, actor, reason });
        result = {
          ok: true,
          mode: 'erg',
          target: verdict.watts,
          ramping: state.ramping,
          note: `已受理；按 ${RAMP.wattsPerSecond} W/s 逼近目标`,
        };
      }
    } else {
      result = { ok: false, reason: 'mode 必须是 erg、sim 或 stop' };
    }

    if (!result.ok && !audited) {
      // A refusal is not a wire write, but it is still a decision worth a line.
      auditDecision({ actor, reason, cmd: mode || null, from: before, to: after(), ok: false, extra: { rejected: result.reason } });
    }
    logger?.info?.(`ride: ${actor} ${mode} ${result.ok ? 'ok' : `rejected (${result.reason})`}`);
    return result;
  };

  // Heart-rate ladder: its timers live here, its decisions live in lib/ride-core.js.
  let hrTimers = { hrHighSince: 0, hrHardSince: 0, lastDerateAt: 0, derateCount: 0, hrBottomSince: 0 };
  // Four safety watchdogs share one `fired` ledger so each condition acts once.
  let safetyTimers = { fired: {}, cadenceSince: 0, heartbeatSince: 0, metricsSince: 0 };

  const watchdogTick = () => {
    if (disposed) return;
    const now = clock();
    const elapsedSec = state.startedAt === null ? 0 : Math.round((now - state.startedAt) / 1000);

    const hrDecision = watchdogDecision({
      state: { hr: state.hr, mode: state.mode, target: state.target, alert: state.alert },
      settings,
      now,
      timers: hrTimers,
    });
    hrTimers = hrDecision.timers;
    if (hrDecision.alert !== undefined) {
      state.alert = hrDecision.alert === null
        ? null
        : { ...hrDecision.alert, ...(hrDecision.code ? { code: hrDecision.code } : {}) };
    }

    const safety = safetyDecision({
      state: {
        mode: state.mode,
        target: state.target,
        cadence: state.cadence,
        elapsedSec,
        lastEventAt: state.lastEventAt,
        lastMetricsAt: state.lastMetricsAt,
        leaseRenewedAt: state.leaseRenewedAt,
      },
      settings,
      now,
      timers: safetyTimers,
    });
    safetyTimers = safety.timers;
    if (safety.alert !== undefined) {
      const current = state.alert;
      // A warning never talks over a critical that is already on screen.
      if (!(current !== null && current?.level === 'critical' && safety.alert.level === 'warn')) {
        state.alert = safety.alert;
      }
    }

    let stoppedThisTick = false;
    for (const action of safety.actions) {
      if (action.kind === 'kill') {
        // A kill is an action with consequences, so it gets its own line: the stop above
        // says "released", this one says "gave up on the process".
        auditDecision({ actor: 'watchdog', reason: action.reason, cmd: 'kill', from: null, to: null });
        logger?.warn?.(`ride: ${action.reason}`);
        try { child?.kill('SIGTERM'); } catch { /* already gone */ }
        continue;
      }
      stoppedThisTick = true;
      applyCommand({ mode: 'stop', reason: action.reason }, 'watchdog', {
        wire: action.wire,
        dropControl: action.code === 'lease_expired',
        code: action.code,
      });
      // Set after the command: applyCommand clears the marker for any fresh decision,
      // and this one is the decision that just lapsed.
      if (action.code === 'lease_expired') state.leaseExpiredAt = now;
    }
    // One stop per tick is enough: a dead sidecar also starves the metrics watchdog, and
    // two stop commands would only make the audit say the same thing twice.
    if (!stoppedThisTick) {
      if (hrDecision.action === 'stop') {
        applyCommand({ mode: 'stop', reason: hrDecision.reason }, 'watchdog', { code: hrDecision.code });
      } else if (hrDecision.action === 'derate') {
        applyCommand({ mode: 'erg', watts: hrDecision.watts, reason: hrDecision.reason }, 'watchdog');
      }
    }
  };

  /**
   * The control lease. Timer-driven on purpose: renewing inside a tool's execute would
   * tie "the trainer stays under control" to "a model turn happened", which is exactly
   * the failure this closes. Reusing `{"t":"erg","watts":<target>}` keeps the wire
   * protocol unchanged for the sidecar already on the trainer (`{"t":"lease"}` exists in
   * the M4b sidecar, but relying on it would put a T4-side dependency in this task).
   */
  const renewLease = () => {
    if (disposed) return;
    if (state.mode !== 'erg' || state.target === null) return;
    if (!child?.stdin?.writable) return;
    const now = clock();
    // Renew what the trainer is actually being held at. Mid-ramp that is the last step,
    // not the final setpoint: re-asserting the destination would cancel the ramp.
    const target = ramp !== null ? ramp.lastWritten : state.target;
    try {
      dispatch({ t: 'erg', watts: target }, {
        actor: 'host',
        reason: `lease: 续约 ${target} W`,
        from: { target },
        to: { target },
      });
      state.leaseRenewedAt = now;
    } catch (error) {
      logger?.warn?.(`ride: lease renewal failed: ${String(error?.message ?? error)}`);
    }
  };

  const leaseTimer = timers.setInterval(renewLease, LEASE.renewMs);
  const watchdogTimer = timers.setInterval(watchdogTick, WATCHDOG.tickMs);

  ctx.effect(() => () => {
    disposed = true;
    if (timer !== null) timers.clearTimeout(timer);
    timers.clearInterval(leaseTimer);
    timers.clearInterval(watchdogTimer);
    abortRamp('dispose');
    try { dispatch({ t: 'quit' }, { actor: 'host', reason: '插件卸载' }); } catch { /* already gone */ }
    timers.setTimeout(() => { try { child?.kill('SIGTERM'); } catch { /* already gone */ } }, 800);
  });

  /** The three lines #2.4 adds to `ride_status`, in the order the brief lists them. */
  const safetyLines = (s) => {
    const out = [];
    if (s.ramping !== null) {
      out.push(`斜坡 ${s.ramping.from}→${s.ramping.to} W（还差 ${Math.round(s.ramping.etaMs / 1000)} s）`);
    }
    if (s.alert !== null) out.push(`⚠︎ ${s.alert.message}`);
    if (s.lease.expired) {
      out.push('租约已过期');
    } else if (s.mode === 'erg' && s.target !== null) {
      out.push(`租约 ${s.lease.ageSec ?? 0} s 前续约`);
    }
    return out;
  };

  ctx.tools.register({
    name: 'ride_status',
    description: [
      '当前室内骑行状态：功率 W、踏频 rpm、速度、心率 bpm、ERG 目标、模式、本次时长、是否过期（stale）、连接了哪台台子与心率带。',
      '没有连接时返回 bridge 状态与最后一条错误。只读，不改变任何设置。',
    ].join(' '),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', const: true },
          summary: { type: 'string' },
          power: { type: 'number' },
          cadence: { type: 'number' },
          speed: { type: 'number' },
          hr: { type: 'number' },
          mode: { type: 'string' },
          elapsedSec: { type: 'number' },
          control: { type: 'boolean' },
          stale: { type: 'boolean' },
        },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute: async () => {
      const s = snapshot();
      const lines = [];
      if (s.connected.trainer === null && s.connected.strap === null) {
        lines.push(`未连接任何设备（bridge=${s.bridge}）`);
        if (s.lastError) lines.push(`最后错误：${s.lastError.code} ${s.lastError.message}`);
        lines.push(...safetyLines(s));
        return { ok: true, ...s, summary: lines.join('\n') };
      }
      lines.push(`${s.power} W · ${s.cadence} rpm · ${s.speed} km/h · ${s.hr} bpm`);
      const wattsPerKg = settings.weightKg > 0 ? (s.power / settings.weightKg).toFixed(2) : '—';
      lines.push(`功率区 ${s.zones.powerZone || '—'}（${s.zones.ftpPct}% FTP，${wattsPerKg} W/kg）· 心率区 ${s.zones.hrZone || '—'}（${s.zones.hrPct}% HRmax）`);
      lines.push(`模式 ${s.mode}${s.target === null ? '' : `（目标 ${s.target} W）`} · 时长 ${s.elapsedSec}s · 控制权 ${s.control ? '已获得' : '未获得'}`);
      lines.push(`台子 ${s.connected.trainer?.name ?? '—'} · 心率带 ${s.connected.strap?.name ?? '—'}`);
      const w = s.last60s;
      if (w !== null && w.seconds >= 5) {
        lines.push(`最近 60 秒：均 ${w.avgPower} W / 峰 ${w.maxPower} W · 均心率 ${w.avgHr} / 峰 ${w.maxHr} · 踩踏 ${w.pedalingSec}s · 停脚 ${w.coastingSec}s`);
      }
      if (s.stale) lines.push('⚠︎ 数据超过 6 秒没有更新，可能断连');
      if (s.lastError) lines.push(`最后错误：${s.lastError.code} ${s.lastError.message}`);
      lines.push(...safetyLines(s));
      return { ok: true, ...s, summary: lines.join('\n') };
    },
  });

  ctx.tools.register({
    name: 'ride_control',
    description: [
      '切换骑行台的工作模式：erg = ERG 定功率；sim = 模拟坡度（自由骑，飞轮有惯性拖拽，像真车滑行）；stop = 结束本次控制并回到坡度 0。',
      '为什么要 grade 而不是把阻力设 0：阻力 0 会让飞轮几乎没有制动，停止踩踏后疯狂空转；坡度 0 保留模拟阻力，滑行会自然减速。',
      '会被信封夹紧：功率必须在 minPower–maxPower 之间、单次变化不超过 maxStep、坡度在 −10…15%，越界直接拒绝，不会静默改到边界值。',
      'erg 目标按 10 W/s 斜坡逼近，不会一步跳到位；期间收到新的 erg/sim/stop 会立刻中止当前斜坡。',
      '每次调用都记录 reason，便于复盘是谁在什么时候把功率拉上去的。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['erg', 'sim', 'stop'], description: 'erg = 定功率；sim = 坡度模拟；stop = 结束并回到坡度 0。' },
        watts: { type: 'number', description: `目标功率 W（erg 必填），信封 ${settings.minPower}–${settings.maxPower}。` },
        grade: { type: 'number', description: '坡度百分比（sim 必填），−10…15，例如 1.5 表示 1.5%。' },
        reason: { type: 'string', description: '为什么要这样改，写进审计日志。' },
      },
      required: ['mode', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          note: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `ride_control: ${value.mode}${value.target == null ? '' : ` → ${value.target} W`}${value.grade == null ? '' : ` → ${value.grade}%`} · ${value.note ?? ''}`
          : `ride_control 被拒绝：${value.reason ?? 'unknown'}`,
      }],
    },
    execute: async (args) => applyCommand(args, 'agent'),
  });

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/ride/state',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(snapshot()));
      },
    }), 'dsh-ride: GET /ride/state');

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/ride/command',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) { res.writeHead(413); res.end(); return; }
        }
        let input = {};
        try { input = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end('bad json'); return; }
        const result = await applyCommand(input, 'user');
        res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result));
      },
    }), 'dsh-ride: POST /ride/command');

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/ride/config',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' });
          res.end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ settings, ranges: RANGES }));
          return;
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192) { res.writeHead(413); res.end(); return; }
        }
        let patch = {};
        try { patch = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end('bad json'); return; }
        const verdict = validateSettings(patch);
        if (!verdict.ok) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(verdict));
          return;
        }
        settings = { ...settings, ...verdict.value };
        try {
          await mkdir(dirname(SETTINGS_PATH), { recursive: true });
          await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        } catch (error) {
          logger?.warn?.(`ride: could not persist settings: ${String(error)}`);
        }
        // A cda/crr edit only reaches the trainer through this re-send, so it is a real
        // command (audit #11 bypass 2) and gets its own line.
        if (state.mode === 'sim') {
          try {
            dispatch({ t: 'sim', pct: state.grade, crr: settings.crr, cda: settings.cda }, {
              actor: 'user-config',
              reason: `设置变更后重发 sim（cda=${settings.cda}, crr=${settings.crr}）`,
              from: { grade: state.grade },
              to: { grade: state.grade },
            });
          } catch (error) {
            logger?.warn?.(`ride: sim re-send failed: ${String(error?.message ?? error)}`);
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, settings }));
      },
    }), 'dsh-ride: GET/POST /ride/config');
  });

  logger?.debug?.('dsh-ride: host half ready');

  // Test seams only (no runtime consumer): the suite drives ticks by hand so it never
  // sleeps, and asserts on the wire/audit rather than on wall-clock behaviour.
  return { tick: watchdogTick, snapshot, applyCommand, renewLease };
}
