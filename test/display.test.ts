/**
 * The screen renderers, and the boundary they exist to hold.
 *
 * A stage answer is read by two audiences that want opposite things from it.
 * The next stage wants TOON, because it pays for a field name once per table
 * instead of once per row. A person wants none of that — a plan reached the
 * screen as `steps[2]{file,action,detail}:` and comma-joined rows breaking
 * mid-word, which is a wire format read by the one audience it was never meant
 * for.
 *
 * The ugly direction announces itself. The expensive direction does not: making
 * the prompt form pretty would raise the cost of every later stage and show up
 * nowhere, so that is the direction pinned hardest here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPlan, type Plan } from '../src/schemas.ts';
import { displayEvidence, displayPlan, frameWidth, shownPlan, wrap } from '../src/ui.ts';

const PLAN: Plan = {
  approach: 'Add a body param to addNote and a getNote helper that mirrors listNotes.',
  steps: [
    { file: 'src/store.ts', action: 'edit', detail: 'Accept a body param and validate the id.' },
    { file: 'src/cli.ts', action: 'edit', detail: 'Accept --body or stdin, and add show <id>.' },
  ],
  tests: [
    {
      file: 'test/store.test.ts',
      case: 'addNote persists the given body',
      whyFailsToday: "body is hardcoded '' today, so it is silently dropped",
    },
  ],
  risks: ['basename() also rejects an id containing a literal backslash'],
};

/** Drops colour, so assertions are about layout rather than about escapes. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching the escapes is the point
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

test('the prompt form stays TOON, because that is what it is paid for', () => {
  // The regression that would cost real money and announce itself nowhere:
  // someone "tidies up" by pointing the prompt renderer at the pretty one.
  const prompt = renderPlan(PLAN);
  assert.match(prompt, /steps\[2\]\{file,action,detail\}/, 'steps must stay a TOON table');
  assert.match(prompt, /tests\[1\]\{file,case,whyFailsToday\}/, 'so must tests');
});

test('the screen form carries no wire format', () => {
  const shown = plain(displayPlan(PLAN));
  assert.doesNotMatch(shown, /\[\d+\]\{/, 'no TOON header may reach the screen');
  // The content still has to survive the reformatting.
  assert.match(shown, /src\/store\.ts/);
  assert.match(shown, /Accept --body or stdin/);
  assert.match(shown, /addNote persists the given body/);
});

test('a plan is shown in both forms at once, and they differ', () => {
  const shown = shownPlan(JSON.stringify(PLAN));
  assert.ok(shown.value, 'a well-formed plan parses');
  assert.equal(shown.value.steps.length, 2);
  assert.notEqual(shown.prompt, shown.display, 'two audiences, two renderings');
  assert.match(shown.prompt, /\[\d+\]\{/);
  assert.doesNotMatch(plain(shown.display), /\[\d+\]\{/);
});

test('an answer that is not in the schema degrades to its own text', () => {
  // Providers end a stage early for budget or turn limits. A partial answer is
  // shown as prose rather than taking the task down.
  const shown = shownPlan('I ran out of turns before finishing.');
  assert.equal(shown.value, null);
  assert.equal(shown.prompt, 'I ran out of turns before finishing.');
  assert.equal(shown.display, shown.prompt, 'nothing to lay out, so both are the raw text');
});

test('nothing drawn is wider than the terminal', () => {
  // The frame is drawn two narrower than the terminal, because both callers —
  // renderArtifact and the approval gate — indent what they are given by two.
  // Measured against the real width rather than a constant: there is no cap any
  // more, so a hard number here would pass on a narrow terminal and say nothing
  // about a wide one.
  const limit = frameWidth() + 2;
  for (const line of plain(displayPlan(PLAN)).split('\n')) {
    assert.ok(line.length <= limit, `line overruns the terminal: ${String(line.length)}`);
  }
});

test('wrap breaks at spaces, not mid-word', () => {
  const lines = wrap('the quick brown fox jumps over the lazy dog', 16);
  for (const line of lines) assert.ok(line.length <= 16, `too wide: ${line}`);
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog');
});

test('wrap cuts a token that has no space to break at', () => {
  // A path or a type signature can exceed the whole line. Cutting it is a
  // decision; leaving it to the terminal is how it wrapped unpredictably.
  const lines = wrap('src/very/deeply/nested/module/implementation.ts', 12);
  for (const line of lines) assert.ok(line.length <= 12, `too wide: ${line}`);
  assert.equal(lines.join(''), 'src/very/deeply/nested/module/implementation.ts');
});

test('wrap keeps the blank lines that separate paragraphs', () => {
  assert.deepEqual(wrap('one\n\ntwo', 40), ['one', '', 'two']);
});

test('a repro command is shown when there is one, and skipped when there is not', () => {
  const base = { observations: [], suspects: ['parseNote'], hypotheses: ['it drops the body'] };
  assert.match(plain(displayEvidence({ ...base, repro: 'npm test -- note' })), /Repro/);
  assert.doesNotMatch(plain(displayEvidence({ ...base, repro: null })), /Repro/);
});

test('an empty section is left out rather than drawn empty', () => {
  const bare: Plan = { approach: 'Do the thing.', steps: [], tests: [], risks: [] };
  const shown = plain(displayPlan(bare));
  assert.match(shown, /Approach/);
  assert.doesNotMatch(shown, /Steps/, 'a plan with no steps draws no Steps box');
  assert.doesNotMatch(shown, /Risks/);
});

test('nothing ever escapes the frame it is drawn inside', () => {
  // The failure this pins down was visible from across the room: the box frames
  // stopped at 120 columns while their contents ran on to the real terminal
  // edge and wrapped raggedly underneath. Two causes — a hard width cap, and
  // several call sites pushing text in without wrapping it — so this measures
  // the property rather than either cause, and uses content chosen to be
  // hostile: very long test names, a long repro command, and a deep path.
  const brutal: Plan = {
    approach: 'A '.repeat(200),
    steps: [
      {
        file: 'src/very/deeply/nested/package/module/implementation/detail.ts',
        action: 'edit',
        detail: 'Change '.repeat(120),
      },
    ],
    tests: [
      {
        file: 'test/very/deeply/nested/suite/for/this/module.test.ts',
        case: 'list truncates a note line to the fallback terminal width when stdout is piped and the title alone is two hundred characters long',
        whyFailsToday: 'because '.repeat(80),
      },
    ],
    risks: ['x'.repeat(400), 'a genuinely long sentence about something that could go wrong '.repeat(6)],
  };

  const limit = frameWidth() + 2; // the frame, plus the two-space indent callers add
  for (const [i, line] of plain(displayPlan(brutal)).split('\n').entries()) {
    assert.ok(
      line.length <= limit,
      `line ${String(i)} is ${String(line.length)} wide, frame allows ${String(limit)}: ${line.slice(0, 70)}`,
    );
  }

  const evidence = plain(
    displayEvidence({
      observations: [
        { file: 'src/a/b/c/d/e/f/g/really-quite-long-name.ts', line: 4210, what: 'w '.repeat(150) },
      ],
      suspects: ['s'.repeat(300)],
      repro: 'node --experimental-strip-types src/cli.ts show missing-id 2>&1 | grep -E "something|rather|long" | head -20',
      hypotheses: ['h '.repeat(200)],
    }),
  );
  for (const line of evidence.split('\n')) {
    assert.ok(line.length <= limit, `evidence line ${String(line.length)} wide: ${line.slice(0, 70)}`);
  }
});
