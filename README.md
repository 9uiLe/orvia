# Orvia

> The human control plane for coding agents.

[![CI](https://github.com/9uiLe/orvia/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/9uiLe/orvia/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Status: pre-release foundation (v0.0.0).** Interfaces and the database schema will change. Not
published to any package registry yet.

## What is Orvia?

Orvia is a local daemon that keeps track of what coding agents (Codex, Claude Code, and others)
are working on, where, and under which human decisions. You talk to it from ChatGPT (through
MCP) or from the `orvia` CLI. Agents work on their own; you watch, and you step in when you
choose to.

## Why does it exist?

Running several agents at once raises questions that the agents themselves do not answer:
which agent is working on which change, in which worktree and branch, what the human already
decided, and how to stop or redirect one of them without stopping the rest. Orvia keeps that
state outside the agents and outside your repositories, and makes it explicit.

## Human-on-the-loop

Agents proceed without asking for approval on every step (that would be human-in-the-loop).
The human stays able to act at any time:

| Action                                      | How                                                             | Status                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Observe                                     | `get_status`, `get_plan`, `get_work_item`, `get_run_output`     | Implemented                                                                                                              |
| Pause / resume                              | `pause_work_item` (cancels a running agent), `resume_work_item` | Implemented                                                                                                              |
| Add context                                 | `add_context` (Plan or Work Item)                               | Implemented                                                                                                              |
| Redirect / reject / comment                 | `submit_feedback` with `kind`                                   | Implemented: recorded and included in the next agent prompt. It does not stop a running agent by itself; pause for that. |
| Record or change a decision                 | `record_decision`, with `supersedesDecisionId` to change one    | Implemented                                                                                                              |
| Rollback                                    | —                                                               | Not implemented (needs git changes; planned as an explicit feature)                                                      |
| Escalation of design questions to the human | —                                                               | Planned                                                                                                                  |

## Plans and Work Items

- A **Plan** (`P-42`) is a logical change you discuss with the human, e.g. "KMP rollout". It is
  not a branch or a PR.
- A **Work Item** (`W-101`) is one implementation unit: one branch, one git worktree, one PR. A
  Work Item can exist before it has a worktree or PR.
- A Plan can be split into several Work Items while staying one Plan:

```text
P-42 KMP rollout
├── W-101 Repository changes
├── W-102 UI changes
└── W-103 Legacy cleanup
```

- Every mutation takes explicit ids. Orvia has no "current" Plan or Work Item and never uses a
  chat session as an identity.

More: [ADR 0003](docs/adr/0003-plan-work-item-model.md).

## Architecture

```text
ChatGPT ── Secure MCP Tunnel ──┐
Claude Code / Codex (MCP) ─────┤
                               ▼
                         orvia mcp (stdio, stateless)
                               │
orvia CLI ─────────────────────┤  Unix socket (0700 directory)
                               ▼
                         orvia daemon ── the only process that opens the database
                         ├── Application: operation registry, use cases, run supervisor
                         ├── Domain: Plan, Work Item, workspace identity, storage policy
                         └── Infrastructure
                             ├── SQLite (node:sqlite, WAL, exclusive lock, migrations)
                             ├── git (read-only plumbing)
                             ├── cache (ephemeral, bounded)
                             └── agent adapters ── Codex, Claude Code
```

```text
src/
  domain/          pure types and rules; no Node.js, SQLite, git, or MCP imports
  application/     use cases, ports, and the operation registry shared by CLI, IPC, and MCP
  infrastructure/  SQLite, migrations, git, cache, config, paths, agent adapters
  interface/       daemon (composition root), IPC, CLI, MCP server
test/
  unit/            domain rules, config, paths, adapters, registry
  integration/     real git repos, real SQLite, a fake agent process, MCP clients
docs/adr/          architecture decisions
```

Decisions: [runtime and Nix](docs/adr/0001-runtime-and-nix.md) ·
[SQLite](docs/adr/0002-sqlite.md) · [Plans and Work Items](docs/adr/0003-plan-work-item-model.md) ·
[storage](docs/adr/0004-storage-policy.md) ·
[repository isolation](docs/adr/0005-repository-isolation.md) ·
[MCP boundary](docs/adr/0006-local-mcp-boundary.md)

## Implemented vs planned

Implemented (covered by tests):

- Plan and Work Item create/read/update/archive, Work Item split lineage, decisions with
  supersession, human context and feedback.
- Git repository and worktree discovery, Work Item ↔ worktree binding, workspace identity
  validation before every agent run (fails closed with `WORKSPACE_MISMATCH`).
- SQLite storage owned by the daemon; versioned, checksummed migrations with backup and
  rollback; refusal of databases newer than the binary.
- Configurable storage limits, pressure levels, automatic and manual cleanup, `HARD_LIMIT`
  gating.
- Daemon with a local socket API; CLI; MCP server over stdio.
- `AgentAdapter` abstraction with Codex and Claude Code adapters.

Experimental:

- `start_run` with the Codex and Claude Code adapters. The run lifecycle is tested with a fake
  agent; the real adapters' command lines are unit-tested but have not been run end to end in CI.

Not implemented / planned:

- Autonomous implement → review → fix loop, review tracking, design escalation.
- Orvia-enforced filesystem sandbox (see [Security model](#security-model)).
- Git operations: worktree creation, rollback, PR creation, git cleanup.
- MCP over Streamable HTTP (needs authentication first).
- Running the daemon as a launchd/systemd service; Windows support (path code exists, untested).
- Multi-machine handoff, cloud sync, web dashboard, telemetry (Orvia sends none).

## Development setup (Nix)

Nix is the standard development environment and what CI uses. It is not needed to _use_ Orvia.

```sh
git clone https://github.com/9uiLe/orvia.git
cd orvia
nix develop        # Node.js 24, npm, git, sqlite3 pinned by flake.lock
npm ci
npm test
```

Inside the shell: `npm run typecheck`, `npm run lint`, `npm test` (`test:unit`,
`test:integration`), `npm run build`, `npm run bench`, or `npm run check` for all of them.
Without Nix you need Node.js ≥ 24.15 and git; if results differ, the Nix shell is the
reference. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Installation

There is no release yet. From a checkout:

```sh
npm ci && npm run build
npm link            # puts `orvia` on your PATH (or run node dist/interface/cli/main.js)
```

Requires Node.js ≥ 24.15 and git at runtime.

## Quick start

```sh
orvia daemon &                     # foreground process; logs JSON lines to stderr
orvia doctor                       # checks Node, git, config, daemon, schema, storage

orvia create-plan --title "KMP rollout"
orvia create-work-item --plan-id P-1 --title "Repository changes" --branch kmp-repository
orvia discover-worktrees --repository-path ~/src/app
orvia bind-workspace --work-item-id W-1 --worktree-path ~/src/app-kmp-repository
orvia status

orvia start-run --work-item-id W-1 --agent codex --instructions "Move the repository layer to KMP"   # experimental
orvia pause-work-item --work-item-id W-1
```

`orvia` creates no files in your repository. Its state lives in user-local directories
([ADR 0005](docs/adr/0005-repository-isolation.md)).

## ChatGPT integration

`orvia mcp` is an MCP server over stdio that forwards every call to the daemon. Tools mirror the
operations (`get_status`, `create_plan`, `list_work_items`, `start_run`, `pause_work_item`,
`add_context`, `record_decision`, `submit_feedback`, `get_storage_status`, …; `orvia operations`
lists all). Read-only tools carry `readOnlyHint`, so ChatGPT asks for confirmation only on
writes.

Per OpenAI's documentation, ChatGPT (developer mode) reaches MCP servers through a public HTTPS
URL or a **Secure MCP Tunnel**, which can launch a local stdio server. To use Orvia:

1. Run `orvia daemon`.
2. Configure a Secure MCP Tunnel whose server command is `orvia mcp`.
3. In ChatGPT, create a developer-mode app and select the tunnel.

Verification status: `orvia mcp` is tested with MCP SDK clients for protocol 2026-07-28 and for
the earlier revisions. **A connection from ChatGPT itself has not been tested.** Do not expose
Orvia through a public URL: it has no authentication.

Other MCP clients that can launch a stdio server work the same way (untested examples):
`claude mcp add orvia -- orvia mcp`, or in Codex `~/.codex/config.toml`:
`[mcp_servers.orvia]` with `command = "orvia"` and `args = ["mcp"]`.

## CLI

```text
orvia daemon       run the daemon in the foreground (owns the database)
orvia mcp          MCP server over stdio
orvia doctor       diagnose environment, config, daemon, schema, storage (--json)
orvia status       get_status            orvia plans       list_plans
orvia work-items   list_work_items       orvia storage     get_storage_status
orvia cleanup      run_storage_cleanup   orvia migrate     schema status
orvia operations   list every operation and its flags
orvia <operation> --flag value …   e.g. orvia get-plan --plan-id P-1
```

Every operation prints JSON. The CLI and MCP tools are generated from the same operation
registry, so they behave identically. Migrations run when the daemon starts; `orvia migrate`
reports the result.

## Storage model

| Class            | What                                                                                  | Where           | Lifetime                             |
| ---------------- | ------------------------------------------------------------------------------------- | --------------- | ------------------------------------ |
| Durable          | Plans, Work Items, workspace bindings, PR URLs, decisions, human context and feedback | SQLite          | never removed automatically          |
| Bounded metadata | Agent Run records                                                                     | SQLite          | newest N finished runs per Work Item |
| Reconstructible  | diffs, source scans, build details                                                    | not stored      | recomputed from git                  |
| Ephemeral        | agent output                                                                          | cache directory | TTL + size cap, oldest evicted first |

Large text (agent output, diffs, source, prompts) is never stored in SQLite. Storage cleanup
never touches git repositories, worktrees, branches, or commits; this is tested.
Details: [ADR 0004](docs/adr/0004-storage-policy.md).

## Storage configuration

`config.toml` in the config directory (`~/Library/Application Support/orvia/` on macOS,
`~/.config/orvia/` on Linux). All keys are optional; these are the defaults:

```toml
log_level = "info"                     # error | warn | info | debug | trace

[storage]
database_max_mb = 128                  # state.db + WAL + SHM + migration backups
cache_max_mb = 512                     # agent output cache
retention_days = 7                     # cache entries and migration backups
max_completed_runs_per_work_item = 5
pressure_percent = 70                  # cleanup starts
warning_percent = 90                   # status reports WARNING

[agents.codex]
command = "codex"                      # path or name on PATH
[agents.claude]
command = "claude"
```

The size defaults come from the project brief and the thresholds were set by the maintainer.
They are starting points to revisit with real usage data, not measured optima. Invalid values
stop the daemon with `CONFIG_INVALID`.

Pressure levels: `NORMAL` → `PRESSURE` (cleanup starts) → `WARNING` → `HARD_LIMIT` (limit minus
a maintenance reserve of one WAL checkpoint interval). At `HARD_LIMIT`, status, storage status,
pause/resume, cleanup, and archive keep working; new writes and agent runs are refused.

## Security model

What Orvia does:

- Keeps all state in user-local directories; writes nothing into your repositories.
- Lets only the daemon open its database (SQLite exclusive lock).
- Exposes its API on a Unix socket inside a directory with mode 0700 owned by you.
- Validates a Work Item's repository, worktree, and branch identity immediately before starting
  an agent, and refuses on any mismatch. The agent's working directory comes from the Work Item,
  never from the agent.
- Passes prompts to agents on stdin, not on the command line.
- Stores no credentials and sends no telemetry. Logs contain ids and counts, not prompts, agent
  output, or file contents.

What Orvia does **not** guarantee:

- **No Orvia-enforced filesystem sandbox.** Agents run with your user's permissions. Orvia
  computes a filesystem policy (worktree root plus its git directories) and passes it to each
  agent's own mechanism: Codex's `workspace-write` sandbox, and Claude Code's permission
  settings (not an OS sandbox). How well that holds depends on the agent.
- Workspace identity is checked immediately before launch, not continuously. An agent or a
  person can still change branches or files afterwards.
- `get_run_output` returns agent output to whichever client asks for it, including ChatGPT.
  Agent output can contain your source code.
- MCP clients and ChatGPT are subject to prompt injection from content they read. Write tools
  require ChatGPT's confirmation, but review what you approve.
- Windows has not been tested.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Performance

`npm run bench` measures the status queries ChatGPT triggers. On an Apple Silicon laptop
(Node 24.21, 100 Plans × 5 Work Items), p95 latency was 0.02–1.0 ms in-process and 0.08–1.5 ms
over the daemon socket. The brief's candidate budget is p95 < 50 ms. CI does not enforce it
because shared runners vary too much for a fixed threshold to mean anything.

## Roadmap

1. Agent run hardening: run the real Codex and Claude Code adapters end to end, structured
   output parsing, run summaries.
2. Review loop: review findings and their resolution as durable records; escalation of design
   questions to the human.
3. Git operations as explicit features: worktree creation, PR mapping from the GitHub CLI,
   rollback.
4. Orvia-enforced filesystem sandbox at the process launch boundary.
5. MCP over Streamable HTTP with authentication; verified ChatGPT setup guide.
6. Distribution ([docs/releasing.md](docs/releasing.md)) and service units for launchd and
   systemd.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and the
[Code of Conduct](CODE_OF_CONDUCT.md). Questions: [SUPPORT.md](SUPPORT.md).

## License

[Apache License 2.0](LICENSE).
