import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  RANGES,
  clampGrade,
  clampPower,
  summarize,
  validateSettings,
  zones,
} from '../lib/ride-core.js';

const settings = { ...DEFAULT_SETTINGS };

test('DEFAULT_SETTINGS 原值照抄', () => {
  assert.deepEqual(settings, {
    weightKg: 75, ftp: 200, maxHr: 180, hrCeilingPct: 92,
    cda: 0.51, crr: 0.004, defaultGrade: 0,
    minPower: 40, maxPower: 250, maxStep: 50,
    maxDuration: 90,
  });
});

test('RANGES 原值照抄', () => {
  assert.deepEqual(RANGES, {
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
  });
});

test('validateSettings 接受合法补丁并保留 3 位小数', () => {
  const verdict = validateSettings({ maxHr: 181.23456, ftp: 210 });
  assert.deepEqual(verdict, { ok: true, value: { ftp: 210, maxHr: 181.235 } });
});

test('validateSettings 接受完整默认值', () => {
  const verdict = validateSettings(DEFAULT_SETTINGS);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.value, settings);
});

test('validateSettings 忽略未知键', () => {
  const verdict = validateSettings({ ftp: 300, nonsense: 1, mode: 'erg' });
  assert.deepEqual(verdict, { ok: true, value: { ftp: 300 } });
});

test('validateSettings 接受空补丁与边界值', () => {
  assert.deepEqual(validateSettings({}), { ok: true, value: {} });
  assert.deepEqual(validateSettings({ hrCeilingPct: 100 }), { ok: true, value: { hrCeilingPct: 100 } });
  assert.deepEqual(validateSettings({ minPower: 0 }), { ok: true, value: { minPower: 0 } });
  assert.deepEqual(validateSettings({ defaultGrade: -5 }), { ok: true, value: { defaultGrade: -5 } });
});

test('validateSettings 拒绝越界并给中文 reason', () => {
  assert.deepEqual(validateSettings({ maxHr: 260 }), { ok: false, reason: 'maxHr 必须在 100…220 之间' });
  assert.deepEqual(validateSettings({ minPower: -1 }), { ok: false, reason: 'minPower 必须在 0…400 之间' });
  assert.deepEqual(validateSettings({ maxStep: 5 }), { ok: false, reason: 'maxStep 必须在 10…200 之间' });
  assert.deepEqual(validateSettings({ cda: 0.81 }), { ok: false, reason: 'cda 必须在 0.2…0.8 之间' });
  assert.deepEqual(validateSettings({ hrCeilingPct: 100.001 }), { ok: false, reason: 'hrCeilingPct 必须在 80…100 之间' });
});

test('validateSettings 拒绝非数字', () => {
  assert.deepEqual(validateSettings({ ftp: 'abc' }), { ok: false, reason: 'ftp 必须在 50…600 之间' });
  assert.deepEqual(validateSettings({ weightKg: Number.NaN }), { ok: false, reason: 'weightKg 必须在 30…200 之间' });
});

test('validateSettings 拒绝 minPower >= maxPower', () => {
  assert.deepEqual(validateSettings({ minPower: 300, maxPower: 250 }), { ok: false, reason: 'minPower 必须小于 maxPower' });
  assert.deepEqual(validateSettings({ minPower: 250, maxPower: 250 }), { ok: false, reason: 'minPower 必须小于 maxPower' });
  // 只给一个键时无法比较，不触发交叉校验
  assert.deepEqual(validateSettings({ minPower: 300 }), { ok: true, value: { minPower: 300 } });
});

test('clampPower 正常通过并四舍五入到整瓦', () => {
  assert.deepEqual(clampPower(150.4, { settings, currentTarget: 130 }), { ok: true, watts: 150 });
  assert.deepEqual(clampPower(150.6, { settings, currentTarget: 130 }), { ok: true, watts: 151 });
  assert.deepEqual(clampPower('150', { settings, currentTarget: null }), { ok: true, watts: 150 });
});

test('clampPower 越界直接拒绝，不夹到边界', () => {
  assert.deepEqual(clampPower(30, { settings, currentTarget: null }), {
    ok: false,
    reason: '目标 30 W 超出信封 40–250 W，已拒绝（不会自动夹到边界，避免你以为设定生效了）',
  });
  assert.deepEqual(clampPower(251, { settings, currentTarget: null }), {
    ok: false,
    reason: '目标 251 W 超出信封 40–250 W，已拒绝（不会自动夹到边界，避免你以为设定生效了）',
  });
});

test('clampPower 超过 maxStep 拒绝', () => {
  assert.deepEqual(clampPower(200, { settings, currentTarget: 140 }), {
    ok: false,
    reason: '一次调整 140 → 200 W 超过 50 W，请分步下发',
  });
});

test('clampPower 非数字拒绝', () => {
  assert.deepEqual(clampPower('abc', { settings, currentTarget: 100 }), { ok: false, reason: 'watts must be a number' });
  assert.deepEqual(clampPower(undefined, { settings, currentTarget: null }), { ok: false, reason: 'watts must be a number' });
  assert.deepEqual(clampPower(Number.NaN, { settings, currentTarget: null }), { ok: false, reason: 'watts must be a number' });
});

test('clampPower 恰好边界与恰好步长通过', () => {
  assert.deepEqual(clampPower(40, { settings, currentTarget: null }), { ok: true, watts: 40 });
  assert.deepEqual(clampPower(250, { settings, currentTarget: null }), { ok: true, watts: 250 });
  assert.deepEqual(clampPower(100, { settings, currentTarget: 50 }), { ok: true, watts: 100 });
  assert.deepEqual(clampPower(100, { settings, currentTarget: 50.4 }), { ok: true, watts: 100 });
  assert.deepEqual(clampPower(101, { settings, currentTarget: 50 }), {
    ok: false,
    reason: '一次调整 50 → 101 W 超过 50 W，请分步下发',
  });
});

test('clampGrade 正常、取 1 位小数、越界与非数字', () => {
  assert.deepEqual(clampGrade(1.55), { ok: true, grade: 1.6 });
  assert.deepEqual(clampGrade(3.333), { ok: true, grade: 3.3 });
  assert.deepEqual(clampGrade(-10), { ok: true, grade: -10 });
  assert.deepEqual(clampGrade(15), { ok: true, grade: 15 });
  assert.deepEqual(clampGrade(15.1), { ok: false, reason: '坡度 15.1% 超出 −10…15%，已拒绝' });
  assert.deepEqual(clampGrade(-10.1), { ok: false, reason: '坡度 -10.1% 超出 −10…15%，已拒绝' });
  assert.deepEqual(clampGrade('abc'), { ok: false, reason: 'grade must be a number' });
  assert.deepEqual(clampGrade(undefined), { ok: false, reason: 'grade must be a number' });
});

test('zones 功率分档边界 55/76/91/106/121 %FTP', () => {
  const at = (power) => zones({ power, hr: 0, settings: { ...settings, ftp: 200 } });
  assert.equal(at(0).powerZone, 0);
  assert.equal(at(109).powerZone, 1);   // 54.5%
  assert.equal(at(110).powerZone, 2);   // 55%
  assert.equal(at(151).powerZone, 2);   // 75.5%
  assert.equal(at(152).powerZone, 3);   // 76%
  assert.equal(at(181).powerZone, 3);   // 90.5%
  assert.equal(at(182).powerZone, 4);   // 91%
  assert.equal(at(211).powerZone, 4);   // 105.5%
  assert.equal(at(212).powerZone, 5);   // 106%
  assert.equal(at(241).powerZone, 5);   // 120.5%
  assert.equal(at(242).powerZone, 6);   // 121%
  assert.equal(at(110).ftpPct, 55);
});

test('zones 心率分档边界 60/70/80/90 %HRmax', () => {
  const at = (hr) => zones({ power: 0, hr, settings: { ...settings, maxHr: 200 } });
  assert.equal(at(0).hrZone, 0);
  assert.equal(at(119).hrZone, 1);   // 59.5%
  assert.equal(at(120).hrZone, 2);   // 60%
  assert.equal(at(139).hrZone, 2);   // 69.5%
  assert.equal(at(140).hrZone, 3);   // 70%
  assert.equal(at(159).hrZone, 3);   // 79.5%
  assert.equal(at(160).hrZone, 4);   // 80%
  assert.equal(at(179).hrZone, 4);   // 89.5%
  assert.equal(at(180).hrZone, 5);   // 90%
  assert.equal(at(180).hrPct, 90);
});

test('zones ftp/maxHr 为 0 时不除零', () => {
  const value = zones({ power: 150, hr: 130, settings: { ...settings, ftp: 0, maxHr: 0 } });
  assert.deepEqual(value, { powerZone: 1, ftpPct: 0, hrZone: 1, hrPct: 0 });
});

test('summarize 无数据返回 null', () => {
  assert.equal(summarize([], 60_000, 1_000_000), null);
  assert.equal(summarize([{ t: 1, p: 100, c: 80, s: 30, hr: 120 }], 60_000, 1_000_000), null);
});

test('summarize 窗口内 moving + 停脚', () => {
  const rows = [
    { t: 970_000, p: 100, c: 80, s: 30, hr: 120 },
    { t: 980_000, p: 150, c: 85, s: 32, hr: 130 },
    { t: 990_000, p: 0, c: 0, s: 28, hr: 140 },
  ];
  assert.deepEqual(summarize(rows, 60_000, 1_000_000), {
    seconds: 30,
    avgPower: 125,
    maxPower: 150,
    avgHr: 130,
    maxHr: 140,
    pedalingSec: 2,
    coastingSec: 20,
  });
});

test('summarize 全程没踩踏时 coastingSec 取行数', () => {
  const rows = [
    { t: 990_000, p: 0, c: 0, s: 20, hr: 100 },
    { t: 995_000, p: 0, c: 0, s: 18, hr: 110 },
  ];
  assert.deepEqual(summarize(rows, 60_000, 1_000_000), {
    seconds: 10,
    avgPower: 0,
    maxPower: 0,
    avgHr: 105,
    maxHr: 110,
    pedalingSec: 0,
    coastingSec: 2,
  });
});

test('summarize 无心率时 avgHr 为 0', () => {
  const rows = [{ t: 995_000, p: 0, c: 0, s: 0, hr: 0 }];
  const value = summarize(rows, 60_000, 1_000_000);
  assert.equal(value.avgHr, 0);
  assert.equal(value.maxHr, 0);
  assert.equal(value.pedalingSec, 0);
  assert.equal(value.coastingSec, 1);
});
