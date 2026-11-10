import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, watchdogDecision } from '../lib/ride-core.js';

// Real-ish epoch: the 30 s derate gate compares against lastDerateAt === 0, which
// only reads as "never" once the clock is a real epoch. Same arithmetic as today.
const BASE = 1_700_000_000_000;
const settings = { ...DEFAULT_SETTINGS, maxHr: 200, hrCeilingPct: 92 }; // ceiling = 184
const zeroTimers = () => ({ hrHighSince: 0, hrHardSince: 0, lastDerateAt: 0 });

const tick = (state, now, timers) => watchdogDecision({ state, settings, now, timers });

test('watchdog: 超过 ceiling 先告警，满 20 秒才降载一次，30 秒节流', () => {
  let timers = zeroTimers();
  let state = { hr: 185, mode: 'erg', target: 200, alert: null };

  let d = tick(state, BASE, timers);
  assert.equal(d.action, 'none');
  assert.deepEqual(d.alert, { level: 'warn', message: '心率 185 超过红线 184（92% HRmax）', at: BASE });
  assert.equal(d.timers.hrHighSince, BASE);
  timers = d.timers;

  d = tick(state, BASE + 19_000, timers);
  assert.equal(d.action, 'none');
  assert.equal(d.alert.level, 'warn');
  assert.equal(d.timers.hrHighSince, BASE);          // 计时不重启
  timers = d.timers;

  d = tick(state, BASE + 20_000, timers);
  assert.equal(d.action, 'derate');
  assert.equal(d.watts, 180);                        // max(40, round(200*0.9))
  assert.equal(d.reason, 'watchdog: HR 185 >= 184，自动降载');
  assert.equal(d.alert.level, 'warn');
  assert.equal(d.timers.lastDerateAt, BASE + 20_000);
  timers = d.timers;

  state = { ...state, target: d.watts };             // host 下发后目标变成 180
  d = tick(state, BASE + 40_000, timers);
  assert.equal(d.action, 'none');                    // 距上次降载只有 20 秒
  assert.equal(d.alert.level, 'warn');
  timers = d.timers;

  d = tick(state, BASE + 50_000, timers);
  assert.equal(d.action, 'derate');
  assert.equal(d.watts, 162);                        // max(40, round(180*0.9))
  assert.equal(d.timers.lastDerateAt, BASE + 50_000);
});

test('watchdog: 降载不越过 minPower，也不会把目标往上抬', () => {
  const state = { hr: 185, mode: 'erg', target: 40, alert: null };
  const timers = { ...zeroTimers(), hrHighSince: BASE };
  const d = tick(state, BASE + 60_000, timers);
  assert.equal(d.action, 'none');
  assert.equal(d.alert.level, 'warn');
  assert.equal(d.timers.lastDerateAt, 0);
});

test('watchdog: 非 erg 或没有目标时不降载', () => {
  const timers = { ...zeroTimers(), hrHighSince: BASE };
  assert.equal(tick({ hr: 185, mode: 'sim', target: 200, alert: null }, BASE + 60_000, timers).action, 'none');
  assert.equal(tick({ hr: 185, mode: 'follow', target: 200, alert: null }, BASE + 60_000, timers).action, 'none');
  assert.equal(tick({ hr: 185, mode: 'erg', target: null, alert: null }, BASE + 60_000, timers).action, 'none');
});

test('watchdog: 到 maxHr 立刻告警，满 10 秒停机', () => {
  let timers = zeroTimers();
  const state = { hr: 200, mode: 'erg', target: 150, alert: null };

  let d = tick(state, BASE, timers);
  assert.equal(d.action, 'none');
  assert.deepEqual(d.alert, { level: 'critical', message: '心率 200 已达最大 200', at: BASE });
  assert.equal(d.timers.hrHardSince, BASE);
  timers = d.timers;

  d = tick(state, BASE + 9_000, timers);
  assert.equal(d.action, 'none');
  assert.equal(d.alert.level, 'critical');
  timers = d.timers;

  d = tick(state, BASE + 10_000, timers);
  assert.equal(d.action, 'stop');
  assert.equal(d.reason, 'watchdog: HR 200 >= maxHr 200');
  assert.deepEqual(d.alert, { level: 'critical', message: '心率红线：已停机并回到坡度 0', at: BASE + 10_000 });
  assert.equal(d.timers.hrHardSince, 0);             // 停机后重新计时
});

test('watchdog: 停机后若心率仍在 maxHr，再过 10 秒会再次停机', () => {
  const state = { hr: 200, mode: 'erg', target: 150, alert: null };
  let timers = zeroTimers();

  let d = tick(state, BASE, timers);
  timers = d.timers;
  d = tick(state, BASE + 10_000, timers);
  assert.equal(d.action, 'stop');
  timers = d.timers;

  d = tick(state, BASE + 12_000, timers);
  assert.equal(d.action, 'none');
  assert.equal(d.timers.hrHardSince, BASE + 12_000);
  timers = d.timers;

  d = tick(state, BASE + 22_000, timers);
  assert.equal(d.action, 'stop');
});

test('watchdog: 非 erg 时到 maxHr 只告警不停机', () => {
  const timers = { ...zeroTimers(), hrHardSince: BASE - 20_000 };
  const d = tick({ hr: 205, mode: 'sim', target: null, alert: null }, BASE, timers);
  assert.equal(d.action, 'none');
  assert.deepEqual(d.alert, { level: 'critical', message: '心率 205 已达最大 200', at: BASE });
  assert.equal(d.timers.hrHardSince, BASE - 20_000);
});

test('watchdog: 回到 ceiling-5 以下清 alert', () => {
  const redline = { level: 'critical', message: '心率红线：已停机并回到坡度 0', at: BASE };
  let timers = { ...zeroTimers(), hrHardSince: 0, hrHighSince: BASE };

  let d = tick({ hr: 179, mode: 'sim', target: null, alert: redline }, BASE + 30_000, timers);
  assert.equal(d.action, 'none');
  assert.equal(d.alert, undefined);                  // 恰好 ceiling-5，不清

  d = tick({ hr: 178, mode: 'sim', target: null, alert: redline }, BASE + 30_000, timers);
  assert.equal(d.action, 'none');
  assert.equal(d.alert, null);                       // 低于 ceiling-5，清掉
  assert.equal(d.timers.hrHighSince, 0);
});

test('watchdog: 已经清了 alert 时不重复清', () => {
  const d = tick({ hr: 120, mode: 'erg', target: 150, alert: null }, BASE, zeroTimers());
  assert.equal(d.action, 'none');
  assert.equal(d.alert, undefined);
});

test('watchdog: 没有心率或 maxHr 非法时清计时且不动 alert', () => {
  const d = tick({ hr: 0, mode: 'erg', target: 150, alert: null }, BASE, {
    hrHighSince: 1, hrHardSince: 2, lastDerateAt: 3,
  });
  assert.equal(d.action, 'none');
  assert.equal(d.alert, undefined);
  // derateCount / hrBottomSince 是 #6 心率梯子新增的两个计时器（形状断言随之更新）
  assert.deepEqual(d.timers, { hrHighSince: 0, hrHardSince: 0, lastDerateAt: 3, derateCount: 0, hrBottomSince: 0 });

  const bad = watchdogDecision({
    state: { hr: 150, mode: 'erg', target: 150, alert: null },
    settings: { ...settings, maxHr: 0 },
    now: BASE,
    timers: { hrHighSince: 1, hrHardSince: 2, lastDerateAt: 3 },
  });
  assert.equal(bad.action, 'none');
  assert.equal(bad.alert, undefined);
  assert.equal(bad.timers.hrHighSince, 0);
  assert.equal(bad.timers.hrHardSince, 0);
});

test('watchdog: 不修改传入的 timers（纯函数）', () => {
  const timers = zeroTimers();
  const snapshot = { ...timers };
  tick({ hr: 185, mode: 'erg', target: 200, alert: null }, BASE, timers);
  tick({ hr: 200, mode: 'erg', target: 200, alert: null }, BASE + 60_000, timers);
  assert.deepEqual(timers, snapshot);
});
