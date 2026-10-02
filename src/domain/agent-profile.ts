import type { StageState } from './cycle.ts';

/**
 * What Orvia needs an agent to be able to do. Names describe the effect, never a provider's
 * mechanism; adapters translate them into each CLI's own controls.
 */
export const AGENT_CAPABILITIES = [
  'workspaceRead',
  'workspaceWrite',
  'commandExecution',
  'structuredResult',
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** Profile ids are user-chosen names such as `primary` or `reviewer`. */
export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Review needs no command execution: Orvia collects the change evidence from git itself and
 * puts it into the review prompt (ADR 0011).
 */
const REQUIRED: Readonly<Record<StageState, readonly AgentCapability[]>> = {
  IMPLEMENTING: ['workspaceRead', 'workspaceWrite', 'structuredResult'],
  VERIFYING: ['workspaceRead', 'commandExecution', 'structuredResult'],
  REVIEWING: ['workspaceRead', 'structuredResult'],
  FIXING: ['workspaceRead', 'workspaceWrite', 'structuredResult'],
};

export function requiredCapabilitiesFor(stage: StageState): readonly AgentCapability[] {
  return REQUIRED[stage];
}

/** The stages run by each of a cycle's two profiles. */
export const IMPLEMENTATION_PROFILE_STAGES: readonly StageState[] = [
  'IMPLEMENTING',
  'VERIFYING',
  'FIXING',
];
export const REVIEW_PROFILE_STAGES: readonly StageState[] = ['REVIEWING'];

export function profileRoleFor(stage: StageState): 'implementation' | 'review' {
  return REVIEW_PROFILE_STAGES.includes(stage) ? 'review' : 'implementation';
}

/**
 * A profile can only narrow what its adapter provides; it cannot grant a capability the
 * adapter does not have. `policy` null means "everything the adapter provides".
 */
export function effectiveCapabilities(
  adapter: readonly AgentCapability[],
  policy: readonly AgentCapability[] | null,
): AgentCapability[] {
  return AGENT_CAPABILITIES.filter(
    (capability) =>
      adapter.includes(capability) && (policy === null || policy.includes(capability)),
  );
}

export function missingCapabilities(
  required: readonly AgentCapability[],
  available: readonly AgentCapability[],
): AgentCapability[] {
  return required.filter((capability) => !available.includes(capability));
}
