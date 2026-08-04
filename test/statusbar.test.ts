/**
 * The activity line draws with terminal escape codes, which cannot be exercised
 * through a pipe — so what is tested here is the part that can be: the text it
 * composes, and its refusal to touch a non-terminal at all.
 *
 * That refusal is the load-bearing one. Escape codes written into a pipe corrupt
 * the transcript, and `sumo | tee run.log` is an ordinary thing to do.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enable, render, renderInput, rule } from '../src/statusbar.ts';

const WIDTH = 60;
const SPIN = '⠋';

test('an idle line names the repo and the session total', () => {
  const line = render(
    { activity: '', since: Date.now(), costUsd: 0.0412, where: 'sumo-news' },
    WIDTH,
    SPIN,
  );

  assert.match(line, /sumo · sumo-news/);
  assert.match(line, /\$0\.0412 this session/);
});

test('a busy line shows the stage, a clock, and that typing is allowed', () => {
  const line = render(
    { activity: 'evidence 1/5', since: Date.now() - 12_000, costUsd: 0.0412, where: 'x' },
    WIDTH,
    SPIN,
  );

  assert.match(line, /evidence 1\/5/);
  assert.ok(line.startsWith(SPIN), 'the spinner leads, so movement reads as progress');
  assert.match(line, /0:12/, 'elapsed as m:ss');
  // Steering is invisible unless something says it exists.
  assert.match(line, /type to steer/);
});

test('the clock rolls into minutes rather than counting seconds forever', () => {
  const line = render(
    { activity: 'implement 5/6', since: Date.now() - 125_000, costUsd: 0, where: 'x' },
    WIDTH,
    SPIN,
  );
  assert.match(line, /2:05/);
});

test('the line never wraps, because a wrapped line cannot be erased', () => {
  // Erasing is one carriage return and one clear-to-end-of-line. That only
  // reaches the row the cursor is on, so a line that wrapped would leave its
  // first row behind on screen for the rest of the session.
  const line = render(
    {
      activity: 'root-cause 2/5 with an unreasonably long stage name',
      since: Date.now(),
      costUsd: 1.2345,
      where: 'x',
    },
    32,
    SPIN,
  );

  assert.ok(line.length <= 32, `must not wrap: got ${line.length}`);
  // What it cost is the part worth protecting; the stage name is recoverable
  // from the scrollback right above.
  assert.match(line, /\$1\.2345/);
});

test('an absurdly narrow terminal still produces something printable', () => {
  for (const width of [1, 5, 12]) {
    const line = render(
      { activity: 'evidence 1/5', since: Date.now(), costUsd: 0.5, where: 'x' },
      width,
      SPIN,
    );
    assert.ok(line.length <= width, `width ${width}: got ${line.length}`);
  }
});

test('the rule framing a turn fits the terminal', () => {
  assert.equal(rule(40).length, 40);
  assert.ok(rule(500).length <= 120, 'a very wide terminal needs a visible rule, not a long one');
});

test('a terminal that reports no width still renders something', () => {
  // `process.stdout.columns` is 0, not undefined, when the size is unknown —
  // a pty with no window size, which is what CI and `script` produce. Taken
  // literally it rendered a line of no characters and a rule of none either.
  const line = render(
    { activity: 'evidence 1/5', since: Date.now(), costUsd: 0.5, where: 'x' },
    0,
    SPIN,
  );
  assert.ok(line.length > 0, 'an unknown width must fall back, not render nothing');
  assert.ok(rule(0).length > 0, 'the same for the rule that frames a turn');
});

test('the input line shows what is typed, with the cursor on it', () => {
  const { line, column } = renderInput('› ', 'fix the cart bug', 7, 60);
  assert.equal(line, '› fix the cart bug');
  // Column 10 is 1-based: two for the prompt, seven for the cursor's offset.
  assert.equal(column, 10);
});

test('a long message scrolls sideways rather than wrapping', () => {
  // Wrapping is the one thing this cannot survive. The block is erased by
  // walking back a counted number of rows, so a line that occupied two rows
  // would leave its first behind on every redraw — once per keystroke.
  const long = 'a'.repeat(200);
  const { line, column } = renderInput('› ', long, long.length, 40);

  assert.ok(line.length <= 40, `must fit the terminal: got ${line.length}`);
  assert.ok(column <= 40, `the cursor must stay on the row: got ${column}`);
  assert.ok(line.startsWith('› '), 'the prompt stays put while the text moves under it');
});

test('the cursor is placed by visible width, not by escape codes', () => {
  // A coloured prompt carries bytes that occupy no columns. Counting them would
  // put the cursor several places right of where the character actually lands.
  const plain = renderInput('› ', 'hi', 2, 60);
  const coloured = renderInput('\x1b[36m› \x1b[39m', 'hi', 2, 60);
  assert.equal(coloured.column, plain.column);
});

test('an empty buffer still leaves the cursor after the prompt', () => {
  assert.equal(renderInput('› ', '', 0, 60).column, 3);
});

test('there is no activity line without a terminal', () => {
  // Under `node --test` stdout is a pipe, which is exactly the case that must
  // not have escape codes written into it.
  assert.equal(process.stdout.isTTY, undefined, 'this test assumes a piped stdout');
  assert.equal(enable('anywhere'), false, 'enable must decline and say so');
});
