/**
 * Stage answers are validated by the provider before they arrive, so these
 * tests are about the two things the harness still owns: that the wire schema
 * is strict enough to be worth relying on, and that a malformed answer degrades
 * to prose instead of taking the task down.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Evidence,
  Explore,
  jsonSchema,
  parse,
  Plan,
  renderEvidence,
  renderExplore,
  renderPlan,
  renderRootCause,
  RootCause,
} from '../src/schemas.ts';

const EVIDENCE = {
  observations: [{ file: 'src/cart.js', line: 12, what: 'multiplies by percent, not percent/100' }],
  suspects: ['applyDiscount'],
  repro: 'node -e "console.log(require(\'./cart\').applyDiscount(1000,25))"',
  hypotheses: ['the divisor is missing'],
};

test('the wire schema is strict', () => {
  // Anything less and a provider is free to invent fields or omit required
  // ones, which puts the parsing risk straight back where it was.
  for (const schema of [Evidence, RootCause, Explore, Plan]) {
    const wire = jsonSchema(schema);
    assert.equal(wire['additionalProperties'], false);
    assert.ok(Array.isArray(wire['required']), 'every field must be required');
    assert.equal(wire['$schema'], undefined, 'the dialect key is not part of the data');
  }
});

test('a valid answer parses', () => {
  const parsed = parse(Evidence, JSON.stringify(EVIDENCE));
  assert.equal(parsed?.observations[0]?.line, 12);
  assert.equal(parsed?.repro, EVIDENCE.repro);
});

test('a missing field is a null, not a throw', () => {
  const { suspects: _dropped, ...incomplete } = EVIDENCE;
  assert.equal(parse(Evidence, JSON.stringify(incomplete)), null);
});

test('a wrong type is a null', () => {
  const wrong = { ...EVIDENCE, observations: [{ file: 'a.js', line: 'twelve', what: 'x' }] };
  assert.equal(parse(Evidence, JSON.stringify(wrong)), null);
});

test('prose is a null rather than an exception', () => {
  // This is the path a budget-truncated stage takes, and the reason the
  // workflows fall back to showing the raw output.
  assert.equal(parse(Evidence, 'Observations: the discount is wrong'), null);
  assert.equal(parse(Evidence, ''), null);
});

test('repro is optional but explicit', () => {
  const parsed = parse(Evidence, JSON.stringify({ ...EVIDENCE, repro: null }));
  assert.equal(parsed?.repro, null, 'null is a valid answer; absent is not');
  assert.equal(parse(Evidence, JSON.stringify({ ...EVIDENCE, repro: undefined })), null);
});

test('evidence renders with its observations as a table', () => {
  const rendered = renderEvidence(EVIDENCE);

  assert.match(rendered, /observations\[1\]\{file,line,what\}:/);
  assert.match(rendered, /src\/cart\.js/);
  assert.match(rendered, /Repro:/);
  assert.match(rendered, /Suspects:/);
});

test('an empty section says so rather than rendering an empty table', () => {
  const rendered = renderEvidence({ observations: [], suspects: [], repro: null, hypotheses: [] });
  assert.match(rendered, /Observations:\s+none/);
  assert.match(rendered, /Repro:\s+none/);
});

test('the other three render their tables too', () => {
  assert.match(
    renderRootCause({
      cause: 'percent is not divided by 100',
      evidenceRefs: ['src/cart.js:12'],
      fix: [{ file: 'src/cart.js', change: 'divide by 100' }],
      verification: 'the seeded test passes',
    }),
    /fix\[1\]\{file,change\}:/,
  );

  assert.match(
    renderExplore({
      files: ['src/cart.js'],
      reuse: [{ symbol: 'formatMoney', file: 'src/money.js', why: 'already rounds' }],
      conventions: { example: 'test/cart.test.js', note: 'node:test' },
      constraints: [],
    }),
    /reuse\[1\]\{symbol,file,why\}:/,
  );

  assert.match(
    renderPlan({
      approach: 'divide by 100',
      steps: [{ file: 'src/cart.js', action: 'edit', detail: 'fix the divisor' }],
      tests: [{ file: 'test/cart.test.js', case: 'whole percentage', whyFailsToday: 'no divisor' }],
      risks: [],
    }),
    /steps\[1\]\{file,action,detail\}:/,
  );
});

test('rendering beats JSON once there is more than one observation', () => {
  // At a single row the headings and the TOON header cost about what the JSON
  // punctuation does — the two are within a few characters, and readability is
  // the only thing being bought. The saving arrives with the second row and
  // grows from there, which is the shape every table in this harness has.
  const evidence = (rows: number) => ({
    ...EVIDENCE,
    observations: Array.from({ length: rows }, (_, i) => ({
      file: 'src/cart.js',
      line: 12 + i,
      what: 'multiplies by percent, not percent/100',
    })),
  });

  const ratio = (rows: number) => {
    const payload = evidence(rows);
    return renderEvidence(payload).length / JSON.stringify(payload).length;
  };

  // Measured: 1.06 at one row, 0.96 at two, 0.84 at six, 0.77 at twenty-five.
  // The ceiling is well short of the ~0.50 the ledger sees, and for a good
  // reason — TOON removes repeated *field names*, which are a large share of a
  // row of short numbers and a small share of a row containing a sentence.
  assert.ok(ratio(2) < 1, `two rows should already pay, got ${ratio(2).toFixed(2)}`);
  assert.ok(ratio(6) < 0.9, `six rows should be clearly cheaper, got ${ratio(6).toFixed(2)}`);
  assert.ok(ratio(25) < ratio(6), 'and the advantage should keep widening');
});
