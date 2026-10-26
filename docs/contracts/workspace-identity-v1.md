# Workspace Identity v1

日期：2026-09-15。实现位于 pi-studio-control-plane（`workspace_resolution.py`、Workspace Registry）。

## 目的与范围

锁定跨设备工作区身份词汇与解析规则：同一 `workspace_id` 在不同 executor 上可以绑定不同本机路径；
展示名允许碰撞；可选 `repository` 是发现合并键。本契约描述 Runtime **已经实现**的行为，供
Web / Mobile / Desktop / 脚本共用同一套语义，避免把本机绝对路径当作跨设备身份。

本版本范围：

- 术语与字段边界（`workspace_id` / `executor_binding` / `local_path` / `name` / `repository`）
- 客户端与解析规则（路径不得作 id；路径仅在选定 executor 后绑定）
- Fixture + 自动化测试钉死当前 Runtime 行为

**不在本轮范围：**生产注册表 rename/merge、删除 path-only 旧字段、UI 展示消歧、变更 wire 字段名。

## 术语

| 术语 | 含义 |
| --- | --- |
| `workspace_id` | Runtime 管理的**稳定跨设备身份**（如 `ws_*`）。任务意图与客户端选择应携带此 id，而不是某台机器上的绝对路径。 |
| `executor_binding` | 某台设备上的绑定：`executor_id` + `local_path`。同一 `workspace_id` 可有多条 binding。 |
| `local_path` | **仅设备本地**的绝对路径。只在选定 executor 之后由注册 binding 填入 `TaskSpec.workspace` / tool transport；服务器不做跨 OS 路径规范化。 |
| `name` | 展示名。**不要求唯一**；两台设备上的本地「Works」文件夹可以同名但拥有不同 `workspace_id`。 |
| `repository` | 可选合并键（如 `owner/repo`）。发现库存时，相同 repository 的 Mac/Win 绑定可合并到同一 `workspace_id`。 |

兼容字段：`TaskSpec.workspace` 仍表示已解析的设备路径（旧客户端可直接传路径）。它是兼容字段，不是跨设备身份。

## 规则

1. **客户端不得把绝对路径当作 `workspace_id`。** Mobile / Web / 脚本应发送稳定 id；路径只出现在设备侧 binding 或 legacy `workspace` 字段。
2. **路径只在 executor 选定之后绑定。** 仅有 `workspace_id` 时，入口可补齐 `repository`，但不得自行挑选任一设备路径。
3. **同一 `workspace_id` + 不同 executor → 不同路径合法。** 例如 Mac `/Users/me/Works/pi-studio` 与 Win `D:\Works\pi-studio` 共享一个 id。
4. **同 repository 发现合并 binding。** 库存同步按 repository 归并；单次发现内同一 executor 的额外 worktree 记为 conflict，不静默覆盖。
5. **name 碰撞允许。** 两个 local「Works」可以同名、不同 id；UI 消歧是后续 Slice E 可选工作，不是本契约的前置条件。
6. **失败关闭。** 未知 id、选定设备无 binding、repository 冲突、已绑定路径与注册漂移 → 拒绝，不静默换路径。
7. **无 `workspace_id` 的 path-only 旧任务**继续通过，不要求访问 Workspace Registry（本轮不删除该兼容路径）。

## Fixture

契约场景位于 Runtime `tests/fixtures/workspace-identity-v1.json`，由
`tests/test_workspace_resolution.py` / `tests/test_workspaces.py` 加载并断言当前行为。
至少覆盖：

- 双 binding（Mac/Win）同 id、不同路径；按 executor 解析路径
- 两个 local「Works」同名、不同 id
- 客户端禁止用绝对路径充当 `workspace_id` 的示例断言

## 与相关文档

- 解析收敛实现记录：[pi-studio `workspace-resolution-2026-09-14.md`](https://github.com/GreenBeanLiu/pi-studio-desktop/blob/master/docs/workspace-resolution-2026-09-14.md)
- 架构切片：[Slice E](https://github.com/GreenBeanLiu/pi-studio-desktop/blob/master/docs/architecture-decoupling-review-2026-09-13.md)（首切 = 契约 + 测试）
- 目标解析中的 `workspace_id` 入参语义见 [Target Resolution v1](target-resolution-v1.md)
