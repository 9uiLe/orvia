# 0005. Repository isolation

- Status: Accepted
- Date: 2026-10-02

## Context

Orvia works on other people's repositories. Adding `.orvia/` directories, ignore entries, or
metadata files to them would leak Orvia into every project that uses it.

## Decision

- Orvia writes nothing into a target repository: no `.orvia/`, `.ai/`, `.gitignore` entries,
  metadata, or configuration files. Agents may change the repository as their task requires; that
  is the agent's work, not Orvia's state.
- Orvia reads repositories only through read-only git plumbing (`rev-parse`, `symbolic-ref`,
  `worktree list`) with `GIT_OPTIONAL_LOCKS=0`, all spawned from
  `src/infrastructure/git/git-cli.ts` (enforced by ESLint).
- Existing project files such as `AGENTS.md`, `CLAUDE.md`, or `README` may be read by agents;
  Orvia never uses them to store state.
- All Orvia state lives in user-local directories, resolved per platform:

|        | macOS                                             | Linux and other Unix                                          | Windows (untested)                 |
| ------ | ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| config | `~/Library/Application Support/orvia/config.json` | `$XDG_CONFIG_HOME/orvia` (`~/.config/orvia`)                  | `%APPDATA%\orvia`                  |
| data   | `~/Library/Application Support/orvia/`            | `$XDG_DATA_HOME/orvia` (`~/.local/share/orvia`)               | `%LOCALAPPDATA%\orvia\data`        |
| cache  | `~/Library/Caches/orvia/`                         | `$XDG_CACHE_HOME/orvia` (`~/.cache/orvia`)                    | `%LOCALAPPDATA%\orvia\cache`       |
| socket | `$TMPDIR/orvia-<uid>/orvia.sock`                  | `$XDG_RUNTIME_DIR/orvia/orvia.sock`, else `/tmp/orvia-<uid>/` | named pipe `\\.\pipe\orvia-<user>` |

`ORVIA_CONFIG_DIR`, `ORVIA_DATA_DIR`, `ORVIA_CACHE_DIR`, and `ORVIA_RUNTIME_DIR` override them.

- Orvia stores no credentials. Agents authenticate with their own existing mechanisms; Orvia
  passes its environment through unchanged.

## Consequences

- Moving to another machine does not carry Orvia state with the repository. Multi-machine
  handoff is out of scope for now.
