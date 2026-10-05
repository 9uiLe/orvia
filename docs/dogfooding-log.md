# Dogfooding log

Notes from using Orvia on real work. One entry per checkpoint or incident worth remembering;
ordinary successful checkpoints need no entry. Orvia collects none of this itself.

Use the standard flow: confirm a design → prepare and inspect the prompt →
`start_run({ checkpointId })` → inspect the work report and Git evidence → record the app
evaluation and human decision → prepare the next checkpoint or complete the Work Item.
Record the desktop app/version and connection path when testing in ChatGPT.app or Claude.app;
SDK tests alone do not verify that flow in a real app.

Automated cycle testing requires `orchestration.enable_legacy_cycles=true`; it is an optional
compatibility workflow. See [the current implementation guide](current-implementation.md#orchestration-cycles).

What to look for:

- a prepared prompt that omitted the design, earlier report, evaluation or human decision
- stale context/code that was accepted, or a valid send that was refused
- a checkpoint that started a second run without a human instruction
- an incomplete report, diff or source page that looked complete
- agent-reported checks that ran the wrong commands or missed some
- a profile's capabilities that did not match what the agent could actually do
- a checkpoint state that was hard to understand, or a pause/resume that felt wrong
- too many or too few operations for what you wanted to do
- anything you had to do by hand

## Entry template

```text
Date:
Repository:
Work Item:
Design Revision / Checkpoint / Run:
App and version / environment / connection path:
Profile:
Legacy cycle (only when explicitly enabled):
Outcome (final state and reason):

Report and evidence completeness / fingerprint:
App evaluation / human decision:

Unexpected escalation:
Missing escalation:
Manual workaround:
Failure:
What should Orvia change?
```

Useful commands: `orvia get-checkpoint --checkpoint-id K-n`,
`orvia get-checkpoint-changes --checkpoint-id K-n --max-bytes 20000`,
`orvia get-checkpoint-source --checkpoint-id K-n --path src/example.ts --offset 0 --max-bytes 20000`,
`orvia get-run-output --run-id R-n --max-bytes 20000`, `orvia storage`, `orvia doctor`.
For legacy cycles, use `get-cycle` and `get-current-review` with the explicit cycle ID.

## Entries
