import type { AgentAdapter, AgentRunRequest } from '../../application/ports.ts';

function extraWritableRoots(request: AgentRunRequest): string[] {
  return request.policy.writableRoots.filter((root) => root !== request.policy.workingDirectory);
}

/**
 * Codex enforces the policy with its own sandbox: `workspace-write` for roles that edit,
 * `read-only` for review. With `--output-schema` it prints only the final message, the
 * structured result, to stdout; progress goes to stderr.
 */
export function codexAdapter(command = 'codex'): AgentAdapter {
  return {
    name: 'codex',
    command,
    buildInvocation: (request) => ({
      command,
      args: [
        'exec',
        '--sandbox',
        request.access === 'edit' ? 'workspace-write' : 'read-only',
        '--cd',
        request.policy.workingDirectory,
        ...(request.access === 'edit'
          ? extraWritableRoots(request).flatMap((root) => ['--add-dir', root])
          : []),
        ...(request.result === null ? [] : ['--output-schema', request.result.schemaPath]),
        '-',
      ],
      cwd: request.policy.workingDirectory,
      stdin: request.prompt,
    }),
    extractResult: (stdout) => (stdout.trim() === '' ? null : stdout.trim()),
  };
}

/**
 * Claude Code applies the policy through its permission system, not an OS sandbox. Editing
 * roles accept file edits; whether they may run shell commands is left to the user's own Claude
 * Code permission settings. Review gets read-only tools only. With `--json-schema`, the result
 * is the `structured_output` field of the JSON envelope on stdout.
 */
export function claudeAdapter(command = 'claude'): AgentAdapter {
  return {
    name: 'claude',
    command,
    buildInvocation: (request) => ({
      command,
      args: [
        '--print',
        ...(request.access === 'edit'
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
}
