# pi-studio Session Kernel 架构评审

> 日期：2026-09-21  
> 输入：GitHub Engineering《Migrating the GitHub Copilot runtime to Rust, using Copilot》与
> `agent-runtime-session-kernel-github-2026-09-21.md`。  
> 目标：把文章里的生产经验映射到 pi-studio 的真实模块，不把推论伪装成 GitHub 的设计。

## 1. 结论

`Session Kernel` 对 pi-studio 是有用的名称，但它不是一个应该新建的“大总管”模块。
它描述的是 Electron main 中已经存在的一组共同所有权：

- 工作区打开、切换与关闭；
- 会话创建、恢复、激活与回收；
- agent backend 进程所有权与 job 血缘；
- runtime event 到 UI projection 的投影；
- 待审批请求与前后台会话状态；
- 可诊断的启动、终止和清理证据。

当前这组实现主要分布在 `pi-client.ts`、`pi-agent-pool.ts`、
`pi-event-projection.ts`、`session-projection.ts` 与 `agent-runtime.ts`。
近期方向应是**收敛所有权和权威状态**，而不是增加一个只会转发这些模块的新 facade。

## 2. GitHub 原文能证明什么

原文明确支持以下判断：

1. Copilot 的 agent runtime 是多个产品共享的 agentic harness，产品 UI 应构建在它之上。
2. runtime implementation 与 hosting model 是两个维度；同一 runtime 可以 in-process，
   也可以通过 stdio/socket out-of-process。
3. session orchestration 持有可变状态、双向 callback，并贯穿很多子系统，是迁移中耦合最高的部分。
4. GitHub 从纯函数和叶子模块开始，随后迁移 tools、hooks、model clients、MCP，最后处理
   session orchestration。
5. 性能数字是端到端、特定 workload 的结果，不能单独归因于 Rust；移除 Node/V8 启动、
   减少进程与 IPC 同样重要。

原文**没有**把核心正式命名为 `Session Kernel`，也没有证明所有 agent 系统都应该拆成
`Control Plane + Harness + Session Kernel + Runtime Provider + Sandbox`。这套分层是可检验的
架构推论，不是来源事实。

## 3. 对原架构推论的三处修正

### 3.1 Harness 与 Session Kernel 不是上下游产品层

在 pi-studio 中，Pi coding agent 和 ACP agent 已经拥有 agent loop、model interaction、
tool/MCP 行为和 context policy。Electron main 不应再实现一套 harness。

因此两者是嵌套所有权，而不是简单的纵向调用链：

```text
Desktop Session Kernel
  owns: session identity / lifecycle / projection / approval ownership / cleanup
  hosts:
    Agent Backend
      owns: agent loop / model interaction / tools / MCP / context policy
```

Session Kernel 可以托管不同 harness，但不决定 harness 如何思考。

### 3.2 Session 与 control-plane task 不是同一个 durable object

云端 task 是可 lease、可重试、可调度的工作记录；桌面 session 是对话、backend 状态与本机
资源的所有权。二者可以关联，但不能共用一个状态机：

```text
Control-plane task  --dispatch/resume-->  Tool operation / desktop run
        |                                      |
        | durable cloud state                  | local execution evidence
        v                                      v
 task/execution records                  desktop session + artifacts
```

如果强行统一，离线恢复、聊天交互和调度重试会互相污染语义。

### 3.3 Runtime Provider 不等于 Sandbox

Runtime Provider 决定 backend 在哪里以及以何种 hosting model 存活；Sandbox 强制执行安全策略。
一个 provider 可以使用不同 sandbox，一个 sandbox 也可能承载不同 run kind。当前
`RunProfileCompiler` 已把两者编译为同一份可审计启动画像，但概念上仍要分开，避免把
“在 WSL 运行”误当成“已经满足所有权限策略”。

## 4. pi-studio 目标架构

```text
Product surfaces
Renderer IPC / Mobile WebSocket / Routine Scheduler / Eval CLI
                         |
                         v
Application adapters
typed IPC / remote command dispatcher / routine runner
                         |
                         v
Desktop Session Kernel
workspace lifecycle / session activation / backend ownership
jobs + lineage / approvals / projections / recovery coordination
             |                           |
             v                           v
AgentBackend interface             Durable local records
Pi adapter / ACP adapter           Pi session JSONL / ACP index
             |                     runtime events / artifacts
             v
Runtime Host + Run Profile
launch / hosting / audit / cleanup evidence
             |
             v
Execution enforcement
host / WSL+bwrap / seatbelt / Docker
```

### 当前模块映射

| 架构职责 | 当前模块 | 结论 |
| --- | --- | --- |
| Session Kernel 外部 seam | `pi-client.ts` | 保留；逐步减少调用者必须拼装的状态读取 |
| backend 资源所有权 | `pi-agent-pool.ts` | 保留；Pi 与 ACP 的 adopt/cleanup 路径应继续收敛 |
| backend 共同 interface | `pi-agent-entry.ts#AgentBackend` | 是真实 seam，已有 Pi/ACP 两个 adapter |
| live event projection | `pi-event-projection.ts` | 保留为 kernel 内部模块，不暴露给 renderer |
| durable + live UI projection | `session-projection.ts` | 保留为 renderer 唯一会话读取模型 |
| 启动与运行证据 | `runtime-host.ts` | 保留；它是 runtime launcher，不是完整 Session Kernel |
| 安全启动画像 | `run-profile.ts` | 保留；连接 policy 决策和具体执行方式 |
| UI runtime 快照 | `agent-runtime.ts` | 只作为 kernel projection，不作为第二份业务权威状态 |
| 云端调度与 lease | `pi-studio-control-plane` | 不下沉到桌面 Session Kernel |

## 5. 权威状态规则

同一个事实只能有一个 owner，其余都必须是可重建 projection：

| 事实 | 权威 owner | 可重建副本 |
| --- | --- | --- |
| 云任务状态、lease、重试 | control plane database | mobile/desktop task view |
| 当前工作区与活动 session | Desktop Session Kernel | renderer snapshot |
| 对话历史 | Pi session JSONL 或 ACP backend | `SessionProjectionSnapshot.messages` |
| backend 进程与清理状态 | `AgentJobRegistry` | diagnostics snapshot |
| 待审批请求是否仍可响应 | 活着的 `AgentEntry.outstandingUi` | approval projection |
| 启动安全画像 | compiled `RunProfile` + digest | runtime event summary |
| runtime 事件日志 | `runtime-events.jsonl` | diagnostics summary |

`runtime-events.jsonl` 是诊断证据，不应升级为会话内容的第二个事件存储。
Renderer 中的 React state 也不能成为恢复依据。

## 6. 接下来怎么做

### Now：先深化现有模块

1. **定义 kernel snapshot。** 用一次读取返回 workspace、active session、backend capabilities、
   job 状态、projection revision 和仍可响应的 approvals，避免 IPC handler 分别读取多个对象后
   得到撕裂快照。这个 interface 应成为 main 内调用者和测试的主要读取面。
2. **收敛 backend adoption。** Pi 与 ACP 创建后统一进入一个内部 adopt 路径，集中登记 job、
   订阅事件、维护 status、挂接 process observers 和执行 cleanup。差异只留在 adapter 创建阶段。
3. **给 session lifecycle 写行为测试。** 从 kernel interface 验证 start → prompt → approval →
   settle → switch → stop；测试 observable outcome，不直接断言内部数组。
4. **版本化跨仓库 tool operation envelope。** Desktop、control plane、runtime 共用 schema fixture；
   先用契约测试阻止漂移，再考虑抽共享 package。
5. **补 recovery checkpoint。** 明确应用崩溃后哪些对象能恢复、哪些只能标记 interrupted；
   approval 必须 fail closed，后台进程不能凭旧 projection 假装仍受控。

### Next：有真实需求再扩展

- RuntimeHost 支持独立 provider adapter，让本地进程、远程 executor 使用相同 run interface。
- session artifact index 与 tool result envelope 统一摘要、原文、来源和截断信息。
- 按 workspace + session 建立可查询的运行时间线，但仍从权威记录投影，不复制对话存储。
- 用指标验证 process/session 内存、冷启动、恢复耗时后，再决定是否需要共享 backend 进程。

### Postpone：目前属于过度设计

- 把 pi-studio runtime 重写为 Rust；
- 为单机桌面引入 FFI/in-process ABI；
- 任意 Windows/macOS/cloud 之间迁移正在运行的对话进程；
- 把 session 建成通用 distributed object；
- 新建一个同时复制 Pi harness 和 control plane 职责的“Agent OS”。

## 7. Hermes Agent 参考判断

`hermes-agent-daily-2026-09-20.md` 提到的两个 PR 截至 2026-09-21 仍是开放 PR，
因此只能作为设计信号，不能当作已经稳定交付的上游契约。

### 7.1 采用：lifecycle、outcome 与 resource disposition 分离

Hermes 把 durable lifecycle 与 execution outcome 分开，这个方向适用于 pi-studio；但桌面还多一个
Hermes delegation 没有表达的维度：宿主资源是否真的释放。因此不能把 `orphaned` 简单映射为
terminal failure。

```text
Lifecycle
  STARTING / ACTIVE / TERMINAL

Outcome
  SUCCESS / FAILURE / CANCELLED / INTERRUPTED / UNKNOWN

ResourceDisposition
  NONE / OWNED / RELEASED / ORPHANED
```

- lifecycle 回答调度器是否继续等待；
- outcome 回答这次执行产生了什么结果；
- resource disposition 回答进程、文件句柄等资源是否确认释放。

当前 `AgentJobState` 把三者压在 `starting/running/idle/cancelling/done/failed/orphaned`
一个字段中。对于真实进程，`orphaned` 必须继续算 live，因为 force-dispose 失败时进程可能仍在；
对于没有独立资源的 subagent，失败目前只写进 `finishReason`，job 最终仍成为 `done`，这正是后续应
补显式 outcome 的地方。

建议在下一次需要修改诊断契约时，为 `AgentJobSnapshot` 增加可选的 `outcome` 与
`resourceDisposition`，先保持旧 `state` 兼容，再让内部状态机和 UI 逐步改读新字段。不要仅为追随
Hermes 立刻改受保护的跨版本 IPC 契约。

### 7.2 已经具备：unknown effect 的恢复语义

Hermes 文档强调 unknown outcome 下不能盲目重试有副作用的工具。pi-studio 在 tool operation
链路已经有更具体的实现：`unknown_effect`、idempotency key、桌面 receipt ledger，以及
`unknown/dispatched/settled` reconciliation。这里不需要再引入一套通用 delegation receipt；
应该继续把跨仓库 envelope 和 fixture 收敛为单一版本化契约。

Routine 重启恢复也已经通过 `run.interrupted` 把未到终态的 run 收敛为明确结果；审批重启后会
变成 `unavailable`，不会继续伪装为可响应。这些都符合 lifecycle 收敛、原始 outcome 保真的原则。

### 7.3 暂不采用：在 Desktop 新建 Context Engine

Hermes 的 Context Engine interface 对“自己拥有 agent loop 的 runtime”很有价值，但
pi-studio desktop 目前托管 Pi 与 ACP 两种 backend：context selection、model budget、fallback 和
compaction 都属于 backend harness。Desktop 再实现 `ContextEngineV1` 会产生第二个上下文权威源，
也无法可靠修改 ACP agent 内部的上下文。

正确落点是：

- 如果未来 `pi-studio-engine` 自己拥有 agent loop，在 engine 内定义版本化 Context Engine interface；
- Desktop 的 `AgentBackend` 只暴露 capability、只读状态和生命周期事件；
- 上游能提供 committed compaction event 时，再把它标准化为 backend event，供 projection、Memory、
  Eval 与 diagnostics 消费；
- `ModelContext` 只在真正负责组装模型输入的 runtime 内成为权威值对象，Desktop 不复制它。

换言之，应参考 Hermes 的**提交后事件**和**完整预算输入**原则，但不复制其插件 interface 到错误
的进程层。

### 7.4 采用优先级

| 建议 | pi-studio 判断 | 时机 |
| --- | --- | --- |
| lifecycle 与 outcome 分离 | 采用，并额外分离资源释放状态 | 下一次演进 job diagnostics 契约 |
| unknown outcome + reconciliation | 已采用 | 收敛跨仓库 schema 与 fixtures |
| committed compaction event | 条件采用 | Pi/ACP backend 能提供事件后 |
| 完整 `ModelContext` 值对象 | 采用原则 | 在拥有 agent loop 的 engine/runtime 内 |
| Desktop `ContextEngineV1` | 不采用 | 除非 Desktop 将来自己拥有 agent loop |
| 动态反射兼容 plugin 签名 | 不采用 | 新契约直接版本化、加载时 fail fast |

## 8. 设计验收标准

一次改动只有同时满足以下条件，才算在深化 Session Kernel：

- 删除了调用者需要知道的状态或顺序约束，而不是多加一层转发；
- 同一个事实只有一个 owner；
- Pi 与 ACP 的共同生命周期逻辑只实现一次；
- 测试穿过 kernel interface 验证行为，不依赖内部实现；
- renderer reload、workspace switch、backend crash 和 app shutdown 都有明确结果；
- 安全策略的 decision、enforcement 与 evidence 不被混成一个布尔值。

## 9. 一句话版本

pi-studio 不需要复制 GitHub 的 Rust runtime；它需要把已经存在的本地会话编排深化成一个
小 interface、高杠杆的 Desktop Session Kernel，并让 Pi/ACP harness、Runtime Host、Sandbox
和云端 Control Plane 各自只拥有一类权威状态。
