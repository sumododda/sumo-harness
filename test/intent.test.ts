/**
 * What routing still decides without a model.
 *
 * Most of this file used to assert which regex caught which phrasing. Those
 * rules are gone — a model reads the request now — so what is left to test
 * offline is the part that never was a guess: a mode the operator named, a
 * request that is really shell work, and the arithmetic that turns a
 * classification into a rung.
 *
 * The phrasings themselves were not thrown away. They live in
 * `routing-cases.ts` as a labelled set for evaluating the real classifier, and
 * the last test here keeps that file honest.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASSIFY_PROMPT,
  CLASSIFY_SCHEMA,
  intentFromClassifier,
  isLabel,
  pinned,
  shellRequest,
} from '../src/intent.ts';
import { LADDER } from '../src/types.ts';
import { ROUTING_CASES } from './routing-cases.ts';

test('a named mode is honoured as typed, and recorded as ground truth', () => {
  for (const mode of ['chat', 'do', 'fix', 'feature', 'plan', 'research'] as const) {
    const intent = pinned('the total is off by one', mode);
    assert.ok(intent, mode);
    assert.equal(intent.mode, mode, 'the operator named it, so nothing overrules it');
    // Asserted on provenance rather than the wording of the reason: the routing
    // log has to tell a mode the operator named apart from one that was guessed.
    assert.equal(intent.by, 'you', mode);
  }
});

test('a pinned chat cannot be widened into a writable mode', () => {
  // The failure this pins down wrote to a file. `/chat` once fell through to
  // automatic routing, which read "delete the parseNote function" as an edit
  // and deleted it. Chat is the one mode that asks for *less* authority — it
  // cannot write — so a pin on it has to hold whatever the text looks like.
  for (const input of [
    'delete the parseNote function from src/note.ts and replace it with a stub',
    'add a checkout endpoint with tests',
    'the cart total is wrong',
    'refactor the whole module',
  ]) {
    const intent = pinned(input, 'chat');
    assert.equal(intent?.mode, 'chat', `pinned chat must hold for: ${input}`);
    assert.equal(intent?.by, 'you');
  }
});

test('an unpinned request is left for the classifier rather than guessed at', () => {
  // The absence of a rules layer, asserted. Nothing here reads the words.
  for (const input of [
    'the cart total is wrong',
    'what does applyTax do?',
    'add a discount function',
    'the thing with the stuff',
  ]) {
    assert.equal(pinned(input), null, `must not be decided offline: ${input}`);
  }
});

test('empty input never costs anything', () => {
  const intent = pinned('   ');
  assert.ok(intent);
  assert.equal(intent.mode, 'chat');
  assert.equal(intent.rung.tier, 'small');
  // Not `rules` — there are none. Nothing decided this; there was nothing to
  // decide, and the log should say so rather than imply a judgement was made.
  assert.equal(intent.by, 'default');
});

test('pinned modes start at the base rung and let failure escalate them', () => {
  // Difficulty is the one thing a pin does not carry. Guessing it from words is
  // what the harness just stopped doing, and the ladder measures it for free by
  // running the tests.
  assert.equal(pinned('x', 'do')?.rung.tier, 'small');
  assert.equal(pinned('x', 'chat')?.rung.tier, 'small');
  assert.equal(pinned('x', 'research')?.rung.tier, 'small', 'searching is retrieval, not reasoning');
  assert.equal(pinned('x', 'fix')?.rung.tier, 'mid');
  assert.equal(pinned('x', 'feature')?.rung.tier, 'mid');
  assert.equal(pinned('x', 'plan')?.rung.tier, 'mid');
});

test('shell work is recognised so it never costs a model call', () => {
  // These ask the terminal to do something. Stages have no shell by design, so
  // routing them anywhere buys only a paid refusal. This is a fact about the
  // harness's own tools, not a guess about what the operator meant — which is
  // why it survived the removal of everything else that matched on words.
  for (const input of [
    'Check out to the latest commited brnach',
    'git checkout main',
    'git pull',
    'npm install',
    'restart the server',
  ]) {
    assert.ok(shellRequest(input), `should be shell work: ${input}`);
  }

  // Coding work that merely mentions git must still route normally.
  for (const input of [
    'fix the bug in the git log parser',
    'add a commit message validator',
    'the branch name test is failing',
  ]) {
    assert.equal(shellRequest(input), null, `should be coding work: ${input}`);
  }
});

test('git requests are answered with the command that runs them', () => {
  assert.equal(shellRequest('git checkout main')?.git, true);
  assert.equal(shellRequest('npm install')?.git, false);
});

test('a classification becomes a rung, and a guess never buys the top one', () => {
  assert.equal(intentFromClassifier('fix', 'trivial').rung.tier, 'small');
  assert.equal(intentFromClassifier('fix', 'moderate').rung.tier, 'mid');
  assert.equal(intentFromClassifier('fix', 'hard').rung.tier, 'large');

  // Difficulty is the least reliable half of the answer, so the most expensive
  // rung on the ladder stays out of reach of a guess — it is somewhere failure
  // escalates to, having been measured, not somewhere a description lands.
  assert.notDeepEqual(intentFromClassifier('fix', 'hard').rung, LADDER.at(-1));

  // A hard *edit* is still an edit. The blast radius sets the tier here, not
  // how much thinking the description implies.
  assert.equal(intentFromClassifier('do', 'hard').rung.tier, 'mid');

  // Research is retrieval however hard the question sounds: what it costs is
  // the pages it fetches, not the tier that reads them.
  for (const complexity of ['trivial', 'moderate', 'hard']) {
    assert.equal(intentFromClassifier('research', complexity).rung.tier, 'small', complexity);
  }

  assert.equal(intentFromClassifier('feature', 'moderate').by, 'classifier');
});

/** The modes the classifier may return, as plain strings. */
const OFFERED: readonly string[] = CLASSIFY_SCHEMA.properties.mode.enum;

test('the prompt offers exactly the modes the schema accepts', () => {
  // These drifting apart is a silent failure: the model is told about a mode it
  // is then rejected for choosing, or offered one the harness cannot dispatch.
  for (const mode of OFFERED) {
    assert.ok(isLabel(mode), `${mode} must be a label the harness can dispatch`);
    assert.match(CLASSIFY_PROMPT('x'), new RegExp(`\\b${mode} —`), `${mode} must be described`);
  }
  // `research` earns its place: it is the only mode that can leave the machine,
  // so an instruction to search the web has nowhere else to land.
  assert.ok(OFFERED.includes('research'));
  // `plan` does not: it is reachable by pin only, and never guessed at.
  assert.ok(!OFFERED.includes('plan'));
});

test('the labelled routing cases stay usable as an evaluation set', () => {
  // This file cannot check the answers — that needs a provider and real money.
  // It can check that the set is still worth running: every label dispatchable,
  // every request distinct, and every mode represented.
  const seen = new Set<string>();
  for (const { text, mode } of ROUTING_CASES) {
    assert.ok(isLabel(mode), `${text} is labelled with an undispatchable mode: ${mode}`);
    const key = text.trim().toLowerCase();
    assert.ok(!seen.has(key), `duplicate case: ${text}`);
    seen.add(key);
  }

  for (const mode of OFFERED) {
    assert.ok(
      ROUTING_CASES.some((c) => c.mode === mode),
      `no case exercises ${mode}`,
    );
  }
});

test('corrections accumulate rather than replacing each other', async () => {
  const { feedbackBlock } = await import('../src/prompts.ts');

  // The failure this pins down is why arguing with a proposal did not work.
  // Only the newest note was ever sent, so a second correction silently dropped
  // the first: told "host it on my own Debian laptop, not a VPS" and then
  // "mention the schedule", the next proposal was free to put the VPS back —
  // and nothing on screen said it had.
  const one = feedbackBlock(['use my own Debian server, not a VPS']);
  assert.match(one, /use my own Debian server/);

  const both = feedbackBlock(['use my own Debian server, not a VPS', 'mention the schedule']);
  assert.match(both, /use my own Debian server/, 'the earlier note survives');
  assert.match(both, /mention the schedule/, 'and so does the later one');
  assert.match(both, /1\./, 'ordered, so "later refines earlier" is legible');
  assert.match(both, /2\./);
  assert.match(both, /still applies/, 'and said explicitly, since order alone implies nothing');

  assert.equal(feedbackBlock([]), '', 'no corrections adds nothing to the prompt');
});
