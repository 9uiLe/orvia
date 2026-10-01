import { OrviaError } from './errors.ts';
import type { WorkItemId } from './ids.ts';

/**
 * What Orvia recorded when a Work Item was bound to a worktree.
 * File ids identify the on-disk directory instance, so a repository or worktree that was
 * deleted and recreated at the same path is detected as a different workspace.
 */
export interface WorkspaceIdentity {
  readonly repositoryCommonDir: string;
  readonly repositoryCommonDirFileId: string;
  readonly worktreeGitDir: string;
  readonly worktreeGitDirFileId: string;
  readonly worktreeRoot: string;
  readonly branch: string;
}

/** What git reports for a path right now. `branch` is null for a detached HEAD. */
export interface ObservedWorkspace {
  readonly repositoryCommonDir: string;
  readonly repositoryCommonDirFileId: string;
  readonly worktreeGitDir: string;
  readonly worktreeGitDirFileId: string;
  readonly worktreeRoot: string;
  readonly branch: string | null;
}

export type WorkspaceMismatchReason =
  | 'worktree_missing'
  | 'repository_changed'
  | 'worktree_changed'
  | 'worktree_root_changed'
  | 'branch_changed'
  | 'detached_head';

export function compareWorkspace(
  expected: WorkspaceIdentity,
  observed: ObservedWorkspace | null,
): WorkspaceMismatchReason[] {
  if (observed === null) return ['worktree_missing'];
  const reasons: WorkspaceMismatchReason[] = [];
  if (
    observed.repositoryCommonDir !== expected.repositoryCommonDir ||
    observed.repositoryCommonDirFileId !== expected.repositoryCommonDirFileId
  ) {
    reasons.push('repository_changed');
  }
  if (
    observed.worktreeGitDir !== expected.worktreeGitDir ||
    observed.worktreeGitDirFileId !== expected.worktreeGitDirFileId
  ) {
    reasons.push('worktree_changed');
  }
  if (observed.worktreeRoot !== expected.worktreeRoot) reasons.push('worktree_root_changed');
  if (observed.branch === null) reasons.push('detached_head');
  else if (observed.branch !== expected.branch) reasons.push('branch_changed');
  return reasons;
}

export function assertWorkspaceMatches(
  workItemId: WorkItemId,
  expected: WorkspaceIdentity,
  observed: ObservedWorkspace | null,
): void {
  const reasons = compareWorkspace(expected, observed);
  if (reasons.length > 0) {
    throw new OrviaError(
      'WORKSPACE_MISMATCH',
      `workspace of ${workItemId} does not match its recorded identity: ${reasons.join(', ')}`,
      { workItemId, reasons, expectedWorktreeRoot: expected.worktreeRoot },
    );
  }
}

export function identityFromObservation(
  observed: ObservedWorkspace,
  requiredBranch: string | null,
): WorkspaceIdentity {
  if (observed.branch === null) {
    throw new OrviaError('WORKSPACE_MISMATCH', 'cannot bind a worktree with a detached HEAD', {
      worktreeRoot: observed.worktreeRoot,
      reasons: ['detached_head'],
    });
  }
  if (requiredBranch !== null && observed.branch !== requiredBranch) {
    throw new OrviaError(
      'WORKSPACE_MISMATCH',
      `worktree is on branch ${observed.branch}, expected ${requiredBranch}`,
      { worktreeRoot: observed.worktreeRoot, reasons: ['branch_changed'] },
    );
  }
  return { ...observed, branch: observed.branch };
}
