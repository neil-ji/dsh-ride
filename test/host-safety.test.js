/**
 * Host-half safety, end to end but never on a wire: a fake sidecar process, a fake
 * cordis ctx and a virtual clock. Nothing here sleeps, spawns the real bridge, or
 * touches ~/.dsh/ride — HOME is redirected to a temp dir before index.js is imported,
 * so every audit line lands in the throwaway tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 1_700_000_000_000;

const HOME = await mkdtemp(join(tmpdir(), 'dsh-ride-t3-'));
process.env.HOME = HOME;                       // before index.js reads homedir()
const { apply, flushAudit } = await import('../index.js');

const AUDIT_DIR = join(HOME, '.dsh', 'ride');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** A virtual clock plus setInterval/setTimeout that only fire when `advance` says so. */
function makeVirtualTime(start) {
  let now = start;
  let seq = 0;
  const intervals = new Map();
  const timeouts = new Map();

  const timers = {
    setInterval: (fn, ms) => { const id = ++seq; intervals.set(id, { fn, ms, next: now + ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: (fn, ms) => { const id = ++seq; timeouts.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
  };

  const nextEvent = () => {
    let best = null;
    for (const [id, job] of timeouts) if (best === null || job.at < best.at) best = { kind: 'timeout', id, at: job.at };
    for (const [id, job] of intervals) if (best === null || job.next < best.at) best = { kind: 'interval', id, at: job.next };
    return best;
  };

  return {
    now: () => now,
    set: (t) => { now = t; },
    advance: (ms) => {
      const target = now + ms;
      for (let guard = 0; guard < 200_000; guard += 1) {
        const next = nextEvent();
        if (next === null || next.at > target) break;
        now = next.at;
        if (next.kind === 'timeout') {
          const job = timeouts.get(next.id);
          timeouts.delete(next.id);
          job.fn();
        } else {
          const job = intervals.get(next.id);
          job.next += job.ms;
          job.fn();
        }
      }
      now = target;
    },
    timers,
    pending: () => ({ intervals: intervals.size, timeouts: timeouts.size }),
  };
}

/** A fake cordis ctx: collects tools, effects and web routes, never touches DSH. */
function makeFakeCtx() {
  const tools = [];
  const handlers = new Map();
  const disposers = [];
  const logger = { info() {}, warn() {}, debug() {} };

  const effect = (fn) => {
    const dispose = fn();
    disposers.push(dispose);
    return () => { dispose?.(); };
  };

  const ctx = {
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
    logger,
    effect,
    inject: (names, callback) => {
      assert.deepEqual(names, ['webServer']);
      callback({
        effect,
        webServer: { register: (route) => { handlers.set(route.path, route); return () => {}; } },
      });
    },
  };

  return {
    ctx,
    tools,
    handlers,
    dispose: () => { for (const dispose of disposers) { try { dispose?.(); } catch { /* already gone */ } } },
  };
}

/** A fake sidecar: recorded stdin writes with a timestamp, counted kills. */
function makeFakeChild(now) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writable = true;
  const writes = [];
  stdin.write = (chunk) => {
    const raw = String(chunk).trim();
    if (raw !== '') {
      let cmd = null;
      try { cmd = JSON.parse(raw); } catch { /* keep raw only */ }
      writes.push({ at: now(), raw, cmd });
    }
    return true;
  };
  const child = {
    stdout,
    stderr,
    stdin,
    writes,
    kills: [],
    exitHandlers: [],
    on: (event, handler) => { if (event === 'exit') child.exitHandlers.push(handler); return child; },
    kill: (signal) => { child.kills.push(signal ?? 'SIGTERM'); },
  };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  return child;
}

async function boot(start = BASE) {
  await rm(join(HOME, '.dsh', 'ride', 'config.json'), { force: true });
  await rm(join(HOME, '.dsh', 'ride', 'session.json'), { force: true });
  const vt = makeVirtualTime(start);
  const fake = makeFakeCtx();
  const child = makeFakeChild(vt.now);
  let spawned;
  const spawnedPromise = new Promise((resolve) => { spawned = resolve; });
  const app = apply(fake.ctx, {
    now: vt.now,
    timers: vt.timers,
    spawnImpl: () => { spawned(); return child; },
    logger: { info() {}, warn() {}, debug() {} },
  });
  await spawnedPromise;
  return {
    vt,
    fake,
    child,
    app,
    /** Feed one sidecar event line, the way the real process would. */
    send: (event) => child.stdout.emit('data', `${JSON.stringify(event)}\n`),
  };
}

/** Read every audit line written since the process started. A few loop turns let the
 *  fire-and-forget appendFile settle; this is IO settling, not a behaviour sleep. */
async function auditLines() {
  await flushAudit();                            // deterministic, not a sleep
  let files = [];
  try { files = await readdir(AUDIT_DIR); } catch { return []; }
  const out = [];
  for (const name of files.filter((file) => file.startsWith('audit-')).sort()) {
    const text = await readFile(join(AUDIT_DIR, name), 'utf8');
    for (const line of text.split('\n')) if (line.trim() !== '') out.push(JSON.parse(line));
  }
  return out;
}

/** Cursor into the shared audit log, so one test only judges its own lines. */
const auditMark = async () => (await auditLines()).length;
const auditSince = async (mark) => (await auditLines()).slice(mark);

const watchdogLines = (lines, pattern) => lines.filter((line) => line.actor === 'watchdog' && pattern.test(line.reason));
const ergWrites = (child) => child.writes.filter((write) => write.cmd?.t === 'erg');

function makeRes() {
  const res = {
    status: 0,
    body: '',
    writeHead(code, headers) { res.status = code; res.headers = headers ?? {}; return res; },
    end(body) { if (body !== undefined) res.body += String(body); },
  };
  return res;
}

function makeReq(body, method = 'POST') {
  return {
    method,
    async *[Symbol.asyncIterator]() { yield JSON.stringify(body); },
  };
}

// ---------------------------------------------------------------------------
// 2.1 控制租约：定时器续约，与模型回合无关
// ---------------------------------------------------------------------------

test('租约：erg 之后 11 s 内至少一条续约命令到达边车，且状态没被判过期', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  send({ t: 'metrics', power: 100, cadence: 80, hr: 120 });
  await app.applyCommand({ mode: 'erg', watts: 50, reason: '测试：建立租约' }, 'agent');

  // 每秒一条 metrics：心跳与数据过期两条看门狗保持安静，只有租约定时器在动。
  for (let second = 1; second <= 11; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 100, cadence: 80, hr: 120 });
  }

  const ergs = ergWrites(child);
  assert.deepEqual(ergs.slice(0, 5).map((write) => write.cmd.watts), [10, 20, 30, 40, 50]); // 斜坡
  const renewals = ergs.filter((write) => write.at - BASE >= 10_000 && write.cmd.watts === 50);
  assert.ok(renewals.length >= 1, `11 s 内应至少有一次续约，实际 ${renewals.length}`);

  const snap = app.snapshot();
  assert.equal(snap.mode, 'erg');
  assert.equal(snap.lease.expired, false);
  assert.ok(snap.lease.ageSec !== null && snap.lease.ageSec <= 10);

  const renewalsAudited = (await auditLines()).filter((line) => line.actor === 'host' && /^lease: 续约 50 W$/.test(line.reason));
  assert.ok(renewalsAudited.length >= 1, '续约也要留痕');
});

test('斜坡：中途来新的 erg → 旧斜坡立即作废，不会两个斜坡并行', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  const tick = () => send({ t: 'metrics', power: 60, cadence: 80, hr: 120 });
  tick();
  await app.applyCommand({ mode: 'erg', watts: 50, reason: '测试：斜坡 A' }, 'agent');
  for (let second = 1; second <= 2; second += 1) { vt.advance(1_000); tick(); }
  assert.deepEqual(ergWrites(child).map((write) => write.cmd.watts), [10, 20]);

  await app.applyCommand({ mode: 'erg', watts: 100, reason: '测试：斜坡 B' }, 'agent');
  for (let second = 1; second <= 10; second += 1) { vt.advance(1_000); tick(); }

  // 只看 10 s 之前：10 s 那一下是租约定时器的续约，不是斜坡的一步。
  const steps = ergWrites(child).filter((write) => write.at <= BASE + 9_000).map((write) => write.cmd.watts);
  assert.deepEqual(steps, [10, 20, 30, 40, 50, 60, 70, 80, 90]);  // B 从 20 W 接着走
  const stamps = ergWrites(child).filter((write) => write.at <= BASE + 9_000).map((write) => write.at);
  assert.equal(new Set(stamps).size, stamps.length, '同一秒只许写一次（两个斜坡并行会在同一毫秒各写一次）');
});

test('maxDuration：POST /ride/config 能改（现有校验通道），改小后到点停机', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  const handler = fake.handlers.get('/ride/config');
  const res = makeRes();
  await handler.handler(makeReq({ maxDuration: 5 }), res);
  assert.equal(res.status, 200);
  assert.equal(app.snapshot().settings.maxDuration, 5);

  // 越界由同一条校验通道拒绝
  const bad = makeRes();
  await handler.handler(makeReq({ maxDuration: 999 }), bad);
  assert.equal(bad.status, 409);

  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  await app.applyCommand({ mode: 'sim', grade: 1, reason: '测试：配置时长' }, 'agent');
  vt.set(BASE + 5 * 60_000 + 1_000);
  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  app.tick();
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 1);
  assert.equal(app.snapshot().alert.code, 'max_duration');
});

test('租约：31 s 不续约 → 恰一次 stop（wire stop）+ 审计 actor=watchdog + critical，60 s 仍只有一次', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  const mark = await auditMark();
  send({ t: 'metrics', power: 100, cadence: 80, hr: 120 });
  await app.applyCommand({ mode: 'erg', watts: 100, reason: '测试：租约过期' }, 'agent');
  const writesBefore = child.writes.length;

  // 事件循环被节流到停摆：时钟跳过去，那个 10 s 续约定时器一次都没有跑。
  vt.set(BASE + 31_000);
  send({ t: 'metrics', power: 100, cadence: 80, hr: 120 });   // 只有租约该报警
  app.tick();

  const stopWrites = child.writes.slice(writesBefore).filter((write) => write.cmd.t === 'stop');
  assert.equal(stopWrites.length, 1);
  assert.equal(stopWrites[0].at, BASE + 31_000);

  const snap = app.snapshot();
  assert.equal(snap.mode, 'sim');
  assert.equal(snap.target, null);
  assert.equal(snap.grade, 0);
  assert.equal(snap.control, false);                 // 本地也不再声称握着控制权
  assert.equal(snap.alert.level, 'critical');
  assert.equal(snap.alert.code, 'lease_expired');
  assert.match(snap.alert.message, /控制租约已过期/);
  assert.equal(snap.lease.expired, true);
  assert.match((await fake.tools.find((tool) => tool.name === 'ride_status').execute({})).summary, /租约已过期/);

  let lines = await auditSince(mark);
  let leaseLines = watchdogLines(lines, /^lease_expired: /);
  assert.equal(leaseLines.length, 1);
  assert.deepEqual(leaseLines[0].from, { mode: 'erg', target: 100, grade: 0 });
  assert.deepEqual(leaseLines[0].to, { mode: 'sim', target: null, grade: 0 });
  assert.equal(leaseLines[0].ok, true);
  assert.equal(leaseLines[0].cmd, 'stop');

  // 幂等：再推到 60 s，条件仍然为真（但如果已经停机就没有租约可谈）
  vt.set(BASE + 60_000);
  send({ t: 'metrics', power: 100, cadence: 80, hr: 120 });
  app.tick();
  assert.equal(child.writes.filter((write) => write.cmd.t === 'stop').length, 1);
  lines = await auditSince(mark);
  leaseLines = watchdogLines(lines, /^lease_expired: /);
  assert.equal(leaseLines.length, 1);
});

// ---------------------------------------------------------------------------
// 2.3 看门狗·心跳 / 数据过期 / 踏频
// ---------------------------------------------------------------------------

test('心跳：5 s 无事件 → stop；11 s 无事件 → 一次 SIGTERM，之后不再重复', async (t) => {
  const { vt, child, app, fake } = await boot();
  t.after(() => fake.dispose());
  const mark = await auditMark();

  vt.advance(5_000);
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 0); // 恰好 5 s 还不动

  vt.advance(1_000);
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 1);

  vt.advance(5_000);                                   // 到 11 s
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 1);

  vt.advance(20_000);                                  // 一路推到 31 s
  assert.deepEqual(child.kills, ['SIGTERM']);          // 只 kill 一次

  const lines = await auditSince(mark);
  assert.equal(watchdogLines(lines, /^bridge_heartbeat: /).length, 1);
  assert.equal(watchdogLines(lines, /^bridge_kill: /).length, 1);
});

test('数据过期：边车心跳还在、metrics 停在 10 s → 一次 stop + critical', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());
  const mark = await auditMark();

  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  await app.applyCommand({ mode: 'erg', watts: 50, reason: '测试：数据过期' }, 'agent');

  // 每 2 s 一条 warn（脚在、数据不流），直到 12 s
  for (let second = 2; second <= 12; second += 2) {
    vt.advance(2_000);
    send({ t: 'warn', code: 'IBD_SILENT', message: '心跳还在' });
  }

  const ends = child.writes.filter((write) => write.cmd.t === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].at, BASE + 11_000);             // 11 s 第一次越过 10 s

  const snap = app.snapshot();
  assert.equal(snap.alert.level, 'critical');
  assert.equal(snap.alert.code, 'metrics_stale');

  for (let second = 2; second <= 12; second += 2) {      // 心跳继续，metrics 仍然不流
    vt.advance(2_000);
    send({ t: 'warn', code: 'IBD_SILENT', message: '心跳还在' });
  }
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 1);

  const lines = await auditSince(mark);
  assert.equal(watchdogLines(lines, /^metrics_stale: /).length, 1);
});

test('踏频归零：cadence=0、target=150、erg 推 21 s → 一次 stop + warn', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  const mark = await auditMark();
  send({ t: 'metrics', power: 0, cadence: 0, hr: 120 });
  await app.applyCommand({ mode: 'erg', watts: 150, reason: '测试：踏频归零' }, 'agent');

  for (let second = 1; second <= 21; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 0, cadence: 0, hr: 120 });
  }

  const ends = child.writes.filter((write) => write.cmd.t === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].at, BASE + 21_000);

  const snap = app.snapshot();
  assert.equal(snap.alert.level, 'warn');
  assert.equal(snap.alert.code, 'cadence_zero');
  assert.match(snap.alert.message, /下车或掉链/);

  const lines = await auditSince(mark);
  assert.equal(watchdogLines(lines, /^cadence_zero: /).length, 1);
});

test('踏频归零：中途踩回来 → 计时复位，不在 20 s 处误停', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  send({ t: 'metrics', power: 0, cadence: 0, hr: 120 });
  await app.applyCommand({ mode: 'erg', watts: 150, reason: '测试：踏频恢复复位' }, 'agent');

  for (let second = 1; second <= 10; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 0, cadence: 0, hr: 120 });
  }
  // 踩了一脚：计时清零
  vt.advance(1_000);
  send({ t: 'metrics', power: 150, cadence: 85, hr: 120 });
  for (let second = 1; second <= 15; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 0, cadence: 0, hr: 120 });
  }
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 0, '复位后 15 s 还不该停');

  for (let second = 1; second <= 10; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 0, cadence: 0, hr: 120 });
  }
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 1);
});

// ---------------------------------------------------------------------------
// 2.2 斜坡
// ---------------------------------------------------------------------------

test('斜坡：0→50 W 分 5 步下发（每步 ≤ maxStep），中途 stop 后续步骤不再下发', async (t) => {
  const { vt, child, app, fake } = await boot();
  t.after(() => fake.dispose());

  await app.applyCommand({ mode: 'erg', watts: 50, reason: '测试：斜坡' }, 'agent');
  vt.advance(3_000);
  assert.deepEqual(ergWrites(child).map((write) => write.cmd.watts), [10, 20, 30]);

  const snap = app.snapshot();
  assert.equal(snap.ramping.from, 0);
  assert.equal(snap.ramping.to, 50);
  assert.equal(snap.ramping.now, 30);
  assert.equal(snap.ramping.etaMs, 2_000);
  assert.match((await fake.tools.find((tool) => tool.name === 'ride_status').execute({})).summary, /斜坡 0→50 W（还差 2 s）/);

  await app.applyCommand({ mode: 'stop', reason: '测试：中止斜坡' }, 'user');
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 1);
  assert.equal(app.snapshot().ramping, null);

  vt.advance(10_000);
  assert.deepEqual(ergWrites(child).map((write) => write.cmd.watts), [10, 20, 30], '中止后不许再有任何一步');
});

test('斜坡：每步都不超过 maxStep，相邻两步相差 10 W', async (t) => {
  const { vt, child, app, fake } = await boot();
  t.after(() => fake.dispose());

  await app.applyCommand({ mode: 'erg', watts: 50, reason: '测试：步长' }, 'agent');
  vt.advance(5_000);

  const steps = ergWrites(child).map((write) => write.cmd.watts);
  assert.deepEqual(steps, [10, 20, 30, 40, 50]);
  const settings = app.snapshot().settings;
  let previous = 0;
  for (const watts of steps) {
    assert.ok(Math.abs(watts - previous) <= settings.maxStep);
    assert.ok(Math.abs(watts - previous) <= 10);
    previous = watts;
  }
});

// ---------------------------------------------------------------------------
// 2.6 #6 心率梯子接到 dispatch 上：一条决策一行审计，斜坡分片不刷屏
// ---------------------------------------------------------------------------

test('心率梯子接线：满 20 s 降载一次，审计恰好一行 actor=watchdog，斜坡分片不再各写一行', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  send({ t: 'metrics', power: 150, cadence: 80, hr: 170 });   // 170 ≥ ceiling(165.6)
  await app.applyCommand({ mode: 'erg', watts: 150, reason: '测试：心率降载' }, 'agent');

  for (let second = 1; second <= 21; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 150, cadence: 80, hr: 170 });
  }

  const snap = app.snapshot();
  assert.equal(snap.target, 135);                              // 150 × 0.9
  assert.equal(snap.mode, 'erg');

  const lines = await auditLines();
  const derates = lines.filter((line) => line.actor === 'watchdog' && /自动降载/.test(line.reason));
  assert.equal(derates.length, 1);
  assert.equal(derates[0].cmd, 'erg');
  assert.deepEqual(derates[0].to, { mode: 'erg', target: 135, grade: 0 });
  assert.equal(derates[0].ramp.from, 150);                     // 从 150 往下走，不 jump

  // 斜坡的分片（140、135）确实下线了，但没有各写一行审计
  for (let second = 1; second <= 3; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 150, cadence: 80, hr: 170 });
  }
  const rampWrites = ergWrites(child).filter((write) => write.at > BASE + 21_000);
  assert.deepEqual(rampWrites.map((write) => write.cmd.watts), [140, 135]);
});

// ---------------------------------------------------------------------------
// 2.6 #10 maxDuration
// ---------------------------------------------------------------------------

test('maxDuration：elapsedSec 推过 90 分钟 → 恰一次 stop + 审计；未到不动作', async (t) => {
  const { vt, child, app, fake, send } = await boot();
  t.after(() => fake.dispose());
  const mark = await auditMark();

  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  await app.applyCommand({ mode: 'sim', grade: 2, reason: '测试：时长信封' }, 'agent');

  // 未到：89 分钟
  vt.set(BASE + 89 * 60_000);
  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  app.tick();
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 0);

  // 到点：90 分 01 秒
  vt.set(BASE + 90 * 60_000 + 1_000);
  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  app.tick();
  assert.equal(child.writes.filter((write) => write.cmd.t === 'end').length, 1);

  const snap = app.snapshot();
  assert.equal(snap.alert.code, 'max_duration');
  assert.match(snap.alert.message, /到点收工/);

  vt.set(BASE + 91 * 60_000);
  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  app.tick();
  assert.equal(
    child.writes.filter((write) => write.cmd.t === 'end').length,
    1,
    JSON.stringify(child.writes.map((w) => [w.at - BASE, w.cmd])),
  );

  const lines = await auditSince(mark);
  assert.equal(watchdogLines(lines, /^max_duration: /).length, 1);
});

// ---------------------------------------------------------------------------
// 2.6 #11 审计收敛：重连恢复 / 改 cda·crr 后重发 sim
// ---------------------------------------------------------------------------

test('审计收敛：重连后恢复 intent 恰好一行 actor=host-restore', async (t) => {
  const { child, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  await app.applyCommand({ mode: 'erg', watts: 100, reason: '测试：恢复前提' }, 'agent');

  send({ t: 'device', role: 'trainer', name: 'Think XX02' });   // restorePending
  send({ t: 'ready', role: 'trainer' });

  const snap = app.snapshot();
  assert.equal(snap.mode, 'erg');
  assert.equal(snap.lastRestore.mode, 'erg');

  const lines = await auditLines();
  const restored = lines.filter((line) => line.actor === 'host-restore');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].cmd, 'erg');
  assert.deepEqual(restored[0].to, { mode: 'erg', target: 100 });
  assert.equal(restored[0].ok, true);

  // 恢复也是一条命令：它同样走斜坡，而不是一步写回去
  assert.equal(app.snapshot().ramping.to, 100);
  assert.equal(child.writes.filter((write) => write.cmd.t === 'erg' && write.cmd.watts === 100).length, 0);
});

test('审计收敛：改 cda 后重发 sim 恰好一行 actor=user-config', async (t) => {
  const { fake, app } = await boot();
  t.after(() => fake.dispose());

  await app.applyCommand({ mode: 'sim', grade: 2, reason: '测试：配置前' }, 'agent');

  const handler = fake.handlers.get('/ride/config');
  const res = makeRes();
  await handler.handler(makeReq({ cda: 0.55 }), res);
  assert.equal(res.status, 200);
  assert.equal(app.snapshot().settings.cda, 0.55);

  const lines = await auditLines();
  const configured = lines.filter((line) => line.actor === 'user-config');
  assert.equal(configured.length, 1);
  assert.equal(configured[0].cmd, 'sim');
  assert.match(configured[0].reason, /cda=0\.55/);
});

test('审计落盘位置：一行都写在临时 HOME 里，不碰 ~/.dsh/ride', async (t) => {
  const { app, fake, send } = await boot();
  t.after(() => fake.dispose());

  send({ t: 'metrics', power: 150, cadence: 80, hr: 120 });
  await app.applyCommand({ mode: 'erg', watts: 50, reason: '测试：审计落盘' }, 'agent');

  const lines = await auditLines();
  assert.ok(lines.length >= 1);
  assert.ok(AUDIT_DIR.startsWith(HOME));
  const mine = lines.filter((line) => line.reason === '测试：审计落盘');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].actor, 'agent');
  assert.equal(typeof mine[0].ts, 'number');
  assert.match(mine[0].iso, /^\d{4}-\d{2}-\d{2}T/);
});

// ---------------------------------------------------------------------------
// 2.4 ride_status 摘要增补（只增不改）
// ---------------------------------------------------------------------------

test('ride_status：追加斜坡 / 告警 / 租约三行，前面的行保持原样', async (t) => {
  const { vt, app, fake, send } = await boot();
  t.after(() => fake.dispose());

  const trainer = { name: 'Think XX02' };
  const strap = { name: 'HR40' };
  send({ t: 'metrics', power: 100, cadence: 80, hr: 120, trainer, strap });
  send({ t: 'device', role: 'trainer', name: 'Think XX02' });
  send({ t: 'device', role: 'strap', name: 'HR40' });
  await app.applyCommand({ mode: 'erg', watts: 50, reason: '测试：摘要' }, 'agent');
  vt.advance(3_000);

  const status = fake.tools.find((tool) => tool.name === 'ride_status');
  const value = await status.execute({});
  const lines = value.summary.split('\n');
  assert.match(lines[0], /^100 W · 80 rpm · /);
  assert.match(lines[2], /^模式 erg（目标 50 W） · 时长 /);
  assert.match(value.summary, /斜坡 0→50 W（还差 2 s）/);
  assert.match(value.summary, /租约 \d+ s 前续约/);

  // 告警行：制造一条 cadence_zero 之后再看（计时从踏频归零的第一跳起算，留足 20 s）
  for (let second = 1; second <= 23; second += 1) {
    vt.advance(1_000);
    send({ t: 'metrics', power: 0, cadence: 0, hr: 120, trainer, strap });
  }
  const after = await status.execute({});
  assert.match(after.summary, /⚠︎ 踏频已 0 rpm/);
  assert.match(after.summary, /台子 Think XX02 · 心率带 HR40/);   // 旧行还在
});

test('ride_status / ride_control 的参数 schema 未变，工具名未变', async (t) => {
  const { fake } = await boot();
  t.after(() => fake.dispose());

  assert.deepEqual(fake.tools.map((tool) => tool.name), ['ride_status', 'ride_control']);
  assert.deepEqual(fake.tools[0].parameters, { type: 'object', additionalProperties: false, properties: {} });
  assert.deepEqual(fake.tools[1].parameters.properties.mode.enum, ['erg', 'sim', 'stop']);
  assert.deepEqual(fake.tools[1].parameters.required, ['mode', 'reason']);
  assert.deepEqual([...fake.handlers.keys()].sort(), ['/ride/command', '/ride/config', '/ride/state']);
});
