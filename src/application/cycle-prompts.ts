import type { Cycle } from '../domain/cycle.ts';
import { AUTO_FIX_CATEGORIES, HUMAN_CATEGORIES, type Finding } from '../domain/review.ts';
import { RESULT_LIMITS, type VerificationResult } from './agent-results.ts';

const L = RESULT_LIMITS;

const RESULT_RULE =
  'End with the JSON result described by the output schema. Put no source code, diffs, or logs ' +
  'into it; refer to files by path and line instead.';

const HUMAN_DECISIONS =
  'design or architecture changes, scope or acceptance-criteria changes, public API changes, ' +
  'database schema or persistence changes, security or permission decisions, new or major ' +
  'dependency changes, and anything that contradicts an accepted decision';

export function implementationInstructions(cycle: Cycle): string {
  return [
    'Role: implementation agent.',
    `Implement the following:\n\n${cycle.instructions}`,
    `Do not decide on your own anything a human must decide: ${HUMAN_DECISIONS}. If the work ` +
      'needs such a decision, or the requirements are ambiguous, stop and report status ' +
      '`needs_input` with what has to be decided in the summary.',
    `Otherwise report status \`completed\` with a summary of what you changed (at most ${L.summary} characters). ${RESULT_RULE}`,
  ].join('\n\n');
}

export function verificationInstructions(): string {
  return [
    'Role: verification. Do not change source files.',
    'Work out how this repository checks changes from its own files (package scripts, Makefile, README, AGENTS.md, CLAUDE.md, CI configuration) and run the relevant checks: build or typecheck, lint, and tests.',
    `Report every command you ran with its exit code and a one-line summary (at most ${L.commands} commands, ${L.command} characters per command, ${L.commandSummary} per summary).`,
    'Status `passed` only if you ran at least one command and every command exited with 0. Status ' +
      '`failed` if a check failed. Status `blocked` if the checks cannot run here: no way to find ' +
      'them, missing tools, credentials, services, or network. Never report `passed` for checks ' +
      `you did not run. ${RESULT_RULE}`,
  ].join('\n\n');
}

export function reviewInstructions(cycle: Cycle): string {
  return [
    'Role: independent reviewer. Do not modify any file.',
    'Do not rely on what the implementation agent reported. Examine the current state yourself: ' +
      'the worktree, the changes on this branch (git status, git diff against the base), the tests, ' +
      'and the decisions and context above.',
    `The work being reviewed:\n\n${cycle.instructions}`,
    `Report each problem as a finding with one category. Routine fixes: ${AUTO_FIX_CATEGORIES.join(', ')}. ` +
      `Questions for a human: ${HUMAN_CATEGORIES.join(', ')}. Use \`decision_mismatch\` or ` +
      '`acceptance_mismatch` only when the code clearly differs from an accepted decision or ' +
      'acceptance criterion; use `decision_conflict` when a decision itself is in question, and ' +
      '`unknown` when you cannot tell.',
    'Give evidence for every finding: a file path, a line where possible, and a short message.',
    'Verdict `pass` only with no findings, `findings` with at least one, `needs_human` when you ' +
      'cannot judge the change.',
    `Limits: at most ${L.findings} findings; title ${L.title} characters, detail ${L.detail}, ` +
      `suggestedAction ${L.suggestedAction}, at most ${L.evidence} evidence items per finding ` +
      `(path ${L.path}, message ${L.message}), summary ${L.summary}. ${RESULT_RULE}`,
  ].join('\n\n');
}

export function fixInstructions(
  source:
    | { readonly kind: 'review'; readonly reviewId: string; readonly findings: readonly Finding[] }
    | { readonly kind: 'verification'; readonly result: VerificationResult },
): string {
  const work =
    source.kind === 'review'
      ? `Fix these findings from review ${source.reviewId} and nothing else:\n\n` +
        JSON.stringify(
          source.findings.map((finding) => ({
            id: finding.id,
            category: finding.category,
            title: finding.title,
            detail: finding.detail,
            evidence: finding.evidence,
            suggestedAction: finding.suggestedAction,
          })),
          null,
          2,
        )
      : 'Fix the failing checks below and nothing else:\n\n' +
        JSON.stringify(
          source.result.commands.filter((command) => command.exitCode !== 0),
          null,
          2,
        );
  const escalation =
    source.kind === 'review'
      ? 'Change only what these require. If you think a finding is wrong, or fixing it needs a ' +
        `decision only a human can make (${HUMAN_DECISIONS}), do not work around it: report status ` +
        '`disputed` and list its id in disputedFindingIds, or `needs_input` if information is missing.'
      : 'Change only what these require. If a check cannot be fixed without a decision only a ' +
        `human can make (${HUMAN_DECISIONS}) or without missing information, do not work around ` +
        'it: report status `needs_input` and explain in the summary.';
  return [
    'Role: fix agent.',
    work,
    escalation,
    `Otherwise report status \`fixed\` with an empty disputedFindingIds and a summary (at most ${L.summary} characters). ${RESULT_RULE}`,
  ].join('\n\n');
}
