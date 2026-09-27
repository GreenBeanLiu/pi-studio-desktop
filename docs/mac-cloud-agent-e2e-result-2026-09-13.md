# Mac 云端 Agent / 本地工具 E2E 结果 2026-09-13

对应手册：`mac-cloud-agent-e2e.md`。本轮由 Mac 侧执行，用例 A/B/C/E 通过 Runtime 的
`POST /providers/pi-studio/commands` 提交 —— 与手机 `sendPiStudioCommand` 发出的字段完全一致
（`agent_target=personal-agent-engine`、`tool_target=Mac`、`execution_mode=native-tools`、
`risk=read_only`、`workspace_id`），但**没有经过手机界面**。手机界面相关的检查（工作区选择器、
"已完成"终态展示、用例 D 刷新）仍待手机上补做，见文末。

```text
测试时间 / 时区：2026-09-13 13:44–14:01 (Asia/Shanghai, UTC+8)
Mac 名称 / 芯片 / macOS：Glanger的MacBook Air / arm64 (Apple Silicon) / macOS 26.5.1 (25F80)
桌面构建 HEAD / 实际安装与启动时间：e88bffa（含 be68c3b）/ 13:51 装入 /Applications，13:53:40 启动，13:53:41 remote host connected
手机版本 / 构建号（可获取时）：未使用手机
Runtime / Engine 实测版本（维护者核对）：personal-agent-runtime@5a3d6b8（含 297e46e）/ personal-agent-engine@f253331（含 0cdd839），取自 executions 表
测试工作区绝对路径 / workspace_id：/Users/glanger/Works/pi-e2e-local-list.hHcH8i / ws_6d93f9513759492d9d4d819451eaef4f
Mac tool_target：pi-studio:ff1b3f56-6818-453b-8378-7c6e8ea1b320

A：通过；task_id：task_c787a04946144f18bd03d7f9d2d4641b
B：通过；task_id：task_de41a41691c1442a8d135ad1554b43fe
C：通过；task_id：task_924f88500d414499bcfa0064accbbef4
D：未做（需要手机界面）；可复用 task_id：task_c787a04946144f18bd03d7f9d2d4641b
E：通过；task_id：task_93ab56b5640d448cbcc6a8cf858b2596

随机标记是否匹配：是。local.read 读回 local-list-e2e-607A3B4A-5378-4A63-9800-AE6DF4AF2567，与 Mac 生成的一致
前后文件哈希是否一致：一致（alpha b6a98d9c…、bravo 5da8f23d…、probe 359fa746…，测试后复算无差异）
是否出现重复提交、工具调用、审批或停在执行中：无。每个任务 1 个计划子任务；A/C/E 各 1 次操作，B 2 次；execution_queue 无残留；四个任务终态均 complete；无写审批
原始错误 / 发生时间 / 相关截图：仅 E 的预期拒绝：INVALID_PATH "Symbolic links are not supported by local file tools"（06:00:04Z）
后台核对的子任务数、操作 ID、协议版本、结果与 scope：见下表
```

## 构建与安装

- `git pull --ff-only` 到 `e88bffa`；`git merge-base --is-ancestor be68c3b HEAD` 为真。
- pnpm 10.6.1；`pnpm install --frozen-lockfile` 无变更。
- `pnpm run package:mac`：check:text / typecheck / lint 通过，测试 **116 files, 957 passed, 1 skipped**，签名 Apple Development，跳过公证（正常）。
- 打包产物 `app.asar` 内含 `local.list` 处理器与 manifest 条目（`scopeVersion: 1, maxEntries: 200`）。
- 安装到 `/Applications/pi-studio.app` 后用 Helper 二进制 spawn 引擎 `cli.js --version` 返回 `0.84.2`。
- 装机前后 Mac 上均只有一个实例（进程路径 `/Applications/pi-studio.app/Contents/MacOS/pi-studio`）。
- 界面版本号仍显示 v0.13.0（手册已说明不能据此判断）。

## 工作区

按手册第 2 节创建；根目录恰好四项，测试期间无新增（含隐藏文件）。Mac 打开该目录后，Runtime 的
周期性 discovery（300 秒）于 05:56:35Z 注册为 `ws_6d93f9513759492d9d4d819451eaef4f`，
绑定 `pi-studio:ff1b3f56-…` → `/Users/glanger/Works/pi-e2e-local-list.hHcH8i`，`kind=local`。

## 后台证据（personal-harness.sqlite3 只读查询）

四个任务共有字段：`agent_target=personal-agent-engine`、`tool_target=pi-studio:ff1b3f56-6818-453b-8378-7c6e8ea1b320`、
`metadata.execution_mode=native-tools`、`workflow_profile=single`、`runtime_profile=readonly`、
`tool_transport.tools=[local.list, local.read, server.time]`（只读，未暴露 local.write）；
每个操作 `protocol_version=2`，`scope={workspace: <测试目录>, workspace_id: ws_6d93…, permissions:[<tool>]}`，
`gateway_state=ready / capabilities verified`（Runtime 校验了 manifestVersion=1、operationProtocols 含 2、
`local.list` 声明 `scopeVersion=1`）。

| 用例 | 子任务 | 操作 ID | 工具 / 参数 | 结果 |
| --- | --- | --- | --- | --- |
| A | sub_00c83ef8… | toolop_b0233c80631d4973a0d641dcaea31b7b | local.list `{"path":".","limit":10}` | entries = alpha.txt file / bravo.txt file / folder directory / link-folder symlink；truncated=false |
| B | sub_a6f24575… | toolop_c33c7e2bf37d4746bb90cdcc0bc11071 | local.list `{"path":"folder","limit":10}` | entries = probe.txt file；truncated=false |
| B | 同上 | toolop_8bc49556015445e2960b8c12949e54aa | local.read `{"path":"folder/probe.txt"}` | bytes=52，内容为随机标记，utf-8 |
| C | sub_fc722f90… | toolop_b62d0cfb55fd4540b449134dbf47f25d | local.list `{"path":".","limit":2}` | entries = alpha.txt file / bravo.txt file；truncated=true |
| E | sub_e2070991… | toolop_26e9e9b3232046d291bb7a08c28d72b9 | local.list `{"path":"link-folder","limit":10}` | status=failed，code=INVALID_PATH，未返回目标目录内容 |

时间窗 05:50Z 之后，该 Mac 的 `tool_operations` 恰好只有上述 5 条；无其它任务的操作混入。
execution attempt 数为 A=2、B=3、C=2、E=2，对应"模型调用 → 等待工具 → 模型续跑"的正常轮次，
每个任务的 `subtask.finished` 仅 1 条。

模型结论与工具记录一致：A/C 原样报告 entries/truncated，C 明确指出"目录中还存在未列出的条目"；
B 报告了两次工具返回和完整文本；E 报告了原始错误、未改用 `folder`、未重试。

Mac 应用日志（`logs/pi-studio.log`）不记录工具操作，设备侧无法从日志再次核对次数；本轮全部只读，
以文件哈希前后一致作为无副作用的证据。

## 仍待手机上补做

1. 第 3 节：Harness 选"云端" + 本地工具选这台 Mac + 只读 + 工作区选 `pi-e2e-local-list.hHcH8i`，确认选择器里能出现该目录。
2. 用例 D：打开 task_c787a04946144f18bd03d7f9d2d4641b，刷新 / 返回再进 / 切后台再回前台，确认任务 ID 与"已完成"不变、
   后台不新增子任务和操作（当前基线：1 子任务、1 操作 toolop_b0233c80…）。
3. 若要严格按手册"从手机提交"复测 A/B/C，可重新提交；后台核对方法同上。

测试目录尚未删除，待上述核对结束后人工删除 `/Users/glanger/Works/pi-e2e-local-list.hHcH8i`。
