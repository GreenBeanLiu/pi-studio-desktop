# Pi Studio · Desktop

> 仓库 `pi-studio-desktop`(2026-09-16 前叫 `pi-studio`;应用名、`productName`、安装包名仍是 pi-studio)。
> **架构位置:Operator Session 的 Harness + pi Agent Runtime + Tool Gateway(给控制面执行本地工具)+ Sandbox Provider。**
> 词汇表(SoT)在 [pi-studio-control-plane/docs/glossary.md](https://github.com/GreenBeanLiu/pi-studio-control-plane/blob/main/docs/glossary.md);
> 全家福:desktop / mobile / device-plane / control-plane / engine / llm-provider / ops,前缀统一 `pi-studio-`。

pi-studio 是基于 Electron、React 和 pi-coding-agent 的桌面 coding agent 客户端。它提供工作区聊天、会话管理、沙箱执行、图像/3D 生成和可选的手机远程控制;
同时作为控制面派发本地工具操作的 Tool Gateway(`local.list/read/write`、scoped `shell.exec`)。

## 开发

```bash
pnpm install
pnpm dev
```

常用校验命令：

```bash
pnpm run check       # 文本编码、类型检查、测试和 lint
pnpm run verify      # check + Electron 构建
```

主要设计和运行时说明见：

- [整体架构](docs/architecture.md)
- [Desktop × Session Mailbox / Reactor 集成架构](docs/session-mailbox-reactor-integration-2026-09-27.md)
- [Session Kernel 架构评审](docs/session-kernel-architecture-2026-09-21.md)
- [运行时依赖](docs/runtime-dependencies.md)
- [本地发布流程](docs/release-local.md)
- [Skill 写作规范](docs/skill-authoring.md)

## Codex 会话导入

pi-studio 内置了 `pi-studio-codex-sessions` 扩展，可以读取本机 Codex CLI 保存的历史会话，并把选中的会话转换成 pi 会话。导入后会话会出现在 pi-studio 的会话列表中，可以继续对话，而不只是导出成一份只读 transcript。

### 数据来源

默认从以下位置读取 Codex 数据：

```text
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
$CODEX_HOME/history.jsonl
```

如果没有设置 `CODEX_HOME`，默认使用 `~/.codex`。扩展会流式读取 rollout JSONL，只提取用户消息和 Codex agent 消息，不读取 reasoning 轨迹或工具调用载荷，因此不会把大型 rollout 文件中的内部数据全部带入上下文。

### 导入步骤

在 pi-studio 的聊天中按下面顺序调用工具：

1. 用 `codex_sessions_list` 查看可用会话。

   可选参数：

   - `cwd`：只列出工作目录中包含该文本的会话。
   - `limit`：最多返回的会话数，默认 `30`，最大 `200`。

2. 需要按内容定位时，用 `codex_sessions_search` 搜索关键词。搜索范围只包括用户和 agent 的对话文本，并返回命中片段及会话 ID。

   ```text
   codex_sessions_search({"query":"登录"})
   ```

3. 导入前可用 `codex_session_read` 分页查看会话内容。它接受 `sessionId`，并支持 `offset` 和 `limit`；单条消息过长时会截断显示。

4. 调用 `codex_session_import` 完成导入：

   ```text
   codex_session_import({
     "sessionId": "<来自列表或搜索结果的会话 ID>",
     "cwd": "/path/to/workspace",
     "maxTurns": 200
   })
   ```

   参数说明：

   - `sessionId`：要导入的 Codex 会话 ID。
   - `cwd`：目标工作区，默认使用 Codex 会话记录的工作目录；如果未记录则使用当前进程工作目录。
   - `maxTurns`：最多导入最近多少轮，默认 `200`，最大 `500`。

   扩展会合并连续的同角色消息，并从最近一段历史中回退到用户消息开头，避免导入结果从半截 agent 回复开始。写入完成后，工具输出 pi 会话 ID 和文件路径。

5. 切换到目标工作区，在 pi-studio 会话列表中打开新导入的会话即可继续工作。

### 注意事项

- 导入只搬运用户和 agent 的文本消息，不会搬运 Codex 的工具调用、工具结果、reasoning 轨迹或可恢复的执行状态。
- 如果指定了 `cwd`，导入的会话只会出现在该工作区的会话列表中；工作区路径必须与 pi-studio 当前打开的工作区一致。
- `maxTurns` 是截取最近历史的上限，不是按原始 JSONL 行数计算。连续同角色消息合并后，实际写入条数可能更少。
- Codex 自动审批评估会话会在列表中标记为“自动审批评估，非真人对话”，导入前应确认它确实是需要的历史。
- 找不到会话时先运行 `codex_sessions_list` 或 `codex_sessions_search` 获取有效 ID。没有会话时，检查 `CODEX_HOME` 是否指向包含 `sessions` 目录的 Codex 数据目录。
- pi-studio 负责管理 pi 的会话目录，通常不需要手动设置 `PI_CODING_AGENT_DIR`。

### 相关实现

- `resources/pi-extensions/pi-studio-codex-sessions.ts`：Codex 会话扫描、搜索、读取和转换。
- `tests/codex-sessions-extension.test.ts`：扩展行为和导入后 pi 会话可读取性的测试。
