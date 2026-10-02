# 0011. Agent profiles, capabilities, and review evidence

- Status: Accepted
- Date: 2026-10-02

## Context

The first cycle implementation selected agents by adapter name (`codex`, `claude`), and the
cycle passed an `edit`/`read-only` access flag that each adapter interpreted. That made two
CLIs part of Orvia's contract: a cycle stored provider names, and a stage could find out only
after it ran that its agent could not do what the stage needed. In particular, the review
prompt asked the reviewer to run `git status` and `git diff`, which one adapter's read-only mode
does not allow.

## Decision

### Adapter, profile, capability

- An **Agent Adapter** (infrastructure) knows how to run one kind of agent CLI. It declares the
  capabilities it can provide, turns a run's granted capabilities into the CLI's own flags,
  delivers the result schema, says how much stdout a result may take, and extracts the result
  from the CLI's output. Concrete provider names exist only in adapters and in the default
  configuration.
- An **Agent Profile** (configuration, `agents.profiles`) gives a user-chosen id an adapter, a
  command, and optionally a list that narrows the adapter's capabilities. Profiles are not
  stored in the database; a cycle stores only the two profile ids it uses.
- **Capabilities** are named by effect: `workspaceRead`, `workspaceWrite`, `commandExecution`,
  `structuredResult`. Effective capabilities = adapter capabilities ∩ profile list, so a
  configuration cannot give an agent something its adapter cannot do.

No plugin loading: adapters are a typed internal interface, registered in code.

### Stage requirements

`requiredCapabilitiesFor(stage)` in the domain is the single definition:

| Stage        | Required                                          |
| ------------ | ------------------------------------------------- |
| IMPLEMENTING | workspaceRead, workspaceWrite, structuredResult   |
| VERIFYING    | workspaceRead, commandExecution, structuredResult |
| REVIEWING    | workspaceRead, structuredResult                   |
| FIXING       | workspaceRead, workspaceWrite, structuredResult   |

A run is granted exactly its stage's requirements (a manual `start_run` gets the profile's
capabilities). The implementation profile must cover implementing, verifying, and fixing; the
review profile must cover reviewing. Nothing prevents splitting these per stage later.

### Resolution and failure

- `start_cycle` takes `implementationProfileId` and `reviewProfileId`; a missing one falls back
  to `orchestration.default_implementation_profile` / `default_review_profile`, and without
  either it fails. Orvia never chooses a profile by itself and never substitutes one for an
  unavailable one.
- Before creating the cycle, it checks that both profiles exist, cover all their stages, and
  have a command on the daemon's `PATH` (`AGENT_PROFILE_NOT_FOUND`,
  `AGENT_CAPABILITY_MISMATCH` with profile, stage, required, available, and missing
  capabilities, `AGENT_UNAVAILABLE`).
- Every stage launch resolves the profile again from the daemon's current configuration, the
  same way resume rebuilds prompts from the latest decisions. A profile that was removed or
  narrowed blocks the cycle with that reason. Profiles are not snapshotted: the cycle history
  keeps the profile id each run used, and a snapshot would preserve configuration the human
  has deliberately changed.
- `list_agent_profiles` and `doctor` report, per profile: adapter, command, whether the command
  is found (`available`), effective capabilities, and the stages it can run.

### Review evidence: Orvia collects it (option B)

Two ways to let a reviewer see the change without depending on a CLI's shell:

- **Option A — a `changeInspection` capability.** Only reviewers whose adapter can run git
  read-only could review. Cheap to add, but it keeps review dependent on each CLI's shell rules,
  and the evidence differs by agent.
- **Option B — Orvia collects the evidence.** Orvia already runs read-only git plumbing. At
  each review launch it records `git status --porcelain=v1 --untracked-files=all` and
  `git diff <base>` (tracked files, base to working tree) in the bound worktree and puts them in
  the prompt as data. The reviewer then needs only `workspaceRead` and `structuredResult`, and
  every reviewer sees the same evidence.

Option B is adopted. Its cost was small: a bounded git call and a prompt section.

- The base is the commit `HEAD` named when the cycle started, or `baseRef` from `start_cycle`,
  stored on the cycle.
- Status and diff together are bounded by `orchestration.max_review_diff_kb`, default 256 KiB
  (chosen by the maintainer). Git output is read up to that size and stopped. If the bound is
  reached, no review runs: the cycle stops at `NEEDS_HUMAN / CHANGES_TOO_LARGE`, because a
  review of part of a change could pass what nobody saw.
- Untracked files appear in the status; their contents are not in the diff, and the reviewer
  reads them from the worktree.

### Structured results and the cache

`structuredResult` is a capability: an agent that cannot return schema-checked output is not
used for any cycle stage, and Orvia does not interpret free text. The space for a stage's
result is reserved in the cache before the agent starts, sized by the adapter
(`resultStdoutBytes`, one byte above it to detect oversized output). Verbose logs cannot take
that space. A reservation that does not fit is `RESULT_STORAGE_EXHAUSTED`, and the agent does
not start.

The cache accounting counts what open writers have accepted instead of their files' size on
disk, so measuring the cache during a run cannot release bytes that are already taken.

## Alternatives considered

- **Keep adapter names in cycles and an access flag.** Rejected: the cycle model would depend
  on which CLIs exist, and mismatches would surface only after an agent ran.
- **Profiles in the database.** Rejected: profiles are installation configuration; storing
  them would duplicate the configuration and outlive edits to it.
- **Truncate large diffs.** Rejected: a truncated review can pass unseen code.

## Consequences

- Adding an agent CLI means adding an adapter; cycles, reviews, and policies do not change.
  Tests use two fake adapters with different output formats to check this.
- An adapter's declared capabilities are a claim about its CLI. Local validation corrected
  them where needed (README, Compatibility); for example, an adapter that cannot guarantee shell
  access does not declare `commandExecution`, even if the user's own settings allow it.
- Some CLIs cannot withhold everything: a sandbox may still run read-only commands when
  `commandExecution` is not granted. Write access is what reviews are denied, and that holds.
- Configuration changes take effect when the daemon restarts.
