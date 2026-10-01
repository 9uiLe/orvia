import { spawn } from 'node:child_process';

export interface StoragePeak {
  readonly total: number;
  readonly journal: number;
  readonly wal: number;
  readonly samples: number;
}

/**
 * Records the largest combined size of the database files and the backup directory, polling
 * from a separate process because SQLite calls block the test's event loop. Polling can miss a
 * peak shorter than its interval, so it can show that a bound was exceeded, never prove it holds;
 * the tests pair it with checks of the mechanism itself.
 */
export async function startStorageSampler(databaseFile: string, backupDir: string) {
  const source = `
    const { readdirSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
    const backups = (d) => { try { return readdirSync(d).reduce((s, n) => s + size(join(d, n)), 0); } catch { return 0; } };
    const db = ${JSON.stringify(databaseFile)};
    const peak = { total: 0, journal: 0, wal: 0, samples: 0 };
    const sample = () => {
      const main = size(db), wal = size(db + '-wal'), shm = size(db + '-shm'), journal = size(db + '-journal');
      const total = main + wal + shm + journal + backups(${JSON.stringify(backupDir)});
      peak.total = Math.max(peak.total, total); peak.journal = Math.max(peak.journal, journal);
      peak.wal = Math.max(peak.wal, wal); peak.samples++;
    };
    sample();
    process.stdout.write('ready\\n');
    setInterval(sample, 1);
    process.on('SIGTERM', () => { sample(); process.stdout.write(JSON.stringify(peak)); process.exit(0); });`;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await new Promise<void>((resolve) => {
    const check = () => {
      if (output.includes('ready\n')) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
  return {
    stop: () =>
      new Promise<StoragePeak>((resolve) => {
        child.once('exit', () => {
          resolve(JSON.parse(output.slice(output.indexOf('\n') + 1)) as StoragePeak);
        });
        child.kill('SIGTERM');
      }),
  };
}
