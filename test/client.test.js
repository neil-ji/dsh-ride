// dsh-ride HUD 的客户端单测：不依赖浏览器、不新增依赖（只用 node:test）。
//
// 做法：给 globalThis.window 造一个 __ModuleLoader__ 桩，import 真实 client.js 拿到
// factory；再用一个 ~80 行的极简 hook 运行时当 require('react') 的替身。
//
// 替身比"useState 返回 [初始值, ()=>{}]"强一点：它能真的重渲染。这样「浮层拿到
// /ride/state 之后渲染成什么」是走真实代码路径（store 订阅 → fetch → setState →
// 重渲染）测出来的，不是先摆好一个假树再断言。

import test from 'node:test';
import assert from 'node:assert/strict';

// ── 模块加载 ──────────────────────────────────────────────────────────────────
let spec = null;
globalThis.window = {
  __ModuleLoader__: {
    load(captured) { spec = captured; },
  },
};
await import('../client.js');

assert.equal(spec?.id, '@local/dsh-ride', 'client.js 应该通过 window.__ModuleLoader__ 注册 @local/dsh-ride');
assert.equal(typeof spec.factory, 'function');

// ── 极简 hook 运行时（require('react') 的替身）─────────────────────────────────
function createReactRuntime() {
  let current = [];
  let cursor = 0;
  let dirty = false;
  let queue = [];

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => value === b[index]);

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in current)) current[index] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = current[index];
      return [cell.value, (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next;
        dirty = true;
      }];
    },
    useEffect(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previous = current[index];
      const changed = previous === undefined || !sameDeps(previous.deps, deps);
      current[index] = { ...(previous ?? {}), deps };
      if (changed) queue.push(fn);
    },
    useMemo(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previous = current[index];
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value;
      const value = fn();
      current[index] = { value, deps };
      return value;
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in current)) current[index] = { value: { current: initial } };
      return current[index].value;
    },
  };

  // 渲染到稳定为止：每次 setState 都把 dirty 打上，再跑一轮。
  // 每个 mount 有自己的 hook 单元数组，所以可以同时挂两个组件（浮层 + 侧边栏页）。
  async function renderOnce(Component, cells) {
    const cleanups = [];
    let tree = null;
    for (let pass = 0; pass < 25; pass += 1) {
      current = cells;
      cursor = 0;
      queue = [];
      dirty = false;
      tree = Component();
      for (const fn of queue) {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      // 让 /ride/state 的 promise 落地（store.emit → setState）
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      if (!dirty) break;
    }
    return { tree, cleanups };
  }

  async function mount(Component) {
    const cells = []; // 每次 mount 都是全新的一份 hook 状态，测试之间不串味
    const { tree, cleanups } = await renderOnce(Component, cells);
    let unmounted = false;
    return {
      tree,
      async rerender() {
        const next = await renderOnce(Component, cells);
        cleanups.push(...next.cleanups);
        return next.tree;
      },
      unmount() {
        // 逆序跑 cleanup：store 的退订会清掉唯一那个 setInterval，测试进程才能退出
        if (unmounted) return;
        unmounted = true;
        for (const cleanup of cleanups.reverse()) cleanup();
      },
    };
  }

  return { React, mount };
}

const runtime = createReactRuntime();

function requireStub(name) {
  if (name === 'react') return runtime.React;
  throw new Error(`unexpected require('${name}')`);
}

// ── 假 slots / 假 fetch ──────────────────────────────────────────────────────
function loadModule() {
  const registered = [];
  const slots = {
    inject(name, fn) {
      assert.equal(typeof fn, 'function', `slots.inject('${name}') 应该拿到一个回调`);
      fn();
    },
    register(registration, component) {
      registered.push({ registration, component });
      return () => {};
    },
  };
  const mod = spec.factory(requireStub);
  mod.apply({ slots });
  const byName = Object.fromEntries(registered.map((entry) => [entry.registration.name, entry]));
  return { mod, registered, byName };
}

function installFetch(statePayload, options = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const method = String(init.method ?? 'GET').toUpperCase();
    calls.push({ url: target, method, body: init.body });
    if (target === '/ride/state') {
      return { ok: true, status: 200, json: async () => statePayload };
    }
    if (target === '/ride/command') {
      const ok = options.commandOk ?? true;
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => options.commandReply ?? { ok: true },
      };
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return calls;
}

const baseState = () => ({
  bridge: 'ready',
  connected: { trainer: { name: 'KICKR CORE' }, strap: { name: 'HRM-DUAL' } },
  power: 187,
  hr: 142,
  cadence: 88,
  speed: 31.2,
  mode: 'erg',
  target: 200,
  grade: 0,
  elapsedSec: 754, // 12:34
  stale: false,
  zones: { powerZone: 2, ftpPct: 74, hrZone: 2, hrPct: 71 },
  alert: null,
  ramping: null,
});

// ── 渲染树小工具 ─────────────────────────────────────────────────────────────
function textOf(node, separator = '') {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => textOf(child, separator)).join(separator);
  if (typeof node === 'object' && Array.isArray(node.children)) {
    return node.children.map((child) => textOf(child, separator)).join(separator);
  }
  return '';
}

function collect(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (Array.isArray(node.children)) for (const child of node.children) collect(child, predicate, out);
  return out;
}

const isButton = (node) => node.type === 'button' && typeof node.props.onClick === 'function';

// 设 DSH_RIDE_HUD_DUMP=1 时把每个场景真实渲染出来的文案打出来，供验收留档。
const DUMP = process.env.DSH_RIDE_HUD_DUMP === '1';
const dump = (label, value) => { if (DUMP) console.log(`[dump] ${label} :: ${value}`); };

// ── 1. 三个落点 ──────────────────────────────────────────────────────────────
test('1) apply 注册三个落点：sidebar.panellist / main / shell.overlay', () => {
  installFetch(baseState());
  const { mod, registered, byName } = loadModule();

  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(
    registered.map((entry) => entry.registration.name),
    ['sidebar.panellist', 'main', 'shell.overlay'],
  );
  assert.equal(byName['shell.overlay'].registration.id, 'dsh-ride-hud');
  assert.equal(byName['shell.overlay'].registration.order, 40);
  assert.equal(typeof byName['shell.overlay'].component, 'function');
  assert.equal(byName['sidebar.panellist'].registration.id, 'dsh-ride');
  assert.equal(typeof byName.main.component, 'function');
});

// ── 2. STOP 在浮层里，整层 click-through ─────────────────────────────────────
test('2) 浮层渲染出 STOP 按钮（带 onClick），容器 click-through', async () => {
  installFetch(baseState());
  const { byName } = loadModule();
  const Hud = byName['shell.overlay'].component;

  const view = await runtime.mount(Hud);
  try {
    const text = textOf(view.tree);
    dump('2 折叠态（健康）', text);
    const stopButtons = collect(view.tree, (node) => isButton(node) && textOf(node).trim() === 'STOP');
    assert.equal(stopButtons.length, 1, `浮层里应该恰好一颗 STOP，实际 ${stopButtons.length}`);

    // 折叠态一行：187W · 142bpm · 88rpm · Z2 12:34
    assert.match(text, /187W/);
    assert.match(text, /142bpm/);
    assert.match(text, /88rpm/);
    assert.match(text, /Z2 12:3\d/);

    // 硬要求：整层不接收指针事件，只有自己的小块 auto
    assert.equal(view.tree.props.style.pointerEvents, 'none');
    assert.equal(view.tree.props.style.position, 'fixed');
    const interactive = collect(view.tree, (node) => node.props?.style?.pointerEvents === 'auto');
    assert.ok(interactive.length >= 2, 'STOP 与折叠条自己应该 opt-in pointer-events');
    for (const node of interactive) {
      assert.notEqual(node.props.style.pointerEvents, 'none');
    }
  } finally {
    view.unmount();
  }
});

// ── 3. 点 STOP → 一次 POST /ride/command ─────────────────────────────────────
test('3) 点 STOP 发一次 POST /ride/command，body.mode === "stop"，且不做乐观清零', async () => {
  const calls = installFetch(baseState());
  const { byName } = loadModule();
  const Hud = byName['shell.overlay'].component;

  const view = await runtime.mount(Hud);
  try {
    const [stopButton] = collect(view.tree, (node) => isButton(node) && textOf(node).trim() === 'STOP');
    await stopButton.props.onClick();

    const commands = calls.filter((call) => call.url === '/ride/command');
    assert.equal(commands.length, 1, `应该只发一次命令，实际 ${commands.length}`);
    assert.equal(commands[0].method, 'POST');
    assert.deepEqual(JSON.parse(commands[0].body), { mode: 'stop', reason: 'hud stop' });

    // 本地立即回执，但功率仍以服务端为准（187W 不会被写成 0）
    const after = textOf(await view.rerender());
    dump('3 点 STOP 之后', after);
    assert.match(after, /已发送停止/);
    assert.match(after, /187W/);
    assert.ok(!after.includes('0W'), '点 STOP 后不应该把功率乐观清零');
  } finally {
    view.unmount();
  }
});

// ── 4. stale：重连中，不是 0 W ───────────────────────────────────────────────
test('4) state.stale === true 时显示「重连中」，不出现 0 W', async () => {
  installFetch({ ...baseState(), stale: true, power: 0, hr: 0, cadence: 0 });
  const { byName } = loadModule();
  const Hud = byName['shell.overlay'].component;

  const view = await runtime.mount(Hud);
  try {
    const text = textOf(view.tree);
    dump('4 stale 折叠态', text);
    const spaced = textOf(view.tree, ' ');
    assert.match(text, /重连中/);
    assert.ok(!text.includes('0W'), `stale 时不应该出现 0W，实际：${text}`);
    assert.ok(!spaced.includes('0 W'), `stale 时不应该出现 0 W，实际：${spaced}`);
    // 整条降透明度
    const bar = collect(view.tree, (node) => node.props?.style?.borderRadius === 999)[0];
    assert.ok(bar, '折叠条应该在');
    assert.equal(bar.props.style.opacity, 0.55);
  } finally {
    view.unmount();
  }
});

// ── 5. critical 告警 ────────────────────────────────────────────────────────
test('5) state.alert.level === "critical" 时浮层带上告警文案（红底）', async () => {
  const message = '心率 178 已达最大 178';
  installFetch({ ...baseState(), alert: { level: 'critical', message, at: 1_731_234_567_890 } });
  const { byName } = loadModule();
  const Hud = byName['shell.overlay'].component;

  const view = await runtime.mount(Hud);
  try {
    dump('5 critical 告警', textOf(view.tree));
    assert.match(textOf(view.tree), /心率 178 已达最大 178/);
    const alertNode = collect(view.tree, (node) => node.props?.role === 'alert')[0];
    assert.ok(alertNode, 'critical 时应该有一条 role="alert" 的告警条');
    assert.equal(alertNode.props.style.background, 'var(--dsw-alias-state-error-primary, #e5484d)');
    assert.equal(alertNode.props.style.color, 'var(--dsw-alias-label-primary-inverted)');
    assert.equal(typeof alertNode.props.onClick, 'function', '告警条点一下要能收起');

    // 点一下暂时收起（只存本地内存）
    alertNode.props.onClick();
    const after = textOf(await view.rerender());
    assert.ok(!after.includes(message), '收起后这条告警不再显示');
  } finally {
    view.unmount();
  }
});

// ── 附加：斜坡与 warn 边（2.3 的其余部分）─────────────────────────────────────
test('6) ramping 存在时折叠条追加 →200W 3s；warn 告警用黄边而不是红底', async () => {
  installFetch({
    ...baseState(),
    alert: { level: 'warn', message: '心率接近红线', at: 1_731_234_567_890 },
    ramping: { from: 140, to: 200, now: 170, etaMs: 3000 },
  });
  const { byName } = loadModule();
  const Hud = byName['shell.overlay'].component;

  const view = await runtime.mount(Hud);
  try {
    const text = textOf(view.tree);
    dump('6 斜坡 + warn', text);
    assert.match(text, /→200W 3s/);
    const alertNode = collect(view.tree, (node) => node.props?.role === 'alert')[0];
    assert.ok(alertNode);
    assert.equal(alertNode.props.style.border, '1px solid var(--dsw-alias-state-warn-primary, #f5a524)');
    assert.equal(alertNode.props.style.background, 'var(--dsw-alias-bg-layer-1, #1b1b1e)');
  } finally {
    view.unmount();
  }
});

// ── 附加：展开态的三个大数字 ─────────────────────────────────────────────────
test('7) 展开态：功率/心率/踏频 三个 ≥44px 的 tabular-nums 数字 + 目标/模式/时长', async () => {
  installFetch(baseState());
  const { byName } = loadModule();
  const Hud = byName['shell.overlay'].component;

  const view = await runtime.mount(Hud);
  try {
    const [toggle] = collect(view.tree, (node) => isButton(node) && node.props['aria-expanded'] === false);
    assert.ok(toggle, '折叠条本身就是展开开关');
    toggle.props.onClick();
    const tree = await view.rerender();

    const big = collect(tree, (node) => node.props?.style?.fontSize === 46);
    assert.equal(big.length, 3, `应该有三个 46px 大数字，实际 ${big.length}`);
    for (const node of big) {
      assert.equal(node.props.style.fontVariantNumeric, 'tabular-nums');
      assert.ok(node.props.style.fontSize >= 44);
    }
    assert.deepEqual(big.map((node) => textOf(node)), ['187', '142', '88']);
    const text = textOf(tree, ' ');
    dump('7 展开态', text);
    assert.match(text, /目标 200 W/);
    assert.match(text, /模式 ERG 定功率/);
    assert.match(text, /已骑 12:3\d/);
  } finally {
    view.unmount();
  }
});

// ── 附加：浮层与侧边栏页共用同一个轮询源（2.4 的硬要求）────────────────────────
test('8) 浮层 + 侧边栏页同时挂载时，全局只有一个 setInterval 在跑', async () => {
  const calls = installFetch(baseState());
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const created = [];
  const live = new Set();
  globalThis.setInterval = (fn, ms) => {
    const id = realSetInterval(fn, ms);
    created.push({ id, ms });
    live.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    live.delete(id);
    realClearInterval(id);
  };

  const { byName } = loadModule();
  const hud = await runtime.mount(byName['shell.overlay'].component);
  const page = await runtime.mount(byName.main.component);
  try {
    assert.equal(created.length, 1, `应该只创建一个定时器，实际 ${created.length}`);
    assert.equal(created[0].ms, 1000);
    assert.equal(live.size, 1);
    const polls = calls.filter((call) => call.url === '/ride/state');
    assert.ok(polls.length >= 1 && polls.length <= 2, `首轮轮询最多两次，实际 ${polls.length}`);
    dump('8 轮询次数（浮层 + 侧边栏同时挂载）', `setInterval=${created.length} /ride/state=${polls.length}`);

    hud.unmount();
    assert.equal(live.size, 1, '只卸载浮层时侧边栏还在用，定时器不能停');
    page.unmount();
    assert.equal(live.size, 0, '两个都卸载后定时器必须停掉');
  } finally {
    hud.unmount();
    page.unmount();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});
