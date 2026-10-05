export interface CodeSnapshot {
  readonly head: string;
  readonly fingerprint: string;
  readonly files: readonly {
    readonly path: string;
    readonly fingerprint: string;
  }[];
}

export interface WorkspaceChanges {
  readonly baseCommit: string;
  readonly head: string;
  readonly fingerprint: string;
  readonly observedAt: string;
  readonly files: readonly { readonly path: string; readonly status: string }[];
  readonly diff: string;
  readonly complete: boolean;
}

export interface SourcePage {
  readonly path: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly totalBytes: number;
  readonly content: string;
  readonly encoding: 'utf8' | 'base64';
  readonly head: string;
  readonly fingerprint: string;
  readonly observedAt: string;
  readonly complete: boolean;
}
