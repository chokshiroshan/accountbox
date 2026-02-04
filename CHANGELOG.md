# Changelog

All notable changes to Accountbox will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `accountbox codex limits` (fetches ChatGPT `wham/usage`) with `--json`, `--raw`, `--timeout-ms`, `--concurrency`
- `accountbox codex whoami` (masked email) for debugging account mismatches
- `accountbox codex status`, `logout`, `rebuild` helpers
- Improved Codex login ergonomics (`--browser`, `--force`, `--fresh-browser`)

### Changed
- Codex container image installs `ca-certificates` (fixes TLS failures in some environments)
- Sandboxed Chrome login flow forces `localhost -> 127.0.0.1` for callback reliability
- `accountbox codex logout` clears both container session and host `auth.json` to keep them consistent
- `accountbox doctor` output expanded (cwd/git root/project config/default accounts)

### Fixed
- `.git` detection when `.git` is a file (worktrees/submodules)
- Docker TTY handling so passthrough flags like `-V` work in non-interactive shells
- Tools config path default (`~/.config/accountbox/tools.toml`) with legacy fallback

## [0.1.0] - 2026-02-02

### Added
- Initial release of Accountbox
- Per-account wrappers for Codex and Claude Code
- Docker containerization for Codex
- XDG-based isolation for Claude Code
- Project-local configuration via `.accountbox.toml`
- Interactive installer script
- CLI commands: `codex`, `claude`, `doctor`, `install`
- Account management: login, list, snapshots, save, switch, use
- Browser sandboxing with isolated Chrome profiles
- Codex auth sync between host and container
- Per-account Docker volumes for Codex state

## Release Process (maintainers)

1. Update `CHANGELOG.md`
2. Bump version in `package.json`
3. Create and push a tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`
4. GitHub Actions handles the release (see `.github/workflows/release.yml`)
