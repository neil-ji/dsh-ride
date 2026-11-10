import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

import { apply, inject, name } from '../index.js';

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
        webServer: {
          register: (route) => { handlers.set(route.path, route); return () => {}; },
        },
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

/** A fake sidecar process: real EventEmitters for stdout/stderr, recorded stdin. */
function makeFakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writable = true;
  const writes = [];
  stdin.write = (chunk) => { writes.push(String(chunk)); return true; };

  const child = {
    stdout,
    stderr,
    stdin,
    writes,
    kills: 0,
    exitHandlers: [],
    on: (event, handler) => { if (event === 'exit') child.exitHandlers.push(handler); return child; },
    kill: () => { child.kills += 1; },
  };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  return child;
}

test('host: 只 spawn 注入的桩进程，注册两个工具，并能读到 stub 的 metrics', async (t) => {
  // Prove the real spawn is not called: index.js reads `childProcess.spawn` at call
  // time, so replacing it here would catch any accidental real spawn. Restored below.
  const realSpawn = childProcess.spawn;
  let realSpawnCalls = 0;
  childProcess.spawn = (...args) => { realSpawnCalls += 1; return realSpawn(...args); };
  const restore = () => { childProcess.spawn = realSpawn; };
  t.after(restore);

  const fake = makeFakeCtx();
  const child = makeFakeChild();
  const spawnCalls = [];
  let onSpawn;
  const spawned = new Promise((resolve) => { onSpawn = resolve; });
  const fakeSpawn = (bin, args, opts) => {
    spawnCalls.push({ bin, args, opts });
    onSpawn();
    return child;
  };

  try {
    apply(fake.ctx, { spawnImpl: fakeSpawn });
    await spawned;

    assert.equal(name, 'dsh-ride');
    assert.deepEqual(inject, ['tools']);

    // exactly one process, and it is the stub
    assert.equal(spawnCalls.length, 1);
    assert.equal(realSpawnCalls, 0);
    assert.match(spawnCalls[0].bin, /[\\/]bin[\\/]ride-bridge$/);
    assert.deepEqual(spawnCalls[0].args, []);
    assert.deepEqual(spawnCalls[0].opts, { stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepEqual(child.writes, ['{"t":"connect"}\n']);

    // exactly the two agent-facing tools, unchanged names
    assert.equal(fake.tools.length, 2);
    assert.deepEqual(fake.tools.map((tool) => tool.name), ['ride_status', 'ride_control']);
    assert.equal(fake.tools[0].parameters.type, 'object');
    assert.deepEqual(fake.tools[1].parameters.properties.mode.enum, ['erg', 'sim', 'stop']);

    // the three read/write HTTP routes are wired
    assert.deepEqual([...fake.handlers.keys()].sort(), ['/ride/command', '/ride/config', '/ride/state']);

    // feed one metrics line the way the sidecar would, then read it back
    child.stdout.emit('data', 'not json\n');
    child.stdout.emit('data', '{"t":"metrics","power":150,"cadence":80,"hr":130,"control":true}\n');

    const status = fake.tools.find((tool) => tool.name === 'ride_status');
    const value = await status.execute({});
    assert.equal(value.ok, true);
    assert.equal(value.power, 150);
    assert.equal(value.cadence, 80);
    assert.equal(value.hr, 130);
    assert.equal(value.control, true);
    assert.equal(value.bridge, 'starting');            // 没有收到 hello
    assert.match(value.summary, /未连接任何设备（bridge=starting）/);
  } finally {
    fake.dispose();
    restore();
  }
});
