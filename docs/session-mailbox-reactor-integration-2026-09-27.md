# Desktop × Session Mailbox / Reactor 集成架构

> 日期：2026-09-27  
> 范围：`pi-studio-desktop` 与 `pi-studio-control-plane` 的职责边界和后续接入顺序。  
> 权威契约：Mailbox 的表结构、租约、fencing 和队列语义属于 Control Plane；本文只定义 Desktop 如何与它协作。

## 1. 一眼看懂整体入口

```text
用户入口
  ├─ Desktop 聊天 / 审批 / steer
  ├─ Mobile
  └─ GitHub / API / Routine
             │
             ▼
┌──────────────────────────────────────────────────────────────┐
│ Control Plane                                                │
│                                                              │
│ Task / Execution Queue        Session Mailbox / Reactor       │
│ 选择“哪个任务现在运行”  ───►  决定“这个 session 下一条处理什么” │
│                              control > resume > normal        │
└───────────────────────────────┬──────────────────────────────┘
                                │ dispatch tool operation / run
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ pi-studio-desktop                                            │
│                                                              │
│ Remote Control / typed IPC                                   │
│              │                                               │
│              ▼                                               │
│ Desktop Session Kernel                                       │
│ workspace / active session / backend ownership / projection  │
│              │                         │                     │
│              ▼                         ▼                     │
│ AgentBackend (Pi / ACP)          Tool Gateway                │
│ 本地对话与 agent loop             shell / file / desktop tool │
│              └──────────────┬──────────┘                     │
│                             ▼                                │
│                    Runtime Host + Sandbox                    │
└─────────────────────────────┬────────────────────────────────┘
                              │ receipt / tool_result / status
                              └──────────────► Control Plane resume
```

入口不在图中央：用户请求总是从最上方进入。Control Plane 先决定任务和会话内顺序；只有需要本机能力时，才进入 Desktop。

## 2. 两个“Session”不是同一个对象

名称相近，但生命周期不同：

| 概念 | 权威 owner | 管什么 | 不管什么 |
| --- | --- | --- | --- |
| Control Plane session mailbox | Control Plane SQLite | `control`、`resume`、`normal` 的持久顺序、claim、lease、重试和 fencing | Desktop backend 进程、聊天 JSONL、本机资源释放 |
| Desktop Session Kernel | Electron main | 当前 workspace、活动会话、Pi/ACP backend、审批投影、本机 job 与 cleanup | 云任务 lease、跨任务调度、Mailbox 消费顺序 |

二者通过稳定标识关联，例如 task/execution/session/operation id；不能共享一个状态机，也不能把任意一边的 projection 当成另一边的权威状态。

## 3. Mailbox 三条 lane 与 Desktop 的关系

```text
control lane  用户 steer / cancel / policy change
      │        未来需要快速影响正在运行的 turn
      ▼
resume lane   Desktop tool_result / approval result /异步恢复
      │        必须携带稳定 operation id 与幂等证据
      ▼
normal lane   新用户 turn / 普通任务输入
               维持会话内 FIFO
```

优先级由 Control Plane Reactor 决定。Desktop 不维护第二份优先队列，也不根据到达时间自行猜测 `control > resume > normal`。

Desktop 只负责：

- 接收已被 Control Plane 选中的操作；
- 按本机 workspace、capability、approval 和 sandbox 规则再次 fail closed；
- 返回可持久化、可去重的 receipt/result；
- 在资源真的释放前保持 job/resource 状态真实，不用“消息已回复”冒充“进程已收敛”。

## 4. 当前状态

Control Plane 已完成 Mailbox Foundation：durable enqueue、严格 lane 映射、每 lane FIFO、priority fairness、单 writer lease、续租、过期恢复、fencing、幂等和 poison item 终态处理。

但生产路径尚未切到 Mailbox：

- 旧入口与旧执行路径仍是权威路径；
- 下一步是 M0 shadow，只做双写、投影、指标和对账，不允许触发第二次真实执行；
- Foundation 默认只消费 `normal`；`resume` 和 `control` 要等各自阶段显式启用；
- Desktop 当前不需要为了 M0 新建本地 mailbox、队列或 Reactor。

Desktop 已具备后续接入所需的基础：

- `RemoteControl` 接收 control-plane 的 tool operation；
- Tool Gateway 支持 scoped shell 与本地文本文件操作；
- receipt ledger 与 `unknown_effect` 语义用于副作用对账；
- Desktop Session Kernel 拥有 backend、projection、job lineage 和 cleanup；
- Runtime Host / Run Profile / Sandbox 负责本机启动和执行约束。

## 5. Desktop 后续开发顺序

### D0：保持兼容，不参与 M0 shadow

- 不改变现有 ToolOperation 行为；
- 不把 Control Plane mailbox 表或调度算法复制到 Desktop；
- 契约字段新增时保持 optional，兼容自动更新期间的新旧版本组合。

### D1：收敛 resume envelope

在 Control Plane 进入 M2 前完成：

1. 对齐 operation id、execution id、session id 和 idempotency key 的含义；
2. Desktop receipt/result 保留 settled、unknown effect 和重复请求证据；
   **已落地（2026-09-27）**：`executeToolOperation` 现在按 operationId 幂等——已结算则复用结果
   （不再产生第二次副作用）、同一 operationId 换参数拒绝（`OPERATION_ID_REUSE`）、处理中重发拒绝
   （`OPERATION_IN_FLIGHT`）。见 `src/main/remote-command-dispatch.ts` 与 `tool-receipts.ts`
   （`hashToolArguments`）。这落实了 §6「transport 重试不能产生第二次工具副作用」。
3. 用跨仓库共享 fixture 做契约测试，先阻止漂移，再考虑共享 package；
4. 重连或进程重启后不凭 renderer state 伪造成功结果。

### D2：接入 control / steer

在 Control Plane 进入 M3 时完成：

1. Desktop 用户动作写入 Control Plane 的 control ingress，而不是直接修改云端执行状态；
2. 明确 `steer`、`cancel`、`interrupt` 的接收确认与最终结果是两类事件；
3. Desktop Session Kernel 只执行本机生命周期动作，并回传资源释放结果；
4. 测量从 enqueue 到当前 turn 可观察到 steer 的 interrupt latency。

### D3：GatewayMux

等 normal、resume、control 三条链路分别稳定后，再统一 transport routing、连接状态和背压观测。GatewayMux 只统一传输入口，不吞并 Control Plane Reactor，也不吞并 Desktop Session Kernel。

## 6. 必须守住的不变量

- `execution_queue` 管任务/attempt；Session Mailbox 管 session 内事件；Desktop Session Kernel 管本机资源。
- Control Plane 的 durable history 是云任务事实；Desktop JSONL/runtime events 是本机会话与诊断事实。
- Desktop 不读取或写入 Control Plane SQLite。
- transport 重试不能产生第二次工具副作用；无法证明结果时保留 `unknown_effect`，不能盲目重跑。
- workspace、capability、approval 和 sandbox 校验在 Desktop 仍需执行，不能因为上游已排队就跳过。
- renderer 只消费 projection，不拥有恢复状态。

## 7. 文档入口

Desktop：

- [整体架构](architecture.md)
- [Session Kernel 架构评审](session-kernel-architecture-2026-09-21.md)
- [Tool Gateway v1](contracts/tool-gateway-v1.md)

Control Plane（权威来源）：

- [Session Mailbox / Reactor 提案](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/docs/proposals/session-mailbox-reactor.md)
- [Session Mailbox v1 契约](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/docs/contracts/session-mailbox-v1.md)
- [开发计划 v2](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/docs/development-plan-2026-09-21-v2.md)

