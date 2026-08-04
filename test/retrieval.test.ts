/**
 * Table-driven, in the style of test/intent.test.ts.
 *
 * The asymmetry here is deliberate and worth stating: a wrongly skipped lookup
 * costs the model several rounds of reading its way to the same files, while a
 * wrongly performed one costs a couple of thousand tokens. So these tests care
 * far more about false skips than false retrievals.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shouldRetrieve } from '../src/retrieval.ts';
import { rungAt } from '../src/types.ts';

const SMALL = rungAt(0);
const MID = rungAt(1);

/** A repo containing one real file, so "names a file" can be tested honestly. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-retrieval-'));
  writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.1;\n', 'utf8');
  return dir;
}

test('a task naming a real file skips the lookup', () => {
  const dir = repo();
  try {
    for (const input of [
      'fix the rounding in cart.js',
      'update `cart.js` to use the shared helper',
      'what does cart.js do?',
    ]) {
      const decision = shouldRetrieve('do', MID, input, dir);
      assert.equal(decision.retrieve, false, input);
      assert.match(decision.why, /cart\.js/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that does not exist is a description, not a pointer', () => {
  const dir = repo();
  try {
    // Naming parser.ts when there is no parser.ts means the model still has to
    // be told where things are.
    assert.equal(shouldRetrieve('do', MID, 'rework the parser.ts logic', dir).retrieve, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trivial mechanical edits skip the lookup', () => {
  const dir = repo();
  try {
    for (const input of [
      'fix the typo in the readme',
      'rename the helper',
      'add a docstring',
      'bump the version',
    ]) {
      assert.equal(shouldRetrieve('do', SMALL, input, dir).retrieve, false, input);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mechanical word does not skip retrieval for real work', () => {
  const dir = repo();
  try {
    // The same keyword at a higher rung, or in another mode, is describing
    // something larger than a mechanical edit.
    assert.equal(shouldRetrieve('do', MID, 'rename the helper', dir).retrieve, true);
    assert.equal(shouldRetrieve('fix', SMALL, 'the rename broke imports', dir).retrieve, true);
    assert.equal(shouldRetrieve('feature', SMALL, 'add a docstring generator', dir).retrieve, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('everything substantive still retrieves', () => {
  const dir = repo();
  try {
    for (const [mode, input] of [
      ['fix', 'the cart total is wrong for whole percentages'],
      ['feature', 'add a rounding helper for cents'],
      ['chat', 'how does the escalation ladder pick a model?'],
      ['plan', 'split the runner into two modules'],
      ['do', 'make applyTax reuse formatMoney'],
    ] as const) {
      const decision = shouldRetrieve(mode, MID, input, dir);
      assert.equal(decision.retrieve, true, `${mode}: ${input}`);
      assert.equal(decision.why, '');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
