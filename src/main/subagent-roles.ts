import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { agentConfigDir } from './settings'

const DEFAULT_AGENTS: Record<string, string> = {
  'scout.md': `---
name: scout
description: Fast codebase recon. Use to find relevant files, understand architecture, and gather context before planning or implementation. Does not modify files.
tools: read, grep, find, ls, bash
---
You are a scout agent. Your job is to investigate the codebase quickly and return precise context for another agent.

Focus on:
- Relevant files and symbols.
- Existing architecture and conventions.
- Likely change points.
- Risks, hidden constraints, and tests to run.

Use bash only for read-only inspection commands such as git diff, git log, find, rg, ls, and test discovery.

Return:
- Files Retrieved
- Key Code
- Architecture
- Start Here
- Risks
`,
  'planner.md': `---
name: planner
description: Creates an implementation plan from gathered context. Use after scout or when a task needs decomposition. Does not modify files.
tools: read, grep, find, ls
---
You are a planning agent. Turn the task and available context into a concrete implementation plan.

Do not edit files. Be specific about:
- The smallest useful vertical slice.
- Files and functions to change.
- Tests or checks to run.
- Risks and decisions that need user confirmation.

Prefer repo-native patterns over new abstractions.

Return:
- Goal
- Plan
- Files To Touch
- Verification
- Open Questions
`,
  'reviewer.md': `---
name: reviewer
description: Reviews code changes for bugs, regressions, missing tests, and product-quality risks. Use after implementation or before shipping.
tools: read, grep, find, ls, bash
---
You are a reviewer agent. Review the current worktree changes like a senior engineer.

Prioritize:
- Bugs and behavioral regressions.
- Security or data-loss risks.
- Broken product flows.
- Missing or insufficient tests.
- Inconsistent repo patterns.

Use bash only for read-only inspection such as git diff, git status, git log, git show, and test discovery. Do not modify files.

Return findings first, ordered by severity:
- Critical
- Warnings
- Suggestions
- Summary
`,
  'worker.md': `---
name: worker
description: Implements focused code changes. Use when context and plan are clear enough to make edits.
---
You are a worker agent. Implement the requested change using the repository's existing patterns.

Keep scope tight:
- Make the smallest complete change that satisfies the task.
- Do not rewrite unrelated code.
- Preserve user changes.
- Run appropriate checks when possible.

Return:
- Completed
- Files Changed
- Verification
- Notes
`,
}

const DEFAULT_PROMPTS: Record<string, string> = {
  'implement.md': `---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Use the subagent workflow to implement this task:

1. Ask scout to investigate the relevant codebase context.
2. Ask planner to produce a concrete implementation plan from the scout result.
3. Ask worker to implement the plan.

Task:
{{args}}
`,
  'scout-and-plan.md': `---
description: Gather codebase context and create an implementation plan without editing files
---
Use the subagent workflow to prepare this task:

1. Ask scout to investigate the relevant codebase context.
2. Ask planner to produce a concrete plan from the scout result.

Do not implement yet.

Task:
{{args}}
`,
  'implement-and-review.md': `---
description: Implement a task, then review the changes and apply review fixes
---
Use the subagent workflow:

1. Ask worker to implement the task.
2. Ask reviewer to review the resulting changes.
3. If the reviewer finds actionable issues, ask worker to fix them.

Task:
{{args}}
`,
}

function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
}

function writeFiles(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content.trimStart(), 'utf-8')
  }
}

function resolvePiSubagentExampleDir(): string {
  // ESM 下没有裸 require
  const searchPaths =
    createRequire(import.meta.url).resolve.paths('@earendil-works/pi-coding-agent') ?? []

  const candidates = searchPaths.map((basePath) =>
    join(basePath, '@earendil-works', 'pi-coding-agent', 'examples', 'extensions', 'subagent'),
  )
  // electron-builder 默认剔除 node_modules 里的 examples 目录,打包版曾因此从未生效
  // (装机版每次开工作区报 "Could not locate pi subagent extension example")。
  // 兜底:构建期快照在 resources/pi-subagent(pi 引擎升版后记得刷新快照)。
  candidates.push(join(app.getAppPath(), 'resources', 'pi-subagent'))

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.ts')) && existsSync(join(candidate, 'agents.ts'))) {
      return candidate
    }
  }

  throw new Error('Could not locate pi subagent extension example (node_modules or resources)')
}

export function syncSubagentRoles(enabled: boolean): void {
  const root = agentConfigDir()
  const extensionDir = join(root, 'extensions', 'subagent')
  const agentsDir = join(root, 'agents')
  const promptsDir = join(root, 'prompts')

  if (!enabled) {
    removeIfExists(extensionDir)
    for (const file of Object.keys(DEFAULT_AGENTS)) removeIfExists(join(agentsDir, file))
    for (const file of Object.keys(DEFAULT_PROMPTS)) removeIfExists(join(promptsDir, file))
    return
  }

  const sourceDir = resolvePiSubagentExampleDir()

  removeIfExists(extensionDir)
  mkdirSync(extensionDir, { recursive: true })
  copyFileSync(join(sourceDir, 'index.ts'), join(extensionDir, 'index.ts'))
  copyFileSync(join(sourceDir, 'agents.ts'), join(extensionDir, 'agents.ts'))

  writeFiles(agentsDir, DEFAULT_AGENTS)
  writeFiles(promptsDir, DEFAULT_PROMPTS)
}

export const syncSubagentWorkflow = syncSubagentRoles
