# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub Private Vulnerability Reporting:
<https://github.com/9uiLe/orvia/security/advisories/new>

Do not open a public issue, pull request, or discussion for a suspected vulnerability. Include the affected version or commit SHA, reproduction steps, and the impact you observed. The project is maintained by one person, so responses are best-effort.

## Supported versions

Orvia is pre-1.0. Only the latest `master` and the latest 0.x release receive security fixes.

## Scope and threat model

- Orvia stores its state in user-local directories.
- Orvia does not store credentials.
- Orvia does not send telemetry.
- Coding agents run with your user's privileges. A full filesystem sandbox is not implemented yet (planned), so an agent can access whatever your user can.
- The local MCP server is intended for local use only and must not be exposed publicly.

Reports about the lack of a filesystem sandbox are already known; reports about bypasses of safeguards that do exist are welcome.

## What not to post publicly

Do not post in public issues or pull requests: exploit details for unfixed vulnerabilities, secrets, credentials, tokens, or private source code. Sanitize any logs you share.
