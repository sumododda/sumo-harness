/**
 * Parsed against output captured from the real runners rather than invented,
 * because the formats are exactly the kind of thing that looks obvious and
 * isn't — node uses its spec reporter even when piped, and pytest puts the line
 * number somewhere other than the summary line.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delta, parse, testFiles, toPrompt } from '../src/failures.ts';

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

/** Verbatim from `vitest run --no-color`, piped. */
const VITEST_OUTPUT = `
 RUN  v4.1.10 /repo

 ❯ test/cart.test.js (2 tests | 1 failed) 3ms
       × applies a whole percentage 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/cart.test.js > cart > applyDiscount > applies a whole percentage
AssertionError: expected 25000 to be 750 // Object.is equality

- Expected
+ Received

- 750
+ 25000

 ❯ test/cart.test.js:10:39
      8|   describe('applyDiscount', () => {
      9|     it('applies a whole percentage', () => {
     10|       expect(applyDiscount(1000, 25)).toBe(750);
       |                                       ^
     11|     });
     12|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  17:46:50
   Duration  67ms (transform 5ms, setup 0ms, import 10ms, tests 3ms, environment 0ms)
`;

/** The same run through `npm test`, and with a second file failing too. */
const VITEST_MULTI_OUTPUT = `
 RUN  v4.1.10 /repo

 ❯ test/receipt.test.js (1 test | 1 failed) 3ms
     × formats as currency 2ms
 ❯ test/cart.test.js (2 tests | 1 failed) 3ms
       × applies a whole percentage 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/cart.test.js > cart > applyDiscount > applies a whole percentage
AssertionError: expected 25000 to be 750 // Object.is equality

- Expected
+ Received

- 750
+ 25000

 ❯ test/cart.test.js:10:39
      8|   describe('applyDiscount', () => {
      9|     it('applies a whole percentage', () => {
     10|       expect(applyDiscount(1000, 25)).toBe(750);
       |                                       ^
     11|     });
     12|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/receipt.test.js > receipt > formats as currency
AssertionError: expected '1.5' to be '$1.50' // Object.is equality

Expected: "$1.50"
Received: "1.5"

 ❯ test/receipt.test.js:9:30
      7| describe('receipt', () => {
      8|   it('formats as currency', () => {
      9|     expect(receiptLine(1.5)).toBe('$1.50');
       |                              ^
     10|   });
     11| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed (2)
      Tests  2 failed | 1 passed (3)
   Start at  17:49:23
   Duration  74ms (transform 13ms, setup 0ms, import 22ms, tests 6ms, environment 0ms)
`;

/** Verbatim from `jest --no-colors --ci`, piped. */
const JEST_OUTPUT = `FAIL ./cart.test.js
  ● cart › applyDiscount › applies a whole percentage

    expect(received).toBe(expected) // Object.is equality

    Expected: 750
    Received: 25000

       6 |   describe('applyDiscount', () => {
       7 |     test('applies a whole percentage', () => {
    >  8 |       expect(applyDiscount(1000, 25)).toBe(750);
         |                                       ^
       9 |     });
      10 |   });
      11 |

      at Object.toBe (cart.test.js:8:39)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 passed, 2 total
Snapshots:   0 total
Time:        0.102 s
Ran all test suites.
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

test('vitest failures become records', () => {
  const failures = parse(VITEST_OUTPUT);

  assert.equal(failures.length, 1, 'the live summary line must not double-count');
  assert.equal(failures[0]!.test, 'cart > applyDiscount > applies a whole percentage');
  assert.equal(failures[0]!.file, 'test/cart.test.js');
  assert.match(failures[0]!.message ?? '', /AssertionError: expected 25000 to be 750/);
});

test('jest failures become records', () => {
  const failures = parse(JEST_OUTPUT);

  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.test, 'cart › applyDiscount › applies a whole percentage');
  assert.equal(failures[0]!.file, './cart.test.js');
  assert.match(failures[0]!.message ?? '', /expect\(received\)\.toBe\(expected\)/);
});

test('vitest and jest output are not double-counted through the union parser', () => {
  // Each runner's own live-summary line is shaped closely enough to its
  // detail block that it is worth confirming the union still lands on one.
  assert.equal(parse(VITEST_OUTPUT).length, 1);
  assert.equal(parse(JEST_OUTPUT).length, 1);
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

test('testFiles dedupes and preserves first-seen order', () => {
  const failures = [
    { test: 'a', file: 'a.test.ts' },
    { test: 'b', file: 'b.test.ts' },
    { test: 'c', file: 'a.test.ts' },
    { test: 'd' },
  ];

  assert.deepEqual(testFiles(failures), ['a.test.ts', 'b.test.ts']);
});

test('testFiles names the files a runner reported, not its suite names', () => {
  const failures = parse(VITEST_MULTI_OUTPUT);

  assert.equal(failures.length, 2);
  assert.deepEqual(testFiles(failures), ['test/cart.test.js', 'test/receipt.test.js']);
});
