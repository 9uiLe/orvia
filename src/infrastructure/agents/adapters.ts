import type { AgentAdapter, AgentRunRequest } from '../../application/ports.ts';

function extraWritableRoots(request: AgentRunRequest): string[] {
  return request.policy.writableRoots.filter((root) => root !== request.policy.workingDirectory);
}

/** Codex enforces the policy with its own workspace-write sandbox. */
export function codexAdapter(command = 'codex'): AgentAdapter {
  return {
    name: 'codex',
    command,
    buildInvocation: (request) => ({
      command,
      args: [
        'exec',
        '--sandbox',
        'workspace-write',
        '--cd',
        request.policy.workingDirectory,
        ...extraWritableRoots(request).flatMap((root) => ['--add-dir', root]),
        '-',
      ],
      cwd: request.policy.workingDirectory,
      stdin: request.prompt,
    }),
  };
}

/** Claude Code applies the policy through its permission system, not an OS sandbox. */
export function claudeAdapter(command = 'claude'): AgentAdapter {
  return {
    name: 'claude',
    command,
    buildInvocation: (request) => ({
      command,
      args: [
        '--print',
        '--permission-mode',
        'acceptEdits',
        ...extraWritableRoots(request).flatMap((root) => ['--add-dir', root]),
      ],
      cwd: request.policy.workingDirectory,
      stdin: request.prompt,
    }),
  };
}
