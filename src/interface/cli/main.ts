#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { findOperation, OPERATIONS, type Operation } from '../../application/operations.ts';
import { isOrviaError, OrviaError } from '../../domain/errors.ts';
import { resolvePaths, type OrviaPaths } from '../../infrastructure/paths.ts';
import { ORVIA_VERSION } from '../../version.ts';
import { startDaemon } from '../daemon/daemon.ts';
import { IpcClient } from '../ipc-client.ts';
import { createMcpServer } from '../mcp/mcp-server.ts';
import { runDoctor } from './doctor.ts';

/** Shortcuts for the commands people type most; every operation is also available by name. */
const ALIASES: Record<string, string> = {
  status: 'get_status',
  plans: 'list_plans',
  'work-items': 'list_work_items',
  storage: 'get_storage_status',
  cleanup: 'run_storage_cleanup',
  migrate: 'get_schema_status',
};

const USAGE = `orvia ${ORVIA_VERSION} — the human control plane for coding agents

Usage:
  orvia daemon                 Run the daemon in the foreground (owns the database)
  orvia mcp                    Serve MCP over stdio (forwards to the daemon)
  orvia doctor [--json]        Diagnose the environment, daemon, schema, and storage
  orvia status                 Overview (get_status)
  orvia plans                  List plans (list_plans)
  orvia work-items             List open work items (list_work_items)
  orvia storage                Storage usage and pressure (get_storage_status)
  orvia cleanup                Run storage cleanup (run_storage_cleanup)
  orvia migrate                Schema status; migrations run when the daemon starts
  orvia operations             List every operation and its flags
  orvia <operation> [--flag value ...] [--input JSON]
                               Run an operation, e.g. orvia create-plan --title "KMP rollout"

All operations print JSON. Operations need a running daemon.`;

function toKebab(name: string): string {
  return name.replace(/_/g, '-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

interface FlagSpec {
  readonly key: string;
  readonly flag: string;
  readonly kind: 'string' | 'integer' | 'array' | 'nullable-string';
  readonly required: boolean;
}

function flagSpecs(operation: Operation): FlagSpec[] {
  const schema = z.toJSONSchema(operation.input) as {
    properties?: Record<string, { type?: string; anyOf?: { type?: string }[] }>;
    required?: string[];
  };
  return Object.entries(schema.properties ?? {}).map(([key, property]) => {
    let kind: FlagSpec['kind'] = 'string';
    if (property.type === 'integer') kind = 'integer';
    else if (property.type === 'array') kind = 'array';
    else if (property.anyOf?.some((option) => option.type === 'null') === true) {
      kind = 'nullable-string';
    }
    return { key, flag: toKebab(key), kind, required: schema.required?.includes(key) ?? false };
  });
}

function inputFromFlags(operation: Operation, args: readonly string[]): unknown {
  const specs = flagSpecs(operation);
  const { values }: { values: Record<string, string | string[] | boolean | undefined> } = parseArgs(
    {
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        input: { type: 'string' },
        ...Object.fromEntries(
          specs.map((spec) => [
            spec.flag,
            { type: 'string' as const, multiple: spec.kind === 'array' },
          ]),
        ),
      },
    },
  );
  let parsed: unknown = {};
  try {
    if (typeof values.input === 'string') parsed = JSON.parse(values.input) as unknown;
  } catch {
    throw new OrviaError('VALIDATION_FAILED', '--input must be a valid JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OrviaError('VALIDATION_FAILED', '--input must be a valid JSON object');
  }
  const input = parsed as Record<string, unknown>;
  for (const spec of specs) {
    const value = values[spec.flag];
    if (value === undefined) continue;
    if (spec.kind === 'integer') input[spec.key] = Number(value);
    else if (spec.kind === 'nullable-string' && value === 'null') input[spec.key] = null;
    else input[spec.key] = value;
  }
  return input;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function describeOperations(): string {
  return OPERATIONS.map((operation) => {
    const flags = flagSpecs(operation)
      .map((spec) => (spec.required ? `--${spec.flag}` : `[--${spec.flag}]`))
      .join(' ');
    return `  ${toKebab(operation.name)} ${flags}\n      ${operation.description}`;
  }).join('\n');
}

async function runDaemonForeground(paths: OrviaPaths): Promise<void> {
  const daemon = await startDaemon({ paths });
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await daemon.close();
}

async function runMcp(client: IpcClient): Promise<void> {
  const server = createMcpServer((operation, input) => client.call(operation, input));
  await server.connect(new StdioServerTransport());
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const paths = resolvePaths();
  const client = new IpcClient(paths.socketPath);

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE + '\n');
      return command === undefined ? 2 : 0;
    case '--version':
    case 'version':
      process.stdout.write(ORVIA_VERSION + '\n');
      return 0;
    case 'daemon':
      await runDaemonForeground(paths);
      return 0;
    case 'mcp':
      await runMcp(client);
      return 0;
    case 'doctor': {
      const checks = await runDoctor(paths, client);
      if (rest.includes('--json')) print(checks);
      else
        for (const check of checks)
          process.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
      return checks.some((check) => check.status === 'fail') ? 1 : 0;
    }
    case 'operations':
      process.stdout.write(describeOperations() + '\n');
      return 0;
    default: {
      const name = ALIASES[command] ?? command.replace(/-/g, '_');
      const operation = findOperation(name);
      print(await client.call(operation.name, inputFromFlags(operation, rest)));
      return 0;
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (isOrviaError(error)) {
      process.stderr.write(`error ${error.code}: ${error.message}\n`);
    } else if (
      error instanceof Error &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`usage error: ${error.message}\n`);
      process.exitCode = 2;
      return;
    } else {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  },
);
