# pi-studio macOS 移植手册

> 目的：把这份 Windows 桌面客户端移植成 macOS 版，拿过去能直接照着改。
> 结论先行：**绝大部分代码跨平台、无需动**。真正要改的只有「平台相关」的一小撮：
> 窗口/标题栏、打包与签名公证、托盘/自动更新、沙箱(WSL→Docker)、Blender 路径、图标。
>
> 适用版本：v0.6.0 · Electron 42 · electron-vite 2 · React 19 · antd 6 · Node 22(内置)

---

## 0. 技术栈与整体架构

```
Electron 42 + electron-vite 2
  main/      Node/Electron 主进程(业务、IPC、子进程、持久化)
  preload/   contextBridge 暴露 window.api
  renderer/  React 19 + antd 6 + antd-style + @lobehub/ui + Tailwind v4 + lucide
```

- **核心是「Pi coding agent」客户端**：`@earendil-works/pi-coding-agent` 以 **RPC 子进程**方式运行，
  用的是 **Electron 自身当 Node**（`ELECTRON_RUN_AS_NODE=1`），**不依赖目标机的系统 Node** →
  这条链路**天生跨平台**，Mac 无需改（见 `src/main/pi-client.ts`）。
- **云端能力**（生图 / 3D / LLM）都经 **中继** `https://trail-api.glanger.xyz` 转发到
  自建后端 `pi-studio-device-plane`(2026-09-16 前叫 `pi-studio-backend`)（FastAPI + 自托管 Hatchet worker）。中继地址在**构建期**由
  `electron.vite.config.ts` 的 `__CLOUD_IMAGE_RELAY__` 写入；App Key 存本地**加密配置**，不随构建分发。
  → 后端与中继**同一套，Mac 版直接复用，零改动**。
- **持久化**：
  - 设置：`electron-store` 风格的 `settings.json`（`app.getPath('userData')/settings.json`，见 `src/main/settings.ts`）。
  - Routines 数据库：**`node:sqlite`（Electron 42 内置，非原生模块）** → **不需要按架构重编**，跨平台直接可用。
- 功能页：Chat(agent) / Routines / 生图(gpt-image-2) / 3D(Tripo/Hi3D/Blender)。换装视频(Kling)2026-09-29 已删。

**没有需要按平台重编的原生 node 插件**（SQLite 用内置的 `node:sqlite`）→ 省掉最大的一块移植麻烦。

---

## 1. 平台触点总览（要改的都在这）

| 文件 | Windows 专属逻辑 | macOS 要做什么 |
|---|---|---|
| `package.json` → `build` | 只有 `win`(nsis) 目标、`icon.ico` | 加 `mac`/`dmg` 目标、`icon.icns`、签名+公证(见 §4) |
| `src/main/index.ts` | `frame:false` + `titleBarStyle:'hidden'`；托盘仅 win32；关闭→隐藏仅 win32 | mac 用 `titleBarStyle:'hiddenInset'` + `trafficLightPosition`；托盘可省；关闭行为已就绪(见 §2) |
| `src/renderer/src/components/TitleBar.tsx` | 右上角自绘 最小化/最大化/关闭 三个按钮 | mac 隐藏这三个按钮(用原生红绿灯)，左侧留出红绿灯位置(见 §2) |
| `src/main/sandbox.ts` + `sandbox-wsl.ts` | 首选 **WSL2+bubblewrap** 沙箱 | mac 无 WSL → 自动回退 **Docker 沙箱** 或关闭(见 §3) |
| `src/main/blender-setup.ts` | `blender.exe` / `where.exe` / `platform!=='win32' 直接 return []` | mac 检测 `/Applications/Blender.app/...` + `which blender`（可暂缓，见 §5） |
| 图标资源 `build/icon.ico`、`renderer/.../assets/app-icon.png` | .ico | 增加 `build/icon.icns`（app-icon.png 通用） |
| `src/main/index.ts` 自动更新 `quitAndInstall(true,true)` | NSIS `/S` 静默语义 | mac 走 Squirrel.Mac(zip)，**必须签名**才能自动更新(见 §4.4) |

**其余全部跨平台，别动**：所有 renderer UI、IPC 架构、agent 运行时、生图/换装/3D 的中继调用、`node:sqlite`、
`git-diff.ts`(用系统 `git`，mac 自带)、`code-model.ts` 的 `spawn(process.execPath,…)`(Electron 二进制，跨平台)。

---

## 2. 窗口与标题栏（改动最直观）

### 2.1 主进程窗口选项 — `src/main/index.ts` `createWindow()`

当前（Windows 自绘无边框）：
```ts
const mainWindow = new BrowserWindow({
  width: 1480, height: 920, minWidth: 960, minHeight: 640,
  show: false,
  frame: false,
  titleBarStyle: 'hidden',
  backgroundColor: '#000000',
  webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true },
})
```

改成按平台分支（mac 保留原生红绿灯）：
```ts
const isMac = process.platform === 'darwin'
const mainWindow = new BrowserWindow({
  width: 1480, height: 920, minWidth: 960, minHeight: 640,
  show: false,
  backgroundColor: '#000000',
  ...(isMac
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 13 } } // 原生红绿灯，内嵌
    : { frame: false, titleBarStyle: 'hidden' }),                              // Windows 自绘
  // 可选 mac 磨砂效果：vibrancy: 'sidebar', visualEffectState: 'active',
  webPreferences: { preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false, contextIsolation: true },
})
```
> 注意：mac 上**不要**同时设 `frame:false`，否则红绿灯会被隐藏。`hiddenInset` 会保留红绿灯并隐藏标题条。

### 2.2 渲染层标题栏 — `src/renderer/src/components/TitleBar.tsx`

- **mac 隐藏右上角自绘的 最小化/最大化/关闭**（用原生红绿灯代替）。
- **mac 左侧要给红绿灯让位**：当前最左是 `railOffset`(56px，与 NavRail 同宽)，红绿灯在 x≈18 会压在 NavRail 顶部。
  两种做法二选一：把 `trafficLightPosition.y` 下移，或给标题栏最左加 ~72px 内边距（mac 时）。

需要在渲染层知道当前平台 → 在 **preload** 暴露一下：
```ts
// src/preload/index.ts 的 api 对象里加：
platform: process.platform,           // 'darwin' | 'win32' | ...
// 并在 src/shared/ipc/contract.ts 的 DesktopApi 里补类型：platform: NodeJS.Platform
```
TitleBar 里：
```tsx
const isMac = api.platform === 'darwin'
// …右上角三个 winBtn 用 {!isMac && ( … )} 包起来
// railOffset 在 mac 时宽度给足红绿灯：width: isMac ? 78 : 56
```
> `-webkit-app-region: drag` 的拖拽区在 mac 一样生效；红绿灯所在区域系统会自动处理，不用管。

---

## 3. 沙箱：WSL → Docker（或先关掉）

`src/main/sandbox.ts` 的 agent 隔离有两条路：
1. **WSL2 + bubblewrap**（Windows 首选，`sandbox-wsl.ts`，用到 `wsl.exe`、`pi-studio-sandbox` 发行版）；
2. **Docker**（跨平台回退，靠 `sandbox-rpc-shim.cjs` 把 stdio 透明转发进 `docker run … pi …`）。

mac 上没有 WSL：
- 确认 `detectWslSandboxDistro()`（`sandbox-wsl.ts`）在**非 Windows 直接返回未就绪**（若它靠调用 `wsl.exe`，在 mac 会失败→未就绪，天然安全；**最好显式加 `if (process.platform !== 'win32') return {ready:false,…}` 提前返回**，避免无谓 spawn）。
- 未就绪时会自动走 **Docker 沙箱**（需装 Docker Desktop）。Docker 这条**在 mac 可用、无需改**。
- 若初期不想折腾沙箱：让沙箱检测都返回不可用 → agent **直跑主机**（`sandboxMode=null`，功能不受影响，只是少了隔离）。

`sandbox.ts` 里 `sandboxSessionPathToContainer` 用了 `.toLowerCase()` 做路径比较（Windows 大小写不敏感）。
macOS 默认 APFS 也大小写不敏感，一般无碍；若目标盘是大小写敏感卷需留意。

---

## 4. 打包 / 签名 / 公证（macOS 新增工作，占大头）

### 4.1 `package.json` → `build` 加 mac 目标
```jsonc
"build": {
  "appId": "com.jiubingwangwang.pi-studio",
  "productName": "pi-studio",
  "asar": false,                         // 保持：外部子进程要能读到 cli.js（app.asar 内读不到）
  "directories": { "output": "dist" },
  "files": [ /* 保持现有 */ ],
  "win": { "target": "nsis", "icon": "build/icon.ico" },
  "nsis": { /* 保持 */ },
  "mac": {
    "target": [
      { "target": "dmg", "arch": ["arm64", "x64"] },   // 分发用
      { "target": "zip", "arch": ["arm64", "x64"] }     // 自动更新必需(Squirrel.Mac 认 zip)
    ],
    "icon": "build/icon.icns",
    "category": "public.app-category.developer-tools",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "notarize": true                      // electron-builder 26 支持 notarize:true(用下方环境变量)
  },
  "dmg": { "sign": false },
  "publish": { "provider": "github", "owner": "GreenBeanLiu", "repo": "pi-studio", "releaseType": "release" }
}
```
> `asar:false` **务必保留**：agent 子进程要从 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` 读脚本，
> 打进 `app.asar` 后非 Electron 进程读不到（见 `pi-client.ts` 注释）。

### 4.2 入口图标 `build/icon.icns`
用现有 1024×1024 PNG 生成：
```bash
# 在 mac 上：
mkdir icon.iconset
sips -z 16 16   app.png --out icon.iconset/icon_16x16.png
sips -z 32 32   app.png --out icon.iconset/icon_16x16@2x.png
# …128/256/512 及 @2x…
iconutil -c icns icon.iconset -o build/icon.icns
```

### 4.3 entitlements — `build/entitlements.mac.plist`
因为 App 会 **spawn 子进程**（Electron-as-node 跑 agent CLI、Docker shim），Hardened Runtime 下需要：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>  <!-- ELECTRON_RUN_AS_NODE -->
  <key>com.apple.security.inherit</key><true/>
</dict></plist>
```

### 4.4 签名 + 公证（自动更新的前提）
macOS 上 **electron-updater 要求应用已签名+公证**，否则 Squirrel.Mac 更新会失败、首次打开也会被 Gatekeeper 拦。
需要 **Apple Developer ID Application** 证书 + 一个 App 专用密码：
```bash
# 证书(二选一)：导入钥匙串，或用环境变量指向 .p12
export CSC_LINK=/absolute/path/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD='p12 密码'
# 公证(notarytool)：
export APPLE_ID='you@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'   # appleid.apple.com 生成
export APPLE_TEAM_ID='XXXXXXXXXX'
# 打包(在 mac 上跑；Windows 无法交叉编 mac)：
pnpm exec electron-vite build && pnpm exec electron-builder --mac --publish never
```
> 没有 Apple 开发者账号时：可先 `hardenedRuntime:false` + `notarize:false` 做**本地自用**包（自己右键打开绕过 Gatekeeper），
> 但**不能自动更新、不能分发给别人**。

### 4.5 `package.json` scripts 建议加
```jsonc
"package:mac": "pnpm run build && electron-builder --mac --publish never",
"package:win": "pnpm run verify && electron-builder --win --publish always"
```
> 现有 `package` 写死了 `--win --publish always`，mac 单独加一个脚本；**mac 包必须在 macOS 上打**。

---

## 5. Blender 出 3D（Mac 明确不移植）

`src/main/blender-setup.ts` 是纯 Windows：`BLENDER_EXE='blender.exe'`、`where.exe` 查路径、`platform!=='win32'` 直接返回空。

> **决策：Mac 版不支持 Blender 引擎，不做移植**（产品定位：不在 mac 上做 3D 建模）。
> Mac 上该功能直接**隐藏/降级**即可——现有 `platform!=='win32'` 早退逻辑已经让它优雅失效，
> **无需为 mac 补任何 Blender 分支**。
> 影响面很小：**换装、生图、图生 3D(Tripo/Hi3D，走云中转)、three.js 代码建模、agent 全不依赖 Blender**，
> 在 mac 上都照常可用；唯独「3D → Blender 引擎」这一个子入口在 mac 隐藏。

---

## 6. 托盘与退出行为（基本已就绪）

`src/main/index.ts`：
- `createTray()` 开头 `if (process.platform !== 'win32' …) return` → **mac 自动不建托盘**（无需改；mac 习惯用 Dock）。
- 关闭窗口→隐藏 的逻辑也 `platform!=='win32'` 早退 → mac 关闭窗口即正常关闭。
- `window-all-closed` 已判 `!== 'darwin'`、`activate` 已能重建窗口 → **mac 的标准生命周期已经写好了**。

自动更新 `quitAndInstall(true, true)` 的两个布尔在 mac 上语义不同（无 NSIS `/S`），但 electron-updater 会自行处理，
**代码不用改**，前提是 §4.4 的签名+公证到位、且 GitHub Release 里有 `latest-mac.yml` + `*-mac.zip`。

---

## 7. 从零到能跑：mac 上的操作顺序

```bash
# 0) 前置：mac 上装 Node 22+/pnpm、Xcode CLT(自带 git)、(可选)Docker Desktop
git clone <repo> pi-studio && cd pi-studio
pnpm install
pnpm approve-builds        # 批准 electron 的二进制下载脚本(否则 dev 报 "Electron uninstall")

# 1) 开发运行(热重载)
pnpm dev

# 2) 按 §2/§3 改窗口、标题栏、沙箱守卫；typecheck
pnpm run typecheck

# 3) 按 §4 加 mac build 配置 + icns + entitlements，本地出包(先不签名自用)
pnpm exec electron-vite build && pnpm exec electron-builder --mac --publish never

# 4) 有开发者账号后：配 §4.4 环境变量，出签名+公证包并发布
pnpm exec electron-builder --mac --publish always
```

---

## 8. 移植时容易踩的坑（预警）

1. **`asar` 必须保持 false**：否则 agent CLI / Docker shim 读不到 `dist/cli.js`（Electron-as-node、docker 都不是 Electron patched-fs）。
2. **mac 包只能在 mac 上打**：electron-builder 不能在 Windows 交叉编 mac(签名/公证/dmg 都依赖 macOS 工具链)。
3. **红绿灯 vs `frame:false`**：mac 千万别再设 `frame:false`，用 `titleBarStyle:'hiddenInset'`，否则没有红绿灯又没自绘按钮 = 无法关窗。
4. **自动更新在 mac 强依赖签名+公证**：没签名的包 electron-updater 会静默失败。
5. **`pnpm install` 后 electron 二进制没下来**：`pnpm approve-builds` 或手动 `node node_modules/electron/install.js`（构建脚本审批门跳过了 electron 的 postinstall）。
6. **`node:sqlite` 需要 Node ≥ 22**：本仓库用 Electron 42(内置 Node 22)没问题；别把 Electron 降级到旧版否则 Routines 库会报 `RoutineSqliteUnavailable`。
7. **中继/后端不用动**：Mac 版直接连同一个 `trail-api.glanger.xyz`；App Key 首次在 App 内「设置 → 生图 → 云端中继」里填（存本地加密），或用 `PI_CLOUD_IMAGE_KEY` 环境变量(dev)。

---

## 附：关键文件速查

| 关注点 | 文件 |
|---|---|
| 窗口/生命周期/托盘/更新 | `src/main/index.ts` |
| 标题栏/窗口按钮 | `src/renderer/src/components/TitleBar.tsx` |
| agent 子进程运行时 | `src/main/pi-client.ts`（跨平台，勿动核心） |
| 沙箱(WSL/Docker) | `src/main/sandbox.ts`、`src/main/sandbox-wsl.ts` |
| 云端中继连接/Key | `src/main/cloud-connection.ts`、`src/main/settings.ts`、`electron.vite.config.ts`(define) |
| Routines DB(node:sqlite) | `src/main/routine-database.ts` |
| Blender | `src/main/blender-setup.ts` |
| 打包配置 | `package.json` → `build` |
| IPC 契约/桥 | `src/shared/ipc/contract.ts`、`src/preload/index.ts`、`src/main/ipc.ts` |
| 云端中继功能(参考新功能怎么加) | main `image-gen.ts` / `model3d.ts`（见 `pi-studio-device-plane`）;原来的换装 `dressup.ts` 2026-09-29 已删 |
