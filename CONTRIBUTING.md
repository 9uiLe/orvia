# Contributing to Orvia

Thanks for your interest in Orvia. The project is pre-release (v0.x) and its APIs are unstable, so please open an issue to discuss non-trivial changes before investing time in a pull request.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Nix flakes is the standard development environment and the reference used by CI.

```sh
git clone https://github.com/9uiLe/orvia.git
cd orvia
nix develop
npm ci
npm test
```

Without Nix you need git and the Node.js version in the `engines` field of `package.json` (>= 24.15). CI uses the Nix shell, so if results differ, the Nix shell is the reference.

## npm scripts

| Script                     | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run typecheck`        | Type-check the project                                            |
| `npm run lint`             | ESLint and Prettier check                                         |
| `npm run format`           | Format files with Prettier                                        |
| `npm test`                 | Run all tests                                                     |
| `npm run test:unit`        | Run unit tests (`test/unit`)                                      |
| `npm run test:integration` | Run integration tests (`test/integration`)                        |
| `npm run build`            | Build the project                                                 |
| `npm run bench`            | Run the status-query benchmark                                    |
| `npm run bench:storage`    | Run the storage benchmark (operation mix, file sizes)             |
| `npm run deps:check`       | Check dependencies against the allowed list                       |
| `npm run orvia`            | Run the CLI from source (`src/interface/cli/main.ts`)             |
| `npm run check`            | Typecheck, lint, dependency check, test, and build in one command |

Run `npm run check` before opening a pull request.

## Coding standards

- TypeScript strict mode. Do not use `any`.
- Layers are `src/domain`, `src/application`, `src/infrastructure`, and `src/interface`. Keep `src/domain` free of infrastructure imports.
- No raw SQL outside `src/infrastructure/sqlite`.
- Invoke git only through `src/infrastructure/git`.
- Never edit a migration that has already been applied; add a new one.
- Add tests with behavior changes: unit tests in `test/unit`, integration tests in `test/integration`.

## Commits and pull requests

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`.
- Changes go through pull requests to `master`. CI must pass and review conversations must be resolved. Force-pushing to `master` is disabled.
- Fill in the pull request template. Keep `docs/specification.md` as the product specification and update it with behavior changes. Update relevant tests, its implementation-status section, and `docs/current-implementation.md` in the same change. Keep the README's entry points accurate.

## Updating dependencies

- Prefer the Node.js standard library and dependencies already in use. Before adding a runtime
  dependency, review its necessity, maintenance cost, security, transitive dependencies, install
  scripts, and version pinning. If it adds runtime packages, run `npm run deps:check -- --write`
  and commit `docs/runtime-dependencies.txt`; CI fails otherwise.

- Nix inputs are updated deliberately with `nix flake update`, in a dedicated pull request. A
  change of Node.js (and therefore SQLite) must pass the storage-contract and migration tests,
  plus process-lifecycle tests, and be compared with `npm run bench:storage`.
- JavaScript dependencies are updated by Dependabot (grouped, with a cooldown). Do not mix manual dependency bumps into feature pull requests.

## Issues and secrets

Never paste secrets, credentials, tokens, or private source code into issues, pull requests, or logs. Sanitize logs first. Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

Orvia is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the same license (inbound = outbound, as in Section 5 of the license). A DCO sign-off is not required.
