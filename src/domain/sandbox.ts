import type { WorkspaceIdentity } from './workspace.ts';

/**
 * The filesystem boundary Orvia intends for an Agent Run.
 *
 * Orvia computes the policy; agent adapters translate it into the agent's own sandbox options.
 * Orvia itself does not enforce it yet (see README "Security model").
 */
export interface FilesystemPolicy {
  readonly workingDirectory: string;
  readonly writableRoots: readonly string[];
}

export function filesystemPolicyFor(workspace: WorkspaceIdentity): FilesystemPolicy {
  // Commits from a linked worktree write objects and refs into the shared common dir,
  // so the worktree root alone is not enough for an agent that commits.
  const roots = new Set([
    workspace.worktreeRoot,
    workspace.worktreeGitDir,
    workspace.repositoryCommonDir,
  ]);
  return { workingDirectory: workspace.worktreeRoot, writableRoots: [...roots] };
}
