import { readFileSync } from 'node:fs';

// Resolved at runtime because package.json sits outside the compiled rootDir; this file is one
// level below the package root both in src/ and in dist/.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  engines: { node: string };
};

export const ORVIA_VERSION: string = manifest.version;

function parseMinimumNode(range: string): readonly [number, number, number] {
  // Only ">=X.Y.Z" is understood. Anything else throws so a
  // changed engines field cannot silently disable the doctor's Node check.
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (match === null) {
    throw new Error(`package.json engines.node must have the form ">=X.Y.Z", got "${range}"`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export const MINIMUM_NODE_VERSION: readonly [number, number, number] = parseMinimumNode(
  manifest.engines.node,
);
