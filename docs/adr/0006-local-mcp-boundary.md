# 0006. Local MCP boundary

- Status: Accepted
- Date: 2026-10-02

## Context

The primary human interface is ChatGPT. According to OpenAI's documentation (checked
2026-10-02), ChatGPT connects to MCP servers in developer mode through a public HTTPS endpoint or
a Secure MCP Tunnel, which can reach a local stdio or HTTP MCP server. Supported transports are
SSE and streaming HTTP. Authentication may be OAuth or none. ChatGPT treats tools without
`readOnlyHint` as write actions and asks for confirmation. The MCP specification (2026-07-28)
removed protocol sessions. Local HTTP servers must validate `Origin`, should bind to localhost,
and should authenticate.

Sources: <https://developers.openai.com/api/docs/guides/developer-mode>,
<https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>,
<https://developers.openai.com/api/docs/mcp>,
<https://modelcontextprotocol.io/specification/2026-07-28>.

## Decision

```
ChatGPT ── Secure MCP Tunnel ──▶ `orvia mcp` (stdio) ──▶ daemon socket ──▶ Application ──▶ SQLite
Claude / Codex / other MCP clients ──▶ `orvia mcp` (stdio) ─┘
CLI ───────────────────────────────────────────────────────▶ daemon socket
```

- `orvia mcp` is an MCP server over **stdio**, built with the official TypeScript SDK v2. It is
  stateless and forwards every tool call to the daemon over its socket. It never opens the
  database.
- The daemon socket is a Unix domain socket in a directory that Orvia creates with mode 0700 and
  verifies (owner and mode) before use; the socket itself is chmod 0600. Its access control is
  that of the local user account.
- Tools are generated from the operation registry (the same one the CLI uses), so MCP and CLI
  cannot drift. Inputs are validated with zod schemas and published as JSON Schema.
- Tool annotations come from the operation class: read operations have `readOnlyHint: true`;
  `start_run` and maintenance have `destructiveHint: true`; `start_run` has `openWorldHint: true`.
- Identity is always explicit (`P-n`, `W-n`); nothing depends on chat sessions or MCP sessions.
- Errors are tool results with `isError: true` and `{ error: { code, message, details } }`.

### Not implemented: Streamable HTTP

An HTTP transport would let ChatGPT reach Orvia through a public URL. Orvia has no
authentication yet, so exposing it would let anyone with the URL start agents on the user's
machine. HTTP is planned together with authentication (OAuth per the MCP authorization spec)
and `Origin`/`Host` validation.

## Verification

- MCP clients of the SDK v2 (protocol 2026-07-28) and SDK v1.31 (earlier revisions) list and
  call tools against `orvia mcp` in the integration tests.
- An end-to-end connection from ChatGPT through a Secure MCP Tunnel has **not** been tested.

## Consequences

- Prompt injection: content that agents or other connectors produce can try to steer ChatGPT
  into calling write tools. ChatGPT's confirmations for write tools and Orvia's explicit ids
  narrow this but do not remove it. Do not connect untrusted MCP servers in the same
  conversation.
