// A stand-in for a coding agent. Usage: node fake-agent.ts <mode>
//   echo          print cwd and the prompt from stdin, exit 0
//   bytes:<n>     print n bytes, exit 0
//   fail          exit 3
//   wait:<file>   print "waiting", then exit 0 once <file> exists (or when terminated)
import { existsSync } from 'node:fs';

const mode = process.argv[2] ?? 'echo';
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += String(chunk);

if (mode === 'echo') {
  process.stdout.write(JSON.stringify({ cwd: process.cwd(), prompt: stdin }));
} else if (mode.startsWith('bytes:')) {
  process.stdout.write('x'.repeat(Number(mode.slice(6))));
} else if (mode === 'fail') {
  process.exitCode = 3;
} else if (mode.startsWith('wait:')) {
  const file = mode.slice(5);
  process.stdout.write('waiting\n');
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(file)) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
}
