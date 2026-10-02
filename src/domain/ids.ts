import { OrviaError } from './errors.ts';

const PREFIXES = {
  plan: 'P',
  workItem: 'W',
  run: 'R',
  decision: 'D',
  note: 'N',
  cycle: 'C',
  review: 'Rv',
  finding: 'F',
} as const;

export type EntityKind = keyof typeof PREFIXES;

export type PlanId = `P-${number}`;
export type WorkItemId = `W-${number}`;
export type RunId = `R-${number}`;
export type DecisionId = `D-${number}`;
export type NoteId = `N-${number}`;
export type CycleId = `C-${number}`;
export type ReviewId = `Rv-${number}`;
export type FindingId = `F-${number}`;

export interface IdByKind {
  plan: PlanId;
  workItem: WorkItemId;
  run: RunId;
  decision: DecisionId;
  note: NoteId;
  cycle: CycleId;
  review: ReviewId;
  finding: FindingId;
}

export function formatId<K extends EntityKind>(kind: K, rowId: number): IdByKind[K] {
  if (!Number.isSafeInteger(rowId) || rowId <= 0) {
    throw new OrviaError('INTERNAL', `invalid row id for ${kind}: ${rowId}`);
  }
  return `${PREFIXES[kind]}-${rowId}` as IdByKind[K];
}

export function idPattern(kind: EntityKind): RegExp {
  return new RegExp(`^${PREFIXES[kind]}-[1-9][0-9]*$`);
}

export function parseId(kind: EntityKind, id: string): number {
  if (!idPattern(kind).test(id)) {
    throw new OrviaError('VALIDATION_FAILED', `expected a ${kind} id like ${PREFIXES[kind]}-1`, {
      id,
    });
  }
  const rowId = Number(id.slice(PREFIXES[kind].length + 1));
  if (!Number.isSafeInteger(rowId)) {
    throw new OrviaError('VALIDATION_FAILED', `id out of range: ${id}`, { id });
  }
  return rowId;
}
