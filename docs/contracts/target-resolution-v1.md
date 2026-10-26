# Target Resolution v1

日期：2026-09-14。实现位于 pi-studio-control-plane。

## 目的与范围

`POST /execution-targets/resolve` 提供只读、可重复的目标解析预检，复用正式 provider command 的
字段归一化、工作区检查和 RoutingExecutor 路由选择。Web、Mobile、脚本可使用同一结果展示
将采用的 Agent 目标、工具设备、工作区路径和拒绝原因。

此版本范围为 `/providers/pi-studio/commands` 的 prompt / followUp / steer 任务意图。
暂不覆盖其他任务入口，也不修改手机现有提交逻辑。云端无本地工具的请求可明确使用
`agent_target=pi-studio-engine`、`execution_mode=desktop-agent`；这里 desktop-agent 是既有
“非 native-tools 路径”的历史协议名称，不能由这个名称推断实际 Agent 在桌面运行。

## 请求

认证与 Runtime 其他私有接口一致。请求复用 ProviderCommand，推荐 snake_case：

```json
{
  "text": "列出工作区根目录，最多三项",
  "agent_target": "pi-studio-engine",
  "tool_target": "pi-studio:mac",
  "workspace_id": "ws-shared",
  "execution_mode": "native-tools",
  "risk": "read_only"
}
```

- `agent_target` 表达 Agent loop 目标；`tool_target` 表达本地工具设备。
- `workspace_id` 表达稳定身份，设备选定后解析其路径；`workspace` 保留旧路径兼容。
- `requires` 表达环境能力；请求的 `required_capabilities` 表达权限，二者不同。
- 兼容 `agentTarget`、`toolTarget`、`executionTarget`；字段优先级与正式提交完全共用。
- `execution_target` 是历史兼容入参（旧客户端）。云端 Agent + Mac 工具时旧客户端可能仍镜像 Mac，不能覆盖明确的 `agent_target`。**新 Mobile（2026-09-15 起）不再发送该字段。**
- `run` 不触发执行，预检即使收到 `run=true` 也不创建任务。
- 不执行数据库写入、模型推理、设备工具、审批或任务事件；可能读取设备库存和执行器健康状态。

## 成功响应

```json
{
  "contract_version": 1,
  "advisory": true,
  "execution_mode": "native-tools",
  "resolution": {
    "agent_target": "pi-studio-engine",
    "tool_target": "pi-studio:mac",
    "selection_complete": true,
    "workspace_id": "ws-shared",
    "workspace": "/Users/me/repo",
    "repository": "owner/repo",
    "required_runtime_capabilities": ["tool.local-files"],
    "gateway_status": "online",
    "tool_capabilities_verified": false,
    "decision": {
      "mode": "native-tools",
      "target": "pi-studio-engine",
      "agent_target": "pi-studio-engine",
      "tool_target": "pi-studio:mac"
    }
  }
}
```

`advisory=true` 表示结果不预留设备、不授权执行，正式提交和执行仍重新校验。
`selection_complete` 只表示目标是否仍是泛设备选择器：旧的裸 `pi-studio` 可保留到桌面执行器再选设备，
此时值为 false；平台约束路由可提前返回具体设备。它不代表审批、工具握手或业务任务已经成功。

`gateway_status` 在 native-tools 模式检查当前设备库存，其他模式为 null。
库存 online 不是实时握手；`tool_capabilities_verified=false` 明确表示未验证工具 schema/scope。
`decision` 在 capability 路由中保留候选及 claimed/assumed 来源，不能把 assumed 当成设备真实证明。
响应不包含临时规划产生的 task/subtask ID；fixture 位于 Runtime 的
`tests/fixtures/target-resolution-v1.json`，由完整响应断言保护。

## 错误响应

业务拒绝格式为 `{"detail":{"code":"...","message":"..."}}`：

| HTTP | code | 含义 |
| --- | --- | --- |
| 422 | unsupported_command | 非任务命令 |
| 422 | invalid_intent | 原有字段组合不合法、未知工作区或 repository 冲突 |
| 422 | workspace_resolution_failed | 选定设备缺失工作区绑定或路径冲突 |
| 409 | target_unavailable | 写任务的指定设备未在线，沿用提交入口规则 |
| 409 | unroutable | 无在线节点满足 requires；附 requires 与 online 库存 |
| 409 | route_rejected | 路由器拒绝，例如只读 native-tools 设备离线 |
| 503 | resolution_unavailable | 当前 executor 未提供路由预检 |

认证失败及 Pydantic 字段格式校验保持 FastAPI 原有错误格式。调用方只把明确的业务 code 当作契约，
不要解析 message 字符串。读取端应允许新增字段。

## 客户端迁移

先上线 Runtime，再为 Mobile 增加可选预检调用和 v1 响应读取。旧服务返回 404/503 时可保留原有
提交流程；业务拒绝应显示具体原因。预检不是新增的提交前强制依赖，不可在网络超时后自动重复创建任务。
跨版本验证与产品确认已完成（2026-09-15）。Mobile 已删除 `executionTarget` / `execution_target`
兼容镜像（PR [`#5`](https://github.com/GreenBeanLiu/pi-studio-mobile/pull/5)）；wire 只发规范轴。
Runtime 仍可接受历史 `execution_target` 入参（字段优先级不变），但新客户端不再发送。

跨版本验收证据与解锁结论见
[Slice D 跨版本验收证据包](https://github.com/GreenBeanLiu/pi-studio-desktop/blob/master/docs/slice-d-cross-version-validation-2026-09-15.md)
（**镜像删除已解锁并落地**）。
