import type { AgentAdapter, AgentRunRequest } from '../../application/ports.ts';

function extraWritableRoots(request: AgentRunRequest): string[] {
  return request.policy.writableRoots.filter((root) => root !== request.policy.workingDirectory);
}

/**
 * Codex enforces the request with its own sandbox. With `--output-schema` it prints only the
 * final message, the structured result, to stdout; progress goes to stderr.
 *
 * Codex has no switch to turn its shell off: without commandExecution the read-only sandbox
 * still runs commands, but none of them can write (observed in local validation).
 */
export const codexAdapter: AgentAdapter = {
  id: 'codex',
  defaultCommand: 'codex',
  capabilities: ['workspaceRead', 'workspaceWrite', 'commandExecution', 'structuredResult'],
  buildInvocation: (command, request) => {
    // Checks write build output and caches inside the worktree; under the read-only sandbox
    // most test runners fail, so command execution gets the workspace-write sandbox too.
    const writes =
      request.capabilities.includes('workspaceWrite') ||
      request.capabilities.includes('commandExecution');
    return {
      command,
      args: [
        'exec',
        '--sandbox',
        writes ? 'workspace-write' : 'read-only',
        '--cd',
        request.policy.workingDirectory,
        ...(writes ? extraWritableRoots(request).flatMap((root) => ['--add-dir', root]) : []),
        ...(request.result === null ? [] : ['--output-schema', request.result.schemaPath]),
        '-',
      ],
      cwd: request.policy.workingDirectory,
      stdin: request.prompt,
    };
  },
  resultStdoutBytes: (resultBytes) => resultBytes,
  extractResult: (stdout) => (stdout.trim() === '' ? null : stdout.trim()),
};

/**
 * Claude Code applies the request through its permission system, not an OS sandbox. Editing
 * accepts file edits; without workspaceWrite only the Read, Grep, and Glob tools are available.
 * With `--json-schema`, the result is the `structured_output` field of the JSON envelope.
 *
 * No commandExecution: Orvia does not grant Claude Code's Bash tool. Whether Bash runs is left
 * to the user's own Claude Code permission settings, so the adapter cannot promise it.
 */
export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  defaultCommand: 'claude',
  capabilities: ['workspaceRead', 'workspaceWrite', 'structuredResult'],
  buildInvocation: (command, request) => ({
    command,
    args: [
      '--print',
      ...(request.capabilities.includes('workspaceWrite')
        ? [
            '--permission-mode',
            'acceptEdits',
            ...extraWritableRoots(request).flatMap((root) => ['--add-dir', root]),
          ]
        : ['--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk']),
      ...(request.result === null
        ? []
        : ['--output-format', 'json', '--json-schema', JSON.stringify(request.result.schema)]),
    ],
    cwd: request.policy.workingDirectory,
    stdin: request.prompt,
  }),
  // The envelope carries the result twice (`result` as text and `structured_output`) plus run
  // metadata, measured at about 2 KB; a third result-sized share covers the metadata.
  resultStdoutBytes: (resultBytes) => 3 * resultBytes,
  extractResult: (stdout) => {
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (typeof envelope !== 'object' || envelope === null) return null;
    const fields = envelope as Record<string, unknown>;
    if (fields['is_error'] === true || fields['structured_output'] === undefined) return null;
    return JSON.stringify(fields['structured_output']);
  },
};

/** Adapters shipped with Orvia. Profiles in the configuration refer to them by id. */
export const BUNDLED_ADAPTERS: readonly AgentAdapter[] = [codexAdapter, claudeAdapter];
