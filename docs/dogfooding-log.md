# Dogfooding log

Notes from using Orvia on real work. One entry per cycle or incident worth remembering; most
cycles that go as expected need no entry. Orvia collects none of this itself.

What to look for:

- a cycle stopped when it did not need to, or did not stop when it should have
- an automatic fix that should have been a question for a human
- review findings that did not help
- verification that ran the wrong checks or missed some
- a profile's capabilities that did not match what the agent could actually do
- a cycle state that was hard to understand, or a pause/resume that felt wrong
- too many or too few operations for what you wanted to do
- anything you had to do by hand

## Entry template

```text
Date:
Repository:
Work Item:
Cycle:
Profiles (implementation / review):
Outcome (final state and reason):

Unexpected escalation:
Missing escalation:
Manual workaround:
Failure:
What should Orvia change?
```

Useful commands: `orvia get-cycle --cycle-id C-n`, `orvia get-current-review --cycle-id C-n`,
`orvia get-run-output --run-id R-n --max-bytes 20000`, `orvia storage`, `orvia doctor`.

## Entries
