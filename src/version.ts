import { readFileSync } from 'node:fs';

// Resolved at runtime because package.json sits outside the compiled rootDir; this file is one
// level below the package root both in src/ and in dist/.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const ORVIA_VERSION: string = manifest.version;
