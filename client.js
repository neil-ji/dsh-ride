window.__ModuleLoader__.load({
  id: '@local/dsh-ride',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const POLL_MS = 1000;

    const T = {
      bg: 'var(--dsw-alias-bg-base, #131316)',
      layer: 'var(--dsw-alias-bg-layer-1, #1b1b1e)',
      layer2: 'var(--dsw-alias-bg-layer-2, #232327)',
      border: 'var(--dsw-alias-border-l1, rgba(130,130,140,.28))',
      border2: 'var(--dsw-alias-border-l2, rgba(130,130,140,.4))',
      fg: 'var(--dsw-alias-label-primary, #ededf0)',
      dim: 'var(--dsw-alias-label-secondary, rgba(235,235,245,.62))',
      err: 'var(--dsw-alias-state-error-primary, #e5484d)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      ok: 'var(--dsw-alias-state-success-primary, #30a46c)',
      idle: 'var(--dsw-alias-state-idle-primary, #8a8a8e)',
      brand: 'var(--dsw-alias-brand-primary, #4c8dff)',
      // 实心色块（红底 STOP / 告警条）上的文字：主题自带的 inverted 标签色，
      // 亮色下近白、暗色下近黑，两种主题都能读。
      onSolid: 'var(--dsw-alias-label-primary-inverted)',
    };

    const num = { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"' };
    const ZONE_COLORS = [T.idle, '#7aa2f7', '#30a46c', '#e0b341', '#f5a524', '#e5484d', '#b4343a'];

    const FIELD_LABELS = {
      weightKg: '体重 (kg)',
      ftp: 'FTP (W)',
      maxHr: '最大心率 (bpm)',
      hrCeilingPct: '心率红线 (%HRmax)',
      cda: '风阻 CdA (kg/m²)',
      crr: '滚阻 Crr',
      minPower: '功率下限 (W)',
      maxPower: '功率上限 (W)',
      maxStep: '单次步进 (W)',
    };

    function clock(sec) {
      const s = Math.max(0, Math.floor(sec));
      const mm = Math.floor(s / 60);
      return `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}`;
    }

    const post = async (path, body) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json().catch(() => ({}));
    };

    // ── 共享轮询源 ────────────────────────────────────────────────────────────
    // 浮层（shell.overlay）与侧边栏页读同一份快照：全局只有一个 setInterval、
    // 一个 /ride/state 请求在飞，没人订阅时定时器停掉。断线时保留上一份快照，
    // 只把 failed 打上——不要把功率显示成 0。
    function createRideStore() {
      let snapshot = { state: null, failed: false, at: 0 };
      const listeners = new Set();
      let timer = null;
      let inflight = false;

      const emit = () => {
        for (const listener of Array.from(listeners)) listener(snapshot);
      };

      const tick = async () => {
        if (inflight) return;
        inflight = true;
        try {
          const res = await fetch('/ride/state', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          snapshot = { state: data, failed: false, at: Date.now() };
        } catch {
          snapshot = { state: snapshot.state, failed: true, at: snapshot.at };
        } finally {
          inflight = false;
          emit();
        }
      };

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) {
            timer = setInterval(tick, POLL_MS);
            tick();
          }
          listener(snapshot);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && timer !== null) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
      };
    }

    const rideStore = createRideStore();

    function useRideState() {
      const [snapshot, setSnapshot] = useState(() => rideStore.getSnapshot());
      useEffect(() => rideStore.subscribe(setSnapshot), []);
      return snapshot;
    }

    function RideIcon() {
      return h('svg', { viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': true, style: { display: 'block' } },
        h('g', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' },
          h('circle', { cx: 10, cy: 10, r: 6.4 }),
          h('path', { d: 'M10 3.6v1.4M10 15v1.4M3.6 10H5M15 10h1.4' })),
        h('path', { d: 'M5.5 10.4h2.2l1-2.6 1.6 5 1.2-3 .8 1h2.2',
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }

    function Tile({ label, value, unit, sub, color }) {
      return h('div', {
        style: {
          background: T.layer, border: `1px solid ${T.border}`, borderRadius: 12,
          padding: '12px 14px', minWidth: 0,
        },
      },
        h('div', { style: { color: T.dim, fontSize: 12, marginBottom: 2 } }, label),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 4 } },
          h('span', { style: { ...num, fontSize: 34, fontWeight: 600, letterSpacing: '-0.8px', color: color ?? T.fg } }, String(value)),
          unit ? h('span', { style: { color: T.dim, fontSize: 13 } }, unit) : null),
        sub ? h('div', { style: { color: T.dim, fontSize: 12, marginTop: 2 } }, sub) : null);
    }

    function Button({ children, onClick, tone, disabled }) {
      const color = tone ?? T.brand;
      return h('button', {
        onClick, disabled,
        style: {
          padding: '7px 14px', borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${color}`, background: `color-mix(in srgb, ${color} 12%, transparent)`,
          color, fontSize: 13, fontWeight: 600, opacity: disabled ? 0.45 : 1,
        },
      }, children);
    }

    function NumberField({ label, value, onChange, min, max, step }) {
      return h('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: T.dim } },
        label,
        h('input', {
          type: 'number', value, min, max, step: step ?? 'any',
          onChange: (event) => onChange(event.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 7,
            border: `1px solid ${T.border2}`, background: T.layer2, color: T.fg,
            font: 'inherit', ...num,
          },
        }));
    }

    function Page() {
      const { state, failed } = useRideState();
      const [settings, setSettings] = useState(null);
      const [ranges, setRanges] = useState({});
      const [draft, setDraft] = useState({});
      const [note, setNote] = useState('');
      const [ergInput, setErgInput] = useState('');
      const [gradeInput, setGradeInput] = useState('1.5');

      useEffect(() => {
        let alive = true;
        fetch('/ride/config', { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => { if (alive) { setSettings(d.settings); setRanges(d.ranges ?? {}); setDraft(d.settings); } })
          .catch(() => { if (alive) setNote('读不到设置'); });
        return () => { alive = false; };
      }, []);

      if (state === null) {
        return h('div', { style: { padding: 40, color: T.dim } }, failed ? 'ride 服务未响应。' : '连接中…');
      }

      const live = state.connected.trainer !== null || state.connected.strap !== null;
      const z = state.zones ?? { powerZone: 0, ftpPct: 0, hrZone: 0, hrPct: 0 };
      const w = state.last60s;
      const dot = live ? (state.stale ? T.warn : (state.mode === 'erg' ? T.ok : T.brand)) : T.idle;

      const setSim = async () => {
        const grade = Number(gradeInput);
        const result = await post('/ride/command', { mode: 'sim', grade, reason: 'page control' }).catch(() => ({ ok: false, reason: '网络错误' }));
        setNote(result.ok ? `坡度已设为 ${result.grade}%` : (result.reason ?? '失败'));
      };
      const setErg = async () => {
        const result = await post('/ride/command', { mode: 'erg', watts: Number(ergInput), reason: 'page control' }).catch(() => ({ ok: false, reason: '网络错误' }));
        setNote(result.ok ? `ERG 目标 ${result.target} W` : (result.reason ?? '失败'));
      };
      const stop = async () => {
        const result = await post('/ride/command', { mode: 'stop', reason: 'page stop' }).catch(() => ({ ok: false }));
        setNote(result.ok ? '已结束并回到坡度 0' : '失败');
      };
      const saveSettings = async () => {
        const patch = {};
        for (const key of Object.keys(FIELD_LABELS)) patch[key] = Number(draft[key]);
        const result = await post('/ride/config', patch).catch(() => ({ ok: false, reason: '网络错误' }));
        if (result.ok) { setSettings(result.settings); setDraft(result.settings); setNote('设置已保存'); }
        else setNote(result.reason ?? '保存失败');
      };

      return h('div', { style: { padding: '22px 26px 40px', maxWidth: 860, margin: '0 auto', color: T.fg } },
        // header
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 } },
          h('span', { style: { width: 9, height: 9, borderRadius: 9, background: dot } }),
          h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 600 } }, '骑行台'),
          h('span', { style: { color: T.dim, fontSize: 13 } },
            live ? `${state.connected.trainer?.name ?? '—'} · ${state.connected.strap?.name ?? '—'}` : '未连接设备'),
          h('span', { style: { marginLeft: 'auto', color: T.dim, fontSize: 12 } },
            `bridge ${state.bridge}${state.stale ? ' · 数据过期' : ''}`)),

        state.alert ? h('div', {
          style: {
            marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13,
            color: state.alert.level === 'critical' ? T.err : T.warn,
            border: `1px solid ${state.alert.level === 'critical' ? T.err : T.warn}`,
            background: `color-mix(in srgb, ${state.alert.level === 'critical' ? T.err : T.warn} 10%, transparent)`,
          },
        }, state.alert.message) : null,

        // tiles
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 } },
          h(Tile, { label: '功率', value: state.power, unit: 'W', sub: z.powerZone ? `Z${z.powerZone} · ${z.ftpPct}% FTP` : '—', color: ZONE_COLORS[z.powerZone] }),
          h(Tile, { label: '心率', value: state.hr, unit: 'bpm', sub: z.hrZone ? `Z${z.hrZone} · ${z.hrPct}% HRmax` : '—', color: ZONE_COLORS[z.hrZone] }),
          h(Tile, { label: '踏频', value: state.cadence, unit: 'rpm', sub: `${state.speed} km/h` }),
          h(Tile, { label: '时长', value: clock(state.elapsedSec), sub: state.mode === 'erg' ? `ERG ${state.target ?? '—'} W` : state.mode === 'sim' ? `坡度 ${state.grade ?? 0}%` : '只读跟随' })),

        // controls
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 14 } },
          h('div', { style: { width: 120 } }, h(NumberField, { label: 'ERG 目标 (W)', value: ergInput, onChange: setErgInput, min: settings?.minPower, max: settings?.maxPower })),
          h(Button, { onClick: setErg, disabled: !live || ergInput === '' }, '设功率'),
          h('div', { style: { width: 110 } }, h(NumberField, { label: '坡度 (%)', value: gradeInput, onChange: setGradeInput, min: -10, max: 15, step: 0.1 })),
          h(Button, { onClick: setSim, disabled: !live }, '设坡度'),
          h('div', { style: { marginLeft: 'auto' } }, h(Button, { onClick: stop, tone: T.err }, 'STOP · 归零阻力'))),

        note ? h('div', { style: { marginTop: 8, fontSize: 12, color: T.dim } }, note) : null,
        state.lastRestore ? h('div', { style: { marginTop: 8, fontSize: 12, color: T.brand } },
          `已恢复上次设置：${state.lastRestore.mode === 'erg' ? `ERG ${state.lastRestore.watts} W` : `坡度 ${state.lastRestore.grade}%`}`) : null,

        // last 60s
        w ? h('div', { style: { marginTop: 18, padding: '10px 14px', borderRadius: 10, background: T.layer, border: `1px solid ${T.border}`, fontSize: 13, color: T.dim } },
          `最近 ${w.seconds}s：均 ${w.avgPower} W / 峰 ${w.maxPower} W · 均心率 ${w.avgHr} / 峰 ${w.maxHr} · 踩踏 ${w.pedalingSec}s · 停脚 ${w.coastingSec}s`) : null,

        state.lastError ? h('div', { style: { marginTop: 8, color: T.err, fontSize: 13 } },
          `错误 ${state.lastError.code}：${state.lastError.message}`) : null,
        state.lastWarn ? h('div', { style: { marginTop: 8, color: T.warn, fontSize: 13 } },
          `警告 ${state.lastWarn.code}：${state.lastWarn.message}`) : null,

        // settings
        h('div', { style: { marginTop: 22 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, '常量与安全信封'),
            h('span', { style: { color: T.dim, fontSize: 12 } }, '决定区间、W/kg 与夹紧范围；台子不接受体重，坡度分量仍按固件默认值算')),
          settings === null
            ? h('div', { style: { color: T.dim } }, '读取中…')
            : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 } },
                Object.keys(FIELD_LABELS).map((key) => h(NumberField, {
                  key,
                  label: FIELD_LABELS[key],
                  value: draft[key] ?? '',
                  min: ranges[key]?.[0],
                  max: ranges[key]?.[1],
                  onChange: (value) => setDraft({ ...draft, [key]: value }),
                }))),
          settings === null
            ? null
            : h('div', { style: { marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' } },
                h(Button, { onClick: saveSettings }, '保存'),
                h('span', { style: { color: T.dim, fontSize: 12 } }, '存于 ~/.dsh/ride/config.json'))));
    }

    // ── 常驻浮层（shell.overlay）──────────────────────────────────────────────
    // 位置：窗口右上、会话标题栏下方（top 64 / right 14）。刻意不贴底边——聊天
    // 输入框在底部居中，胶囊贴底会压到发送键。整层 pointer-events:none，只有
    // 胶囊、展开面板、告警条自己开 auto，所以浮层不挡聊天输入。
    const MODE_TEXT = { erg: 'ERG 定功率', sim: '坡度模拟', follow: '只读跟随' };

    function mmss(sec) {
      const s = Math.max(0, Math.floor(sec));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function Hud() {
      const snapshot = useRideState();
      const [open, setOpen] = useState(false);
      const [dismissedAlert, setDismissedAlert] = useState(null);
      const [stopNote, setStopNote] = useState(null);
      const [sending, setSending] = useState(false);

      const state = snapshot.state;
      const stale = snapshot.failed === true || state?.stale === true;
      const connected = !!(state?.connected?.trainer || state?.connected?.strap);
      const alert = state?.alert ?? null;
      const ramping = state?.ramping ?? null;
      const critical = alert?.level === 'critical';
      const alertKey = alert === null ? null : `${alert.level}|${alert.message}`;
      const showAlert = alert !== null && alertKey !== dismissedAlert;

      // 计时用 Date.now() 差值外推，不用 rAF（后台标签会被节流）；数据过期时不外推。
      const elapsed = state === null || stale || snapshot.at === 0
        ? (state?.elapsedSec ?? 0)
        : Math.max(0, (state.elapsedSec ?? 0) + (Date.now() - snapshot.at) / 1000);

      const stop = async () => {
        if (sending) return;
        setSending(true);
        // 本地立即回执；功率只认服务端，不做乐观清零。
        setStopNote({ kind: 'ok', text: '已发送停止' });
        try {
          const res = await fetch('/ride/command', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'stop', reason: 'hud stop' }),
          });
          let payload = {};
          try { payload = await res.json(); } catch { payload = {}; }
          if (!res.ok || payload.ok === false) {
            const why = payload.reason ?? payload.error ?? `HTTP ${res.status}`;
            setStopNote({ kind: 'err', text: `停止失败：${why}` });
          } else {
            setStopNote({ kind: 'ok', text: '已发送停止' });
          }
        } catch (error) {
          setStopNote({ kind: 'err', text: `停止失败：${error?.message ?? '网络错误'}` });
        } finally {
          setSending(false);
        }
      };

      let summary = '未连接';
      if (state !== null && stale) {
        summary = '重连中…';
      } else if (state !== null && connected) {
        const zone = state.zones?.powerZone ?? 0;
        summary = `${state.power}W · ${state.hr}bpm · ${state.cadence}rpm · Z${zone} ${mmss(elapsed)}`;
        if (ramping !== null && typeof ramping?.to === 'number') {
          const eta = Math.max(1, Math.round((ramping.etaMs ?? 0) / 1000));
          summary += ` · →${ramping.to}W ${eta}s`;
        }
      }

      const dot = stale ? T.warn : (state === null || !connected ? T.idle : (state.mode === 'erg' ? T.ok : T.brand));
      const big = (value) => (stale || state === null || !connected ? '—' : value);
      const targetText = state === null ? '—'
        : state.mode === 'erg' ? `${state.target ?? '—'} W`
          : state.mode === 'sim' ? `坡度 ${state.grade ?? 0}%`
            : '—';

      const stat = (label, value, unit, color) => h('div', { key: label, style: { display: 'grid', gap: 2, minWidth: 0 } },
        h('div', { style: { fontSize: 11, letterSpacing: '.04em', color: T.dim } }, label),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 3 } },
          h('span', {
            style: { ...num, fontSize: 46, lineHeight: '48px', fontWeight: 700, letterSpacing: '-1.5px', color: color ?? T.fg },
          }, String(value)),
          h('span', { style: { fontSize: 12, color: T.dim } }, unit)));

      return h('div', {
        'data-dsh-ride-hud': '1',
        style: {
          position: 'fixed', top: 64, right: 14, zIndex: 1000,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
          pointerEvents: 'none',
        },
      },
        showAlert
          ? h('div', {
            key: 'alert',
            role: 'alert',
            onClick: () => setDismissedAlert(alertKey),
            title: '点一下暂时收起这条告警',
            style: {
              pointerEvents: 'auto', cursor: 'pointer', maxWidth: 340,
              padding: '6px 11px', borderRadius: 10,
              fontSize: 12.5, lineHeight: '17px', fontWeight: 700,
              background: critical ? T.err : T.layer,
              color: critical ? T.onSolid : T.warn,
              border: `1px solid ${critical ? T.err : T.warn}`,
            },
          }, alert.message)
          : null,

        open
          ? h('div', {
            key: 'panel',
            style: {
              pointerEvents: 'auto', minWidth: 272, padding: '12px 14px', borderRadius: 14,
              background: T.layer, border: `1px solid ${T.border2}`, color: T.fg,
              display: 'grid', gap: 10,
            },
          },
            h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-end' } },
              stat('功率', big(state?.power), 'W', ZONE_COLORS[state?.zones?.powerZone ?? 0]),
              stat('心率', big(state?.hr), 'bpm', ZONE_COLORS[state?.zones?.hrZone ?? 0]),
              stat('踏频', big(state?.cadence), 'rpm')),
            h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: T.dim } },
              h('span', null, `目标 ${targetText}`),
              h('span', null, `模式 ${MODE_TEXT[state?.mode] ?? '—'}`),
              h('span', null, `已骑 ${mmss(elapsed)}`)),
            stale ? h('div', { style: { fontSize: 12, fontWeight: 600, color: T.warn } }, '重连中… 数字暂停更新') : null)
          : null,

        h('div', {
          key: 'bar',
          style: {
            pointerEvents: 'auto', display: 'flex', alignItems: 'stretch',
            borderRadius: 999, overflow: 'hidden',
            background: T.layer, border: `1px solid ${T.border2}`,
            opacity: stale ? 0.55 : 1,
          },
        },
          h('button', {
            onClick: () => setOpen(!open),
            title: open ? '收起骑行浮层' : '展开大数字',
            'aria-expanded': open,
            style: {
              display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
              border: 'none', background: 'transparent', color: T.fg,
              font: 'inherit', fontSize: 13, fontWeight: 600,
              padding: '7px 12px 7px 10px', minHeight: 32,
            },
          },
            h('span', { style: { width: 7, height: 7, borderRadius: 7, background: dot, flex: 'none' } }),
            summary),
          h('button', {
            onClick: stop,
            disabled: sending,
            title: '立即停止并回到坡度 0（不经过 agent）',
            style: {
              pointerEvents: 'auto', border: 'none', borderLeft: `1px solid ${T.border2}`,
              background: T.err, color: T.onSolid,
              font: 'inherit', fontSize: 12, fontWeight: 800, letterSpacing: '.08em',
              padding: '0 13px', minHeight: 32, cursor: sending ? 'progress' : 'pointer',
              opacity: sending ? 0.7 : 1,
            },
          }, 'STOP')),

        stopNote
          ? h('div', {
            key: 'note',
            style: {
              pointerEvents: 'none', fontSize: 11.5, fontWeight: 600,
              padding: '3px 8px', borderRadius: 8,
              background: T.layer, border: `1px solid ${stopNote.kind === 'err' ? T.err : T.border2}`,
              color: stopNote.kind === 'err' ? T.err : T.dim,
            },
          }, stopNote.text)
          : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'dsh-ride', order: 22, label: () => '骑行' },
          RideIcon,
        ));
        slots.inject('main', () => slots.register({ name: 'main', key: 'dsh-ride' }, Page));
        // 常驻 HUD：shell.overlay 是帧级浮层（list / root），不依赖当前在哪个页面。
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'dsh-ride-hud', order: 40 },
          Hud,
        ));
      },
    };
  },
});
