// Disposable probes verify the real configured type and test discovery paths.
// Existing files are never edited. Every probe is removed in finally.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'apps/web');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function capture(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    const path = join(directory, entry.name);
    // Other acceptance probes may transiently create these directories inside
    // packages/application. They are not product sources, so excluding them
    // keeps this gate from reporting a false byte mismatch when run beside
    // another verifier; all real source files remain covered.
    if (entry.isDirectory() && (entry.name === '.verify-probe' || entry.name.startsWith('.test-'))) continue;
    if (entry.isDirectory()) Object.assign(result, await capture(path));
    else if (entry.isFile()) result[path] = hash(await readFile(path));
  }
  return result;
}
const original = { ...await capture(join(app, 'src')), ...await capture(join(app, 'test')),
  ...await capture(join(root, 'packages/application')) };
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run via npm run verify:gates so the selected npm CLI is explicit');
async function probe(relative, content, script, expectedDiagnostic) {
  const path = join(app, relative);
  // Exclusive creation protects an existing developer file with the same name.
  await writeFile(path, content, { flag: 'wx' });
  try {
    const result = spawnSync(process.execPath, [npmCli, 'run', script, '--workspace', '@noritsubushi/web'],
      { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    if (!result.status || !expectedDiagnostic.test(output)) {
      throw new Error(`Probe did not fail for its intended reason (${result.status}):\n${output}`);
    }
    console.log(`${script} negative probe: exit=${result.status}, intended diagnostic detected`);
    console.log(output);
  } finally {
    await unlink(path);
  }
}
try {
  await probe('src/__p4_type_probe.ts',
    "import { decodeApplicationEnvelope } from '@noritsubushi/application/development-input';\nvoid decodeApplicationEnvelope(42, 'invalid');\n",
    'typecheck', /__p4_type_probe\.ts.*TS2345/s);
  await probe('test/__p4_discovery_probe.test.ts',
    "import { expect, it } from 'vitest';\nit('P4 intentional discovery failure', () => { expect('discovered').toBe('must-fail'); });\n",
    'test', /P4 intentional discovery failure/);
} finally {
  const restored = { ...await capture(join(app, 'src')), ...await capture(join(app, 'test')),
    ...await capture(join(root, 'packages/application')) };
  if (JSON.stringify(original) !== JSON.stringify(restored)) throw new Error('Source bytes differ after probe cleanup');
  console.log('Probe cleanup: original source file set and SHA-256 values unchanged');
}
