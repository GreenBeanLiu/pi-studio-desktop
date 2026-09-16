# Tool Gateway Contract v1

> 状态：**权威 v1**（2026-09-14）。基于生产闭环字段固化；未知可选字段可忽略，改变必需字段 / 错误语义 / 幂等语义时必须升级版本。
>
> 目标：固定 Runtime、Desktop、Mobile 之间的工具调用边界。本目录下的 JSON Schema + fixtures 是跨仓库唯一机器可读来源。

## 0. 机器可读来源（SoT）

| 产物 | 路径 |
| --- | --- |
| 能力清单 Schema | [`schemas/tool-capabilities.schema.json`](schemas/tool-capabilities.schema.json) |
| Request Schema | [`schemas/tool-operation-request.schema.json`](schemas/tool-operation-request.schema.json) |
| Result Schema | [`schemas/tool-operation-result.schema.json`](schemas/tool-operation-result.schema.json) |
| Resume envelope Schema | [`schemas/resume-envelope.schema.json`](schemas/resume-envelope.schema.json) |
| Receipt Schema | [`schemas/tool-operation-receipt.schema.json`](schemas/tool-operation-receipt.schema.json) |
| Fixtures | [`fixtures/`](fixtures/) |

Desktop CI（`pnpm test` → `src/main/tool-gateway-contract.test.ts`）会校验：正例 fixture 通过 Schema；负例 fixture 在网关边界按错误码 fail closed。

### Consumer sync（Runtime / Mobile）

1. **不要各自发明字段。** 新增或改字段先改本仓库 Schema + fixture + 本文，再给姊妹仓开对齐 PR。
2. Runtime（Python）与 Mobile（TS）应 **镜像** `docs/contracts/schemas/` 与 `docs/contracts/fixtures/`（复制或子模块均可），并在各自 CI 用同一组 fixture 跑解析测试。
3. Desktop Relay 可继续使用 camelCase 传输 envelope；进入本地 handler 前映射到本契约的 snake_case canonical object。
4. Backend **不解释** `tool_name`，不改写 operation payload。

## 1. 版本关系

- `contract_version: 1`：本文件定义的跨仓库对象契约版本。
- `protocol_version: 2`：一次工具操作的 scope、deadline、幂等和审计协议版本。
- Desktop Relay 的命令 envelope 可以继续使用 camelCase；它是传输适配，不是另一套业务契约。
- Runtime/Mobile 的控制面 JSON 使用 snake_case。Desktop adapter 在进入本地 handler 前转换为内部 canonical object。

未知字段必须被忽略并记录诊断；未知的必需版本、工具或 scope 必须 fail closed，不能猜测执行。

## 2. Tool capabilities

Runtime 从设备能力握手得到以下结构的语义：

```json
{
  "manifest_version": 1,
  "operation_protocols": [1, 2],
  "tools": [
    {
      "name": "local.read",
      "scope_version": 1,
      "requires_workspace": true,
      "max_bytes": 65536
    }
  ]
}
```

现有 Desktop Relay 的 `toolGateway.manifestVersion`、`operationProtocols` 和 camelCase tool entries 由适配器映射到上述 canonical 结构。滚动升级期间，缺少 manifest 的旧桌面仍按兼容策略处理，但不能把缺少声明当成支持全部工具。

## 3. Tool operation request

控制面到设备网关的 canonical request：

```json
{
  "contract_version": 1,
  "protocol_version": 2,
  "operation_id": "toolop-example-001",
  "task_id": "task-example-001",
  "subtask_id": "subtask-example-001",
  "call_id": "call-example-001",
  "source": "gateway",
  "target_id": "pi-studio:mac-001",
  "tool_name": "local.read",
  "arguments": {
    "workspace": "/Users/example/Works/demo",
    "path": "README.md"
  },
  "idempotency_key": "idem-example-001",
  "scope": {
    "workspace": "/Users/example/Works/demo",
    "permissions": ["local.read"]
  },
  "deadline_at": "2026-09-13T01:00:00+00:00",
  "audit": {
    "approved_capabilities": []
  }
}
```

必需字段：`operation_id`、`task_id`、`subtask_id`、`call_id`、`target_id`、`tool_name`、`arguments`、`source`、`protocol_version`。

当 `protocol_version >= 2` 时还必须有：

- 非空 `idempotency_key`
- 带时区的 `deadline_at`
- `scope.workspace`，且必须等于 `arguments.workspace`
- `scope.permissions`，且必须包含 `tool_name`
- Shell 工具额外要求 `scope.permission` 与命令所需权限一致

设备网关必须重新校验 scope、活动工作区和 deadline，不能只信任 Runtime 的预检查。

## 4. Tool operation result

成功结果：

```json
{
  "contract_version": 1,
  "protocol_version": 2,
  "operation_id": "toolop-example-001",
  "task_id": "task-example-001",
  "subtask_id": "subtask-example-001",
  "call_id": "call-example-001",
  "source": "gateway",
  "target_id": "pi-studio:mac-001",
  "tool_name": "local.read",
  "ok": true,
  "result": {
    "path": "README.md",
    "content": "# Demo\n",
    "bytes": 7,
    "encoding": "utf-8"
  },
  "error": null
}
```

结构化失败结果：

```json
{
  "contract_version": 1,
  "protocol_version": 2,
  "operation_id": "toolop-example-001",
  "task_id": "task-example-001",
  "subtask_id": "subtask-example-001",
  "call_id": "call-example-001",
  "source": "gateway",
  "target_id": "pi-studio:mac-001",
  "tool_name": "local.read",
  "ok": false,
  "result": {},
  "error": {
    "code": "ENOENT",
    "message": "file does not exist"
  }
}
```

`error.code` 是机器可判断的稳定值；`error.message` 只用于诊断和 UI。当前至少保留：`INVALID_TOOL_OPERATION`、`INVALID_TOOL_ARGUMENTS`、`UNSUPPORTED_TOOL`、`UNSUPPORTED_TOOL_PROTOCOL`、`INVALID_DEADLINE`、`DEADLINE_EXPIRED`、`SCOPE_MISMATCH`、`WORKSPACE_MISMATCH`、`EEXIST`、`ENOENT`、`LOCAL_FILE_ERROR` 和 `RECEIPT_UNAVAILABLE`（§8：回执写不进盘，桌面拒绝执行）。

## 5. Resume envelope

Runtime 把设备结果回灌 Agent loop 时，必须保留 `operation_id`、`call_id`、`tool_name`、`ok`、`result` 和 `error`。不得仅用自然语言拼接结果，也不得在恢复时重新生成一个新的 `call_id`。

`waiting_for_async_tool` 只表示 Runtime 正在等待这一次 operation；它不是设备连接状态，也不是 Mobile 自己推导的终态。

## 6. 适配器边界

| 端 | canonical contract 责任 | 传输适配 |
| --- | --- | --- |
| Runtime | 生成、持久化、校验、resume | HTTP API、Backend Relay、Provider transcript |
| Desktop | 本地能力和执行结果符合契约 | camelCase Relay envelope、当前工作区和 OS 文件 API |
| Mobile | 读取任务/操作/能力并做 UI 投影 | Runtime API 字段转换和旧版本兼容 |
| Backend | 不解释 operation payload | 认证、房间、帧转发、controller token |

Backend 不应根据 `tool_name` 执行路由或修改结果；它只负责把已认证的帧送到目标设备。

## 7. Fixture 使用规则

`fixtures/` 中的样例是跨仓库兼容测试输入，不是生产配置：

- 每个 fixture 必须能被 Python Runtime、Desktop TypeScript 和 Mobile TypeScript 解析。
- fixture 的字段变更必须同时更新本文件、兼容测试和版本说明。
- 添加可选字段不升级 contract version；改变必需字段、错误语义或幂等语义时升级版本。
- 新 Desktop 先支持 v1 contract + protocol v2，再删除旧字段兼容。
- 负例 fixture（如 scope mismatch）用于验证 fail-closed，不应被当成可执行成功样例。

## 8. Receipts（回执 / 桌面账本）— 2026-09-16 加入

**问题**：`executeToolOperation` 发到桌面、桌面做了、`result` 帧在回去的路上丢了（断线、Relay 重启、ack 超时）。Relay 对"桌面没收到"和"桌面做了没回"发同一个 `host_offline`，转发失败还静默吞掉。Runtime 对 `local.write` / 非只读 `shell.exec` 既不敢重发（可能做两遍），也不敢当成功。Runtime 侧把这种操作记成 **`unknown_effect`**（Reliability Matrix v1 新词汇），然后来问桌面。

**桌面的义务**（有账本的桌面）：

1. 能力清单里宣告 `toolGateway.receipts: 1`。没有这个字段 = 老桌面，Runtime 不来问，`unknown_effect` 等到 deadline 判 failed（`EFFECT_UNKNOWN`）。
2. 收到 `executeToolOperation` **先记 `dispatched` 再执行**（fsync 落盘），执行完（含被校验拒绝）记 `settled` 带结果或错误码。`dispatched` 写不进盘 → **不执行**，回 `RECEIPT_UNAVAILABLE`。
3. 进程重启时把悬着的 `dispatched` 补成 `settled { ok: false, code: "INTERRUPTED" }`：这个进程还没执行过任何操作，悬着的一定是上一次的。
4. 回答 `toolOperationReceipt`。

**命令**（Relay envelope，camelCase）：

```json
{ "id": "runtime-…", "type": "toolOperationReceipt", "operationId": "toolop-example-001" }
```

**答复** `result.data`：canonical 形状见 [`schemas/tool-operation-receipt.schema.json`](schemas/tool-operation-receipt.schema.json)（snake_case），Relay 上是 camelCase 同名字段；fixtures：`tool-operation-receipt-{settled,dispatched,unknown,interrupted}.json`。

| `state` | 含义 | Runtime 的处置 |
| --- | --- | --- |
| `unknown` | 账本里没有这条 `operationId`：桌面从没收到 | 回 `pending`，重发是安全的 |
| `dispatched` | 收到了、还没做完（或做到一半进程没了但还没重启） | 原地等，下次再问；到 deadline 判 `EFFECT_UNKNOWN` |
| `settled` | 做完了：`ok` / `result` 或 `code` / `error` 就是结果 | 按 `tool.result` / `tool.failed` 恢复任务，**不重发** |

账本是只追加的 JSONL（`<userData>/pi-agent/tool-operations.jsonl`），每条操作两行；`result` 超过 256 KiB 只存哈希（`{"truncated": true, "sha256": …}`）。`dispatched` 记录带 `audit.task_id` / `audit.subtask_id` / `audit.principal` / `idempotencyKey` / `arguments` 的 sha256——账本能回答"这条写是哪个任务、谁要的、写的是什么"。

不在 v1 里：桌面主动推送迟到的结果（现在只被动答问）；跨 `operationId` 的按幂等键查询。
