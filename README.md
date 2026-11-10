# dsh-ride

把室内骑行台和心率带接进 [DeepSeek Harness](https://github.com/deepseek-ai)：一个 BLE 边车、两个 agent 工具、一块骑行 HUD。

骑的时候屏幕上是一行 `187W · 142bpm · 88rpm · Z2 12:34` 和一顆随时能按的 STOP；agent 能读到你的功率心率、能在安全信封内改目标；DSH 卡死时台子会自己松手。

> 状态：M0–M4 主体已落地（边车、Host、HUD、ERG/坡度控制、信封、看门狗、审计）。M5（菜单栏薄壳）与 M6（教练循环、课程文件）未做。

## 为什么需要原生边车

Web Bluetooth 在 DSH 桌面窗口里必然失败：DSH 是 Electron，主进程没有监听 `select-bluetooth-device`，按 Electron 文档该事件无监听时**所有蓝牙请求都会被取消**。所以蓝牙在进程外：

```
DSH Host (Node)  ──stdin/stdout JSON Lines──▶  ride-bridge (Swift + CoreBluetooth)  ──BLE──▶  骑行台 / 心率带
      │                                                                                        FTMS 0x1826 / HRS 0x180D
      ├── tools: ride_status / ride_control
      ├── HTTP:  /ride/state /ride/command /ride/config
      └── 审计:  ~/.dsh/ride/audit-YYYY-MM-DD.jsonl
                     ▲
DSH Client (React) ──┘  fetch /ride/state，渲染 HUD 与 STOP
```

## 安全模型：DSH 只提议，不决定

有物理后果的部分一律由代码挡，不由模型自觉：

| 机制 | 位置 | 行为 |
|---|---|---|
| 信封夹紧 | `lib/ride-core.js` | 功率必须在 `minPower…maxPower`、单次变化 ≤ `maxStep`、坡度 −10…15%；**越界直接拒绝，不静默夹到边界** |
| 变化率 | `lib/ride-core.js` + 边车 | 目标功率按 10 W/s 斜坡推进，不是一步到位 |
| 控制租约 | `src/lease.swift` + `src/bridge.swift` | 每个 setpoint 带 30 s TTL，到期没有续约 → 边车自己回到坡度 0 并发出 `lease_expired`。**DSH 崩了、插件被禁用、agent 卡在长回合里，车都不会停在一个没人负责的功率上** |
| 看门狗 | `index.js` | 边车 5 s 无事件、10 s 无数据、踏频 0 且目标 >0 持续 20 s、租约过期 → 停控 |
| 心率红线 | `lib/ride-core.js` | 超红线先降载（最多 2 次），降到底仍超则停机；到 `maxHr` 10 s 直接停 |
| 审计 | `index.js` | 每次有物理后果的下发写一行 `{ts, actor, from, to, reason}`，可回放"谁在什么时候把功率拉到 300 W" |

模型的回合制和车的安全不该有关系，所以续约与看门狗都在 Host 定时器里，不经过模型。

## 安装

```bash
# 1. 编译边车（需要 Xcode Command Line Tools；产物是 arm64 Mach-O）
swiftc -O -swift-version 5 -o bin/ride-bridge src/lease.swift src/bridge.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker src/Info.plist

# 2. 让 DSH 装上它（在 DSH 会话里）
#    plugin_manager { action: "install_bundle", target: "/abs/path/to/dsh-ride" }
#    然后在 profile 里启用，重启 DSH。
```

首次 spawn 边车时系统会弹"DeepSeek Harness 想使用蓝牙"，允许一次即可。

## 两个工具

```js
ride_status()                                  // 只读：功率/踏频/速度/心率/模式/目标/时长/是否过期
ride_control({ mode, watts?, grade?, reason }) // erg | sim | stop
```

`ride_control` 不是透传：它过夹紧、限速、模式检查，越界返回原因而不是悄悄改到边界。每次调用都要求 `reason`，写进审计。

## HUD

`shell.overlay` 里的常驻胶囊（帧级浮层、默认 click-through，不会挡住聊天输入）：

- 折叠：`187W · 142bpm · 88rpm · Z2 12:34` + 红色 STOP
- 展开：三个大数字 + 目标/模式/已骑时长
- `stale` 时显示"重连中…"而不是 0 W —— 0 W 会误导人
- 超红线红底白字常亮，点一下可收起

## 测试

```bash
npm test        # node:test，无第三方依赖
```

`lib/ride-core.js` 是纯函数内核（无 IO、无时钟、无 ctx），`apply(ctx, deps)` 允许注入 `{spawnImpl, now, binPath, logger}`，所以整套安全逻辑可以在没有蓝牙、没有 DSH 的进程里跑测试。

## 配置

`~/.dsh/ride/config.json`，也可通过 `POST /ride/config` 改：

```json
{ "weightKg": 73, "ftp": 175, "maxHr": 200, "hrCeilingPct": 92,
  "cda": 0.51, "crr": 0.004,
  "minPower": 40, "maxPower": 250, "maxStep": 50 }
```

功率区/心率区按 FTP 与 `maxHr` 分档；`cda`/`crr` 只在模拟坡度模式里用。

## 已知限制

- 只在 macOS + 一台 FTMS 骑行台（Think XX02）+ 一条标准 HRS 心率带上实测过。
- FTMS 控制点响应的延迟分布、以及"一段 ERG 只发一次 Start/Resume"是否被各家固件接受，未跨机型验证。
- 设备独占：插件连上台子后 Zwift/码表就连不上（这是有意选择，不是缺陷）。
- M5 菜单栏薄壳未做，所以 DSH 整个退出时没有独立于它的 STOP。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 设计文档

设计取舍、协议细节与踩过的坑在 `03-研究资料/DSH骑行台插件-调研与集成方案.md`（未随仓库发布）。
