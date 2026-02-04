# accountbox

`accountbox` runs **Codex** and **Claude Code** with *per-account isolation* and per-project defaults.

This repo is a Node CLI package (publishable to npm/Homebrew).

Goals:
- Multiple accounts without clobbering your main browser session.
- Fast: keep Claude Code native; isolate Codex via containers.
- Reproducible-ish: install latest by default, but don’t reinstall every run.

## Requirements

- macOS or Linux (Windows not supported yet)
- Node.js >= 18
- Docker-compatible runtime (for `accountbox codex ...`)

## Quick start

### Install

If installed via npm, run the interactive installer:

```bash
accountbox install
# or
abox i
```

(If you cloned this repo, you can also run `./install.sh` to drop a binary into `~/.local/bin`.)

```bash
# Install accountbox + container runtime (macOS)
./install.sh

# In a project directory
cd /path/to/repo

# Create a Codex profile/label and login (choose one)
accountbox codex roshan login               # device code (default)
accountbox codex roshan login --browser     # browser OAuth (localhost callback)
OPENAI_API_KEY=... accountbox codex roshan login --api-key

# Run Codex (containerized)
accountbox codex roshan

# Claude Code (native)
accountbox claude roshan
```

## Commands

```bash
accountbox codex  <account> [codex args...]
accountbox claude <account> [claude args...]

# Use per-project defaults (no <account> needed)
accountbox codex
accountbox codex status
accountbox codex whoami
accountbox codex limits
accountbox codex rebuild
accountbox codex logout
accountbox codex list
accountbox codex snapshots
accountbox codex <account> save <snapshotName>
accountbox codex [account] switch <snapshotName> [toAccount]
accountbox codex use <account>
accountbox codex <account> app [--quit]

accountbox set codex  <account>
accountbox set claude <account>

accountbox browser <account> <url>
accountbox doctor
accountbox run <toolId> [account] [args...]
accountbox tools list|show|validate
accountbox resolve <toolId> [--cwd <path>] [--json]
```

## Limits / Usage

`accountbox codex limits` fetches per-account usage from ChatGPT (`/backend-api/wham/usage`) using the OAuth token stored in each label’s `auth.json`.

```bash
# All accounts
accountbox codex limits

# One account
accountbox codex roshan limits

# Machine-readable
accountbox codex limits --json

# Options
accountbox codex limits --timeout-ms 10000 --concurrency 4

# Print raw API response (no masking)
accountbox codex limits --json --raw
```

## Profiles (account labels)

A “profile” in accountbox is just the `<account>` label you pass on the command line (e.g. `roshan`, `try1`, `work`).

Create a new profile/label by logging in:

```bash
accountbox codex try1 login --browser
accountbox codex try1 whoami
```

Toggle between profiles by:
- passing the label explicitly: `accountbox codex try1`
- setting the repo default: `accountbox set codex try1` (writes `.accountbox.toml` at repo root)
- or inside a repo: `accountbox codex use try1`

## Per-project account defaults

`accountbox` looks for a `.accountbox.toml` in your repo (walking upward until `.git`).

Example `.accountbox.toml`:

```toml
codex_account = "roshan"
claude_account = "alt"
```

Set it quickly:

```bash
accountbox set codex roshan
# writes/updates .accountbox.toml
accountbox set claude alt
```

## Custom tools config

You can add your own tool definitions in:

```
~/.config/accountbox/tools.toml
```

Override the location with `ACCOUNTBOX_TOOLS_TOML`.

### Tool “plugins” (TOML-only)

Accountbox’s “plugin” system is intentionally simple: tools are defined in TOML (no JS execution).

Example `~/.config/accountbox/tools.toml`:

```toml
[tools.aider]
mode = "native"
command = "aider"
isolate = true

[tools.gh]
mode = "native"
command = "gh"
isolate = false
```

Inspect and validate:

```bash
accountbox tools list
accountbox tools show aider --json
accountbox tools validate
```

## Browser sandboxing for login

- For **Codex**, `accountbox ... login` defaults to device code flow (`--device-auth`).
- If device auth isn’t allowed for your plan, use `--browser` (authorization code + PKCE, localhost callback).
- `accountbox browser <account> <url>` opens the URL in a separate browser profile when possible.

Tip: `accountbox codex whoami` prints the masked email for the current `auth.json` so you can confirm you’re on the right OpenAI account.

Switching OpenAI accounts for a label:
- `accountbox codex logout`
- `accountbox codex login --browser --force --fresh-browser` (fresh sandboxed Chrome profile)

Flags:
- `--force`: moves the existing host `auth.json` aside before logging in (prevents “re-using” stale credentials)
- `--fresh-browser`: resets the sandboxed Chrome profile dir for that label (prevents “re-using” cookies / the wrong logged-in account)

Notes:
- `accountbox codex <label> login` runs Codex **on the host** (not in the container) to complete OAuth reliably, then syncs `auth.json` into the Docker volume.
- If `codex` isn’t installed on the host, accountbox will fall back to `npx` using `ACCOUNTBOX_CODEX_HOST_NPM_SPEC` (default: same as `ACCOUNTBOX_CODEX_NPM_SPEC`).
- `--api-key` uses `OPENAI_API_KEY` from your environment and stores credentials only in the Docker volume (so `whoami` won’t work; use `status`).

Behavior:
- If Google Chrome is installed: opens Chrome with `--user-data-dir ~/.accountbox/browser/<account>`
- Otherwise: opens your system default browser (not truly sandboxed)

## Codex app (macOS)

If you use the Codex desktop app, you can launch it using an accountbox label:

```bash
accountbox codex <label> app
```

To run multiple app instances at the same time (separate Electron user data per label):

```bash
accountbox codex <label> app --multi
```

To switch labels, quit/restart the app first:

```bash
accountbox codex <label> app --quit
```

## Account isolation model

### Codex
Codex stores state under `CODEX_HOME` (default `~/.codex`) and caches credentials in `auth.json` (or OS keychain). We avoid collisions by:
- running Codex in a container
- mounting a per-account Docker volume at `/root/.codex`

This does **not** keep 1 container per account running. Containers are ephemeral; per-account state lives on disk:
- Docker volume: `accountbox_codex_<account>`
- Host auth cache: `~/.accountbox/codex/<account>/auth.json`

Relevant upstream docs:
- https://developers.openai.com/codex/auth/
- https://developers.openai.com/codex/config-advanced/

### Claude
Claude Code is installed natively and auto-updates.
We isolate per-account state by setting XDG dirs:
- `XDG_CONFIG_HOME=~/.accountbox/claude/<account>/config`
- `XDG_DATA_HOME=~/.accountbox/claude/<account>/data`
- `XDG_STATE_HOME=~/.accountbox/claude/<account>/state`

If Claude ignores XDG in some environments, the fallback is using separate macOS users.

## Updating

- `accountbox` does **not** reinstall CLIs on every run.
- Codex container image is built/pulled on first use.
- Run `accountbox doctor` to see status.

Environment overrides:
- `ACCOUNTBOX_CODEX_NPM_SPEC` (default: `@openai/codex@latest`)

## Security

- Treat Codex `auth.json` like a password.
- Don’t paste API keys/tokens into chat or issues.
- Each account’s browser profile dir lives under `~/.accountbox/browser/<account>`.

## Using with Clawdbot / OpenClaw

Accountbox doesn’t integrate with Clawdbot directly (it won’t touch `~/.clawdbot/*`), but it’s useful when you’re operating Clawdbot/OpenClaw in multiple repos and juggling multiple Codex/Claude accounts.

Recommended: set per-repo defaults in the repo you use for Clawdbot work (e.g. `~/clawd/.accountbox.toml`):

```toml
codex_account = "work"
claude_account = "work"
```

Preflight before heavy work:

```bash
# Check which accounts have headroom
accountbox codex limits

# Resolve the default account for the current repo (scripts can use --json)
accountbox resolve codex
accountbox resolve codex --json
```
