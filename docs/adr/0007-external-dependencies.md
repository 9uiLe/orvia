# 0007. External dependencies

- Status: Accepted
- Date: 2026-10-02

## Context

Each dependency adds supply-chain attack surface, vulnerability response work, breaking-change
risk, and transitive growth. Orvia also controls coding agents on a developer's machine, which
makes its supply chain a security concern for its users.

## Policy

Before adding a capability, consider in this order: the Node.js standard library, existing
system capabilities (git, SQLite), dependencies already adopted, a new dependency, and an
internal implementation. Do not apply the order mechanically. Complex protocols, parsers,
cryptography, and network stacks are not re-implemented just to save a dependency.

A new dependency is admitted when the cost of building and maintaining the capability internally
exceeds the cost of introducing, maintaining, and securing the dependency. Being convenient,
well known, or common is not enough. Each admission states its necessity, the cost of the
internal alternative, the dependency's maintenance and security record, its transitive graph,
install scripts and native code, and how it is pinned. Important runtime or security-sensitive
dependencies get a record below.

Frameworks are added only for a capability that is needed now. Examples: a web framework only
when an HTTP server exists, and no CLI, logging, ORM, DI, or migration framework by default.

## Inventory

| What                                         | Where                                                          | Pinned by           |
| -------------------------------------------- | -------------------------------------------------------------- | ------------------- |
| Runtime npm packages (direct and transitive) | [`docs/runtime-dependencies.txt`](../runtime-dependencies.txt) | `package-lock.json` |
| Development npm packages                     | `devDependencies` in `package.json`                            | `package-lock.json` |
| GitHub Actions                               | `.github/workflows/ci.yml`                                     | full commit SHA     |
| Nix inputs                                   | `flake.nix`                                                    | `flake.lock`        |

`npm run deps:check` (run in CI) recomputes the runtime closure from `package-lock.json`. It
fails when the closure differs from the inventory file or when a runtime package has an install
script. A PR that grows the runtime therefore has to change `docs/runtime-dependencies.txt`,
which makes the growth visible in review.

State on 2026-10-02: **3 runtime packages** (`@modelcontextprotocol/server`,
`@modelcontextprotocol/core`, `zod`) and 107 packages in total. No package has an install
script or native code. `npm audit`: 0 vulnerabilities.

## Dependency decision records

### @modelcontextprotocol/server (+ @modelcontextprotocol/core), runtime

- **Purpose:** MCP server protocol (JSON-RPC framing, `initialize` negotiation across protocol
  revisions, tool listing, schemas, stdio transport).
- **Why not the standard library or internal code:** MCP is a separately evolving specification.
  The 2026-07-28 revision is a breaking change from 2025-11-25, and Orvia must also serve clients
  of older revisions (ChatGPT's revision is undocumented). Following that independently would
  be a permanent maintenance cost.
- **Maintenance:** official project of the MCP organization
  (github.com/modelcontextprotocol/typescript-sdk), MIT. v2 is the stable line; 2.0.0 was released
  2026-07-27, and 2.2.0 (used) on 2026-09-28. v1 receives fixes for at least 6 months after v2.
- **Security:** GitHub Advisory Database shows no advisories for `@modelcontextprotocol/server`
  or `core`. The v1 package `@modelcontextprotocol/sdk` had three high-severity advisories
  (DNS-rebinding protection off by default, ReDoS, cross-client data leak on instance reuse; all
  fixed by 1.26.0). The first and third concern HTTP transports and shared instances, which
  Orvia does not use: it runs one stdio server per process. No install scripts or native code.
  Orvia uses no network, filesystem, or credential features of the package.
- **Transitive impact:** 3 packages (`server`, `core`, `zod`).
- **Pinning:** exact version in `package.json`, lockfile. Major updates are reviewed by a human.
- **Re-evaluate when:** a new major architecture, the project becomes unmaintained, or
  high-severity advisories recur.

### zod, runtime

- **Purpose:** input validation for every operation, plus JSON Schema for MCP tool inputs.
- **Why not internal:** the MCP SDK already depends on `zod ^4.2.0` and accepts zod schemas for
  tool inputs. Using it adds **zero** packages; a separate validator would duplicate
  functionality.
- **Maintenance/Security:** MIT, github.com/colinhacks/zod, frequent releases. One advisory
  (DoS, 2023) affects only `<= 3.22.2`. No dependencies of its own, no install scripts.
- **Re-evaluate when:** the MCP SDK stops depending on zod.

### node:sqlite, built-in (release candidate)

- **Stability:** 1.2 (release candidate) since Node.js 24.15.0, which is the `engines` minimum.
  No flag is needed.
- **Why not a package:** `better-sqlite3` is a native addon. It needs a compiler or prebuilt
  binaries per platform and ABI, which complicates Nix, CI, and binary distribution.
- **API change risk:** all use is inside `src/infrastructure/sqlite` behind the `Store` port.
- **Fallback:** if the API changes incompatibly or regresses, implement the same port with
  `better-sqlite3`, recorded as a new decision.

### Development-only

| Package                                     | Why                                                               | Notes                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`, `@types/node`                 | typecheck and build                                               | majors are upgraded by hand: `@types/node` with the Node.js major in `flake.nix`, `typescript` once `typescript-eslint` supports it (Dependabot ignore rules) |
| `eslint`, `@eslint/js`, `typescript-eslint` | lint, layer-boundary rules                                        | largest dev subtree (about 70 packages)                                                                                                                       |
| `prettier`                                  | formatting                                                        | no dependencies                                                                                                                                               |
| `@modelcontextprotocol/client`              | test the server with the official client for the current protocol | 13 packages, test only                                                                                                                                        |

None of them ship in `dist/` or install with Orvia.

## Not adopted

| Capability                                                | Chosen instead                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TOML parser (`smol-toml`, removed)                        | JSON config via `JSON.parse`. The TOML parser had three DoS advisories (all fixed) and one maintainer. Configuration needed no TOML features. |
| `@modelcontextprotocol/sdk` v1 as a test client (removed) | A raw JSON-RPC test for the 2025-06-18 handshake. Removing it dropped 73 transitive dev packages.                                             |
| CLI framework                                             | `node:util` `parseArgs`; flags are generated from the operation schemas                                                                       |
| Logging framework                                         | 30-line JSON-lines logger to stderr                                                                                                           |
| Migration framework / ORM                                 | Internal migrator (versioned SQL, checksums, backup, transactions) and hand-written SQL in one module                                         |
| Web / HTTP framework                                      | `node:http` over a Unix socket for local IPC; no HTTP MCP transport yet                                                                       |
| Test runner, TS runner                                    | `node:test`, Node.js type stripping                                                                                                           |
| DI framework                                              | One composition-root function (`startDaemon`)                                                                                                 |

## Updates and vulnerabilities

- Dependabot opens grouped PRs for npm minor and patch updates and separate PRs for each major
  update, with a 7-day cooldown. Security updates arrive as separate PRs. Nothing is
  auto-merged. Major updates of runtime dependencies need human review of the changelog,
  migration notes, and behavior.
- Dependabot `ignore` rules also suppress security-update PRs for the versions they match.
  They are therefore limited to majors of development-only tools (`typescript`,
  `@types/node`), which never ship in `dist/`. Their minor and patch updates, every runtime
  dependency, and Dependabot alerts are not affected.
- For a critical or high advisory, decide and record in the PR or issue:
  1. which package and version range is affected (`npm ls <package>`);
  2. whether Orvia's use is exploitable (e.g. HTTP-transport advisories against the stdio-only
     server);
  3. whether a patched version exists (update, then `npm run check`);
  4. if not, whether a workaround or alternative is needed.

  An advisory count alone is not a reason to remove a dependency.
