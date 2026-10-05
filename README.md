# Orvia

> The human control plane for coding agents.

[![CI](https://github.com/9uiLe/orvia/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/9uiLe/orvia/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Orvia connects design and review conversations in ChatGPT.app or Claude.app to development
work performed by coding-agent CLIs. The intended workflow is to agree on a design in the app,
send one checkpoint to a CLI, evaluate its report and changes in the app, and include the
human's judgement in the next prompt.

Orvia identifies each Work Item's repository, worktree, and branch, and provides MCP tools
for sending instructions and reading work results. The app handles the conversation and
evaluation; the human decides what to do next.

**Status: pre-release (v0.0.0).** The current build implements an experimental checkpoint
workflow: confirmed design revisions, prepared prompts, exact dispatch, durable reports and
human review. Code, CLI, and MCP protocol checks pass; the full workflow in ChatGPT.app
or Claude.app remains unverified. Legacy automated cycles require explicit opt-in.
Interfaces and the database schema will change; Orvia is not published to a package registry yet.

## Documentation

- [Product specification and requirements](docs/specification.md): the authoritative workflow,
  scope, acceptance criteria, and current implementation gaps.
- [Domain language](CONTEXT.md): definitions of Plans, Work Items, checkpoints, prompts,
  reports, evaluations, and human decisions.
- [Implementation plan](docs/implementation-plan.md): repair sequence, acceptance checks,
  and progress toward the specification.
- [Current implementation guide](docs/current-implementation.md): installation, existing
  commands, configuration, storage behavior, security boundaries, and compatibility results.
- [Contributing](CONTRIBUTING.md): development checks and change requirements.

Implementation behavior described in the guide does not override the product specification.

## Try the current build

You need macOS or Linux, git, Node.js meeting `package.json`'s engine requirement, and a
configured agent CLI on the daemon's PATH. Nix is a development tool, not a runtime requirement.
Follow the [installation and configuration guide](docs/current-implementation.md#getting-started).

Prepare a worktree on branch `orvia-try`, then use the standard checkpoint workflow:

```sh
orvia daemon                 # keep this running in a separate terminal
orvia doctor
orvia create-plan --title "Try Orvia"
orvia create-work-item --plan-id P-1 --title "First change" --branch orvia-try
orvia bind-workspace --work-item-id W-1 --worktree-path ~/src/app-try
orvia confirm-design --plan-id P-1 --goal "Make the first change" --scope "One small change" --constraints "Use existing dependencies" --acceptance-criteria "Relevant checks pass"
orvia prepare-prompt --work-item-id W-1 --profile-id primary --instructions "Implement the agreed change" --end-condition "Return a work report when the change and checks are complete"
orvia get-checkpoint --checkpoint-id K-1   # inspect the full prompt and target
orvia start-run --checkpoint-id K-1       # after the human instructs sending
orvia get-checkpoint --checkpoint-id K-1  # read again after the run finishes
orvia get-checkpoint-changes --checkpoint-id K-1 --max-bytes 20000
orvia get-run-output --run-id R-1 --max-bytes 20000
orvia record-checkpoint-review --checkpoint-id K-1 --evaluation "The report and changes meet the design" --action complete --decision "Accept this work"
```

`primary` is a configured Agent Profile with `workspaceRead` and `structuredResult`.
Inspect results before recording the example evaluation and human decision. `continue` or
`revise` enables preparing the next checkpoint; `complete` completes the Work Item. Preparation
starts no CLI, and sending accepts only `checkpointId`. Reports survive normal cache cleanup
and Run pruning; source and diff content are read from the current worktree.

With the daemon running, a local STDIO MCP client can launch `orvia mcp`. Actual app
connections still need verification; see [MCP client integration](docs/current-implementation.md#mcp-client-integration).

## Development

```sh
nix develop
npm ci
npm run check
```

The flake pins the development toolchain, and `package-lock.json` pins npm dependencies.
See [CONTRIBUTING.md](CONTRIBUTING.md) for checks, dependency review, and documentation updates.

## Community and license

[Governance](GOVERNANCE.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Support](SUPPORT.md) ·
[Security](SECURITY.md) · [Releasing](docs/releasing.md)

[Apache License 2.0](LICENSE).
