# 沙箱模式（Docker）实现说明

> **状态(2026-07-15 晚更新):WSL2 + bubblewrap 路线已实现并 E2E 通过(v0.3.68),成为沙箱默认执行路径**
> (发行版存在即启用,Docker 仅作回退)。开关默认关闭(Alpine 里跑不了 Windows 构建,按需开启)。
> 实现:src/main/sandbox-wsl.ts + sandbox-proxy.ts;发行版准备命令见 sandbox-wsl.ts 头注释。
> E2E 实录:沙箱内聊天正常;工作区可写/系统路径只读/非白名单出站被代理拦截,三项全过。
>
> 此前状态(2026-07-15 早):Docker 路线封存——开沙箱后聊天完全不可用(容器出网不通),该链路从未通过 E2E。
>
> 原状态:已实现第一版执行链路(v0.3.39 后续开发中)。设置页可探测 Docker、构建版本绑定的镜像;开启后工作区通过 RPC shim 在容器内运行。

## 现状

pi-studio 默认把 pi CLI 作为子进程跑在 Windows 主机上；开启沙箱后，
`src/main/pi-client.ts` 会把 `RpcClient` 的 `cliPath` 切到
`%APPDATA%/pi-studio/sandbox-rpc-shim.cjs`。shim 透明转发 stdin/stdout，
再由 `docker run` 启动容器内的 `pi --mode rpc`。

旧版 `securityGuard` 进程内软拦截已移除：它不是隔离，且设置值与真实启动路径长期不一致。
当前以 `ExecutionSecuritySnapshot` 报告实际 enforcement；未开启沙箱时明确标记为主机 full access。

沙箱容器只挂载当前工作区到 `/workspace`，并挂载 pi-studio 专用的
`agentConfigDir()` 到 `/agent`；API key 等环境变量按名称透传，不把值写进镜像或命令行。
未开启时仍保持原有本机执行行为。

## 关键架构发现（决定可行性）

`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js` 里
`RpcClient.start()` **写死了** `spawn("node", [cliPath, "--mode", "rpc", ...])` ——
命令固定是 `"node"`，`RpcClientOptions` 只有 `cliPath/cwd/env/provider/model/args`，
**没有 command/spawn 覆盖点**。所以不能直接让 RpcClient 去跑 `docker run`。

**但是**：RPC 协议是纯 **LF 分隔 JSONL over stdio**（见 pi 的 `docs/rpc.md`）——
RpcClient 只是管这条 stdin/stdout 管道，所有方法（prompt/getState/getMessages/…）
都操作 `this.process` 的 stdio。

⇒ 只要让 RpcClient 启动的那个 `node <cliPath>` 进程**透明地把字节转发进容器**，
所有方法零改动即可工作。这就是**中继 shim** 方案。

## 方案：中继 shim（复用 RpcClient，改动最小）

1. 打包一个 `docker-rpc-shim.cjs`（~30 行）。沙箱模式下把 `cliPath` 指向它。
2. RpcClient 启动 `node docker-rpc-shim.cjs --mode rpc --provider X --model Y`。
3. shim 读自己的 argv（RpcClient 追加的那些参数），`spawn("docker", ["run","-i","--rm", …挂载/env…, IMAGE, "pi", ...forwardedArgs], { stdio: "inherit" })`，
   把主机侧 stdin/stdout（RpcClient 握着的那对）直接继承给 docker——纯字节管道，shim 不需要解析 JSON。
4. RpcClient 以为自己在跟本地 `node` 说话，实际在跟容器里的 pi 说话。

`PiClientManager.startWorkspace` 里按 `settings.sandboxEnabled` 分叉：
- 关：`cliPath = resolvePiCliPath()`，`env = 主机 env`（现状）。
- 开：`cliPath = <shim 路径>`，env 里塞好给 shim 用的挂载/转发信息（或写进临时配置文件让 shim 读）。

## 需要解决的硬骨头

| 项 | 说明 |
|---|---|
| **镜像** | 需要一个含 node + 对应版本 pi + git + ripgrep 的镜像（pi 现为 **v0.79.10**，见 `docs/containerization.md` 的 `Dockerfile.pi`）。electron-builder 塞不进 Docker 镜像，得首次 `docker build`（拉 npm 装 pi，约几分钟）或 `docker pull` 预构建镜像。版本要跟 pi-studio 捆的一致，否则行为漂移。 |
| **工作区挂载** | `-v <host workspace>:/workspace -w /workspace`。Windows 路径要转 Docker Desktop 接受的形式；WSL2 跨界文件性能/大小写/换行有坑。 |
| **agent 配置目录** | pi-studio 把 models.json 覆盖、审核扩展和 sessions 写在 `agentConfigDir()`（userData/pi-agent）。要 `-v agentConfigDir:/agent` 挂进去 + `-e PI_CODING_AGENT_DIR=/agent`，容器里 pi 才能读到网关覆盖/扩展、且 session 落回主机。 |
| **env 转发** | API key、TAVILY_API_KEY、PI_* 等要用 `-e` 传进容器（注意别把主机绝对路径类的 env 原样带进去）。 |
| **session 目录名** | pi 按 cwd 生成 session 子目录名；容器里 cwd 是 `/workspace`，和主机模式的目录名不同 ⇒ 沙箱/非沙箱模式的历史会分叉（session sidebar 靠 getState().sessionFile 仍能找到当前会话，但两套历史不互通）。可接受，需提示。 |
| **cli 路径** | shim 里用镜像内的 `pi` bin（`docker run … IMAGE pi --mode rpc …`）最省心。 |
| **可用性检测** | 开沙箱前检查 `docker` 在 PATH + daemon 在跑 + 镜像存在；缺则引导用户装 Docker Desktop / 构建镜像。 |
| **不受影响的** | git-diff 读、ComfyUI、云端生图都是 pi-studio **主进程**功能，不是 pi 工具；工作区是共享挂载，主机侧读得到 agent 的改动。 |
| **代价** | 每次开工作区多一次 docker run 启动延迟；容器/WSL2 开销；工具在 **Linux** 里跑（和 Windows 原生工作流有路径/换行差异）。 |

## UI

设置「安全策略」页加一个「沙箱模式（Docker）」开关 + 状态行（Docker 是否可用/镜像是否就绪 + 「构建镜像」按钮）。开关存 `settings.sandboxEnabled`，改后需重开工作区生效。

## 工作量估计

- shim + PiClientManager 分叉 + 挂载/env 组装：中等。
- 镜像检测/构建流程 + UI：中等。
- Windows 路径映射、agentConfigDir 挂载联调、session 目录分叉处理：细节坑多，需实机反复测。
- 总体：**一个完整功能**，不是小改。核心难点在"首次镜像就绪"体验和 Windows/WSL2 挂载联调。

## Windows 上有没有比 Docker 更轻的方式？

**核心事实：Windows 上"真隔离"绕不开虚拟机（Hyper-V）。** Docker Desktop、WSL2、
Windows Sandbox 底层都是 Hyper-V 虚机。Linux 那种内核级、便宜的 namespace/cgroup
容器，Windows 没有对应物（Windows 容器要么重、要么是 Windows 环境）。所以不存在
"又轻又强隔离"的原生方案。

"Docker 重"重的是 **Docker Desktop 常驻的那套**（一个 WSL2 虚机 + daemon），
**不是每个容器**——容器跟那一个虚机共享，`docker run` 边际成本只是启动延迟。

按推荐度排：

| 选项 | 是否真隔离 | 相对 Docker | 说明 / 坑 |
|---|---|---|---|
| **WSL2 直连** | 是（虚机） | 更轻 | 装 Docker 就已有 WSL2。shim 把 `docker run` 换成 `wsl.exe -d <distro> -- pi --mode rpc …`，**架构原封不动**。省掉 Docker Desktop 后台 + 容器层。**坑**：WSL2 默认把 C: 挂到 `/mnt/c`，agent 能写主机 ⇒ 必须关 automount（`wsl.conf [automount] enabled=false`）或只挂工作区，否则等于没隔离。 |
| **Docker** | 是（虚机） | 基准 | 最省心最标准最鲁棒；已装且能用就用它。 |
| **Windows Sandbox** | 是（虚机） | 差不多重且不合适 | Win11 Pro 自带，但一次性重置不留工作区、面向 GUI、跑 Windows 非 Linux（pi 要 bash）、stdio RPC 管道难接。**排除**。 |
| **进程级限制**（低完整性 token / Sandboxie-Plus） | 否 | 最轻（无虚机） | 只降权/减小破坏范围（挡系统路径写入等），不是真隔离；DIY 要写 Win32 原生（CreateProcessAsUser + 受限 token）或依赖 Sandboxie。可做"沙箱-lite"过渡。 |

**结论**：真隔离就选 Docker（已装、稳）或 WSL2 直连（同架构、更轻，但要处理 automount）；
两者对 pi-studio 的改动量几乎一样（都是"中继 shim + 主机侧组命令行"）。真正
"又轻又强"的原生 Windows 方案不存在，不值得耗。

## 其它备选

- **Gondolin 微 VM**：对 pi-studio 改动更小（pi 仍在主机，spawn 加 `-e gondolin` 扩展把工具路由进 Linux micro-VM），但要装 QEMU + Node≥23.6，工具也在 Linux 跑。
- **只强化 securityGuard**：非真沙箱，但零额外环境、当天可用——默认打开 + 扩黑名单 + 可选"危险命令执行前确认弹窗"。可作为真沙箱前的过渡。

## 当前落地状态与后续任务

1. **已完成**：设置开关、Docker/WSL 探测、版本绑定的镜像 tag、镜像构建进度，以及 Docker RPC shim。
2. **已完成**：工作区 `/workspace`、agent 配置 `/agent` 的挂载和 API key/TAVILY/Helicone/代理环境变量透传；Docker 未就绪或镜像缺失时会在打开工作区阶段明确报错。
3. **已完成**：容器返回的 `/agent/...` 会映射回 Windows 主机路径，历史会话列表、切换和导出仍可用；停止工作区时 shim 会把 SIGTERM/SIGINT 转发给 `docker run`，避免后台容器残留；镜像构建请求互斥，重复点击会复用同一次构建。
4. **待验证**：在真实 agent 工作区执行一次 prompt→bash→文件写入，并确认写入范围只落在挂载的工作区；同时补充 Docker Desktop 未运行、镜像构建失败、停止超时的 UI 回归测试。（Docker 路线已封存，该项随之搁置；WSL 路线的等价验证已在 v0.3.68 完成）
5. **后续增强（2026-07-16 已完成三项，E2E 验证）**：
   - ✅ 沙箱开关切换后自动重启当前工作区（`settings:save` 返回 `sandboxChanged`，SettingsModal 触发 App 的 restartAgent）；
   - ✅ 标题栏「沙箱」徽标标注 agent 运行于沙箱（`agent:status` started 事件带 `sandbox: 'wsl' | 'docker'`）；
   - ✅ WSL NAT 网络模式适配（`wslinfo --networking-mode` 探测；非 mirrored 时取默认网关 IP 作为代理地址并把白名单代理绑到该 IP 上，不暴露局域网）。
   - 未做：容器/沙箱 CPU、内存资源策略配置。

## 2026-07-15 复盘与决策

### 实测结论:Docker 链路从未真正工作

开启 `sandboxEnabled` 后,聊天的每一轮 LLM 调用都以 "Connection error" 失败
(pi 自动重试 4 次全灭)。根因:pi 跑在容器里之后,**出站流量要穿
Docker NAT + 主机 Clash TUN 两层**,到 LLM 网关(3a-api)的链路不通;
而主机侧直连/走代理都正常。3D 代码建模、Blender、Routines 等自 spawn 的
agent 会话不走沙箱,所以一直没暴露。排查记录:先做了网关探活(401/200)、
Clash 代理对比、node 与 electron-as-node 双运行时手跑 pi CLI(全通),
最后才从 "Launching pi inside Docker sandbox" 日志定位——**教训:先读日志再做网络二分**。

结构性问题(不是配置能救的):

1. 容器网络在国内环境(Clash TUN)天然脆弱,而 agent 的命根子就是连网关;
2. Docker Desktop 是重依赖(Hyper-V/WSL2 虚机 + 常驻 daemon),分发场景劝退;
3. 中继 shim 架构本身没问题,但都是在给错误的地基打补丁。

### 决策

1. **沙箱开关保持默认关闭,Docker 执行链路封存**(代码保留,不再投入)。
2. **重启条件**:当 Routines 无人值守工作流成为核心用法、或 pi-studio 开始对外分发时,
   沙箱才值得再投入——届时**不修 Docker,按下面优先级重做**。
3. **首选:WSL2 + bubblewrap(官方 Linux 路线,今天就成熟)**——本地有 WSL2 时的正解:
   - 架构:中继 shim 原封不动,`docker run` 换成
     `wsl.exe -d <distro> -- bwrap <mount/net 限制> pi --mode rpc …`;
   - 文件隔离:**保留 automount,靠 bwrap 的 mount namespace 只暴露工作区**
     (比"关 automount 藏主机"干净,补上 Windows 最弱的文件隔离);
   - 网络:pi 出网强制走**主机侧白名单代理**(mirrored networking 下 localhost 直通主机)——
     LLM 流量实际从 Windows 主机进程出网,彻底绕开"虚拟网络 × Clash TUN"的脆弱路径,
     根治本次断网一类的问题;
   - 依赖:只要 WSL2 + 发行版 + 里面装 node/pi/bwrap(无 Docker Desktop、无镜像构建);
     `sandbox:detect` 已有 WSL 探测;
   - 坑:mirrored networking 要 Win11 22H2+(NAT 模式下主机代理要走网关 IP,需探测适配);
     发行版内 pi 版本要与 app 对齐;session 目录按 cwd 分叉(已知可接受)。
4. **将来更好的形态:srt Windows 原生**(Claude Code 同源,
   [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)):
   低权限账户 + WFP ALE_AUTH_CONNECT 内核过滤 + 本地白名单代理,无虚机、免 WSL2 依赖。
   暂不动手:experimental、装 WFP/建账户要管理员权限、文件隔离靠 ACL 偏弱。
   等它毕业或 Claude Code 原生 Windows 沙箱落地
   ([feature request #46740](https://github.com/anthropics/claude-code/issues/46740))再评估替换。
5. **轻量级过渡(可选,20% 成本 80% 收益)**:给 Routines 的 agent 会话注入
   `HTTP_PROXY/HTTPS_PROXY` 指向 pi-studio 内置的白名单代理(只放行 LLM 网关等认可域名)。
   非强制隔离(恶意代码可绕),但对"agent 犯傻乱连"够用,与 securityPolicy 设置天然衔接;
   将来切 srt 时这个代理直接升级为 WFP 背后的代理,投资不浪费。

---

## macOS 沙箱现状与选型（2026-08-23 实测）

### 现状:mac 上开沙箱等于开 Docker,而 Docker 这条是封存的

- `sandbox.ts` 的 WSL 探测在非 Windows 直接返回不可用,所以 mac 只会走 **Docker 回退**。
- 设置页那段「整盘只读 + 域名白名单代理」的文案描述的是 **WSL/bwrap 专属**能力
  (`sandbox-wsl.ts` + `sandbox-proxy.ts`)。`buildSandboxDockerArgs` 里**一个网络参数都没有**,
  容器拿默认 bridge 网络,**出站完全不受限**。文案已按平台分支(2026-08-23)。
- 而 Docker 链路正是上面复盘里封存的那条:容器出网不通、聊天每轮 Connection error,
  从未通过 E2E。**在 mac 上开沙箱,大概率直接把聊天弄挂。**

结论:**现阶段 mac 上不要开这个开关**,除非要跑不信任的代码且愿意自己趟 Docker。

### macOS 原生沙箱是有的:Seatbelt(`sandbox-exec`)

macOS 自带 `/usr/bin/sandbox-exec`,能力与 Linux 的 bwrap 对位。本机实测
(macOS 26.5.1 / Darwin 25.5,profile 见下)全部通过:

| 验证项 | 结果 |
|---|---|
| 工作区内写入 | ✅ 允许 |
| 工作区外写入 | ✅ 被拒(`Operation not permitted`),原文件未被改动 |
| 系统路径读取 | ✅ 允许(等价 bwrap `--ro-bind / /`) |
| `(deny network*)` 后直连外网 | ✅ 被拒(curl 返回 000) |
| 只放行 `localhost:<代理端口>` | ✅ 该端口通,外网不通,**其它 localhost 端口也不通** |

最后一行是关键:**WSL 那套「出站强制走主机侧白名单代理」的设计,在 mac 上原样成立**,
`sandbox-proxy.ts` 可以直接复用,不用重写。

实测用的 profile 骨架:

```scheme
(version 1)
(deny default)
(import "system.sb")
(allow process-exec* process-fork)
(allow file-read*)                                  ; 整盘可读
(allow file-write* (subpath (param "WS")))          ; 只写工作区(agent 目录同理再加一条)
(deny network*)
(allow network-outbound (remote ip "localhost:18923"))  ; 只放行白名单代理端口
```

注意:`sandbox-exec` 的 man page 标了 deprecated,但系统仍在用它(Chrome、Claude Code
都走这条),短期不会消失。

### 选项对比

| 方案 | 文件隔离 | 网络管控 | 依赖 | 启动开销 | 评价 |
|---|---|---|---|---|---|
| **不开(现状)** | 无 | 无 | 无 | 0 | 功能不受影响,只是没隔离。当前默认 |
| **Docker 回退** | 有(只挂工作区+agent 目录) | **无** | Docker daemon + 构建镜像 | 每次开工作区一次 `docker run` | 已封存,出网问题未解,不推荐 |
| **srt(推荐)** | 有 | **有**(域名白名单代理) | mac 侧只要 ripgrep | 进程级,无虚机 | 见下 |
| **自写 Seatbelt profile** | 有 | 有(自接 `sandbox-proxy.ts`) | 无 | 进程级 | 可行但要自己维护 profile |

### 推荐:srt(anthropic-experimental/sandbox-runtime)

[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) 就是 Claude Code
自己那套,上面复盘里已经为 Windows 记过一笔。**它在 mac 上的实现正是本节实测的形状**:

- macOS:`sandbox-exec` + 动态生成 Seatbelt profile;
- 网络:HTTP 代理做域名白名单 + SOCKS5 兜其它 TCP,**macOS 侧就是限制到 localhost 端口**;
- Linux:bubblewrap;Windows:alpha,专用本地账户 + WFP;
- **mac 依赖只有 ripgrep**——没有 daemon、没有虚机、没有镜像构建;
- 提供 CLI(`srt`)和 TS 库(`SandboxManager`)两种接法。

对 pi-studio 的接法与现有架构一致:中继 shim 不动,把 `docker run …` 换成
`srt … pi --mode rpc …`(或用 `SandboxManager` 在 main 里包一层),
`sandbox-proxy.ts` 的白名单代理继续用。

### 已落地(2026-08-23)

**macOS 走 Seatbelt,不走 Docker。** `src/main/sandbox-seatbelt.ts`:

- `prepareSandboxLaunch` 第一条分支就是 `detectSeatbelt()`,mac 上永远不会落到 Docker;
- 沿用中继 shim 架构:`cliPath` 指向 `sandbox-seatbelt-shim.cjs`,那个进程再
  `spawn('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, realCli, ...argv])`,
  stdio 原样继承 —— RpcClient 零改动;
- profile 用 `(allow default)` 打底再 `(deny file-write*)` 收窄,只放行
  **工作区 / agent 目录 / 临时目录** 三个 subpath 加 stdio 设备。
  不用 `(deny default)` 全量白名单:那要把 mach 服务、sysctl、IPC 一条条列全,
  漏一条就是难查的运行时故障,而我们要的只是"别写工作区外面";
- 临时目录必须放行:node 要用,粘贴图桥(pi-studio-imagegen 扩展)也写在那里;
- `sandboxAgentPath` 对 seatbelt 是恒等 —— 同一个文件系统,没有命名空间转换;
- `securitySnapshot` 报 `backend: 'macos-seatbelt'`、`filesystemMode: 'workspace-write'`、
  `networkMode: 'allowlist'`(2026-09-27 起出站也收敛,与 WSL 一致);
- 标题栏徽标显示「沙箱·仅工作区可写」。

**网络已收敛**(2026-09-27):Seatbelt 现在与 WSL 走同一套白名单代理 —— `buildSeatbeltProfile`
在给出 `proxyPort` 时加 `(deny network*)` + 只放行 `localhost:<代理端口>`,shim 注入
`HTTP_PROXY/HTTPS_PROXY`;`prepareSeatbeltSandboxLaunch` 启动 `sandbox-proxy.ts` 后必传该端口。
代价与 WSL 一致:白名单外的域名一律 403。内置名单之外需要放行的域名,在 设置 → 安全策略
的「额外放行域名」里按行填写(`settings.sandboxAllowedHosts`),保存后重启工作区生效。

**验证**(`src/main/sandbox-seatbelt.test.ts`,非 darwin 自动跳过):profile 形状 7 项 +
真调 `sandbox-exec` 7 项 —— 工作区可写、区外写入被拒且原文件未改、区外删除被拒、
系统路径可读、**只读工作区写入被拒**、**非白名单出站被拒且放行的 localhost 代理端口可达**,
以及**真实 pi CLI 在沙箱里能启动**(Docker 那条正是死在这一步,而且从来没人真跑过)。

**WSL 验证**(`src/main/sandbox-wsl.test.ts`,发行版就绪时真跑,否则跳过):`buildWslBwrapArgs`
形状 2 项 + 真调 `wsl.exe … bwrap` 5 项 —— 工作区可写、区外写入被拒且原文件未改、系统路径可读、
**只读工作区写入被拒**、**真实 pi CLI 在沙箱里能启动**。

### 若要进一步收紧,待办

1. ~~复用 `sandbox-proxy.ts`,把 `(deny network*)` + `(allow network-outbound (remote ip "localhost:<port>"))`
   加进 `buildSeatbeltProfile`,并给 shim 注入 `HTTPS_PROXY`。~~ 已完成(2026-09-27)。
2. ~~先摸清实际需要的域名(github、各类文档站、非 npm 源的包管理器),否则一开就到处 403。~~
   已提供设置页「额外放行域名」,用户可自助补名单(2026-09-27)。
3. 补 E2E:非白名单出站被拦(照 WSL 的验收标准)。

**要不要换成 srt?** [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
在 mac 上就是 `sandbox-exec` + localhost 白名单代理,和上面自建的是同一套原语,
额外带来的是现成的域名白名单代理和跨平台一致性(Linux bwrap / Windows WFP)。
自建这版已经能跑且零依赖;等要做网络收敛时再评估是否换过去更划算。

---

## 无人值守 routine 的工作区隔离（2026-09-27）

Routine 的 agent 节点默认以 `routine.workspacePath` 为 cwd、工具集含 `edit,write`，所以无人值守
运行**能改真实仓库**。现在 Routine 有 `workspaceMode: 'read-write' | 'read-only' | 'isolated'`
（默认 read-write，不改旧行为）：

- **read-only**：agent profile 去掉 `edit,write`（routine 没有 shell 工具，去掉写工具即去掉
  agent 侧的写能力）；开了沙箱时**工作区只读挂载**——WSL 靠整盘 `--ro-bind / /` 且不额外 bind
  工作区；Seatbelt 把工作区移出可写 subpath；Docker 挂 `:ro`。`ExecutionSecuritySnapshot.filesystemMode`
  报 `workspace-read-only`（无沙箱时仍是 `danger-full-access`，只有工具集被收窄，reason 里说明）。
- **isolated**：run 开始时把工作区按**当前工作树**（含未提交改动）拷进
  `userData/routine-runs/<runId>/workspace`（过滤 `.git` / `node_modules` / `dist` / … 重目录），
  同时记下初始状态的 `manifest.json`（path→sha1）。agent 只在这个一次性副本里跑；跑完变更 =
  **副本 vs manifest**（不是 vs 当前源），所以运行期间用户的并发编辑不会被算成 agent 改动。有变更
  就**保留副本**，在例程页的「隔离变更待处理」面板里可**一键应用**（全量、逐文件校验冲突：源文件自
  run 开始被外部改过的跳过并报告，绝不覆盖）或**丢弃**；无变更自动清理。变更清单也写进 run summary
  与 terminal journal（`changedFiles`）。启动按 7 天保留期清理旧副本（见
  `src/main/routine-isolation.ts`）。不用 `git worktree`：worktree 只含 HEAD、不含未提交改动。
- 两种模式都只作用于 **agent 节点**：确定性节点（`export` / `imagegen` / `folder-input` / …）仍走
  真实工作区。

设置页的工作流编辑器有对应三态开关；隔离副本的变更在例程页应用 / 丢弃。
