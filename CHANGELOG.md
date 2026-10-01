# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0, minor versions may contain breaking changes.

## [Unreleased]

### Added

- Nix flake development environment (Node.js 24, git, sqlite) pinned by `flake.lock`.
- Plans, Work Items (with split lineage), decisions with supersession, human context and
  feedback.
- Git worktree discovery, Work Item ↔ worktree binding, and workspace identity validation that
  fails closed with `WORKSPACE_MISMATCH`.
- Daemon-owned SQLite database with versioned, checksummed migrations, backups, and refusal of
  newer schemas.
- Configurable storage limits with pressure levels, automatic cleanup, and `HARD_LIMIT` gating.
- `orvia` CLI, local IPC socket, and an MCP server over stdio.
- JSON configuration (`config.json`) validated at startup.
- `AgentAdapter` abstraction with experimental Codex and Claude Code adapters.
