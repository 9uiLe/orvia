# Orvia

> The human control plane for coding agents.

[![CI](https://github.com/9uiLe/orvia/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/9uiLe/orvia/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Status: pre-release foundation (v0.0.0).** Interfaces and the database schema will change. Not
published to any package registry yet.

## What is Orvia?

Orvia is a local daemon that keeps track of what coding agents are working on, where, and under
which human decisions. You talk to it from any MCP client or from the `orvia` CLI. Agents are
run through configured Agent Profiles; Orvia ships adapters for two agent CLIs, and its
orchestration does not depend on either. Agents work on their own; you watch, and you step in when you
choose to. An orchestration cycle lets agents implement, verify, review, and fix routine
problems without you, and stops when a human decision is needed.

## Why does it exist?

Running several agents at once raises questions that the agents themselves do not answer:
which agent is working on which change, in which worktree and branch, what the human already
decided, and how to stop or redirect one of them without stopping the rest. Orvia keeps that
state outside the agents and outside your repositories, and makes it explicit.

## Human-on-the-loop

Agents proceed without asking for approval on every step (that would be human-in-the-loop).
The human stays able to act at any time:

| Action                                      | How                                                                                              | Status                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Observe                                     | `get_status`, `get_plan`, `get_work_item`, `get_run_output`                                      | Implemented                                                                                                              |
| Pause / resume                              | `pause_work_item`, `resume_work_item`                                                            | Implemented. Pause returns only after the agent and the processes it started have stopped (macOS/Linux; see below).      |
| Pause / resume a cycle                      | `pause_cycle`, `resume_cycle`, `cancel_cycle`                                                    | Implemented with the same process guarantee as Work Item pause (see [Orchestration cycles](#orchestration-cycles)).      |
| Add context                                 | `add_context` (Plan or Work Item)                                                                | Implemented                                                                                                              |
| Redirect / reject / comment                 | `submit_feedback` with `kind`                                                                    | Implemented: recorded and included in the next agent prompt. It does not stop a running agent by itself; pause for that. |
| Record or change a decision                 | `record_decision`, with `supersedesDecisionId` to change one                                     | Implemented                                                                                                              |
| Rollback                                    | —                                                                                                | Not implemented (needs git changes; planned as an explicit feature)                                                      |
| Escalation of design questions to the human | Cycles stop at `NEEDS_HUMAN`; answer with `record_decision` / `add_context`, then `resume_cycle` | Implemented (experimental; see [Compatibility](#compatibility))                                                          |

### What pause guarantees

`pause_work_item` succeeds only after the Work Item's agent **and every process it started that
stayed in its process group** have exited, the run is recorded as `cancelled`, and the Work Item
is `paused`. Orvia sends `SIGTERM` to the group, waits `agents.termination_grace_ms` (10 s by
default), then sends `SIGKILL` and waits up to `agents.kill_confirmation_ms` (5 s). If the
processes still cannot be confirmed gone, pause fails with `AGENT_TERMINATION_FAILED` and the Work
Item stays `active`. It is never shown as paused while its agent may be running. This holds on
macOS and Linux. Processes that leave the group (`setsid`, daemonizing tools) are not covered.
On Windows only the agent process itself is stopped. Details:
[ADR 0008](docs/adr/0008-agent-process-lifecycle.md).

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

## Orchestration cycles

**Experimental.** The loop is tested end to end with scripted fake adapters, and was run locally
with real agent CLIs ([Compatibility](#compatibility)); CI does not run real agents.

A **Cycle** (`C-17`) is one automated pass over a Work Item:

```text
start_cycle (implement)          start_cycle (review_existing)
        │                                   │
   IMPLEMENTING ──► VERIFYING ◄─────────────┘
                      │   ▲
             passed   │   │ fixed
                      ▼   │
                  REVIEWING ──► FIXING     (routine findings, failed checks)
                      │
          ┌───────────┼──────────────────┐
          ▼           ▼                  ▼
 HUMAN_REVIEW_READY  NEEDS_HUMAN       BLOCKED / PAUSED
 (stop; your turn)   (decision needed) (resume when ready)
```

- A Work Item has at most one active cycle. The cycle's state is separate from the Work Item's
  status. While a cycle is active, `start_run`, `complete_work_item`, and `archive_work_item` are
  refused with `CYCLE_ACTIVE`.
- A cycle uses two [Agent Profiles](#agent-profiles-and-capabilities): the implementation
  profile implements, verifies, and fixes; the review profile reviews. They can use different
  agents.
- **Implement**: the implementation agent works on the cycle's instructions in the bound
  worktree. If the work needs a human decision, it stops and reports that it needs input.
- **Verify**: the same profile finds the repository's own checks (package scripts, Makefile,
  README, AGENTS.md, CI configuration), runs them, and reports each check with its exit code.
  This is **agent-reported verification**: Orvia checks that the report is consistent but does
  not run or attest the commands itself. Orvia adds nothing to your repository. If the checks
  cannot run here, the cycle is `BLOCKED / VERIFICATION_BLOCKED`, never passed.
- **Review**: Orvia collects the changes from git itself: `git status` (including untracked
  files) and the diff from the cycle's base commit (`HEAD` when the cycle starts, or
  `--base-ref`) to the working tree. They go into the review prompt as data. The reviewer gets
  only read access, is told not to rely on the implementer's report, and returns structured
  findings, each with a category and evidence. If the changes exceed
  `orchestration.max_review_diff_kb` (256 KiB), no partial review is done: the cycle stops at
  `NEEDS_HUMAN / CHANGES_TOO_LARGE`.
- **Fix (auto-fix)**: failed checks, and findings in routine categories (correctness, test,
  build, style, and code that clearly differs from a recorded decision or acceptance criterion)
  that name a file, go to the fix agent. It receives only those findings, not the reviewer's
  other text. After a fix, the cycle verifies and reviews again.

**When Orvia escalates.** The cycle stops at `NEEDS_HUMAN` with a reason when:

| Reason                     | Cause                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DECISION_REQUIRED`        | a finding is about design, scope, acceptance criteria, public API, database schema, security, dependencies, architecture, a conflicting decision, or an ambiguous requirement; or its category is `unknown`; or a routine finding names no file |
| `REVIEWER_REQUESTED_HUMAN` | the reviewer could not judge the change                                                                                                                                                                                                         |
| `AGENT_NEEDS_INPUT`        | the implementation or fix agent needs information or a decision                                                                                                                                                                                 |
| `FIX_DISPUTED`             | the fix agent disagrees with a finding                                                                                                                                                                                                          |
| `LOOP_LIMIT`               | automatic fixes reached `orchestration.max_review_fix_cycles` (default 3)                                                                                                                                                                       |
| `CHANGES_TOO_LARGE`        | the changes to review exceed `orchestration.max_review_diff_kb`                                                                                                                                                                                 |

The decision is made by Orvia's fixed rules, not by a model. A review with any finding for a
human starts no fix. `get_cycle` shows the reason and the ids of the findings that need you;
`get_current_review` and `get_review` show the findings. Answer with `record_decision` or
`add_context` and call `resume_cycle`. Resume composes every prompt again from the latest Plan,
decisions, and context, and checks the worktree identity again. After a review escalation the
cycle reviews again; if the code may have changed since the last passed verification (a fix
stopped partway), it verifies first.

**`HUMAN_REVIEW_READY`** means verification passed and the reviewer found nothing. Automation
stops there. Orvia does not create, review, or merge PRs; the Work Item stays `active` for you.

**Loop limit.** `orchestration.max_review_fix_cycles` (default 3) limits automatic fix rounds.
At the limit the cycle stops at `NEEDS_HUMAN / LOOP_LIMIT`. The count starts again each time
you resume from `NEEDS_HUMAN`.

**Pause and resume.** `pause_cycle` stops the running agent with the same process-group
termination as `pause_work_item` and reports `PAUSED` only after the run is recorded as
cancelled. If the agent cannot be stopped, the cycle is not paused. `pause_work_item` also
pauses the Work Item's cycle. If it lands while the next stage is being started, that stage
does not start and the cycle may show `BLOCKED / START_FAILED` instead of `PAUSED`; no agent
runs either way, and `resume_cycle` continues it. `resume_cycle` continues the stage that was
interrupted. `cancel_cycle` ends the cycle.

**Fail closed.** The cycle stops at `BLOCKED` instead of guessing when:

- a review is not valid structured output (`REVIEW_PROTOCOL_INVALID`). This covers free text,
  invalid JSON, an unknown category, a missing field, a field over its limit, or a verdict that
  contradicts the findings. Other stages use `RESULT_PROTOCOL_INVALID`.
- an agent exits with an error (`RUN_FAILED`).
- the daemon restarted during a stage (`RUN_INTERRUPTED`; nothing is relaunched automatically).
- a stage could not start: its profile is no longer configured (`AGENT_PROFILE_NOT_FOUND`),
  lacks a capability the stage needs (`AGENT_CAPABILITY_MISMATCH`), or its command is missing
  (`AGENT_UNAVAILABLE`); storage is at `HARD_LIMIT` (`STORAGE_HARD_LIMIT`); the cache has no
  room to set aside for the stage's result (`RESULT_STORAGE_EXHAUSTED`); anything else is
  `START_FAILED`.
- a result did not fit in the database (`STORAGE_HARD_LIMIT`), or Orvia could not keep the
  agent's output (`RESULT_STORAGE_EXHAUSTED`). These are storage failures, reported separately
  from an agent's malformed output.

Fields over a limit are rejected, not truncated. The limits are 20 findings per review; title
200, detail 2,000, and suggested action 1,000 characters; 5 evidence items per finding; summary
2,000 characters; 20 verification commands.

**Current limitations.**

- Verification is agent-reported. Orvia requires a consistent report (checks, exit codes) and
  an independent review, but does not detect an agent that misreports what it ran.
- Fix scope is instructed, not enforced.
- Findings are not matched across reviews; each review is a fresh assessment.

Details: [ADR 0010](docs/adr/0010-orchestration-cycle-and-review-policy.md).

## Agent profiles and capabilities

| Term                  | Meaning                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Adapter         | Code in Orvia that knows how to run one kind of agent CLI: its flags, sandbox or permission controls, structured-output mechanism, and output envelope. |
| Agent Profile         | An entry in your configuration: an id you choose (`primary`, `reviewer`), the adapter it uses, its command, and optionally fewer capabilities.          |
| Agent Capability      | Something Orvia needs an agent to be able to do, named by effect, not by any CLI's mechanism.                                                           |
| Cycle role / stage    | Implement, verify, review, fix. Each stage requires a fixed set of capabilities.                                                                        |
| Concrete provider/CLI | The agent program itself. Only adapters know about it; cycles, reviews, and policies do not.                                                            |

| Capability         | Meaning                                        | Required by          |
| ------------------ | ---------------------------------------------- | -------------------- |
| `workspaceRead`    | read files in the bound worktree               | every stage          |
| `workspaceWrite`   | change files in the bound worktree             | IMPLEMENTING, FIXING |
| `commandExecution` | run the repository's checks                    | VERIFYING            |
| `structuredResult` | end with JSON matching a schema Orvia supplies | every stage          |

A profile's capabilities are those its adapter provides, narrowed by the profile's optional
`capabilities` list; configuration cannot add one the adapter lacks. Each run is granted only
what its stage requires, so a review cannot edit.

```json
{
  "agents": {
    "profiles": {
      "primary": { "adapter": "<adapter id>" },
      "reviewer": {
        "adapter": "<adapter id>",
        "capabilities": ["workspaceRead", "structuredResult"]
      }
    }
  },
  "orchestration": {
    "default_implementation_profile": "primary",
    "default_review_profile": "reviewer"
  }
}
```

- `start_cycle` uses the profiles named in the request, else the configured defaults, else
  fails with `VALIDATION_FAILED`. It never picks another profile on its own, not even when the
  requested one is unavailable.
- Before anything starts, `start_cycle` checks that both profiles exist, have every capability
  their stages require, and have a command on the daemon's `PATH`. Otherwise it fails with
  `AGENT_PROFILE_NOT_FOUND`, `AGENT_CAPABILITY_MISMATCH` (with the profile, stage, required,
  available, and missing capabilities), or `AGENT_UNAVAILABLE`.
- Every stage resolves its profile again from the daemon's current configuration. A profile
  removed or narrowed since the cycle started blocks the cycle with that reason when it is
  resumed. The configuration is read when the daemon starts; restart it after editing.
- `orvia list-agent-profiles` (MCP `list_agent_profiles`) and `orvia doctor` show each profile's
  adapter, whether its command is found, its capabilities, the stages it can run, and the
  defaults.

Example adapter configuration with the bundled adapters. When `agents.profiles` is not set,
Orvia defines one profile per bundled adapter, named `codex` and `claude`, and no defaults.

```json
{
  "agents": {
    "profiles": {
      "primary": { "adapter": "codex" },
      "reviewer": { "adapter": "claude" }
    }
  }
}
```

Details: [ADR 0011](docs/adr/0011-agent-profiles-and-capabilities.md).

## Compatibility

Bundled adapters are compatibility implementations, not requirements. Results below are from
local runs on macOS (2026-10-02) in a throwaway repository; CI runs only the scripted fake
adapters.

| Adapter  | CLI version         | Capabilities declared                                             | Implement        | Verify                        | Review | Full cycle                                                               |
| -------- | ------------------- | ----------------------------------------------------------------- | ---------------- | ----------------------------- | ------ | ------------------------------------------------------------------------ |
| `codex`  | codex-cli 0.159.0   | workspaceRead, workspaceWrite, commandExecution, structuredResult | tested           | tested                        | tested | tested: implement → verify → review; verify-fail → fix → verify → review |
| `claude` | Claude Code 2.1.287 | workspaceRead, workspaceWrite, structuredResult                   | unit-tested only | refused (no commandExecution) | tested | tested as the review profile in full cycles                              |

Local validation exercised: `HUMAN_REVIEW_READY` with codex implementing and claude reviewing;
a review of existing changes with a codex review profile that went through a failed
verification, an automatic fix, and a pass; `NEEDS_HUMAN / AGENT_NEEDS_INPUT` → `record_decision`
→ `resume_cycle` → `HUMAN_REVIEW_READY`; `pause_cycle` during a real run (the agent's processes
were gone before `PAUSED`); a daemon restart during a run (`BLOCKED / RUN_INTERRUPTED`, nothing
relaunched); `cancel_cycle`; and a claude implementation profile refused with
`AGENT_CAPABILITY_MISMATCH` before anything started.

Known adapter limitations:

- `codex`: without `commandExecution`, Codex's read-only sandbox still runs commands; none of
  them can write. A codex review profile ran the tests during its review. With
  `commandExecution` (verification), Codex runs in its `workspace-write` sandbox, because test
  runners write build output; the verifier is told not to change source files, but the sandbox
  does not prevent it.
- `claude`: Orvia does not grant Claude Code's Bash tool, so the adapter does not declare
  `commandExecution`, and a claude profile cannot verify. Whether Bash runs depends on your own
  Claude Code permission settings; on the validation machine it did run under `acceptEdits`.
  Review uses only the Read, Grep, and Glob tools. The JSON envelope repeats the result, so a
  claude stage reserves three times the result limit in the cache.

## Architecture

```text
MCP clients ───────────────────┐
(e.g. ChatGPT via a tunnel,     │
 Claude, Codex)                 │
                               ▼
                         orvia mcp (stdio, stateless)
                               │
orvia CLI ─────────────────────┤  Unix socket (0700 directory)
                               ▼
                         orvia daemon ── the only process that opens the database
                         ├── Application: operation registry, use cases, run and cycle supervisors
                         ├── Domain: Plan, Work Item, Cycle, review policy, agent capabilities, workspace identity, storage policy
                         └── Infrastructure
                             ├── SQLite (node:sqlite, rollback journal, exclusive lock, migrations)
                             ├── git (read-only plumbing, review evidence)
                             ├── cache (ephemeral, bounded)
                             └── agent adapters (bundled: codex, claude) ── agent CLIs
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
[MCP boundary](docs/adr/0006-local-mcp-boundary.md) ·
[external dependencies](docs/adr/0007-external-dependencies.md) ·
[agent process lifecycle](docs/adr/0008-agent-process-lifecycle.md) ·
[storage contract](docs/adr/0009-storage-contract.md) ·
[orchestration cycle and review policy](docs/adr/0010-orchestration-cycle-and-review-policy.md) ·
[agent profiles and capabilities](docs/adr/0011-agent-profiles-and-capabilities.md)

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
- Agent Profiles over adapters, capabilities checked before any stage starts, profile
  discovery (`list_agent_profiles`, `doctor`).

Experimental:

- `start_run` and orchestration cycles: implement → verify → review → fix, structured review
  findings with Orvia-collected git evidence, deterministic escalation to the human, loop limit,
  pause/resume/cancel. Tested with scripted fake adapters in CI and run locally with real agent
  CLIs ([Compatibility](#compatibility)).

Not implemented / planned:

- Orvia-enforced filesystem sandbox (see [Security model](#security-model)).
- Git operations: worktree creation, rollback, PR creation and merge, GitHub review comments,
  git cleanup.
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

Requires Node.js ≥ 24.15 and git at runtime. To use a local build without `npm link`:

```sh
chmod +x dist/interface/cli/main.js
ln -sf "$PWD/dist/interface/cli/main.js" ~/.local/bin/orvia
```

## Quick start

Define the Agent Profiles you want to use in `config.json` (path in
[Storage configuration](#storage-configuration)); this example binds them to the bundled
adapters:

```json
{
  "agents": {
    "profiles": {
      "primary": { "adapter": "codex" },
      "reviewer": { "adapter": "claude" }
    }
  },
  "orchestration": {
    "default_implementation_profile": "primary",
    "default_review_profile": "reviewer"
  }
}
```

The daemon reads the configuration when it starts; restart it after editing.

```sh
orvia daemon &                     # foreground process; logs JSON lines to stderr
orvia doctor                       # checks Node, git, config, daemon, schema, storage

orvia create-plan --title "KMP rollout"
orvia create-work-item --plan-id P-1 --title "Repository changes" --branch kmp-repository
orvia discover-worktrees --repository-path ~/src/app
orvia bind-workspace --work-item-id W-1 --worktree-path ~/src/app-kmp-repository
orvia status

orvia list-agent-profiles          # what this installation can run
orvia start-run --work-item-id W-1 --profile-id primary --instructions "Move the repository layer to KMP"   # experimental
orvia pause-work-item --work-item-id W-1

# experimental: implement, verify, review, and fix until a human is needed
orvia start-cycle --work-item-id W-1 --mode implement --instructions "Move the repository layer to KMP" \
  --implementation-profile-id primary --review-profile-id reviewer
orvia get-cycle --cycle-id C-1
orvia record-decision --work-item-id W-1 --title "Keep the public API" --body "Clients depend on it"
orvia resume-cycle --cycle-id C-1
```

`orvia` creates no files in your repository. Its state lives in user-local directories
([ADR 0005](docs/adr/0005-repository-isolation.md)).

## MCP client integration

`orvia mcp` is an MCP server over stdio that forwards every call to the daemon. Any MCP client
that can launch a stdio server can use it; the CLI calls the same operations. Tools mirror the
operations (`get_status`, `create_plan`, `list_work_items`, `list_agent_profiles`, `start_run`,
`pause_work_item`, `start_cycle`, `get_cycle`, `get_current_review`, `pause_cycle`,
`resume_cycle`, `add_context`, `record_decision`, `submit_feedback`, `get_storage_status`, …;
`orvia operations` lists all). `get_status` shows each open Work Item's active cycle (state,
reason, iteration, current run). Read-only tools carry `readOnlyHint`, so clients that honor it
ask for confirmation only on writes.

Clients that launch a stdio server directly (untested examples): `claude mcp add orvia -- orvia
mcp`, or in Codex `~/.codex/config.toml`: `[mcp_servers.orvia]` with `command = "orvia"` and
`args = ["mcp"]`.

**ChatGPT.** Per OpenAI's documentation, ChatGPT (developer mode) reaches MCP servers through a public HTTPS
URL or a **Secure MCP Tunnel**, which can launch a local stdio server. To use Orvia:

1. Run `orvia daemon`.
2. Configure a Secure MCP Tunnel whose server command is `orvia mcp`.
3. In ChatGPT, create a developer-mode app and select the tunnel.

Verification status: `orvia mcp` is tested with the MCP SDK client for protocol 2026-07-28 and
with a raw JSON-RPC client speaking revision 2025-06-18. **A connection from ChatGPT itself has not been tested.** Do not expose
Orvia through a public URL: it has no authentication.

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

| Class            | What                                                                                                                                     | Where           | Lifetime                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------ |
| Durable          | Plans, Work Items, workspace bindings, PR URLs, decisions, human context and feedback, cycles, reviews and their findings (size-limited) | SQLite          | never removed automatically          |
| Bounded metadata | Agent Run records, including a cycle stage's validated result (size-limited)                                                             | SQLite          | newest N finished runs per Work Item |
| Reconstructible  | diffs, source scans, build details                                                                                                       | not stored      | recomputed from git                  |
| Ephemeral        | agent output, raw structured output, result schemas                                                                                      | cache directory | TTL + size cap, oldest evicted first |

Large text (agent output, diffs, source, prompts) is never stored in SQLite. Storage cleanup
never touches git repositories, worktrees, branches, or commits; this is tested.

**`database_max_mb` is a hard budget.** It covers `state.db`, its rollback journal, any WAL or SHM
left by an older build, and every migration backup. Orvia's database operations never take
their sum past it, during normal writes, migrations, or startup after a crash. Before every
transaction Orvia caps how far SQLite may grow the database (`max_page_count`) so that the
database plus its worst-case journal plus the other files fit. A write that would not fit is
refused, or stopped by SQLite and rolled back, with `STORAGE_HARD_LIMIT`. The cost: data can use
about half of what the backups leave, because the other half is kept for the journal. This is
tested by sampling file sizes during writes near the limit, conversion of a database left in WAL
mode, and crash recovery. Details: [ADR 0009](docs/adr/0009-storage-contract.md).

SQLite's temporary data (sorts, transient indexes) is kept in memory (`temp_store = MEMORY`), and
a test confirms that Orvia's workload creates no files in the OS temporary directory. SQLite
does not promise how it uses temporary files, and filesystem overhead is outside the budget.

**Migrations stay within the limit.** Before a schema migration Orvia checks that the database,
its journal, a new backup, existing backups, and the control reserve all fit in
`database_max_mb`. If they do not, the daemon refuses to start with
`MIGRATION_STORAGE_REQUIRED` and changes nothing. The error says how many bytes are needed. In
practice a migration needs about three times the database size within the budget.

**When durable data fills the budget.** Cleanup only removes run records, cache, and expired
backups; it never deletes Plans, Work Items, decisions, or notes. Archiving changes a status and
frees almost no space. If durable data alone reaches the write capacity (`HARD_LIMIT`), the only
remedy today is to raise `storage.database_max_mb`. Export, explicit deletion of archived data, and a compaction
command are planned.
Details: [ADR 0004](docs/adr/0004-storage-policy.md).

## Storage configuration

`config.json` in the config directory (`~/Library/Application Support/orvia/` on macOS,
`~/.config/orvia/` on Linux). All keys are optional; these are the defaults:

```json
{
  "log_level": "info",
  "storage": {
    "database_max_mb": 128,
    "cache_max_mb": 512,
    "retention_days": 7,
    "max_completed_runs_per_work_item": 5,
    "pressure_percent": 70,
    "warning_percent": 90
  },
  "agents": {
    "termination_grace_ms": 10000,
    "kill_confirmation_ms": 5000,
    "profiles": {
      "codex": { "adapter": "codex" },
      "claude": { "adapter": "claude" }
    }
  },
  "orchestration": {
    "max_review_fix_cycles": 3,
    "max_review_diff_kb": 256
  }
}
```

| Key                                            | Meaning                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `log_level`                                    | `error`, `warn`, `info`, `debug`, or `trace`                                  |
| `storage.database_max_mb`                      | hard budget for state.db + journal + leftover WAL/SHM + migration backups     |
| `storage.cache_max_mb`                         | agent output cache                                                            |
| `storage.retention_days`                       | cache entries and migration backups                                           |
| `storage.max_completed_runs_per_work_item`     | finished run records kept per Work Item                                       |
| `storage.pressure_percent`                     | cleanup starts                                                                |
| `storage.warning_percent`                      | status reports `WARNING`                                                      |
| `agents.profiles.<id>.adapter`                 | the adapter the profile uses (`codex` or `claude` today)                      |
| `agents.profiles.<id>.command`                 | executable name on `PATH`, or a path; defaults to the adapter's own           |
| `agents.profiles.<id>.capabilities`            | optional list that narrows the adapter's capabilities                         |
| `agents.termination_grace_ms`                  | time between `SIGTERM` and `SIGKILL` when stopping an agent                   |
| `agents.kill_confirmation_ms`                  | how long to wait for the process group to disappear after `SIGKILL`           |
| `orchestration.max_review_fix_cycles`          | automatic fix rounds before a cycle stops at `NEEDS_HUMAN / LOOP_LIMIT`       |
| `orchestration.default_implementation_profile` | profile `start_cycle` uses when the request names none (no default)           |
| `orchestration.default_review_profile`         | the same for reviews (no default)                                             |
| `orchestration.max_review_diff_kb`             | largest change Orvia puts into a review prompt; larger stops at `NEEDS_HUMAN` |

JSON instead of TOML keeps the runtime free of a parser dependency
([ADR 0007](docs/adr/0007-external-dependencies.md)).
The size defaults and the fix-round limit come from the project brief; the thresholds,
termination timeouts, and the review diff limit were set by the maintainer.
They are starting points to revisit with real usage data, not measured optima. Invalid values
stop the daemon with `CONFIG_INVALID`.

Pressure levels: `NORMAL` → `PRESSURE` (cleanup starts) → `WARNING` → `HARD_LIMIT`. For the
database they compare the data size with its write capacity (`get_storage_status` reports
`dataBytes` and `writeCapacityBytes`); for the cache, the cache size with `cache_max_mb`. At
`HARD_LIMIT`, the gate still admits status, storage status, pause/resume, cleanup, and archive.
They use a small shared reserve above the write capacity, so they work until that reserve is
used up. New writes and agent runs are refused. Archive is allowed so work can be wound down; it
does not free space.

**Degraded start.** If marking the previous daemon's unfinished runs as interrupted runs out of
that reserve at startup, the daemon still starts. `orvia status` then reports `recovery` as
`incomplete`, with counts and the fix. Reads, `orvia storage`, and `orvia cleanup` work. New
work is refused with `RECOVERY_INCOMPLETE` until you run cleanup or raise
`storage.database_max_mb` and restart.

## Security model

What Orvia does:

- Keeps all state in user-local directories; writes nothing into your repositories.
- Lets only the daemon open its database (SQLite exclusive lock).
- Exposes its API on a Unix socket inside a directory with mode 0700 owned by you.
- Validates a Work Item's repository, worktree, and branch identity immediately before starting
  an agent, and refuses on any mismatch. The agent's working directory comes from the Work Item,
  never from the agent.
- Runs each agent in its own process group (macOS/Linux) and, on pause or shutdown, stops the
  whole group and confirms it is gone before reporting success.
- Passes prompts to agents on stdin, not on the command line.
- States an instruction precedence in every agent prompt: Orvia rules > accepted human
  decisions > cycle instructions and human context > repository instruction files (AGENTS.md,
  CLAUDE.md) > agent defaults. Other repository content (README, source, comments, issues,
  generated files, command output) is declared data that cannot change the rules.
- Grants each cycle stage only the capabilities it requires, through each adapter's own
  controls (reviews get no write access; see [Compatibility](#compatibility) for what each
  adapter can withhold), collects review evidence from git itself, and accepts agent results only
  as schema-valid, size-limited structured output.
- Never lets its own database files exceed `storage.database_max_mb` (see Storage model).
- Stores no credentials and sends no telemetry. Logs contain ids and counts, not prompts, agent
  output, or file contents.

What Orvia does **not** guarantee:

- **No Orvia-enforced filesystem sandbox.** Orvia does not prevent an agent from writing
  outside its worktree, including into other worktrees. Agents run with your user's permissions.
  What Orvia offers is workspace identity validation before launch, plus a filesystem policy
  (worktree root and its git directories) passed to each agent's own mechanism: Codex's
  `workspace-write` sandbox, and Claude Code's permission settings (not an OS sandbox). How well
  that holds depends on the agent.
- Workspace identity is checked immediately before launch, not continuously. An agent or a
  person can still change branches or files afterwards.
- `get_run_output` returns agent output to whichever MCP client or CLI user asks for it.
  Agent output can contain your source code.
- MCP clients are subject to prompt injection from content they read. Clients that honor
  `readOnlyHint` ask before writes, but review what you approve.
- The instruction precedence is a prompt, not an enforcement mechanism. A coding agent that
  follows instructions planted in the repository is not stopped by Orvia; the read-only review
  and the escalation rules limit what such an agent can push through a cycle.
- Process-tree stopping does not cover descendants that leave the agent's process group, agents
  still running after the daemon was killed by the OS, or Windows (only the agent process is
  stopped there).
- Windows has not been tested.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Performance

`npm run bench` measures the status queries an MCP client or the CLI triggers. On an Apple Silicon laptop
(Node 24.21, 100 Plans × 5 Work Items), p95 latency was 0.02–1.0 ms in-process and 0.08–1.5 ms
over the daemon socket with the earlier WAL configuration. `npm run bench:storage` measures the
full operation mix and file sizes; with the rollback journal, writes are 0.65–0.85 ms and
`get_status` 1.39–1.43 ms at p95 ([results](docs/benchmarks/2026-10-02-journal-mode.md)). With an
active cycle on every Work Item (the most `get_status` can show), `npm run bench` measured
`get_status` at 1.81–1.94 ms p95 in-process and 2.52–2.72 ms over the socket, in three runs.
The brief's candidate budget is p95 < 50 ms. CI does not enforce it
because shared runners vary too much for a fixed threshold to mean anything.

## Local dogfooding

Orvia is ready to be tried on your own repositories from a local build (see
[Installation](#installation)). It adds nothing to the repositories it works on. When something
surprises you (a stop that was not needed, a fix that should have been a question, a confusing
state, a manual workaround), copy the entry template in
[docs/dogfooding-log.md](docs/dogfooding-log.md). Orvia records no telemetry; `get_cycle`,
`get_current_review`, `get_run_output`, `get_storage_status`, and `orvia doctor` show what
happened.

## Roadmap

1. Local dogfooding: use Orvia for real development work, record what goes wrong in
   [docs/dogfooding-log.md](docs/dogfooding-log.md), and choose the next milestone from it.
2. Git operations as explicit features: worktree creation, PR mapping from the GitHub CLI,
   rollback.
3. Orvia-enforced filesystem sandbox at the process launch boundary.
4. Recovery when durable data fills the budget: export, explicit deletion of archived data,
   and a database compaction command.
5. MCP over Streamable HTTP with authentication; verified setup guides for MCP clients.
6. Distribution ([docs/releasing.md](docs/releasing.md)) and service units for launchd and
   systemd.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and the
[Code of Conduct](CODE_OF_CONDUCT.md). Questions: [SUPPORT.md](SUPPORT.md).

## License

[Apache License 2.0](LICENSE).
