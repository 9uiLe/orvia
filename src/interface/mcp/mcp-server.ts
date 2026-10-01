import { McpServer } from '@modelcontextprotocol/server';
import { OPERATIONS } from '../../application/operations.ts';
import { isOrviaError } from '../../domain/errors.ts';
import type { OperationClass } from '../../domain/storage.ts';
import { ORVIA_VERSION } from '../../version.ts';

export type OperationCaller = (operation: string, input: unknown) => Promise<unknown>;

const INSTRUCTIONS = `Orvia is a local control plane for coding agents.
Plans (P-n) are logical changes discussed with the human. Work Items (W-n) are implementation
units: one branch, one worktree, one PR. A Plan can have several Work Items.
Every mutation takes explicit ids. Resolve what the human refers to with list_plans,
list_work_items, or get_status first; if more than one Work Item could match, ask the human
instead of guessing. Use get_status to answer "what is happening now?".`;

interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

// ChatGPT treats any tool without readOnlyHint as a write action that needs confirmation.
const ANNOTATIONS: Record<OperationClass, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  control: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  write: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  maintenance: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  agent_run: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

function asStructured(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

/**
 * Exposes every Orvia operation as an MCP tool. The server holds no state of its own and
 * forwards each call to the daemon, so it never touches the database.
 */
export function createMcpServer(call: OperationCaller): McpServer {
  const server = new McpServer(
    { name: 'orvia', version: ORVIA_VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const operation of OPERATIONS) {
    server.registerTool(
      operation.name,
      {
        title: operation.title,
        description: operation.description,
        inputSchema: operation.input,
        annotations: ANNOTATIONS[operation.operationClass],
      },
      async (input: unknown) => {
        try {
          const result = await call(operation.name, input);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: asStructured(result),
          };
        } catch (error) {
          const code = isOrviaError(error) ? error.code : 'INTERNAL';
          const message = error instanceof Error ? error.message : String(error);
          const details = isOrviaError(error) ? error.details : {};
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${code}: ${message}` }],
            structuredContent: { error: { code, message, details } },
          };
        }
      },
    );
  }
  return server;
}
