import * as z from 'zod/v4';
import { FINDING_CATEGORIES, REVIEW_VERDICTS, VERIFICATION_STATUSES } from '../domain/review.ts';
import type { WorkReport } from '../domain/checkpoint.ts';

/**
 * Limits on what a structured agent result may put into the durable database, approved by the
 * maintainer. Results beyond them are rejected, never truncated, and the cycle
 * blocks; the raw output stays in the bounded cache for inspection.
 */
export const RESULT_LIMITS = {
  summary: 2000,
  findings: 20,
  title: 200,
  detail: 2000,
  suggestedAction: 1000,
  evidence: 5,
  path: 512,
  message: 300,
  commands: 20,
  command: 500,
  commandSummary: 500,
} as const;

const L = RESULT_LIMITS;
const perEvidence = L.path + L.message + 20;
const perFinding = L.title + L.detail + L.suggestedAction + L.evidence * perEvidence + 100;
const perCommand = L.command + L.commandSummary + 20;
/**
 * The raw result budget comes from the bounded stage fields, JSON syntax, and up to four UTF-8
 * bytes per character. Manual deliverable content shares this budget; larger results are rejected.
 */
export const MAX_RESULT_BYTES =
  4 * (L.summary + Math.max(L.findings * perFinding, L.commands * perCommand) + 1000);

/*
 * The schemas sent to agents use only the subset of JSON Schema that strict structured-output
 * modes accept (types, enums, all properties required, no additional properties, null via a
 * union). Length and integer checks are applied by Orvia after parsing instead of being sent.
 */
const evidenceShape = z.strictObject({
  path: z.string(),
  line: z.number().nullable(),
  message: z.string(),
});

const findingShape = z.strictObject({
  category: z.enum(FINDING_CATEGORIES),
  title: z.string(),
  detail: z.string(),
  evidence: z.array(evidenceShape),
  suggestedAction: z.string().nullable(),
});

export const reviewResultShape = z.strictObject({
  verdict: z.enum(REVIEW_VERDICTS),
  summary: z.string(),
  findings: z.array(findingShape),
});

export const verificationResultShape = z.strictObject({
  status: z.enum(VERIFICATION_STATUSES),
  summary: z.string(),
  commands: z.array(
    z.strictObject({ command: z.string(), exitCode: z.number().nullable(), summary: z.string() }),
  ),
});

export const implementationResultShape = z.strictObject({
  status: z.enum(['completed', 'needs_input']),
  summary: z.string(),
});

export const fixResultShape = z.strictObject({
  status: z.enum(['fixed', 'disputed', 'needs_input']),
  summary: z.string(),
  disputedFindingIds: z.array(z.string()),
});

export type ReviewResult = z.output<typeof reviewResultShape>;
export type VerificationResult = z.output<typeof verificationResultShape>;
export type ImplementationResult = z.output<typeof implementationResultShape>;
export type FixResult = z.output<typeof fixResultShape>;

export const workReportShape = z.strictObject({
  status: z.enum(['completed', 'needs_input']),
  summary: z.string(),
  content: z.string().nullable(),
  commands: z.array(
    z.strictObject({ command: z.string(), exitCode: z.number().nullable(), summary: z.string() }),
  ),
  unresolved: z.string(),
  requiredDecision: z.string(),
});

export type ResultPurpose = 'manual' | 'implementation' | 'verification' | 'review' | 'fix';

const SHAPES = {
  manual: workReportShape,
  implementation: implementationResultShape,
  verification: verificationResultShape,
  review: reviewResultShape,
  fix: fixResultShape,
} as const;

export function parseWorkReport(raw: string | null): WorkReport {
  const result = parseShape(workReportShape.partial({ content: true }), raw);
  const problems: string[] = [];
  checkLength(problems, 'summary', result.summary, L.summary);
  checkLength(problems, 'unresolved', result.unresolved, L.detail);
  checkLength(problems, 'requiredDecision', result.requiredDecision, L.suggestedAction);
  checkCount(problems, 'commands', result.commands.length, L.commands);
  result.commands.forEach((command, i) => {
    checkLength(problems, `commands.${i}.command`, command.command, L.command);
    checkLength(problems, `commands.${i}.summary`, command.summary, L.commandSummary);
    if (command.exitCode !== null && !Number.isSafeInteger(command.exitCode)) {
      problems.push(`commands.${i}.exitCode is not an integer`);
    }
  });
  return finish(result, problems);
}

export function resultJsonSchema(purpose: ResultPurpose): Record<string, unknown> {
  const schema = z.toJSONSchema(SHAPES[purpose]) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
}

/** A structured result that Orvia refused. Carries no text from the result itself. */
export class ResultProtocolError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`agent result rejected: ${problems.join('; ')}`);
    this.name = 'ResultProtocolError';
    this.problems = problems;
  }
}

function checkLength(problems: string[], label: string, value: string, max: number): void {
  if (value.length > max) problems.push(`${label} exceeds ${max} characters`);
}

function checkCount(problems: string[], label: string, count: number, max: number): void {
  if (count > max) problems.push(`${label} has more than ${max} items`);
}

function parseShape<S extends z.ZodType>(shape: S, raw: string | null): z.output<S> {
  if (raw === null) throw new ResultProtocolError(['no structured result was produced']);
  if (Buffer.byteLength(raw) > MAX_RESULT_BYTES) {
    throw new ResultProtocolError([`result exceeds ${MAX_RESULT_BYTES} bytes`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ResultProtocolError(['result is not valid JSON']);
  }
  const parsed = shape.safeParse(json);
  if (!parsed.success) {
    throw new ResultProtocolError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function finish<T>(value: T, problems: string[]): T {
  if (problems.length > 0) throw new ResultProtocolError(problems);
  return value;
}

export function parseReviewResult(raw: string | null): ReviewResult {
  const result = parseShape(reviewResultShape, raw);
  const problems: string[] = [];
  checkLength(problems, 'summary', result.summary, L.summary);
  checkCount(problems, 'findings', result.findings.length, L.findings);
  result.findings.forEach((finding, i) => {
    checkLength(problems, `findings.${i}.title`, finding.title, L.title);
    checkLength(problems, `findings.${i}.detail`, finding.detail, L.detail);
    if (finding.title.trim() === '') problems.push(`findings.${i}.title is empty`);
    if (finding.suggestedAction !== null) {
      checkLength(
        problems,
        `findings.${i}.suggestedAction`,
        finding.suggestedAction,
        L.suggestedAction,
      );
    }
    checkCount(problems, `findings.${i}.evidence`, finding.evidence.length, L.evidence);
    finding.evidence.forEach((item, j) => {
      checkLength(problems, `findings.${i}.evidence.${j}.path`, item.path, L.path);
      checkLength(problems, `findings.${i}.evidence.${j}.message`, item.message, L.message);
      if (item.line !== null && (!Number.isSafeInteger(item.line) || item.line < 1)) {
        problems.push(`findings.${i}.evidence.${j}.line is not a positive integer`);
      }
    });
  });
  if (result.verdict === 'pass' && result.findings.length > 0) {
    problems.push('verdict is pass but findings are present');
  }
  if (result.verdict === 'findings' && result.findings.length === 0) {
    problems.push('verdict is findings but no findings are present');
  }
  return finish(result, problems);
}

export function parseVerificationResult(raw: string | null): VerificationResult {
  const result = parseShape(verificationResultShape, raw);
  const problems: string[] = [];
  checkLength(problems, 'summary', result.summary, L.summary);
  checkCount(problems, 'commands', result.commands.length, L.commands);
  result.commands.forEach((command, i) => {
    checkLength(problems, `commands.${i}.command`, command.command, L.command);
    checkLength(problems, `commands.${i}.summary`, command.summary, L.commandSummary);
    if (command.exitCode !== null && !Number.isSafeInteger(command.exitCode)) {
      problems.push(`commands.${i}.exitCode is not an integer`);
    }
  });
  // A pass must show its work: at least one command, every one of which exited 0.
  if (result.status === 'passed') {
    if (result.commands.length === 0) problems.push('status is passed but no command was run');
    if (result.commands.some((command) => command.exitCode !== 0)) {
      problems.push('status is passed but a command did not exit with 0');
    }
  }
  if (result.status === 'failed' && !result.commands.some((command) => command.exitCode !== 0)) {
    problems.push('status is failed but no command failed');
  }
  return finish(result, problems);
}

export function parseImplementationResult(raw: string | null): ImplementationResult {
  const result = parseShape(implementationResultShape, raw);
  const problems: string[] = [];
  checkLength(problems, 'summary', result.summary, L.summary);
  return finish(result, problems);
}

export function parseFixResult(raw: string | null, knownFindingIds: readonly string[]): FixResult {
  const result = parseShape(fixResultShape, raw);
  const problems: string[] = [];
  checkLength(problems, 'summary', result.summary, L.summary);
  checkCount(problems, 'disputedFindingIds', result.disputedFindingIds.length, L.findings);
  for (const id of result.disputedFindingIds) {
    if (!knownFindingIds.includes(id))
      problems.push(`disputed finding ${id.slice(0, 20)} was not given to the fix`);
  }
  if (result.status === 'disputed' && result.disputedFindingIds.length === 0) {
    problems.push('status is disputed but no finding is named');
  }
  return finish(result, problems);
}
