# Releasing (direction)

Release automation does not exist yet. This page records the intended direction.

## Versioning

- [Semantic Versioning](https://semver.org/). Until 1.0.0, versions are `0.y.z`; a minor bump
  (`0.y`) may contain breaking changes, a patch bump may not.
- The database schema version is independent of the package version. A release that adds a
  migration says so in the changelog, because older binaries refuse the upgraded database
  (`UNSUPPORTED_DATABASE_VERSION`).

## Changelog and tags

- [CHANGELOG.md](../CHANGELOG.md) follows Keep a Changelog. Every user-visible change adds an
  entry under `Unreleased` in its pull request.
- A release moves `Unreleased` to a version heading, bumps `package.json`, and tags the commit
  `vX.Y.Z` on `master`.

## Distribution

Not decided. The code keeps these options open:

| Channel           | Notes                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| npm               | `package.json` has `bin` and `files`; `private: true` prevents accidental publishing until the first release. |
| Standalone binary | Node.js single executable applications; possible because there are no native addons.                          |
| Homebrew          | Formula on top of the npm package or a binary.                                                                |
| Nix package       | A flake `packages` output built with `buildNpmPackage`; requires maintaining `npmDepsHash`.                   |

Nix remains a development-environment requirement only.
