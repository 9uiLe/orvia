# 0001. Runtime: TypeScript on Node.js 24; Nix for the development environment

- Status: Accepted
- Date: 2026-10-02

## Context

Orvia is a local daemon with a CLI and an MCP server. It needs a good MCP SDK, an embedded
SQLite, strict typing, cross-platform process and filesystem APIs, and a toolchain that
contributors can reproduce.

## Decision

- **Language/runtime:** TypeScript in strict mode on Node.js 24, the Active LTS line on the
  decision date (Node 26 becomes Active LTS on 2026-10-28; moving to it is a follow-up).
  `engines.node` is `>=24.15.0`, the release in which `node:sqlite` became a release candidate.
- **Erasable syntax only** (`erasableSyntaxOnly`): sources and tests run directly with Node's
  type stripping; `tsc` is used to typecheck and to build `dist/`. No test runner or transpiler
  dependency (`node:test` is used).
- **Package manager:** npm, because it ships with Node and needs no extra tool. Bun is not
  required.
- **SQLite driver:** the built-in `node:sqlite` (see [0002](0002-sqlite.md)). It needs no native
  build, which keeps the Nix shell free of a C toolchain and keeps future single-binary
  distribution possible.
- **MCP:** the official TypeScript SDK v2 (`@modelcontextprotocol/server`), which implements the
  2026-07-28 specification and still accepts clients of earlier revisions (tested).

### Nix

Nix is the standard way to get a reproducible **development** environment; it is not a runtime
requirement for Orvia users.

- `flake.nix` exposes `devShells.<system>.default` for aarch64/x86_64 Darwin and Linux with
  `nodejs_24`, `git`, and `sqlite` only. `mkShellNoCC` keeps a C compiler out of the shell.
- `flake.lock` pins nixpkgs (`nixos-26.05`). `package-lock.json` pins JavaScript dependencies.
  Responsibility split: Nix → Node.js and tools; npm lockfile → JavaScript dependencies.
- npm dependencies are not built through Nix (`buildNpmPackage` would require maintaining an
  `npmDepsHash` on every dependency change).
- CI installs upstream Nix and uses the same `flake.lock`, so CI and local shells get the same
  Node.js, git, and sqlite builds even though the Nix installers differ (the maintainer's
  machine uses Determinate Nix).
- **Updating inputs:** Dependabot's `nix` ecosystem proposes at most one flake input update per
  month; maintainers may also run `nix flake update` in a dedicated pull request. Node.js major
  upgrades are deliberate changes to `flake.nix`.
- nixpkgs 26.05 is the last release that supports x86_64-darwin. When the input moves past it,
  that system will be dropped from `flake.nix`.

## Consequences

- Contributors need Nix (or a matching Node.js and git) to develop; users do not.
- `node:sqlite` is still a release candidate. If its API changes, the impact is contained in
  `src/infrastructure/sqlite`.
- Distribution (npm package, standalone binary, Homebrew, Nix package) is still open; nothing in
  the code assumes one of them. See [docs/releasing.md](../releasing.md).

## Alternatives considered

- **Go or Rust:** better single-binary story, but a less mature MCP SDK at decision time and a
  smaller contributor pool for this kind of tool.
- **better-sqlite3:** mature, but a native addon that needs a compiler and prebuilt binaries per
  platform.
- **Bun:** fast startup, but making it mandatory would narrow the contributor base.
