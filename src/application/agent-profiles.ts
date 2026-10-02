import {
  effectiveCapabilities,
  IMPLEMENTATION_PROFILE_STAGES,
  missingCapabilities,
  requiredCapabilitiesFor,
  REVIEW_PROFILE_STAGES,
  type AgentCapability,
} from '../domain/agent-profile.ts';
import type { StageState } from '../domain/cycle.ts';
import { OrviaError } from '../domain/errors.ts';
import type { AgentAdapter, ProcessLauncher } from './ports.ts';

export interface AgentProfileConfig {
  readonly adapter: string;
  readonly command?: string | undefined;
  /** Narrows the adapter's capabilities; omitted means all of them. */
  readonly capabilities?: readonly AgentCapability[] | undefined;
}

/** A configured profile bound to its adapter, with the capabilities it actually has. */
export interface AgentProfile {
  readonly id: string;
  readonly adapter: AgentAdapter;
  readonly command: string;
  readonly capabilities: readonly AgentCapability[];
}

export function buildAgentProfiles(
  config: Readonly<Record<string, AgentProfileConfig>>,
  adapters: readonly AgentAdapter[],
): ReadonlyMap<string, AgentProfile> {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const profiles = new Map<string, AgentProfile>();
  for (const [id, entry] of Object.entries(config)) {
    const adapter = byId.get(entry.adapter);
    if (adapter === undefined) {
      throw new OrviaError(
        'CONFIG_INVALID',
        `agent profile ${id} uses unknown adapter ${entry.adapter}`,
        { profileId: id, adapter: entry.adapter, adapters: [...byId.keys()] },
      );
    }
    profiles.set(id, {
      id,
      adapter,
      command: entry.command ?? adapter.defaultCommand,
      capabilities: effectiveCapabilities(adapter.capabilities, entry.capabilities ?? null),
    });
  }
  return profiles;
}

export function requireProfile(
  profiles: ReadonlyMap<string, AgentProfile>,
  profileId: string,
): AgentProfile {
  const profile = profiles.get(profileId);
  if (profile === undefined) {
    throw new OrviaError(
      'AGENT_PROFILE_NOT_FOUND',
      `agent profile ${profileId} is not configured`,
      {
        profileId,
        configured: [...profiles.keys()],
      },
    );
  }
  return profile;
}

/** Refuses before anything is started when the profile lacks what the stage needs. */
export function assertCapable(profile: AgentProfile, stage: StageState): void {
  const required = requiredCapabilitiesFor(stage);
  const missing = missingCapabilities(required, profile.capabilities);
  if (missing.length > 0) {
    throw new OrviaError(
      'AGENT_CAPABILITY_MISMATCH',
      `agent profile ${profile.id} cannot run ${stage}: missing ${missing.join(', ')}`,
      {
        profileId: profile.id,
        stage,
        required,
        available: profile.capabilities,
        missing,
      },
    );
  }
}

export async function assertCommandAvailable(
  profile: AgentProfile,
  launcher: ProcessLauncher,
): Promise<void> {
  if ((await launcher.resolveCommand(profile.command)) === null) {
    throw new OrviaError(
      'AGENT_UNAVAILABLE',
      `agent profile ${profile.id}: command not found: ${profile.command}`,
      { profileId: profile.id, command: profile.command },
    );
  }
}

export interface AgentProfileView {
  readonly id: string;
  readonly adapter: string;
  readonly command: string;
  /** The command was found on PATH (or at its path). */
  readonly available: boolean;
  readonly capabilities: readonly AgentCapability[];
  /** Cycle stages whose required capabilities the profile has. */
  readonly stages: readonly StageState[];
}

export async function describeProfiles(
  profiles: ReadonlyMap<string, AgentProfile>,
  launcher: ProcessLauncher,
): Promise<AgentProfileView[]> {
  const stages = [...IMPLEMENTATION_PROFILE_STAGES, ...REVIEW_PROFILE_STAGES];
  return Promise.all(
    [...profiles.values()].map(async (profile) => ({
      id: profile.id,
      adapter: profile.adapter.id,
      command: profile.command,
      available: (await launcher.resolveCommand(profile.command)) !== null,
      capabilities: profile.capabilities,
      stages: stages.filter(
        (stage) =>
          missingCapabilities(requiredCapabilitiesFor(stage), profile.capabilities).length === 0,
      ),
    })),
  );
}
