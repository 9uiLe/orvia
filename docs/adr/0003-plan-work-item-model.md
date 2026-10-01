# 0003. Plan, Work Item, and workspace identity

- Status: Accepted
- Date: 2026-10-02

## Context

A conversation with a human, a logical change, a branch, a worktree, a PR, and an agent run are
different things. Conflating them leads to agents writing in the wrong place, and ChatGPT
session identifiers are neither public nor stable.

## Decision

### Concepts

| Concept                             | Meaning                                                                         | Identity                              |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------- |
| Chat session                        | A ChatGPT (or other client) conversation                                        | Not stored; Orvia never depends on it |
| Plan                                | A logical change discussed with the human                                       | `P-n`                                 |
| Work Item                           | One implementation unit: one branch, one worktree, one PR                       | `W-n`                                 |
| Agent Run                           | One execution of an agent for a Work Item                                       | `R-n`                                 |
| Decision                            | A human decision; changing it creates a new one that supersedes the old         | `D-n`                                 |
| Note                                | Human context (Plan or Work Item) or feedback (`comment`, `redirect`, `reject`) | `N-n`                                 |
| Repository / worktree / branch / PR | Recorded attributes of a Work Item, never identities                            | —                                     |

- A Plan has any number of Work Items. Splitting is creating Work Items with
  `splitFromWorkItemId`; the Plan stays the same.
- A Work Item may exist before it has a worktree or a PR.
- Work Item states: `active` ⇄ `paused` → `completed` → `archived` (and `active`/`paused` →
  `archived`). Pausing cancels a running agent. Only `active`, bound Work Items can run.

### Explicit identity

Every mutation takes explicit ids (`workItemId`, `planId`). There is no "current" Plan or Work
Item anywhere in Orvia. Clients such as ChatGPT may resolve natural language to an id, but they
must pass the id; the MCP instructions tell them to ask the human when more than one Work Item
could match.

### Workspace identity

Binding (`bind_workspace`) records, via read-only git plumbing:

- repository common dir and its on-disk directory id (`dev:ino:birthtime`),
- worktree git dir and its directory id,
- canonical worktree root (realpath),
- branch (detached HEAD is refused).

Before every Agent Run the workspace is observed again and compared. Any difference fails closed
with `WORKSPACE_MISMATCH` and the reasons (`worktree_missing`, `repository_changed`,
`worktree_changed`, `worktree_root_changed`, `branch_changed`, `detached_head`). No run record is
created and no process is started. The check runs immediately before launch; a change in the
milliseconds between the check and the agent's start is not detected.

### The agent does not choose the workspace

Orvia derives the working directory from the Work Item and starts the agent there. The prompt
states the directory as a fact and never asks the agent to find a worktree.

### Filesystem policy and sandbox boundary

`filesystemPolicyFor(workspace)` computes the intended boundary: the worktree root, plus the
worktree git dir and the common dir (commits from a linked worktree write objects and refs
there). Agent adapters translate it:

- Codex: `--sandbox workspace-write --cd <root> --add-dir <git dirs>` (Codex's OS sandbox).
- Claude Code: `--permission-mode acceptEdits --add-dir <git dirs>` (Claude Code's permission
  system, not an OS sandbox).

Orvia does not enforce the policy itself. The enforcement point for a future Orvia-level sandbox
is `ProcessLauncher.launch()`, which receives the invocation built from the policy.

## Consequences

- Moving or recreating a repository or worktree requires re-binding. This is intended.
- Writable git dirs mean an agent can also change other branches' refs in the same repository.
  A finer boundary needs Orvia-level enforcement (planned).
