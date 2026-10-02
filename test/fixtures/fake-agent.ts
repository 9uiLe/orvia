// A stand-in for a coding agent. Usage: node fake-agent.ts <mode>
//   echo                  print cwd and the prompt from stdin, exit 0
//   bytes:<n>             print n bytes, exit 0
//   fail                  exit 3
//   wait:<file>           print "waiting", then exit 0 once <file> exists (or when terminated)
//   tree:<file>           start a child that starts a grandchild, all sharing stdout; every
//                         process appends its pid to <file> and keeps running
//   stubborn-tree:<file>  like tree, but every process ignores SIGTERM
//   leave-child:<file>    start a child that keeps running, then exit 0
//   step:<file>           follow a scripted step (see FakeStep in test/helpers/app.ts)
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** Source of a `node -e` process that records its pid, optionally starts `child`, and idles. */
function generation(file: string, ignoreTerm: boolean, child: string | null): string {
  return [
    ignoreTerm ? "process.on('SIGTERM', () => {});" : '',
    `require('node:fs').appendFileSync(${JSON.stringify(file)}, process.pid + '\\n');`,
    child === null
      ? ''
      : `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' });`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

function pidCount(file: string): number {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0;
}

const mode = process.argv[2] ?? 'echo';
const [kind = mode, file = ''] = mode.split(/:(.*)/s);
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += String(chunk);

if (kind === 'echo') {
  process.stdout.write(JSON.stringify({ cwd: process.cwd(), prompt: stdin }));
} else if (kind === 'bytes') {
  process.stdout.write('x'.repeat(Number(file)));
} else if (kind === 'fail') {
  process.exitCode = 3;
} else if (kind === 'wait') {
  process.stdout.write('waiting\n');
  while (!existsSync(file)) await sleep(10);
} else if (kind === 'tree' || kind === 'stubborn-tree') {
  const stubborn = kind === 'stubborn-tree';
  if (stubborn) process.on('SIGTERM', () => undefined);
  appendFileSync(file, `${String(process.pid)}\n`);
  const grandchild = generation(file, stubborn, null);
  spawn(process.execPath, ['-e', generation(file, stubborn, grandchild)], { stdio: 'inherit' });
  setInterval(() => undefined, 1000);
} else if (kind === 'step') {
  const step = JSON.parse(readFileSync(file, 'utf8')) as {
    result?: unknown;
    stdout?: string;
    exitCode?: number;
    waitFor?: string;
    holdFor?: string;
  };
  if (step.waitFor !== undefined) while (!existsSync(step.waitFor)) await sleep(10);
  process.stdout.write(
    step.stdout ?? (step.result === undefined ? '' : JSON.stringify(step.result)),
  );
  if (step.holdFor !== undefined) while (!existsSync(step.holdFor)) await sleep(10);
  process.exitCode = step.exitCode ?? 0;
} else if (kind === 'leave-child') {
  // unref() lets this process exit while the child keeps running.
  spawn(process.execPath, ['-e', generation(file, false, null)], { stdio: 'inherit' }).unref();
  while (pidCount(file) < 1) await sleep(10);
}
