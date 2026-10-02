# 0008. Agent process lifecycle and pause semantics

- Status: Accepted
- Date: 2026-10-02

## Context

Pause is the human's main safety control. Agents start shells, builds, and other tools. If
pausing only signals the agent process, its descendants can keep changing the worktree while
the Work Item already shows as paused.

Sources: Node.js `child_process` (`detached`: "the child process becomes the leader of a new
process group and session" on non-Windows; `exit` fires while stdio may still be open, `close`
after it is closed), POSIX `kill()` (a negative pid signals every process in that process group;
signal 0 checks existence without sending anything).

## Decision

### Process groups (macOS, Linux)

Each Agent Run's agent is spawned with `detached: true`, so it leads a new process group (and
session). Its descendants stay in that group unless they deliberately leave it.

### Stopping a run

1. `SIGTERM` to the whole group.
2. Wait up to `agents.termination_grace_ms` (default 10,000 ms, the same as `docker stop`) for
   the group to become empty and the agent to be reaped.
3. Otherwise `SIGKILL` to the group.
4. Wait up to `agents.kill_confirmation_ms` (default 5,000 ms). `SIGKILL` cannot be caught, so
   only processes stuck in the kernel (uninterruptible sleep) remain after it.
5. If the group is still not empty: `AGENT_TERMINATION_FAILED`.

`agents.kill_confirmation_ms` has a second use. After an agent exits and its group is stopped, the
launcher waits up to that long for the agent's stdout and stderr pipes to close, because a
descendant outside the group can still hold them open. Then it destroys the pipes and reports the
exit, so output from such a descendant after that point is dropped.

Both defaults were chosen by the maintainer and can be changed in `config.json`.

The group is empty when `kill(-pgid, 0)` fails with `ESRCH`. It is polled because no event
signals it. The same procedure runs when an agent exits by itself and leaves processes behind,
before the run is recorded. Leftovers that cannot be stopped mark the run `failed` and are
logged.

### Pause semantics

`pause_work_item` returns successfully only after:

1. the Work Item's agent process tree has been confirmed gone (as above),
2. the run's final state (`cancelled`) has been committed, and
3. the Work Item has been committed as `paused`.

While a pause is in progress, `start_run` for that Work Item is refused. If termination fails,
nothing is committed. The Work Item stays `active`, the run stays `running`, and the call fails
with `AGENT_TERMINATION_FAILED`. Orvia never shows `paused` while it knows the agent may still
run.

### Daemon shutdown

Stop accepting requests → stop every agent tree with the same procedure → record those runs as
`interrupted` → close the database. Trees that cannot be confirmed stopped are logged as errors
and their runs are marked `interrupted`, because the daemon is exiting regardless. If the daemon
is killed by the OS, none of this runs. The next start marks leftover `running` runs
`interrupted` but does not look for or stop their processes.

## What is not guaranteed

- **Descendants that leave the process group** (`setsid`, daemonizing tools, `nohup` with a
  new session) are not tracked or stopped.
- **Forced daemon termination** (`SIGKILL`, crash, power loss): agent trees keep running. They
  are in their own process group and do not receive the terminal's signals either.
- **Windows:** there are no process groups here. Node.js terminates the agent process itself
  unconditionally, but its descendants are not stopped. Windows is untested overall.
- The group id is a pid. If the whole group disappears and the operating system reuses that
  number for a new group leader within the few milliseconds between the last check and a
  signal, that signal would reach the wrong process group. Orvia stops signalling as soon as
  the group is seen empty.

## Alternatives considered

- **Signal only the agent (`child.kill`)**: the previous behavior; leaves descendants running.
- **Walk the process tree (`ps`, `/proc`)**: platform-specific parsing and races with process
  creation. The process group is kernel-maintained and needs no parsing.
- **A process-tree package**: adds a dependency for what `process.kill(-pgid)` already does on
  the supported platforms ([ADR 0007](0007-external-dependencies.md)).
- **cgroups (Linux) / job objects (Windows)**: stronger containment, including descendants
  that change their session, but platform-specific and requiring more privileges or native code.
  Revisit together with the Orvia-enforced sandbox.
