/**
 * The harness claims to support TypeScript, Python, and Go. These fixtures make
 * that claim checkable rather than aspirational: each has a seeded bug and a
 * failing test, and the harness must detect the right test command and read the
 * suite's verdict correctly.
 *
 * Toolchain-dependent assertions skip when the toolchain is absent, so the
 * suite stays green on a machine without Go or pytest installed.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { detectTestCommand, failureLines, run, runTests } from '../src/runner.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Copies a fixture somewhere disposable so tests never mutate the originals. */
function stage(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sumo-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

async function available(command: string): Promise<boolean> {
  const probe = await run(command, tmpdir(), 10_000);
  return probe.ok;
}

test('the Python fixture is detected and its seeded bug is visible', async (t) => {
  const dir = stage('py-app');
  try {
    assert.equal(detectTestCommand(dir), 'python3 -m pytest -q');

    if (!(await available('python3 -m pytest --version'))) {
      t.skip('pytest not installed');
      return;
    }

    const outcome = await runTests('python3 -m pytest -q', dir);
    assert.equal(outcome.passed, false, 'the seeded bug must fail the suite');
    assert.match(outcome.output, /whole_percentage/);

    // The failure must be legible to the escalation logic.
    assert.ok(failureLines(outcome.output).size > 0, 'failures must be parseable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Go fixture is detected and its seeded bug is visible', async (t) => {
  const dir = stage('go-app');
  try {
    assert.equal(detectTestCommand(dir), 'go test ./...');

    if (!(await available('go version'))) {
      t.skip('go not installed');
      return;
    }

    const outcome = await runTests('go test ./...', dir);
    assert.equal(outcome.passed, false, 'the seeded bug must fail the suite');
    assert.match(outcome.output, /ApplyDiscount/);
    assert.ok(failureLines(outcome.output).size > 0, 'failures must be parseable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the TypeScript fixture is detected and its seeded bug is visible', async () => {
  const dir = stage('ts-app');
  try {
    assert.equal(detectTestCommand(dir), 'npm test --silent');

    const outcome = await runTests('npm test --silent', dir);
    assert.equal(outcome.passed, false, 'the seeded bug must fail the suite');
    assert.match(outcome.output, /applyDiscount/);
    assert.ok(failureLines(outcome.output).size > 0, 'failures must be parseable');

    // The same seeded bug in all three fixtures, so a benchmark comparing them
    // is comparing the harness rather than three different problems.
    assert.match(outcome.output, /-24000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a passing suite is reported as passing in every language', async () => {
  // The inverse matters just as much: a green run must not look like a failure.
  const dir = mkdtempSync(join(tmpdir(), 'sumo-green-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test *.test.js' } }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'ok.test.js'),
      `const { test } = require('node:test');
test('passes', () => {});
`,
      'utf8',
    );

    const outcome = await runTests('npm test --silent', dir);
    assert.equal(outcome.passed, true);
    assert.equal(failureLines(outcome.output).size, 0, 'no phantom failures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
