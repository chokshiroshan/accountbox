# Accountbox — Project Manifest

*Last updated: 2026-02-04*

Accountbox is a Node.js CLI that runs Codex + Claude Code with:
- per-account isolation (avoid “wrong account in wrong repo”)
- repo-local defaults (`.accountbox.toml`)
- optional extensible tool runners (`accountbox run <toolId> ...`)

## What it does (today)

- **Codex**: containerized, per-account Docker volume at `/root/.codex`
- **Codex login**: host-based OAuth/device login, then sync `auth.json` into the Docker volume
- **Claude Code**: native, per-account isolation via XDG dirs
- **Usage visibility**: `accountbox codex limits` fetches ChatGPT `wham/usage` per label

## Key commands

- `accountbox codex <label> login [--browser] [--force] [--fresh-browser]`
- `accountbox codex <label> [codex args...]`
- `accountbox codex limits [--json] [--raw] [--timeout-ms N] [--concurrency N]`
- `accountbox set codex <label>` / `accountbox set claude <label>`
- `accountbox doctor`

## Key files

- `README.md` — user-facing docs
- `bin/accountbox.js` — CLI implementation
- `Dockerfile.codex` — minimal Codex image
- `infrastructure/terraform/` — optional AWS stack (ECR + optional alarms/Lambda)

## Known gaps

- API-key based limits fetch is not implemented yet (`codex ... limits` only supports ChatGPT OAuth `auth.json`).
- No test suite yet (workflows use smoke checks).
