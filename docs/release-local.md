# Local Release Flow

Use the local release script instead of `electron-builder --publish always` when publishing from this Windows machine.

```powershell
pnpm.cmd run release:local
```

The script:

1. Reads `version`, `productName`, and GitHub publish config from `package.json`.
2. Requires a clean working tree unless `--allow-dirty` is passed.
3. Runs the full `pnpm run verify` gate (encoding, typecheck, tests, lint, and build), then packages with `electron-builder --win --publish never`.
4. Verifies `dist/latest.yml` matches the generated setup exe size and SHA-512.
5. Copies the setup exe and blockmap to the dash-named filenames referenced by `latest.yml`.
6. Creates the `vX.Y.Z` tag, pushes `HEAD` and the tag.
7. Creates or updates the GitHub Release with the setup exe, blockmap, and `latest.yml`.
8. Verifies the uploaded release assets.

Useful commands:

```powershell
pnpm.cmd run release:dry
node scripts/release-local.js --install
node scripts/release-local.js --skip-build
```

`--skip-build` reuses existing release artifacts but still runs `pnpm run check`; it never bypasses the encoding, typecheck, test, or lint gates.

Before running a real release, bump `package.json` version, commit it, and make sure `gh` is logged in.

## ToolTransport Release Gate

The runtime smoke checks an explicitly selected online desktop through the backend:
device discovery, controller authentication, `executeToolOperation` capability,
workspace opening, and a successful `shell.exec` running `pwd`.
It uses the control plane's `personal-agent-runtime` CLI (repo `pi-studio-control-plane`) and its `.env`; service tokens
stay out of command arguments and this repository.

Configure the target in the current PowerShell session:

```powershell
$env:PI_STUDIO_SMOKE_DEVICE_ID = 'pi-studio:<device-id>'
$env:PI_STUDIO_SMOKE_WORKSPACE = 'D:\Works\pi-studio-control-plane'
# Optional when the control plane is not the sibling checkout (the script tries ../pi-studio-control-plane, then ../personal-agent-runtime):
$env:PI_STUDIO_RUNTIME_PATH = 'D:\Works\pi-studio-control-plane'
# Optional when Python is not in that checkout's .venv:
# $env:PI_STUDIO_RUNTIME_PYTHON = 'C:\path\to\python.exe'

pnpm.cmd run smoke:runtime
pnpm.cmd run release:verify --skip-build
```

`release:verify` runs the normal release checks, verifies installer hashes, and
runs the remote smoke without creating tags, pushing, uploading, or installing.
Omit `--skip-build` to build a fresh installer first. A dirty checkout still
requires `--allow-dirty`. This local verification does not require `gh`.

To enforce the same smoke before a real publication:

```powershell
pnpm.cmd run release:local --smoke-runtime
```

Any smoke failure or its three-minute timeout stops the release before tag/push/upload.
Plain `release:local`, `package:win`, and CI publishing do not enable this remote gate.
The host must already be running with remote access enabled. The smoke opens the
specified workspace, so use a dedicated validation workspace on that device.

This checks the running host, not the unopened installer: install and start the
candidate build on the selected device first when validating that build. It does
not attest the host's version, perform an LLM turn, or validate task resume; the
full agent E2E remains a separate check. No installation or restart is automatic.

To include file tools and the durable resume queue, set
`$env:PI_STUDIO_SMOKE_FILES = '1'` before either command. This requires a host
advertising `local.read` and `local.write`. It creates a uniquely named
`.tooltransport-smoke-<id>.txt` in the selected workspace, verifies that a second
create fails without overwriting it, and reads back the original Unicode content.
An isolated temporary runtime database verifies pause, claim, success/error result,
requeue and continuation prompt injection. The file remains as smoke evidence;
the temporary database is closed and removed. This does not call an LLM or prove
provider-native session resume. Unset this variable to return to shell-only smoke.
