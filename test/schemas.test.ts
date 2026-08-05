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
  unusableRootCause,
  RootCause,
} from '../src/schemas.ts';

const EVIDENCE = {
  observations: [{ file: 'src/cart.js', line: 12, what: 'multiplies by percent, not percent/100' }],
  suspects: ['applyDiscount'],
  repro: 'node -e "console.log(require(\'./cart\').applyDiscount(1000,25))"',
  reproTest: null,
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

test('reproTest is optional but explicit, same as repro', () => {
  const withTest = {
    ...EVIDENCE,
    reproTest: { file: 'test/cart.test.js', content: 'it fails today' },
  };
  const parsed = parse(Evidence, JSON.stringify(withTest));
  assert.deepEqual(parsed?.reproTest, withTest.reproTest);

  const nulled = parse(Evidence, JSON.stringify({ ...EVIDENCE, reproTest: null }));
  assert.equal(nulled?.reproTest, null, 'null is a valid answer; absent is not');
  assert.equal(parse(Evidence, JSON.stringify({ ...EVIDENCE, reproTest: undefined })), null);
});

test('evidence renders with its observations as a table', () => {
  const rendered = renderEvidence(EVIDENCE);

  assert.match(rendered, /observations\[1\]\{file,line,what\}:/);
  assert.match(rendered, /src\/cart\.js/);
  assert.match(rendered, /Repro:/);
  assert.match(rendered, /Suspects:/);
});

test('an empty section says so rather than rendering an empty table', () => {
  const rendered = renderEvidence({
    observations: [],
    suspects: [],
    repro: null,
    reproTest: null,
    hypotheses: [],
  });
  assert.match(rendered, /Observations:\s+none/);
  assert.match(rendered, /Repro:\s+none/);
  assert.match(rendered, /Repro test:\s+none/);
});

test('a repro test renders with its file and full content', () => {
  // The full content reaches the prompt — unlike the screen (see
  // test/display.test.ts), the next stage genuinely needs it.
  const withTest = { ...EVIDENCE, reproTest: { file: 'test/cart.test.js', content: "assert(applyDiscount(1000, 25) === 750);" } };
  const rendered = renderEvidence(withTest);
  assert.match(rendered, /Repro test:/);
  assert.match(rendered, /test\/cart\.test\.js/);
  assert.match(rendered, /assert\(applyDiscount/);
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

// ------------------------------------------------- a schema slot filled, not answered

test('a root cause proposing no fix is not something to approve', () => {
  // The stage is told to leave the fix empty when the evidence does not support
  // one, so this is a correct answer to a hard question — and exactly the thing
  // that must not reach a gate reading "Approve this root cause and fix?".
  const answer = RootCause.parse({
    cause: 'The evidence covers the parser but never reaches the code that formats the total.',
    evidenceRefs: ['src/cart.js:12'],
    fix: [],
    verification: 'none proposed',
  });
  assert.match(unusableRootCause(answer) ?? '', /did not support a fix/);
});

test('a one-word root cause is refused even with a fix attached', () => {
  // Observed live: a revision came back as `cause: "Test"` with evidence
  // ["a","b"], rendered into a perfectly ordinary box and offered for approval.
  const answer = RootCause.parse({
    cause: 'Test',
    evidenceRefs: ['a', 'b'],
    fix: [{ file: 'src/cli.ts', change: 'something' }],
    verification: 'test',
  });
  assert.match(unusableRootCause(answer) ?? '', /placeholder/);
});

test('a real root cause passes', () => {
  const answer = RootCause.parse({
    cause:
      'The catch block only special-cases JournalParseError, so an ENOENT from readFileSync is rethrown uncaught.',
    evidenceRefs: ['src/cli.ts:18'],
    fix: [{ file: 'src/cli.ts', change: 'handle ErrnoException before the final else' }],
    verification: 'run the CLI against a missing file and check stderr is one line',
  });
  assert.equal(unusableRootCause(answer), null);
});

// ------------------------------------------------------------ stray section tags

test('a section tag the model closed but never opened is stripped', () => {
  const parsed = parse(
    RootCause,
    JSON.stringify({
      cause: 'The gate maps every write to Write, so an edit is refused with advice it cannot take.',
      evidenceRefs: ['src/engine/copilot.ts:307'],
      fix: [{ file: 'src/engine/copilot.ts', change: 'map create and edit apart' }],
      verification: 'run a Copilot edit against an existing file</verification>',
    }),
  );
  assert.equal(parsed?.verification, 'run a Copilot edit against an existing file');
});

test('a tag the model did open survives, because it is content', () => {
  // Evidence.reproTest.content is written to disk. An HTML fixture that ends in
  // </html> opened that tag, and truncating it would corrupt the file.
  const content = '<html>\n  <body>hi</body>\n</html>';
  const parsed = parse(
    Evidence,
    JSON.stringify({ ...EVIDENCE, reproTest: { file: 'test/page.html', content } }),
  );
  assert.equal(parsed?.reproTest?.content, content);
});

test('a tag in the middle of a value is left alone', () => {
  const parsed = parse(
    Evidence,
    JSON.stringify({
      ...EVIDENCE,
      suspects: ['the <div> branch in renderRow'],
    }),
  );
  assert.deepEqual(parsed?.suspects, ['the <div> branch in renderRow']);
});
