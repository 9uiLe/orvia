import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parseFixResult,
  parseImplementationResult,
  parseReviewResult,
  parseVerificationResult,
  RESULT_LIMITS,
  resultJsonSchema,
  ResultProtocolError,
} from '../../src/application/agent-results.ts';
import {
  assertTransition,
  canTransition,
  CYCLE_STATES,
  firstStage,
  resumeStageAfterEscalation,
  resumeTarget,
  type CycleState,
} from '../../src/domain/cycle.ts';
import {
  AGENT_CAPABILITIES,
  effectiveCapabilities,
  missingCapabilities,
  requiredCapabilitiesFor,
} from '../../src/domain/agent-profile.ts';
import { OrviaError } from '../../src/domain/errors.ts';
import {
  AUTO_FIX_CATEGORIES,
  classifyFinding,
  HUMAN_CATEGORIES,
  nextAfterReview,
  nextAfterVerification,
} from '../../src/domain/review.ts';
import { claudeAdapter, codexAdapter } from '../../src/infrastructure/agents/adapters.ts';

const ALLOWED: Record<CycleState, CycleState[]> = {
  IMPLEMENTING: ['VERIFYING', 'NEEDS_HUMAN', 'PAUSED', 'BLOCKED', 'CANCELLED', 'FAILED'],
  VERIFYING: ['REVIEWING', 'FIXING', 'NEEDS_HUMAN', 'PAUSED', 'BLOCKED', 'CANCELLED', 'FAILED'],
  REVIEWING: [
    'FIXING',
    'NEEDS_HUMAN',
    'HUMAN_REVIEW_READY',
    'PAUSED',
    'BLOCKED',
    'CANCELLED',
    'FAILED',
  ],
  FIXING: ['VERIFYING', 'NEEDS_HUMAN', 'PAUSED', 'BLOCKED', 'CANCELLED', 'FAILED'],
  NEEDS_HUMAN: ['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'CANCELLED', 'FAILED'],
  PAUSED: ['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING', 'CANCELLED', 'FAILED'],
  BLOCKED: ['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING', 'CANCELLED', 'FAILED'],
  HUMAN_REVIEW_READY: [],
  FAILED: [],
  CANCELLED: [],
};

describe('cycle state machine', () => {
  for (const from of CYCLE_STATES) {
    test(`${from} allows exactly ${ALLOWED[from].join(', ') || 'nothing'}`, () => {
      for (const to of CYCLE_STATES) {
        assert.equal(canTransition(from, to), ALLOWED[from].includes(to), `${from} -> ${to}`);
      }
    });
  }

  test('an illegal transition is refused with INVALID_STATE_TRANSITION', () => {
    assert.throws(
      () => {
        assertTransition({ id: 'C-1', state: 'NEEDS_HUMAN' }, 'HUMAN_REVIEW_READY');
      },
      (error: unknown) => error instanceof OrviaError && error.code === 'INVALID_STATE_TRANSITION',
    );
    assert.throws(() => {
      assertTransition({ id: 'C-1', state: 'HUMAN_REVIEW_READY' }, 'REVIEWING');
    });
  });

  test('both modes verify before any review', () => {
    assert.equal(firstStage('implement'), 'IMPLEMENTING');
    assert.equal(firstStage('review_existing'), 'VERIFYING');
  });

  test('after an escalation, possibly changed code is verified again before review', () => {
    assert.equal(resumeStageAfterEscalation('IMPLEMENTING'), 'IMPLEMENTING');
    assert.equal(resumeStageAfterEscalation('REVIEWING'), 'REVIEWING');
    assert.equal(resumeStageAfterEscalation('FIXING'), 'VERIFYING');
    assert.equal(resumeStageAfterEscalation('VERIFYING'), 'VERIFYING');
  });

  test('only waiting cycles with a resume stage can be resumed', () => {
    assert.equal(resumeTarget({ id: 'C-1', state: 'PAUSED', resumeStage: 'FIXING' }), 'FIXING');
    for (const state of ['REVIEWING', 'HUMAN_REVIEW_READY', 'CANCELLED'] as const) {
      assert.throws(() => resumeTarget({ id: 'C-1', state, resumeStage: null }));
    }
  });
});

describe('agent capabilities', () => {
  test('each stage requires a fixed set of capabilities', () => {
    assert.deepEqual(requiredCapabilitiesFor('IMPLEMENTING'), [
      'workspaceRead',
      'workspaceWrite',
      'structuredResult',
    ]);
    assert.deepEqual(requiredCapabilitiesFor('VERIFYING'), [
      'workspaceRead',
      'commandExecution',
      'structuredResult',
    ]);
    assert.deepEqual(requiredCapabilitiesFor('REVIEWING'), ['workspaceRead', 'structuredResult']);
    assert.deepEqual(requiredCapabilitiesFor('FIXING'), [
      'workspaceRead',
      'workspaceWrite',
      'structuredResult',
    ]);
  });

  test('a profile narrows its adapter and cannot add to it', () => {
    const adapter = ['workspaceRead', 'workspaceWrite', 'structuredResult'] as const;
    assert.deepEqual(effectiveCapabilities(adapter, null), adapter);
    assert.deepEqual(effectiveCapabilities(adapter, ['workspaceRead', 'commandExecution']), [
      'workspaceRead',
    ]);
  });

  test('missing capabilities are those required but not available', () => {
    assert.deepEqual(
      missingCapabilities(requiredCapabilitiesFor('VERIFYING'), [
        'workspaceRead',
        'workspaceWrite',
      ]),
      ['commandExecution', 'structuredResult'],
    );
    assert.deepEqual(
      missingCapabilities(requiredCapabilitiesFor('REVIEWING'), [...AGENT_CAPABILITIES]),
      [],
    );
  });
});

describe('review policy', () => {
  const evidence = [{ path: 'src/a.ts', line: 3, message: 'here' }];

  test('routine categories with a file path are fixed automatically', () => {
    for (const category of AUTO_FIX_CATEGORIES) {
      assert.deepEqual(classifyFinding({ category, evidence }), {
        action: 'AUTO_FIX',
        reason: 'ROUTINE_FIX',
      });
    }
  });

  test('human categories, unknown, and findings without a path go to a human', () => {
    for (const category of HUMAN_CATEGORIES.filter((c) => c !== 'unknown')) {
      assert.deepEqual(classifyFinding({ category, evidence }), {
        action: 'NEEDS_HUMAN',
        reason: 'HUMAN_CATEGORY',
      });
    }
    assert.deepEqual(classifyFinding({ category: 'unknown', evidence }), {
      action: 'NEEDS_HUMAN',
      reason: 'UNKNOWN_CATEGORY',
    });
    assert.deepEqual(classifyFinding({ category: 'correctness', evidence: [] }), {
      action: 'NEEDS_HUMAN',
      reason: 'INSUFFICIENT_EVIDENCE',
    });
    assert.deepEqual(
      classifyFinding({ category: 'test', evidence: [{ path: ' ', line: null, message: 'm' }] }),
      { action: 'NEEDS_HUMAN', reason: 'INSUFFICIENT_EVIDENCE' },
    );
  });

  const fresh = { autoFixRounds: 0, maxAutoFixRounds: 3 };
  const spent = { autoFixRounds: 3, maxAutoFixRounds: 3 };

  test('a review decides between ready, fix, human, and the loop limit', () => {
    assert.deepEqual(nextAfterReview({ verdict: 'pass', actions: [] }, fresh), {
      state: 'HUMAN_REVIEW_READY',
    });
    assert.deepEqual(nextAfterReview({ verdict: 'findings', actions: ['AUTO_FIX'] }, fresh), {
      state: 'FIXING',
    });
    assert.deepEqual(
      nextAfterReview({ verdict: 'findings', actions: ['AUTO_FIX', 'NEEDS_HUMAN'] }, fresh),
      { state: 'NEEDS_HUMAN', reason: 'DECISION_REQUIRED' },
    );
    assert.deepEqual(nextAfterReview({ verdict: 'needs_human', actions: [] }, fresh), {
      state: 'NEEDS_HUMAN',
      reason: 'REVIEWER_REQUESTED_HUMAN',
    });
    assert.deepEqual(nextAfterReview({ verdict: 'findings', actions: ['AUTO_FIX'] }, spent), {
      state: 'NEEDS_HUMAN',
      reason: 'LOOP_LIMIT',
    });
  });

  test('a verification decides between review, fix, blocked, and the loop limit', () => {
    assert.deepEqual(nextAfterVerification('passed', spent), { state: 'REVIEWING' });
    assert.deepEqual(nextAfterVerification('failed', fresh), { state: 'FIXING' });
    assert.deepEqual(nextAfterVerification('failed', spent), {
      state: 'NEEDS_HUMAN',
      reason: 'LOOP_LIMIT',
    });
    assert.deepEqual(nextAfterVerification('blocked', fresh), {
      state: 'BLOCKED',
      reason: 'VERIFICATION_BLOCKED',
    });
  });
});

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'correctness',
    title: 'Off by one',
    detail: 'The loop skips the last item.',
    evidence: [{ path: 'src/a.ts', line: 10, message: 'loop bound' }],
    suggestedAction: null,
    ...overrides,
  };
}

function rejects(parse: () => unknown, problem: RegExp): void {
  assert.throws(parse, (error: unknown) => {
    assert.ok(error instanceof ResultProtocolError, String(error));
    assert.ok(
      error.problems.some((p) => problem.test(p)),
      `no problem matches ${String(problem)}: ${error.problems.join('; ')}`,
    );
    return true;
  });
}

describe('structured agent results', () => {
  const review = (body: Record<string, unknown>) =>
    JSON.stringify({ verdict: 'findings', summary: 's', findings: [finding()], ...body });

  test('a well-formed review is accepted', () => {
    const result = parseReviewResult(review({}));
    assert.equal(result.findings.length, 1);
    assert.deepEqual(parseReviewResult(review({ verdict: 'pass', findings: [] })).findings, []);
  });

  test('missing, non-JSON, and wrongly shaped results are rejected', () => {
    rejects(() => parseReviewResult(null), /no structured result/);
    rejects(() => parseReviewResult('The code looks fine to me.'), /not valid JSON/);
    rejects(() => parseReviewResult(JSON.stringify({ verdict: 'pass', findings: [] })), /summary/);
    rejects(() => parseReviewResult(review({ extra: 1 })), /extra|Unrecognized/i);
    rejects(
      () => parseReviewResult(review({ findings: [finding({ category: 'style-nit' })] })),
      /category/,
    );
  });

  test('fields over their limit are rejected, not truncated', () => {
    rejects(
      () =>
        parseReviewResult(
          review({ findings: [finding({ title: 'x'.repeat(RESULT_LIMITS.title + 1) })] }),
        ),
      /title exceeds/,
    );
    rejects(
      () =>
        parseReviewResult(
          review({ findings: Array.from({ length: RESULT_LIMITS.findings + 1 }, () => finding()) }),
        ),
      /findings has more than/,
    );
    rejects(
      () =>
        parseReviewResult(
          review({
            findings: [
              finding({
                evidence: Array.from({ length: RESULT_LIMITS.evidence + 1 }, () => ({
                  path: 'a',
                  line: 1,
                  message: 'm',
                })),
              }),
            ],
          }),
        ),
      /evidence has more than/,
    );
    rejects(() => parseReviewResult('x'.repeat(700_000)), /exceeds .* bytes/);
  });

  test('the verdict must agree with the findings, and lines are positive integers', () => {
    rejects(() => parseReviewResult(review({ verdict: 'pass' })), /pass but findings/);
    rejects(() => parseReviewResult(review({ findings: [] })), /findings but no findings/);
    rejects(
      () =>
        parseReviewResult(
          review({ findings: [finding({ evidence: [{ path: 'a', line: 1.5, message: 'm' }] })] }),
        ),
      /line is not a positive integer/,
    );
  });

  test('a verification pass must show commands that all exited with 0', () => {
    const command = (exitCode: number | null) => ({ command: 'npm test', exitCode, summary: 's' });
    const verification = (status: string, commands: unknown[]) =>
      JSON.stringify({ status, summary: 's', commands });
    assert.equal(parseVerificationResult(verification('passed', [command(0)])).status, 'passed');
    rejects(() => parseVerificationResult(verification('passed', [])), /no command was run/);
    rejects(
      () => parseVerificationResult(verification('passed', [command(0), command(1)])),
      /did not exit with 0/,
    );
    rejects(
      () => parseVerificationResult(verification('failed', [command(0)])),
      /no command failed/,
    );
    assert.equal(parseVerificationResult(verification('blocked', [])).status, 'blocked');
  });

  test('a fix may only dispute findings it was given', () => {
    const fix = (status: string, ids: string[]) =>
      JSON.stringify({ status, summary: 's', disputedFindingIds: ids });
    assert.equal(parseFixResult(fix('fixed', []), ['F-1']).status, 'fixed');
    assert.equal(parseFixResult(fix('disputed', ['F-1']), ['F-1']).status, 'disputed');
    rejects(() => parseFixResult(fix('disputed', []), ['F-1']), /no finding is named/);
    rejects(() => parseFixResult(fix('disputed', ['F-9']), ['F-1']), /was not given/);
    assert.equal(
      parseImplementationResult(JSON.stringify({ status: 'needs_input', summary: 's' })).status,
      'needs_input',
    );
  });

  test('the schema sent to agents uses only the strict structured-output subset', () => {
    for (const purpose of ['implementation', 'verification', 'review', 'fix'] as const) {
      const text = JSON.stringify(resultJsonSchema(purpose));
      assert.ok(!text.includes('$schema'), purpose);
      for (const keyword of ['maxLength', 'maxItems', 'minimum', 'pattern', 'format']) {
        assert.ok(!text.includes(`"${keyword}"`), `${purpose} uses ${keyword}`);
      }
      assert.ok(text.includes('"additionalProperties":false'), purpose);
    }
  });
});

describe('agent adapters for cycle stages', () => {
  const policy = { workingDirectory: '/wt/a', writableRoots: ['/wt/a', '/r/.git'] };
  const schema = resultJsonSchema('review');
  const result = { schema, schemaPath: '/cache/runs/x.schema.json' };

  const review = ['workspaceRead', 'structuredResult'] as const;
  const verify = ['workspaceRead', 'commandExecution', 'structuredResult'] as const;

  test('codex reviews in a read-only sandbox and writes the result to stdout', () => {
    const invocation = codexAdapter.buildInvocation('codex', {
      policy,
      prompt: 'p',
      capabilities: review,
      result,
    });
    assert.deepEqual(invocation.args, [
      'exec',
      '--sandbox',
      'read-only',
      '--cd',
      '/wt/a',
      '--output-schema',
      '/cache/runs/x.schema.json',
      '-',
    ]);
    assert.equal(codexAdapter.extractResult(' {"a":1}\n'), '{"a":1}');
    assert.equal(codexAdapter.extractResult('  \n'), null);
    assert.equal(codexAdapter.resultStdoutBytes(100), 100);
  });

  test('codex runs checks in the workspace-write sandbox', () => {
    const invocation = codexAdapter.buildInvocation('codex', {
      policy,
      prompt: 'p',
      capabilities: verify,
      result,
    });
    assert.deepEqual(invocation.args.slice(0, 3), ['exec', '--sandbox', 'workspace-write']);
  });

  test('claude reviews with read-only tools and reads structured_output from the envelope', () => {
    const adapter = claudeAdapter;
    const reviewing = adapter.buildInvocation('/opt/claude', {
      policy,
      prompt: 'p',
      capabilities: review,
      result,
    });
    assert.equal(reviewing.command, '/opt/claude');
    assert.deepEqual(reviewing.args, [
      '--print',
      '--tools',
      'Read,Grep,Glob',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
    ]);
    const edit = adapter.buildInvocation('claude', {
      policy,
      prompt: 'p',
      capabilities: ['workspaceRead', 'workspaceWrite'],
      result: null,
    });
    assert.ok(edit.args.includes('acceptEdits'));
    assert.ok(!edit.args.includes('--allowedTools') && !edit.args.includes('Bash'));

    assert.equal(
      adapter.extractResult(JSON.stringify({ is_error: false, structured_output: { a: 1 } })),
      '{"a":1}',
    );
    assert.equal(
      adapter.extractResult(JSON.stringify({ is_error: true, structured_output: { a: 1 } })),
      null,
    );
    assert.equal(adapter.extractResult(JSON.stringify({ result: 'text only' })), null);
    assert.equal(adapter.extractResult('not json'), null);
  });
});
