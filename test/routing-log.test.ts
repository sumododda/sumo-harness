/**
 * The routing log exists because a wrong route was invisible.
 *
 * A request to change a file routed to `chat` — a read-only mode — produced an
 * apology, a bill, and no evidence. Twelve of fourteen turns in one repository
 * went that way before anyone noticed, because nothing was counting. These pin
 * down the two things that make the file worth keeping: that every turn is
 * recorded with its provenance, and that a correction is marked as one.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { path, read, record, reset, summarize } from '../src/routing-log.ts';

/** A throwaway repo root, so a test never writes into a real one. */
function scratch(): string {
  reset();
  return mkdtempSync(join(tmpdir(), 'sumo-routing-'));
}

test('every turn is recorded with who decided it', () => {
  const root = scratch();
  try {
    record(root, { text: 'what does applyDiscount do', mode: 'chat', why: 'question', by: 'rules' });
    record(root, { text: 'add oauth login', mode: 'feature', why: 'new capability', by: 'rules' });

    const rows = read(root);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.mode, 'chat');
    assert.equal(rows[0]?.by, 'rules');
    // Provenance is the point: a rule that matched and a guess that was paid
    // for are worth different amounts as evidence, and must not look alike.
    assert.equal(rows[1]?.by, 'rules');
    assert.ok(rows[0]?.ts, 'each row is timestamped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-running the same request under another mode is marked a correction', () => {
  const root = scratch();
  try {
    // The failure this whole file exists for: a request to change a file,
    // answered as a question.
    record(root, {
      text: 'change the license to apache-2.0',
      mode: 'chat',
      why: 'question',
      by: 'rules',
    });
    // The operator says otherwise by re-running it with an explicit mode.
    record(root, {
      text: 'change the license to apache-2.0',
      mode: 'do',
      why: '/do mode',
      by: 'you',
    });

    const rows = read(root);
    assert.equal(rows[1]?.was, 'chat', 'the mode it replaced is recorded');
    assert.equal(rows[1]?.by, 'you', 'and it is ground truth, not a guess');
    assert.equal(rows[0]?.was, undefined, 'the original was not a correction');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a retyped request still counts as the same one', () => {
  const root = scratch();
  try {
    record(root, { text: 'the cart total is wrong', mode: 'chat', why: 'question', by: 'rules' });
    // Retyped through a slash command: different spacing and case, same ask.
    record(root, { text: '  The cart   total is WRONG ', mode: 'fix', why: '/fix mode', by: 'you' });

    assert.equal(read(root)[1]?.was, 'chat');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different request after a turn is not a correction', () => {
  const root = scratch();
  try {
    record(root, { text: 'what does the ladder do', mode: 'chat', why: 'question', by: 'rules' });
    record(root, { text: 'add a checkout endpoint', mode: 'feature', why: 'new', by: 'rules' });

    assert.equal(read(root)[1]?.was, undefined, 'a new ask is not a correction of the last one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-running the same request in the same mode is not a correction', () => {
  const root = scratch();
  try {
    record(root, { text: 'fix the cart bug', mode: 'fix', why: 'broken', by: 'rules' });
    record(root, { text: 'fix the cart bug', mode: 'fix', why: '/fix mode', by: 'you' });

    assert.equal(read(root)[1]?.was, undefined, 'agreeing with the route corrects nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the summary names the routes that get corrected', () => {
  const root = scratch();
  try {
    for (const [text, mode, by] of [
      ['change the license', 'chat', 'rules'],
      ['change the license', 'do', 'you'],
      ['update the readme', 'chat', 'classifier'],
      ['update the readme', 'do', 'you'],
      ['what does X do', 'chat', 'rules'],
    ] as const) {
      record(root, { text, mode, why: 'test', by });
    }

    const summary = summarize(read(root));
    assert.equal(summary.turns, 5);
    assert.equal(summary.by.you, 2);
    assert.equal(summary.by.rules, 2);
    assert.equal(summary.by.classifier, 1);
    // The line that earns the file: the harness reporting its own worst route.
    assert.deepEqual(summary.corrections, [{ change: 'chat→do', count: 2 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deciders that are no longer produced are still counted when read back', () => {
  // `rules` and `local` were the keyword table and the local embedding router.
  // Both are gone, but logs written while they existed are still read, and a
  // breakdown that silently dropped their rows would not add up to the turn
  // count printed beside it.
  const root = scratch();
  try {
    record(root, { text: 'what does X do', mode: 'chat', why: 'question', by: 'rules' });
    record(root, { text: 'the total is wrong', mode: 'fix', why: 'moderate', by: 'local' });
    record(root, { text: 'add oauth', mode: 'feature', why: 'moderate', by: 'classifier' });

    const summary = summarize(read(root));
    assert.equal(summary.turns, 3);
    assert.equal(summary.by.rules, 1);
    assert.equal(summary.by.local, 1);
    assert.equal(summary.by.classifier, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt line does not cost every other line', () => {
  const root = scratch();
  try {
    record(root, { text: 'a', mode: 'chat', why: 'x', by: 'rules' });
    const good = readFileSync(path(root), 'utf8');

    // A half-written line is what a crash mid-append leaves behind. It must
    // not take the turns either side of it down with it.
    writeFileSync(
      path(root),
      `${good}{"ts":"broken\n${JSON.stringify({ ts: 'z', text: 'c', mode: 'fix', why: 'w', by: 'rules' })}\n`,
      'utf8',
    );

    const rows = read(root);
    assert.equal(rows.length, 2, 'the readable lines survive');
    assert.equal(rows[0]?.text, 'a');
    assert.equal(rows[1]?.text, 'c');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reading a repo with no log is empty rather than an error', () => {
  const root = scratch();
  try {
    assert.deepEqual(read(root), []);
    assert.equal(summarize([]).turns, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a correction is spotted a few turns after the mistake', () => {
  const root = scratch();
  try {
    // What actually happens: it routes wrong, you read the wrong answer, you
    // ask something about it, and only then do you re-run it properly.
    record(root, { text: 'change the license', mode: 'chat', why: 'question', by: 'rules' });
    record(root, { text: 'where is the license file', mode: 'chat', why: 'question', by: 'rules' });
    record(root, { text: 'change the license', mode: 'do', why: 'pinned', by: 'you' });

    assert.equal(read(root)[2]?.was, 'chat', 'the turn in between must not hide the correction');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a request repeated long after is not treated as a correction', () => {
  const root = scratch();
  try {
    record(root, { text: 'what is the license', mode: 'chat', why: 'question', by: 'rules' });
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      record(root, { text, mode: 'do', why: 'edit', by: 'rules' });
    }
    // Far enough back that repeating it is a new request, not a correction.
    record(root, { text: 'what is the license', mode: 'do', why: 'pinned', by: 'you' });

    assert.equal(read(root).at(-1)?.was, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
