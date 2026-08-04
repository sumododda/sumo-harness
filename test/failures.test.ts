/**
 * Parsed against output captured from the real runners rather than invented,
 * because the formats are exactly the kind of thing that looks obvious and
 * isn't — node uses its spec reporter even when piped, and pytest puts the line
 * number somewhere other than the summary line.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delta, parse, toPrompt } from '../src/failures.ts';

/** Verbatim from `node --test`, piped. */
const NODE_OUTPUT = `✖ applies a whole percentage (0.61675ms)
✔ passes fine (0.061875ms)
ℹ tests 2
ℹ pass 1
ℹ fail 1

✖ failing tests:

test at cart.test.js:3:1
✖ applies a whole percentage (0.61675ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -24000 !== 750

      at TestContext.<anonymous> (/tmp/fx/cart.test.js:4:10)
      at Test.runInAsyncScope (node:async_hooks:228:14) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: -24000,
    expected: 750,
    operator: 'strictEqual',
    diff: 'simple'
  }
`;

/** Verbatim from `python3 -m pytest -q`. */
const PYTEST_OUTPUT = `..F.                                                                     [100%]
=================================== FAILURES ===================================
________________ test_apply_discount_accepts_a_whole_percentage ________________

    def test_apply_discount_accepts_a_whole_percentage():
        # 25 means 25%, not 2500%. This is the seeded bug.
>       assert apply_discount(1000, 25) == 750
E       assert -24000 == 750

test_cart.py:14: AssertionError
=========================== short test summary info ============================
FAILED test_cart.py::test_apply_discount_accepts_a_whole_percentage - assert -24000 == 750
1 failed, 3 passed in 0.01s
`;

/** Verbatim from `go test ./...`. */
const GO_OUTPUT = `--- FAIL: TestApplyDiscountWholePercentage (0.00s)
    cart_test.go:21: ApplyDiscount(1000, 25) = -24000, want 750
FAIL
FAIL	cart	0.467s
FAIL
`;

test('node:test failures become records', () => {
  const failures = parse(NODE_OUTPUT);

  assert.equal(failures.length, 1, 'the top summary must not double-count');
  assert.equal(failures[0]!.test, 'applies a whole percentage');
  assert.equal(failures[0]!.file, 'cart.test.js');
  assert.equal(failures[0]!.line, 3);
  assert.equal(failures[0]!.expected, '750');
  assert.equal(failures[0]!.actual, '-24000');
});

test('pytest failures become records', () => {
  const failures = parse(PYTEST_OUTPUT);

  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.test, 'test_apply_discount_accepts_a_whole_percentage');
  assert.equal(failures[0]!.file, 'test_cart.py');
  assert.equal(failures[0]!.line, 14, 'the line comes from the traceback, not the summary');
  assert.equal(failures[0]!.actual, '-24000');
  assert.equal(failures[0]!.expected, '750');
});

test('go test failures become records', () => {
  const failures = parse(GO_OUTPUT);

  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.test, 'TestApplyDiscountWholePercentage');
  assert.equal(failures[0]!.file, 'cart_test.go');
  assert.equal(failures[0]!.line, 21);
  assert.equal(failures[0]!.actual, '-24000');
  assert.equal(failures[0]!.expected, '750');
});

test('a passing run yields nothing to report', () => {
  assert.deepEqual(parse('✔ everything fine (1ms)\nℹ pass 4\nℹ fail 0\n'), []);
  assert.deepEqual(parse('4 passed in 0.01s\n'), []);
});

test('unrecognised output yields nothing, so the caller can fall back', () => {
  // The contract that keeps this safe: empty means "I could not read this",
  // never "the suite passed".
  assert.deepEqual(parse('Segmentation fault (core dumped)\n'), []);
  assert.deepEqual(parse(''), []);
});

test('only new failures are fresh', () => {
  const before = parse(GO_OUTPUT);
  const after = parse(
    `--- FAIL: TestApplyDiscountWholePercentage (0.00s)
    cart_test.go:21: ApplyDiscount(1000, 25) = -24000, want 750
--- FAIL: TestReceiptLine (0.00s)
    cart_test.go:40: ReceiptLine() = "1.5", want "$1.50"
FAIL
`,
  );

  const changed = delta(before, after);
  assert.equal(changed.fresh.length, 1);
  assert.equal(changed.fresh[0]!.test, 'TestReceiptLine');
  assert.equal(changed.unchanged, 1);
});

test('a fixed failure simply stops appearing', () => {
  const changed = delta(parse(GO_OUTPUT), []);
  assert.deepEqual(changed.fresh, []);
  assert.equal(changed.unchanged, 0);
});

test('the prompt table is tabular and far smaller than the log', () => {
  const rendered = toPrompt(parse(PYTEST_OUTPUT));

  assert.match(rendered, /failures\[1\]\{test,file,line,expected,actual,message\}:/);
  assert.match(rendered, /test_cart\.py/);
  assert.ok(
    rendered.length < PYTEST_OUTPUT.length / 2,
    `the point is to be smaller than the log: ${rendered.length} vs ${PYTEST_OUTPUT.length}`,
  );
});

test('every current failure is listed, marked by what changed', () => {
  const before = parse(GO_OUTPUT);
  const after = parse(
    `--- FAIL: TestApplyDiscountWholePercentage (0.00s)
    cart_test.go:21: ApplyDiscount(1000, 25) = -24000, want 750
--- FAIL: TestReceiptLine (0.00s)
    cart_test.go:40: ReceiptLine() = "1.5", want "$1.50"
FAIL
`,
  );

  const rendered = toPrompt(after, before);

  // The next stage is a fresh session that has never seen the earlier run, so
  // omitting the carried-over failure would leave it unfixable.
  assert.match(rendered, /TestApplyDiscountWholePercentage/);
  assert.match(rendered, /TestReceiptLine/);
  assert.match(rendered, /since_last_attempt/);
  assert.match(rendered, /TestReceiptLine.*new/);
  assert.match(rendered, /TestApplyDiscountWholePercentage.*unchanged/);
});

test('the first attempt carries no comparison column', () => {
  const rendered = toPrompt(parse(GO_OUTPUT));
  assert.doesNotMatch(rendered, /since_last_attempt/, 'nothing to compare against yet');
});

test('nothing failing means nothing to say', () => {
  assert.equal(toPrompt([]), '');
  assert.equal(toPrompt([], parse(GO_OUTPUT)), '');
});

test('a truncated list says it was truncated', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ test: `t${i}`, file: 'a.go', line: i }));
  const rendered = toPrompt(many);

  // A silently capped list reads as a complete one, which is how a harness
  // ends up reporting that it fixed everything.
  assert.match(rendered, /8 further failures not listed/);
});
