// Offline Node adapter only. Browser callers use decodeApplicationEnvelope.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeApplicationEnvelope } from './development-input.mjs';
import { array, requireValue, sha256, text } from './validation.mjs';

async function loadVerified(directory) {
  const exporter = fileURLToPath(new URL('../../tools/export_application_input.py', import.meta.url));
  const { stdout } = await promisify(execFile)('python', ['-B', '-X', 'utf8', exporter, '--input', directory],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return decodeApplicationEnvelope(stdout, await sha256(stdout));
}

export async function loadDevelopmentDirectory(directory) {
  return loadVerified(directory);
}

// Loads several verified development directories in the caller's order.
export async function loadDevelopmentDirectories(directories) {
  array(directories, 'directories', 1000);
  directories.forEach((directory, index) => text(directory, `directories[${index}]`));
  requireValue(directories.length > 0, 'E_FORMAT', 'directories', 'Expected at least one directory');
  const loaded = [];
  for (const directory of directories) loaded.push(await loadVerified(directory));
  return Object.freeze(loaded);
}
