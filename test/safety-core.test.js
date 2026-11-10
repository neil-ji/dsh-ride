import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  rampSteps,
  safetyDecision,
  watchdogDecision,
  leaseExpired,
  WATCHDOG,
  RAMP,
  LEASE,
} from '../lib/ride-core.js';

// A real epoch, so a "never renewed" 0 reads as "long ago" rather than "before the epoch".
const BASE = 1_700_000_000_000;
const settings = { ...DEFAULT_SETTINGS, maxHr: 200, hrCeilingPct: 92 }; // ceiling = 184

/** A state with every watchdog quiet except what a test overrides. */
const quiet = (now, overrides = {}) => ({
  mode: 'erg',
  target: 150,
  cadence: 80,
  elapsedSec: 60,
  lastEventAt: now,
  lastMetricsAt: now,
  leaseRenewedAt: now,
  ...overrides,
});

const zeroTimers = () => ({ fired: {}, cadenceSince: 0, heartbeatSince: 0, metricsSince: 0 });

// ---------------------------------------------------------------------------
// 2.2 ramp: the proposal never moves faster than 10 W/s
// ---------------------------------------------------------------------------

test('rampSteps: 0→50 W 用 10 W/s 得到 5 步，每步 ≤ maxStep，最后一步正好落地', () => {
  const steps = rampSteps(0, 50, { wattsPerSecond: RAMP.wattsPerSecond, tickMs: RAMP.tickMs, maxStep: 50 });
  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map((step) => step.afterMs), [1000, 2000, 3000, 4000, 5000]);
  assert.deepEqual(steps.map((step) => step.watts), [10, 20, 30, 40, 50]);
  for (const step of steps) {
    assert.ok(Math.abs(step.watts) <= 50, '每步不超过 maxStep');
  }
  // 相邻两步之间最多 10 W，即 10 W/s
  let previous = 0;
  for (const step of steps) {
    assert.ok(Math.abs(step.watts - previous) <= 10);
    previous = step.watts;
  }
});

test('rampSteps: 目标相等 = 0 步；目标低于当前按同样的 10 W/s 往下走', () => {
  assert.deepEqual(rampSteps(120, 120), []);
  const down = rampSteps(200, 170, { maxStep: 50 });
  assert.equal(down.length, 3);
  assert.deepEqual(down.map((step) => step.watts), [190, 180, 170]);
  assert.deepEqual(down.map((step) => step.afterMs), [1000, 2000, 3000]);
});

test('rampSteps: maxStep 是每步的硬上限，非数字目标不下发', () => {
  const capped = rampSteps(0, 60, { wattsPerSecond: 25, maxStep: 20 });
  assert.deepEqual(capped.map((step) => step.watts), [20, 40, 60]);
  assert.deepEqual(rampSteps(0, Number.NaN), []);
  assert.deepEqual(rampSteps(0, 'abc'), []);
});

// ---------------------------------------------------------------------------
// 2.1 lease
// ---------------------------------------------------------------------------

test('leaseExpired: 30 s 内不算过期，超过才算；只有 erg 且挂着目标才有租约', () => {
  const base = { mode: 'erg', target: 150, leaseRenewedAt: BASE };
  assert.equal(leaseExpired({ ...base, now: BASE }), false);
  assert.equal(leaseExpired({ ...base, now: BASE + LEASE.ttlMs }), false);
  assert.equal(leaseExpired({ ...base, now: BASE + LEASE.ttlMs + 1 }), true);
  assert.equal(leaseExpired({ ...base, mode: 'sim', now: BASE + 60_000 }), false);
  assert.equal(leaseExpired({ ...base, target: null, now: BASE + 60_000 }), false);
  assert.equal(leaseExpired({ mode: 'erg', target: 150, leaseRenewedAt: 0, now: BASE }), true);
});

// ---------------------------------------------------------------------------
// 2.3 四条看门狗（纯函数部分）
// ---------------------------------------------------------------------------

test('看门狗·租约：31 s 不续约 → 一次 stop（wire stop + critical），再推到 60 s 仍是那一次', () => {
  let timers = zeroTimers();
  let decision = safetyDecision({ state: quiet(BASE, { now: BASE }), settings, now: BASE, timers });
  assert.deepEqual(decision.actions, []);

  const expired = BASE + 31_000;
  decision = safetyDecision({
    state: quiet(expired, { leaseRenewedAt: BASE }),
    settings,
    now: expired,
    timers,
  });
  timers = decision.timers;
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].kind, 'stop');
  assert.equal(decision.actions[0].code, 'lease_expired');
  assert.equal(decision.actions[0].wire, 'stop');
  assert.match(decision.actions[0].reason, /^lease_expired: 31 s 未续约（租约 30 s）$/);
  assert.equal(decision.alert.level, 'critical');
  assert.equal(decision.alert.code, 'lease_expired');

  const later = BASE + 60_000;
  decision = safetyDecision({
    state: quiet(later, { leaseRenewedAt: BASE }),
    settings,
    now: later,
    timers,
  });
  assert.deepEqual(decision.actions, []);          // 幂等：条件持续为真也只动作一次
});

test('看门狗·租约：续约后复位，可以再次触发', () => {
  const expired = BASE + 31_000;
  let decision = safetyDecision({
    state: quiet(expired, { leaseRenewedAt: BASE }), settings, now: expired, timers: zeroTimers(),
  });
  assert.equal(decision.actions.length, 1);
  const renewed = expired + 1_000;
  decision = safetyDecision({
    state: quiet(renewed, { leaseRenewedAt: renewed }), settings, now: renewed, timers: decision.timers,
  });
  assert.deepEqual(decision.actions, []);
  const expiredAgain = renewed + 31_000;
  decision = safetyDecision({
    state: quiet(expiredAgain, { leaseRenewedAt: renewed }), settings, now: expiredAgain, timers: decision.timers,
  });
  assert.equal(decision.actions.length, 1);
});

test('看门狗·心跳：恰好 5 s 不动，6 s 先 stop，7 s 之后只 kill 一次；有事件即复位', () => {
  // 恰好 5 s：不算「超过」
  let decision = safetyDecision({
    state: quiet(BASE + WATCHDOG.heartbeatMs, { lastEventAt: BASE }), settings, now: BASE + WATCHDOG.heartbeatMs, timers: zeroTimers(),
  });
  assert.deepEqual(decision.actions, []);

  const six = BASE + 6_000;
  decision = safetyDecision({ state: quiet(six, { lastEventAt: BASE }), settings, now: six, timers: decision.timers });
  let timers = decision.timers;
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].code, 'bridge_heartbeat');
  assert.equal(decision.actions[0].kind, 'stop');

  const eight = BASE + 8_000;
  decision = safetyDecision({ state: quiet(eight, { lastEventAt: BASE }), settings, now: eight, timers });
  timers = decision.timers;
  assert.deepEqual(decision.actions.map((action) => action.code), ['bridge_kill']);
  assert.equal(decision.actions[0].kind, 'kill');

  const eleven = BASE + 11_000;
  decision = safetyDecision({ state: quiet(eleven, { lastEventAt: BASE }), settings, now: eleven, timers });
  assert.deepEqual(decision.actions, []);          // kill 只发一次

  // 事件回来了：两个标记都复位，再次静默会重新动作
  const fresh = BASE + 12_000;
  decision = safetyDecision({ state: quiet(fresh), settings, now: fresh, timers: decision.timers });
  assert.deepEqual(decision.actions, []);
  const again = fresh + 6_000;
  decision = safetyDecision({
    state: quiet(again, { lastEventAt: fresh }), settings, now: again, timers: decision.timers,
  });
  assert.deepEqual(decision.actions.map((action) => action.code), ['bridge_heartbeat']);
});

test('看门狗·数据过期：心跳还在、metrics 停了 10 s → 一次 stop；metrics 恢复即复位', () => {
  const ten = BASE + WATCHDOG.metricsStaleMs;
  let decision = safetyDecision({
    state: quiet(ten, { lastMetricsAt: BASE }), settings, now: ten, timers: zeroTimers(),
  });
  assert.deepEqual(decision.actions, []);          // 恰好 10 s 不算「超过」

  const eleven = BASE + 11_000;
  decision = safetyDecision({ state: quiet(eleven, { lastMetricsAt: BASE }), settings, now: eleven, timers: decision.timers });
  let timers = decision.timers;
  assert.deepEqual(decision.actions.map((action) => action.code), ['metrics_stale']);
  assert.equal(decision.alert.level, 'critical');

  decision = safetyDecision({ state: quiet(eleven + 5_000, { lastMetricsAt: BASE }), settings, now: eleven + 5_000, timers });
  assert.deepEqual(decision.actions, []);

  // metrics 回来了 → 复位；再停 11 s → 再次触发
  const recovered = eleven + 6_000;
  decision = safetyDecision({ state: quiet(recovered), settings, now: recovered, timers: decision.timers });
  assert.deepEqual(decision.actions, []);
  const again = recovered + 11_000;
  decision = safetyDecision({
    state: quiet(again, { lastMetricsAt: recovered }), settings, now: again, timers: decision.timers,
  });
  assert.deepEqual(decision.actions.map((action) => action.code), ['metrics_stale']);
});

test('看门狗·踏频归零：0 rpm 满 20 s → 一次 stop + warn；中间恢复过就重新计时', () => {
  let decision = safetyDecision({ state: quiet(BASE, { cadence: 0 }), settings, now: BASE, timers: zeroTimers() });
  let timers = decision.timers;
  assert.equal(timers.cadenceSince, BASE);
  assert.deepEqual(decision.actions, []);

  const nineteen = BASE + WATCHDOG.cadenceZeroMs - 1;
  decision = safetyDecision({ state: quiet(nineteen, { cadence: 0 }), settings, now: nineteen, timers });
  timers = decision.timers;
  assert.deepEqual(decision.actions, []);          // 差 1 ms 不动作

  const twenty = BASE + WATCHDOG.cadenceZeroMs;
  decision = safetyDecision({ state: quiet(twenty, { cadence: 0 }), settings, now: twenty, timers });
  timers = decision.timers;
  assert.deepEqual(decision.actions.map((action) => action.code), ['cadence_zero']);
  assert.equal(decision.alert.level, 'warn');
  assert.match(decision.alert.message, /下车或掉链/);

  // 复位：踩一脚就清零（本轮已 fired，但计时器归零；条件再持续会重新计时）
  decision = safetyDecision({ state: quiet(twenty + 1_000, { cadence: 85 }), settings, now: twenty + 1_000, timers });
  assert.equal(decision.timers.cadenceSince, 0);
  decision = safetyDecision({
    state: quiet(twenty + 2_000, { cadence: 0 }), settings, now: twenty + 2_000, timers: decision.timers,
  });
  assert.equal(decision.timers.cadenceSince, twenty + 2_000);
  assert.deepEqual(decision.actions, []);          // 重新计时的第一跳不动作
});

test('看门狗·踏频归零：非 erg、或目标为 0 时不管', () => {
  const now = BASE + 60_000;
  for (const overrides of [{ mode: 'sim' }, { mode: 'follow' }, { target: 0 }, { target: null }]) {
    const decision = safetyDecision({
      state: quiet(now, { cadence: 0, ...overrides }), settings, now, timers: zeroTimers(),
    });
    assert.deepEqual(decision.actions, []);
    assert.equal(decision.timers.cadenceSince, 0);
  }
});

test('看门狗·maxDuration：elapsedSec 推过 maxDuration*60 才停，且只停一次；回落即复位', () => {
  const limit = settings.maxDuration * 60;         // 90 分钟 = 5400 s
  let decision = safetyDecision({
    state: quiet(BASE, { mode: 'sim', target: null, elapsedSec: limit }), settings, now: BASE, timers: zeroTimers(),
  });
  assert.deepEqual(decision.actions, []);          // 恰好到点是允许的

  decision = safetyDecision({
    state: quiet(BASE + 1_000, { mode: 'sim', target: null, elapsedSec: limit + 1 }), settings, now: BASE + 1_000, timers: decision.timers,
  });
  let timers = decision.timers;
  assert.deepEqual(decision.actions.map((action) => action.code), ['max_duration']);
  assert.equal(decision.alert.level, 'warn');
  assert.match(decision.alert.message, /到点收工/);

  decision = safetyDecision({
    state: quiet(BASE + 2_000, { mode: 'sim', target: null, elapsedSec: limit + 2 }), settings, now: BASE + 2_000, timers,
  });
  assert.deepEqual(decision.actions, []);

  decision = safetyDecision({
    state: quiet(BASE + 3_000, { mode: 'sim', target: null, elapsedSec: 10 }), settings, now: BASE + 3_000, timers: decision.timers,
  });
  assert.equal(decision.timers.fired.duration, false);   // 回落到阈值以下 → 复位
});

test('多个看门狗同时为真时一跳只发一次 stop，取最具体的那一条', () => {
  const now = BASE + 31_000;
  const decision = safetyDecision({
    state: quiet(now, { lastEventAt: BASE, lastMetricsAt: BASE, leaseRenewedAt: BASE }),
    settings,
    now,
    timers: zeroTimers(),
  });
  const stops = decision.actions.filter((action) => action.kind === 'stop');
  assert.equal(stops.length, 1);                    // 只有一条 stop，不重复下发
  assert.equal(stops[0].code, 'lease_expired');      // 取最具体的那一条
  assert.match(stops[0].reason, /^lease_expired: /);
  // kill 是另一条动作：同一次静默里边车既没续约也没说话，SIGTERM 该发
  assert.deepEqual(decision.actions.filter((a) => a.kind === 'kill').map((a) => a.code), ['bridge_kill']);
});

test('看门狗不修改传入的 timers（纯函数）', () => {
  const timers = zeroTimers();
  const snapshot = JSON.parse(JSON.stringify(timers));
  safetyDecision({ state: quiet(BASE, { cadence: 0 }), settings, now: BASE, timers });
  safetyDecision({ state: quiet(BASE + 31_000, { lastEventAt: BASE }), settings, now: BASE + 31_000, timers });
  assert.deepEqual(timers, snapshot);
});

// ---------------------------------------------------------------------------
// 2.6 #6 心率梯子：ceiling 20 s 降 10% → 最多 2 次 → 触底 30 s 停；maxHr 10 s 停
// ---------------------------------------------------------------------------

test('心率梯子：ceiling 持续 20 s 降一次 10%，第 2 次之后触底，30 s 内 stop（不再静默）', () => {
  let timers = { hrHighSince: 0, hrHardSince: 0, lastDerateAt: 0, derateCount: 0, hrBottomSince: 0 };
  let target = 200;

  let d = watchdogDecision({ state: { hr: 185, mode: 'erg', target, alert: null }, settings, now: BASE, timers });
  timers = d.timers;
  assert.equal(d.action, 'none');
  assert.equal(d.code, 'hr_ceiling');
  assert.equal(d.timers.hrHighSince, BASE);

  d = watchdogDecision({ state: { hr: 185, mode: 'erg', target, alert: null }, settings, now: BASE + 20_000, timers });
  timers = d.timers;
  assert.equal(d.action, 'derate');
  assert.equal(d.watts, 180);                      // 200 × 0.9
  assert.equal(d.timers.derateCount, 1);
  target = d.watts;

  d = watchdogDecision({ state: { hr: 185, mode: 'erg', target, alert: null }, settings, now: BASE + 50_000, timers });
  timers = d.timers;
  assert.equal(d.action, 'derate');
  assert.equal(d.watts, 162);                      // 180 × 0.9
  assert.equal(d.timers.derateCount, 2);
  target = d.watts;

  // 已降满 2 次：不再降载，开始 30 s 触底计时
  d = watchdogDecision({ state: { hr: 185, mode: 'erg', target, alert: null }, settings, now: BASE + 51_000, timers });
  timers = d.timers;
  assert.equal(d.action, 'none');
  assert.equal(d.code, 'hr_bottom');
  assert.equal(d.timers.hrBottomSince, BASE + 51_000);

  d = watchdogDecision({ state: { hr: 185, mode: 'erg', target, alert: null }, settings, now: BASE + 80_999, timers });
  timers = d.timers;
  assert.equal(d.action, 'none');                  // 差 1 ms，还不许停

  d = watchdogDecision({ state: { hr: 185, mode: 'erg', target, alert: null }, settings, now: BASE + 81_000, timers });
  assert.equal(d.action, 'stop');
  assert.equal(d.code, 'hr_bottom');
  assert.equal(d.alert.level, 'critical');
  assert.match(d.reason, /降载到底/);
});

test('心率梯子：已在 minPower 仍徘徊在 ceiling…maxHr → 30 s 后 stop，而不是什么都不做', () => {
  const timers = { hrHighSince: BASE, hrHardSince: 0, lastDerateAt: 0, derateCount: 0, hrBottomSince: 0 };
  let d = watchdogDecision({
    state: { hr: 186, mode: 'erg', target: settings.minPower, alert: null }, settings, now: BASE + 60_000, timers,
  });
  assert.equal(d.action, 'none');
  assert.equal(d.timers.hrBottomSince, BASE + 60_000);

  d = watchdogDecision({
    state: { hr: 186, mode: 'erg', target: settings.minPower, alert: null },
    settings,
    now: BASE + 90_000,
    timers: d.timers,
  });
  assert.equal(d.action, 'stop');
  assert.equal(d.code, 'hr_bottom');
});

test('心率梯子：maxHr 持续 10 s 直接 stop（保留 M3 的保守时序）', () => {
  let timers = { hrHighSince: 0, hrHardSince: 0, lastDerateAt: 0, derateCount: 0, hrBottomSince: 0 };
  let d = watchdogDecision({ state: { hr: 200, mode: 'erg', target: 150, alert: null }, settings, now: BASE, timers });
  timers = d.timers;
  assert.equal(d.action, 'none');
  d = watchdogDecision({ state: { hr: 200, mode: 'erg', target: 150, alert: null }, settings, now: BASE + 9_999, timers });
  assert.equal(d.action, 'none');
  d = watchdogDecision({ state: { hr: 200, mode: 'erg', target: 150, alert: null }, settings, now: BASE + 10_000, timers: d.timers });
  assert.equal(d.action, 'stop');
  assert.equal(d.code, 'hr_max');
});
