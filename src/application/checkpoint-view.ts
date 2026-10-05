import type { Checkpoint } from '../domain/checkpoint.ts';
import type { CodeSnapshot } from '../domain/repository-evidence.ts';
import type { WorkspaceIdentity } from '../domain/workspace.ts';

export interface CodeSnapshotSummary {
  readonly head: string;
  readonly fingerprint: string;
  readonly fileCount: number;
}

export interface CheckpointView extends Omit<Checkpoint, 'preparedContext' | 'endCode'> {
  readonly preparedContext: {
    readonly workspace: WorkspaceIdentity;
    readonly code: CodeSnapshotSummary;
  };
  readonly endCode: CodeSnapshotSummary | null;
}

function summarizeCode(code: CodeSnapshot): CodeSnapshotSummary {
  return { head: code.head, fingerprint: code.fingerprint, fileCount: code.files.length };
}

export function checkpointView(checkpoint: Checkpoint): CheckpointView {
  const { preparedContext, endCode, ...record } = checkpoint;
  return {
    ...record,
    preparedContext: {
      workspace: preparedContext.workspace,
      code: summarizeCode(preparedContext.code),
    },
    endCode: endCode === null ? null : summarizeCode(endCode),
  };
}
