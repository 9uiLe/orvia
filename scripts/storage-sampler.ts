import { spawn } from 'node:child_process';

/** SQLite blocks the benchmark's event loop, so sample storage from a separate process. */
export async function startStorageSampler(databaseFile: string) {
  const source = `
    const { statSync } = require('node:fs');
    const files = ['', '-wal', '-shm', '-journal'].map((s) => ${JSON.stringify(databaseFile)} + s);
    const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
    const peak = { main: 0, wal: 0, shm: 0, journal: 0, total: 0, samples: 0 };
    const sample = () => {
      const [main, wal, shm, journal] = files.map(size);
      peak.main = Math.max(peak.main, main); peak.wal = Math.max(peak.wal, wal);
      peak.shm = Math.max(peak.shm, shm); peak.journal = Math.max(peak.journal, journal);
      peak.total = Math.max(peak.total, main + wal + shm + journal); peak.samples++;
    };
    const timer = setInterval(sample, 1);
    process.once('SIGTERM', () => {
      clearInterval(timer);
      sample();
      process.stdout.end(JSON.stringify(peak));
    });
    sample();
    process.stdout.write('ready\\n');`;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = Promise.withResolvers<undefined>();
  let output = '';
  let spawnError: Error | null = null;
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.startsWith('ready\n')) ready.resolve(undefined);
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const failure = (exit: { code: number | null; signal: string | null }): Error =>
    spawnError ?? new Error(`storage sampler exited with code ${exit.code}, signal ${exit.signal}`);
  await Promise.race([
    ready.promise,
    closed.then((exit) => {
      throw failure(exit);
    }),
  ]);
  let stopped: Promise<Record<string, number>> | null = null;
  return {
    stop: () =>
      (stopped ??= (async () => {
        child.kill('SIGTERM');
        const exit = await closed;
        if (exit.code !== 0) throw failure(exit);
        return JSON.parse(output.slice('ready\n'.length)) as Record<string, number>;
      })()),
  };
}
