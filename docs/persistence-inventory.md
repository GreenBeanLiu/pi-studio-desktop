# Persistence inventory

pi-studio now uses SQLite for workflow state. Other persistent state remains split between JSON/files,
Pi session files, the selected workspace, Docker, and remote integrations.

## Current local state

| Location | Data | Keep as files? | Future database candidate |
| --- | --- | --- | --- |
| `userData/settings.json` | Provider/model settings, recent workspaces, encrypted API keys | Yes | No |
| `userData/channels.json` | Feishu/WeChat/webhook channel configuration and encrypted secrets | Yes | No; secrets must remain in OS-protected storage |
| `userData/routines.json` | First-run import source or pre-SQLite fallback store | Yes, until SQLite is established | Imported once |
| `userData/routines.sqlite3` | Transactional workflows, steps, runs and sync delete outbox | No | Current local source of truth |
| `userData/cloud-sync-outbox.json` | Legacy/fallback workflow deletion intents | Yes, only for fallback or migration backup | Imported into SQLite when healthy |
| `userData/security-policies.json` | Default/workspace command and write policies | Yes | No |
| `userData/pi-agent/sessions/**` | Pi conversation JSONL and session metadata | Yes; Pi is source of truth | Index only, do not duplicate full messages |
| `userData/pi-agent/models.json` | Generated provider/model override | Yes; generated file | No |
| `userData/pi-agent/acp-sessions.json` | Minimal external-agent session index needed to resume ACP conversations | Yes | No |
| `userData/pi-agent/shared-memory.sqlite3` | Cross-agent shared memory with an FTS5 index | No | Current local source of truth |
| `userData/pi-agent/shared-memory.json` | First-run import source for shared memory | Yes, until imported | Imported once |
| `userData/pi-agent/shared-memory.snapshot.json` | Read-only mirror for sandboxed agents that cannot reach 127.0.0.1 | Regenerable | No |
| `userData/pi-agent/shared-memory.connection.json` | Local memory service port and bearer token | Regenerable; removed on quit | No |
| `userData/logs/**` | Application diagnostics | Yes, with retention limit | No |
| `userData/pi-agent/runtime-status/**` | Per-process agent status snapshots written by the active tracker; removed on dispose, stale leftovers pruned on startup | Regenerable | No |
| `userData/backups/YYYY-MM-DD/**` | Daily startup snapshots of critical configuration and SQLite state, with SHA-256 manifest; newest seven retained | Yes | No |
| `userData/backups/pre-restore-*/**` | Protection points created immediately before a requested restore; newest three retained | Yes | No |
| `userData/backups/.restore-pending.json` | Validated one-shot restore plan consumed before local stores open | Temporary | No |
| `userData/sandbox/**` | Generated Dockerfile and RPC shim | Regenerable | No |
| `<workspace>/.pi-studio/memory.md` | Workspace memory maintained with the project | Yes | No |
| `<workspace>/.pi-studio/articles/**` | Exported Markdown/HTML article artifacts | Yes | Metadata only |

## Crash recovery semantics（2026-09-27）

After a crash or forced kill, state is classified rather than assumed healthy:

- **Recovered**: SQLite workflow/run state, settings, channels, Pi session JSONL, shared memory, and the
  tool receipt ledger's settled entries are all read back as the truth.
- **Marked interrupted (never assumed successful)**: open routine runs via `interruptOpenRoutineRuns`;
  a dangling `dispatched` tool receipt is settled as `INTERRUPTED` on load (`effect unknown`), so a
  retried operation replays the unknown-effect failure instead of running again; an agent job whose
  cleanup could not be confirmed stays `orphaned` with evidence.
- **Regenerated or cleaned**: `runtime-status/**` per-process files are pruned at startup
  (`pruneStaleRuntimeStatus`); `run-change` temp dirs are cleaned at startup
  (`cleanupStaleRunChangeTempDirs`); `shared-memory.connection.json` is removed on quit and rewritten by
  the service.
- **Fail closed**: approvals are not persisted — a crash leaves no reusable pending approval, and
  unattended runs deny every blocking request (`UnattendedApprovalGate`). The renderer consumes
  projections and never fabricates a success from stale state.

## Remote and external state

| System | Data |
| --- | --- |
| Cloud image relay | Generated-image jobs/history and image URLs |
| Model providers / Helicone | Prompts, responses, usage and optional request logs according to provider settings |
| Feishu | Cards, documents and uploaded document images |
| WeChat | Uploaded permanent cover material, inline images and draft media IDs |
| Docker | Versioned `pi-studio-sandbox:<pi-version>` images outside AppData |

## Proposed structured database

pi-studio uses SQLite locally for offline-first transactional state and PostgreSQL behind the TrailAI
backend for backup and future cross-device sync. The desktop app uses an authenticated backend API;
it never connects to PostgreSQL directly.

On first launch after the SQLite upgrade, `routines.json` is imported in one transaction and copied to
`routines.json.backup-v1`. Subsequent reads and writes use `routines.sqlite3`. Explicit workflow
deletions and their sync intents commit in the same SQLite transaction. A v0.3.50
`cloud-sync-outbox.json` is also imported and archived. Before the first SQLite database exists, a
runtime without `node:sqlite` can continue with the JSON store and a durable JSON delete outbox.
JSON-mode deletions use a small recovery journal so the store removal and delete intent finish together
after a crash. Once SQLite exists it is the only source of truth; initialization failures stop workflow
storage instead of falling back to a stale JSON copy.

Shared memory follows the same one-way migration: `shared-memory.json` is imported in one transaction,
copied to `shared-memory.json.backup-v1`, and never read again. The SQLite database has exactly one
writer (the Electron main process, behind the local HTTP service). Sandboxed agents that cannot reach
`127.0.0.1` read `shared-memory.snapshot.json`, a mirror rewritten after every save or delete; writes
have no degraded path and fail loudly instead of racing the database.

The initial migration is `database/migrations/001_pi_studio_core.sql` and uses an isolated
`pi_studio` schema in the existing `trailai` database:

1. `schema_migrations`
   - `version`, `applied_at`
2. `installations`
   - anonymous desktop installation identity and app version; no hardware fingerprint
3. `workflows`
   - identity, name, input, workspace, schedule, enabled, notification configuration
4. `workflow_steps`
   - workflow order, type, prompt/template and engine/channel references
5. `workflow_runs`
   - status, trigger source, start/end time, summary and top-level error
6. `workflow_step_runs`
   - per-step status, duration, text summary, artifact reference and error
7. `image_jobs`
   - local job ID, engine/provider, prompt, status, remote ID/URL and timestamps; image bytes stay in files/R2
8. `publish_jobs`
   - target (`feishu`/`wechat`), workflow run, status, idempotency key, external document/media ID and error

Migration `002_installation_auth_accounts.sql` adds hashed per-installation bearer tokens plus
`accounts` and `account_installations`. Login remains optional: anonymous data is owned by one
installation, while a later login can link installations and expose account-owned data across devices.
Migration `003_account_owned_records.sql` makes the installation owner nullable once an account owns
the record, so removing a linked device cannot delete account-owned workflows or history.
Migration `004_owner_integrity.sql` enforces installation/account links and prevents a run from being
attached to a workflow owned by another installation or account.
Migration `005_owner_function_search_path.sql` pins the trigger lookup path so the same constraints
work for backend connections whose default schema is `public`.
Migration `006_preserve_account_records_on_unlink.sql` clears the creator installation from
account-owned rows before unlinking a device, preserving the ownership invariant and the data.

Do not put API keys, AppSecrets, access tokens, full Pi JSONL sessions, generated image bytes,
or Docker images in PostgreSQL.

Before local databases are opened, startup creates at most one backup per UTC day under
`userData/backups/YYYY-MM-DD`. The snapshot includes configuration, workflow state, shared memory,
and any SQLite WAL/SHM sidecars that exist. `manifest.json` records byte sizes and SHA-256 hashes.
The newest seven daily snapshots are retained. Pi conversation JSONL, generated media, logs, and
regenerable connection files are intentionally excluded to keep startup bounded.

Settings can schedule a restore from a valid manifest. The running process never replaces an open
SQLite database: it writes `.restore-pending.json` and relaunches. On the next startup, before IPC or
the shared-memory service can open stores, the app verifies every file hash, creates a pre-restore
protection point, stages the selected snapshot, and swaps files with rollback on failure. Files in the
managed backup set that are absent from the selected snapshot are removed so the restored state is
an exact snapshot. A failed plan is recorded in `.restore-failed.json` and consumed once to avoid a
restart loop.

## Repository boundary

Commit:

- `src/**`, `tests/**`, `scripts/**`, `docs/**`, `.github/**`
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- dependency patches under `patches/**`
- build configuration and source icons

Never commit:

- `node_modules/**`, `out/**`, `dist/**`, `*.tsbuildinfo`
- AppData/userData files, logs, Pi sessions, local Docker images
- API keys, webhook secrets, AppSecrets, access tokens or exported diagnostics
