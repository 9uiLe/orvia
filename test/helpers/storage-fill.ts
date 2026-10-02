import assert from 'node:assert/strict';
import type { Application } from '../../src/application/application.ts';
import { call } from './app.ts';

const KIB = 1024;

/** Adds notes of `size` bytes to Plan P-1 until a write is refused; returns how many succeeded. */
export async function fillUntilRefused(app: Application, size: number): Promise<number> {
  let written = 0;
  for (let i = 0; i < 5000; i++) {
    try {
      await call(app, 'add_context', { planId: 'P-1', body: 'x'.repeat(size) });
      written++;
    } catch (error) {
      assert.equal((error as { code: string }).code, 'STORAGE_HARD_LIMIT');
      return written;
    }
  }
  throw new Error('writes were never refused');
}

/** Fills durable data with ever smaller notes, so the data reaches the write capacity. */
export async function fillDurableData(app: Application): Promise<void> {
  for (const size of [64 * KIB, 4 * KIB, 100]) await fillUntilRefused(app, size);
}
