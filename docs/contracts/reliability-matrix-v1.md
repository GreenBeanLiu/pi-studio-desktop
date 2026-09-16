# Reliability Matrix Contract v1

日期：2026-09-15。实现位于 pi-studio-control-plane（Native ToolTransport / ToolOperationWorker /
`tests/test_native_tool_recovery_regression.py`）。
本文件为 Desktop docs SoT 镜像；权威行为以 Runtime 实现与
[`tests/fixtures/reliability-matrix-v1.json`](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/tests/fixtures/reliability-matrix-v1.json)
为准。

## 目的与范围

把既有 Runtime **原生工具恢复矩阵**提升为跨仓契约：统一词汇、稳定 `scenario_id`、fixture
与自动化测试映射。本契约描述 Runtime **已经实现且已被恢复回归测试覆盖**的行为，供
Web / Mobile / Desktop / 脚本共用同一套语义。

模式对齐 Slice E [Workspace Identity v1](workspace-identity-v1.md) / [Target Resolution v1](target-resolution-v1.md)：
**docs + fixtures + tests mapped to scenario_ids**；本轮不改生产恢复行为、不改
deadline / idempotency wire 语义。

本版本范围：

- 术语：`waiting_for_async_tool`、`tool.expired`、`tool.gateway_waiting`、`lease`、
  `idempotency_key`、`deadline`、`unknown_effect`、`tool.effect_unknown`、`tool.reconciled`、`receipt`（09-16）
- 自动化场景表：每个已由 Runtime `test_native_tool_recovery_regression.py` 覆盖的行对应稳定
  `scenario_id`（09-15 锁定 12 条，09-16 加 4 条，共 **16** 条）
- Fixture + 薄测试：断言每个 `scenario_id` 被现有恢复回归引用/覆盖

## 术语

| 术语 | 含义 |
| --- | --- |
| `waiting_for_async_tool` | 任务状态：Runtime 已创建本地 tool operation，正在等待桌面/网关交付结果。不是设备在线状态，也不是 Mobile 自行推导的终态。 |
| `tool.gateway_waiting` | 任务事件：gateway 离线或瞬时环境失败，operation 保持 pending，短退避后重试直至 gateway 恢复或 deadline 到期。 |
| `tool.expired` | 任务事件：pending/leased operation 在 claim 前（或等价路径）超过 `deadline_at`，记失败并恢复任务，模型收到失败 tool result。 |
| `lease` | Worker 对 operation 的租约占用。租约过期后可由新 worker 接管；旧 lease owner 的迟到结果不得覆盖新结果。 |
| `idempotency_key` | v2 operation 幂等键。相同 task + 相同内容 + 相同 key → 返回原 operation；相同 key 但内容变更 → 冲突拒绝。本契约不改动该 wire 语义。 |
| `deadline` / `deadline_at` | v2 operation UTC 截止时间（当前实现约五分钟）。到期产生 `tool.expired` 与失败恢复；桌面亦独立拒绝过期命令（如 `DEADLINE_EXPIRED`）。本契约不改动该 wire 语义。 |
| `unknown_effect` | operation 第三个未完成态（2026-09-16）：命令已发到桌面、结果没回来。只对有副作用的操作（`local.write`、非 `shell_read` 的 shell）；Runtime 不重发、不算成功、不恢复模型，等桌面回来问回执。 |
| `receipt` | **桌面的义务**：账本对一条 `operationId` 的回答（[Tool Gateway v1 §8](tool-gateway-v1.md)）：`unknown` / `dispatched` / `settled`。能力清单 `toolGateway.receipts: 1` 表示这台桌面记账。 |
| `tool.effect_unknown` / `tool.reconciled` | Runtime 事件：进入 `unknown_effect`；用回执定性（`settled` 取回执结果 / `not_received` 回 pending 重发）。 |

相关事件/状态（恢复矩阵常用，非本轮新词汇）：`tool.waiting`、`tool.result`、
`native.loop_detected`、operation `pending` / `cancelled` / `failed`。

## 自动化场景表（锁定）

权威机器可读表：Runtime
[`tests/fixtures/reliability-matrix-v1.json`](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/tests/fixtures/reliability-matrix-v1.json)。
覆盖映射测试：Runtime `tests/test_reliability_matrix_contract.py`（映射到
`tests/test_native_tool_recovery_regression.py`，不重写行为断言）。

| scenario_id | 场景摘要 | 期望要点 |
| --- | --- | --- |
| `loop_stop_retry_complete_transcript` | 新版循环停止后显式重试 | 调用/结果配对完整；重试可完成；不重放已完成桌面操作 |
| `loop_stop_retry_legacy_missing_result` | 旧版停止记录缺结果后重试 | 补齐拒绝结果后再续跑；不重放已完成操作 |
| `serial_reset_on_server_tool` | 服务器工具打断串行本地调用 | 无 `native.loop_detected`；后续本地调用开新序列 |
| `serial_reset_on_invalid_call` | 无效调用打断串行计数 | 同上 |
| `serial_reset_on_parallel_batch` | 并行批次打断串行计数 | 批次一次 checkpoint；串行计数重置 |
| `offline_before_claim_then_reconnect` | claim 前桌面离线再恢复 | 等待期 `waiting_for_async_tool` + `tool.gateway_waiting`；恢复同一 operation/`idempotency_key` |
| `transport_disconnect_then_reconnect` | 传输失败后再恢复 | 同上（environment_failure 路径） |
| `cancel_while_pending_rejects_late_result` | pending 时取消 | 任务/operation cancelled；迟到结果不恢复模型 |
| `cancel_while_leased_rejects_late_result` | leased 时取消 | 同上（含 lease owner） |
| `offline_deadline_expire_late_success_rejected` | 离线直至 deadline | operation failed；失败 tool result 只恢复一次；迟到成功不覆盖 |
| `duplicate_result_delivery_idempotent` | 完成前后重复回传 | 保留首次结果；不重复调模型；`tool.result` 一次 |
| `expired_worker_lease_recovered_stale_rejected` | worker 租约过期被接管 | 新 worker 执行；旧 worker 结果拒绝 |
| `write_dispatched_then_lost_ack_reconciled_from_receipt` | 写操作发出后 ack 丢失，桌面回执 `settled` | `unknown_effect`；不重发、不恢复模型；回执结果即结果；桌面只执行 1 次 |
| `write_dispatched_never_reached_desktop_reexecuted` | 写操作发出后 ack 丢失，桌面回执 `unknown` | 回 pending，同一 operation / `idempotency_key` 重发 |
| `write_dispatched_lost_ack_without_receipts_expires_effect_unknown` | 写操作发出后 ack 丢失，桌面不记账（老版本） | 等到 deadline，失败结果 `code=EFFECT_UNKNOWN`；永不重发 |
| `read_dispatched_then_lost_ack_retried` | 读操作发出后 ack 丢失 | 无副作用 → 照旧 pending + `tool.gateway_waiting` → 重发 |

相邻但**不属于**本 fixture 锁定集（仍由 Runtime `tests/test_tool_transport.py` 等覆盖）：
v2 同 key 幂等创建、同 key 内容冲突拒绝。本契约不声称改写那些协议测试。

## OUT OF SCOPE（明确不做 / 未验收）

以下**不在** Reliability Matrix v1 自动化契约范围内，也**不得**因本契约宣称现场验收完成：

1. **物理断网**（真实网络断开，非测试替身）
2. **桌面进程崩溃 / Mac 休眠退出**（含写入后、结果回传前的崩溃窗口）
3. **write-then-lost-ack** 现场验收（自动化已覆盖第 13–16 条；真断网、真装机的现场仍未验；不宣称 exactly-once）
4. 变更 `deadline` / `idempotency_key` wire 语义或生产恢复状态机行为

现场保留项见 [Native Tool 恢复验收补充](../native-tool-recovery-acceptance-2026-09-13.md)。

## 与相关文档

- Runtime 权威契约与 fixture：
  [personal-agent-runtime reliability-matrix-v1](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/docs/contracts/reliability-matrix-v1.md)
- Runtime 矩阵叙述：
  [native-tool-recovery-matrix-2026-09-13.md](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/docs/native-tool-recovery-matrix-2026-09-13.md)
- 本仓验收补充：[native-tool-recovery-acceptance-2026-09-13.md](../native-tool-recovery-acceptance-2026-09-13.md)
- 架构切片：[architecture-decoupling-review-2026-09-13.md](../architecture-decoupling-review-2026-09-13.md)
