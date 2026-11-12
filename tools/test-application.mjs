import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The runner counts every test() call in the discovered files. A silent
// discovery change (an emptied, renamed or deleted file) must fail the gate, so
// both the file count and the test count are asserted. Update both constants in
// the same change that adds or removes a test.
//
// This public repository only carries tests that run on the synthetic demo
// dataset; checks bound to a licensed data snapshot live in the private
// workspace. Grow this suite by adding demo-compatible tests, never by
// weakening an assertion.
const EXPECTED_TEST_FILES = 3;
const EXPECTED_TESTS = 16;

const directory = new URL('../packages/application/test/', import.meta.url);
const tests = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort();
if (tests.length !== EXPECTED_TEST_FILES) {
  throw new Error(`Discovered ${tests.length} application test files, expected ${EXPECTED_TEST_FILES}. ` +
    'Update EXPECTED_TEST_FILES in tools/test-application.mjs when adding or removing a test file.');
}

function summaryOf(tap) {
  const summary = {};
  for (const line of tap.split(/\r?\n/)) {
    const match = /^# (tests|pass|fail) (\d+)$/.exec(line);
    if (match) summary[match[1]] = Number(match[2]);
  }
  return ['tests', 'pass', 'fail'].every(key => Number.isSafeInteger(summary[key])) ? summary : null;
}

const temporary = mkdtempSync(join(tmpdir(), 'noritsubushi-application-test-'));
const tapFile = join(temporary, 'tap.txt');
try {
  // The TAP stream is written to a file rather than captured through a pipe:
  // the spec reporter keeps the readable output on stdout, and the summary can
  // be checked even where child process pipes are unavailable. Keep Node's
  // default per-file isolation: contract tests must not share module state just
  // because a restricted sandbox cannot spawn the runner.
  const result = spawnSync(process.execPath, ['--test',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
    ...tests.map(name => fileURLToPath(new URL(name, directory)))], { stdio: 'inherit' });
  if (result.error) throw result.error;
  let tap = '';
  try { tap = readFileSync(tapFile, 'utf8'); } catch { /* reported below as a missing summary */ }
  const summary = summaryOf(tap);
  const problems = [];
  if (!summary) {
    problems.push(`Could not read a TAP summary (tests/pass/fail) from ${tapFile}.`);
  } else {
    if (summary.tests !== EXPECTED_TESTS) {
      problems.push(`TAP reported ${summary.tests} tests, expected ${EXPECTED_TESTS}. ` +
        'Update EXPECTED_TESTS in tools/test-application.mjs when adding or removing a test.');
    }
    if (summary.pass !== summary.tests) problems.push(`TAP reported pass=${summary.pass} for tests=${summary.tests}; all discovered tests must pass.`);
    if (summary.fail !== 0) problems.push(`TAP reported fail=${summary.fail}; expected 0.`);
  }
  if (result.signal) problems.push(`node --test was terminated by ${result.signal}.`);
  else if (result.status !== 0) problems.push(`node --test exited with code ${result.status}.`);
  for (const problem of problems) console.error(`application test gate: ${problem}`);
  if (problems.length) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}