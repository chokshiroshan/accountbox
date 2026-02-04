# Accountbox — Design Notes (2026-01-31)

This file captures the key decisions and lessons from the initial build/debug session.

## Problem
Need multi-account support for terminal AI CLIs (Codex + Claude Code) without clobbering:
- the user’s main browser session
- global auth state across projects

Also want:
- per-project defaults (repo chooses account)
- extensibility to support more tools later

## Core Value Prop (why not just a “switcher”)
Accountbox is a **project-aware account/context router**:
- repo-local `.accountbox.toml` selects which account to use
- per-account isolation avoids “wrong account in wrong repo” mistakes
- tool-agnostic runner (`accountbox run <tool> <account> ...`) enables adding more CLIs

## Key Decisions

### 1) Codex execution: containerized per account
- Use a Docker-compatible runtime (OrbStack recommended on macOS)
- Use a per-account Docker volume:
  - `accountbox_codex_<account>:/root/.codex`
- Mount repo into container at `/work`

Why: isolates `CODEX_HOME` state cleanly per account.

### 2) Codex login: **host-based** + sync auth.json into volume
We hit two real-world issues:
- **Device auth inside container** returned Cloudflare challenge (HTTP 403 `cf-mitigated: challenge`).
- **Browser OAuth + localhost callback inside container** was brittle: the callback server behaved like it was bound to container localhost (host saw `ERR_EMPTY_RESPONSE`).

Therefore the reliable flow is:
1. Run `codex login` on the host with per-account `CODEX_HOME=~/.accountbox/codex/<account>`
2. Force file-based credential storage: `--config cli_auth_credentials_store="file"`
3. Auto-open the printed auth URL in a sandboxed Chrome profile (best-effort; some CLIs may still open default browser)
4. After login, sync:
   - host `~/.accountbox/codex/<account>/auth.json`
   - into Docker volume `/root/.codex/auth.json`

This makes containerized Codex work reliably after a one-time per-account login.

Follow-up fixes (2026-02-04):
- **TLS failures inside container**: install `ca-certificates` in `Dockerfile.codex` (fixes `error sending request for url (https://chatgpt.com/backend-api/...)` in some environments).
- **Sandboxed Chrome callback flakiness**: force `localhost -> 127.0.0.1` resolution for the sandboxed browser profile (Codex binds its callback server on IPv4).
- **Account mismatches after logout**: `accountbox codex logout` now clears both the container session and the host `auth.json` to keep them consistent.
- **Usage visibility**: `accountbox codex limits` fetches per-label limits via ChatGPT `wham/usage` so you can sanity-check that you’re on the right account/plan.

### 3) Claude Code: native per account via XDG isolation
Claude Code is installed natively and auto-updates.
Per-account isolation is done by setting:
- `XDG_CONFIG_HOME=~/.accountbox/claude/<account>/config`
- `XDG_DATA_HOME=~/.accountbox/claude/<account>/data`
- `XDG_STATE_HOME=~/.accountbox/claude/<account>/state`

(If Claude ignores XDG on some systems, fallback may be separate OS users.)

### 4) Browser sandboxing approach
- Prefer Chrome if installed (supports `--user-data-dir <dir>` for isolated profiles)
- Fallback: system default browser (not truly sandboxed)

We observed Codex may still open default browser (Comet) regardless; treat as noise and direct users to the sandboxed Chrome window.

### 5) Installer
- Interactive `accountbox install` / `accountbox i`
- Auto-runs installs with confirmation (OrbStack via Homebrew)
- Resumable via `~/.accountbox/install-state.json`

## UX Commands Implemented
- `accountbox install` / `abox install` / `accountbox i`
- `accountbox codex <account> ...` (runs in container)
- `accountbox codex login` (host login + sync)
- `accountbox codex list`
- `accountbox codex snapshots`
- `accountbox codex <account> save <snapshotName>`
- `accountbox codex switch <snapshotName> [toAccount]`
- `accountbox codex use <account>` (writes repo default)

## Remaining Improvements
- Make installer always default to host-based device auth (when enabled), else API-key, and clearly detect fallback to localhost OAuth.
- Better browser control messaging (default browser may open; ignore).
- Consider adding a top-level `accountbox update` alias for `accountbox codex rebuild` (optional).
- Add API-key based limits fetch (`codex ... limits`) for the `{base_url}/api/codex/usage` path.
