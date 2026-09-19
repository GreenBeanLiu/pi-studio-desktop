# AGENTS.md

## 项目概览

- **pi-studio** — Pi coding agent 的桌面客户端（Electron 42 + React 19 + TypeScript）
- 主分支 `master`，remote `GreenBeanLiu/pi-studio-desktop`
- 包管理器锁定 `pnpm@10.6.1`（`package.json` 的 `packageManager` 字段）
- 架构与专题设计见 `docs/`，UI 改造方案见根目录 `优化.md`

## 目录结构与进程边界

```
src/main/          Electron 主进程 —— 文件系统、子进程、pi-agent 运行时、沙箱
src/preload/       仅 index.ts —— contextBridge 桥，唯一的跨进程出口
src/renderer/src/  React 渲染进程 —— 无 Node 能力
src/shared/        两侧共用的纯类型与纯函数
src/shared/ipc/    IPC 单一契约源（contract.ts + validators.ts）
tests/             跨模块 / 集成测试 + fixtures
scripts/           构建、发布、eval、编码检查
docs/              架构与专题文档
```

### 依赖方向（单向，不可逆）

```
src/shared    → 零依赖：不 import main / preload / renderer，不 import electron
src/preload   → 只能 import src/shared
src/main      → 只能 import src/shared
src/renderer  → 只能 import src/shared；跨进程一律走 window.api
```

- renderer **禁止**直接 import `src/main/**` 或 `electron`。当前代码库是干净的（零处违规），不要成为第一个
- renderer 拿主进程能力只有一条路：`window.api`，类型来自 `src/shared/ipc/contract.ts`
- `src/renderer/src/lib/api.ts` 只做兼容再导出，**不新增逻辑**

## IPC 契约规则

`src/shared/ipc/contract.ts` 是 `DesktopApi` 及其全部请求/响应类型的**唯一**定义处。

- preload **不手写桥**：`src/preload/index.ts` 只维护一份 `METHODS` 方法清单，channel 名按 `命名空间:方法名` 推导（`settings.save` → `settings:save`），桥在启动时批量生成
- 该清单被 `DesktopApi` 反向约束：漏一个方法、拼错一个名字、少一个命名空间都编译失败（报错直接点名）
- **新增一个 IPC 方法 = 改两处**：`contract.ts` 加类型签名，`METHODS` 加方法名。channel 字符串不再手写，也就拼不错了
- 订阅方法用 `on` + 大写开头识别，channel 默认是 `命名空间:事件名`；`pi.onStatus` / `onRuntime` / `onAgentStatusSnapshot` 挂在 `agent:` 下，走 `EVENT_CHANNEL_OVERRIDES`
- renderer 直接用 `Window.api: DesktopApi`，**不允许手写第二份类型**
- **新增字段一律先加成可选字段**。自动更新期间新旧 renderer/main 会短暂并存，必填字段会让旧端直接炸
- 主进程侧的入参校验集中在 `src/main/ipc-contracts.ts`（`requiredString` / `parseProfile` 这套），新 handler 的参数校验走这里，不要在 handler 里散写
- `ipcMain.handle` 的注册按功能分布：通用的在 `src/main/ipc.ts`（60 个），其余跟着功能模块走（`routines.ts` / `image-gen.ts` / `model3d.ts` / `sandbox.ts` / `dressup.ts` / `blender-model.ts` / `channels.ts`）

## 命名与文件约定

| 位置 | 命名 | 例 |
|------|------|-----|
| `src/main`、`src/shared` | kebab-case | `agent-runtime.ts` |
| `src/renderer` 组件 | PascalCase | `ChatPane.tsx` |
| 单元测试 | 与被测文件**同目录同名** | `agent-runtime.ts` ↔ `agent-runtime.test.ts` |
| 回归测试 | `<模块>.<bug 特征>.regression.test.ts` | `ChatPane.projection-overwrite.regression.test.ts` |

### 测试布局

- **测试与源码同目录**。`src/` 下 72 个 `.test.ts` 全部如此，**不要**新建 `__tests__/`
- `tests/` 只放跨模块 / 集成测试。目前 4 个：`network-policy` `imagegen-extension` `codex-sessions-extension` `model-z-fighting`
- **修 bug 必须留一个 `.regression.test.ts`**，文件名描述 bug 而不是功能（现有 12 个）。这样六个月后看文件名就知道当初在防什么

## 提交前必过

```bash
pnpm run verify
```

= `check:text` → `typecheck` → `test` → `lint` → `build`。迭代中途可以只跑 `pnpm run check`（省掉 build）。

### check:text 是什么

`scripts/check-text-encoding.js` 扫 `src` / `docs` / `scripts` / `package.json`，抓 GBK↔UTF-8 转换残留的乱码字符。**这条不是洁癖，是历史伤口**——看到中文变成「閰嶇疆」这种就是它抓的东西。写文件时确保 UTF-8，不要用会重编码的工具改中文文件。

## 已知地雷（别重新踩）

### 1. master 自带红测试

`origin/master` 上有 2 个测试在 Mac 上就是红的，**不是你改坏的**。动手前先跑一次 `pnpm test` 记下基线，之后只对比**新增**的失败。别花时间修基线里的那两个。

### 2. Mac 版永远不会自动更新

| 命令 | publish |
|------|---------|
| `pnpm run package` / `package:win` | `--publish always`（GitHub Release） |
| `pnpm run package:mac` | `--publish never` |

`.github/workflows/release.yml` 里**只有 windows job**。所以 Mac 上装的 pi-studio 收不到 electron-updater 推送，只能本地 `pnpm run package:mac` 手打。流程见 `docs/release-local.md`。
→ 讨论"用户会自动收到修复"时，记得这句只对 Windows 成立。

### 3. lockfile 分叉 / pnpm 版本不一致 ⚠️

- `package.json` 钉的是 `pnpm@10.6.1`
- 但 `.github/workflows/verify.yml` 和 `release.yml` 的 `pnpm/action-setup` 都写的 **11.9.0**

如果 `pnpm install` 后 `pnpm-lock.yaml` 出现大片 diff 但依赖版本没变，**是工具版本差异，不是依赖变了——别提交那份 diff**。碰依赖前先确认本地 pnpm 版本；要统一的话两边一起改，别只改一边。

### 4. 打包白名单是显式的

`package.json` 的 `build.files` 是白名单，`asar: true`（由 `asar-packaging.regression.test.ts` 锁定）。新增需要进产物的资源（`resources/pi-skills/**` 这类）**必须同步加进白名单**，否则开发环境好好的、装出来的包缺文件。

## 核心资产 —— 改动需先说明理由并等确认

以下文件构成安全边界和跨版本兼容面，**不要顺手改**：

- `src/shared/ipc/contract.ts` — 跨版本兼容面
- `src/main/sandbox.ts` / `sandbox-seatbelt.ts` / `sandbox-wsl.ts` / `sandbox-proxy.ts`
- `src/main/approval-gateway.ts` / `approval-audit.ts`
- `src/main/network-policy.ts`

## 联动规则（改 A 必须同步 B）

| 改动 | 必须同步 |
|------|---------|
| `src/shared/ipc/contract.ts` | `src/preload/index.ts` 实现 + `src/shared/ipc/validators.test.ts` |
| 新增 IPC handler | 对应功能模块的 `ipcMain.handle` + `contract.ts` + preload + `src/main/ipc-contracts.test.ts` |
| 新增 routine 节点类型 | `src/main/routine-node-registry.ts` + 同名 `.test.ts` |
| 新增通知渠道 | `src/main/channels.ts` 加一个 adapter case，**不碰执行器** |
| 新增需打包资源 | `package.json` 的 `build.files` 白名单 |
| 架构性改动 | `docs/architecture.md` |

## 代码风格

- **注释用中文**（现状 133/206 个源文件如此）
- **模块头注释写「为什么」，不只写「做什么」。** 本仓库的范本：
  - `src/shared/ipc/contract.ts` — 讲清了单一契约源的三个受益方，以及"为什么新字段必须可选"
  - `src/main/channels.ts` — "渠道是配置数据，不是代码分支；加渠道 = 加一个 adapter case，不碰执行器"

  写完一个模块问自己：半年后的人（或 agent）只读这段头注释，能不能正确使用它、并且知道哪些改法是错的？
- 不建外部常量文件，配置内联或做成参数
- TypeScript 严格模式，别用 `any` 绕过类型错误
