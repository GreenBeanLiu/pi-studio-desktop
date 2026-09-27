import type { SandboxMode } from '../shared/ipc/contract'

/**
 * 沙箱后端契约 —— 把「在哪跑」从「怎么启动」里拆出来。
 *
 * 原来 prepareSandboxLaunch 是一段 if/else 链:可用性判断、shim 生成、命令行组装、
 * 报错文案全混在一起,再加一个后端就得动那段主流程。这里把每个后端收敛成两个问题:
 *
 *   available()  这台机器上它能不能用(只判断,不抛异常)
 *   prepare()    把一个工作区 / env 变成可启动的 cliPath + env
 *
 * 选择策略是「按数组顺序取第一个 available 的后端」,数组顺序即优先级。新增后端 =
 * 加一个对象并插进数组,不改选择器,也不改 prepareSandboxLaunch。
 *
 * 为什么 available 与 prepare 分开:缺环境时要抛带修复指引的错误(比如「去设置里
 * 构建镜像」),这类文案属于后端自己;选择器只负责在都不行时给一句兜底提示。
 */

export type SandboxLaunch = {
  cliPath: string
  env: Record<string, string>
  mode: SandboxMode
}

/** 每次启动的沙箱参数。`workspaceReadOnly` 让工作区只读(无人值守 routine 用)。 */
export type SandboxPrepareOptions = {
  workspaceReadOnly?: boolean
}

export type SandboxBackend = {
  id: SandboxMode
  /** 只判断可用性,不抛异常;真正的环境缺失报错留给 prepare,好带上修复指引 */
  available: () => Promise<boolean> | boolean
  prepare: (
    cwd: string,
    env: Record<string, string>,
    options: SandboxPrepareOptions,
  ) => Promise<SandboxLaunch>
}

/**
 * 按优先级返回第一个可用后端的启动参数;都不行时抛 `unavailableMessage`。
 * 只做顺序选择和兜底报错,不认识任何具体后端。
 */
export async function selectSandboxBackend(
  backends: SandboxBackend[],
  cwd: string,
  env: Record<string, string>,
  unavailableMessage: string,
  options: SandboxPrepareOptions = {},
): Promise<SandboxLaunch> {
  for (const backend of backends) {
    if (await backend.available()) return backend.prepare(cwd, env, options)
  }
  throw new Error(unavailableMessage)
}
