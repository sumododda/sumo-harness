/**
 * What the harness remembers of a session, and what it sends.
 *
 * Both assertions here are about the *edges* of the context block. A turn is
 * abridged from the middle because that is the region a model reads worst, and
 * the fact list is capped because an unbounded one at the top of the block is
 * what pushes everything else into that middle.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from '../src/conversation.ts';

test('a short turn is sent exactly as it was said', () => {
  const conversation = new Conversation();
  conversation.add('sumo', 'cart.js — fixed the off-by-one in applyTax');

  assert.match(conversation.contextBlock(), /You: cart\.js — fixed the off-by-one in applyTax/);
});

test('an abridged turn keeps its ending, which is where a stage answers', () => {
  const conversation = new Conversation();
  // Every stage that writes is told to close with one line per file changed, so
  // the last line is the part that says what actually happened. Head-only
  // truncation discarded exactly that.
  const long = `${'reasoning about the failing path. '.repeat(60)}cart.js — corrected the rate`;
  conversation.add('sumo', long);

  const block = conversation.contextBlock();
  assert.ok(block.includes('cart.js — corrected the rate'), 'the conclusion must survive');
  assert.ok(block.includes('reasoning about the failing path'), 'and so must the opening');
  assert.ok(block.includes(' … '), 'with the cut marked rather than silent');
  assert.ok(!block.includes(long), 'but the whole turn is not sent');
});

test('nothing is abridged that fits, so no marker appears', () => {
  const conversation = new Conversation();
  conversation.add('user', 'why does applyTax round twice?');
  conversation.add('sumo', 'it calls round() in both the helper and the caller');

  assert.ok(!conversation.contextBlock().includes('…'));
});

test('the fact list is capped, keeping the notes that describe where the work stands', () => {
  const conversation = new Conversation();
  for (let i = 1; i <= 14; i += 1) conversation.note(`fixed thing ${String(i)}`);

  const block = conversation.contextBlock();
  // Ten most recent: 5 through 14. Anything earlier has been overtaken by them.
  assert.ok(!block.includes('fixed thing 4'), 'the oldest notes drop off');
  assert.ok(block.includes('fixed thing 5'), 'ten are kept');
  assert.ok(block.includes('fixed thing 14'), 'and the most recent is never the one dropped');
});

test('the facts survive as a summary rather than being pruned away', () => {
  // Pruning history outright cuts stale-state errors but triples premature
  // terminations — an agent with no record of what it did concludes it is
  // finished. This list is the summary that prevents that, so a capped session
  // must still carry one.
  const conversation = new Conversation();
  for (let i = 0; i < 50; i += 1) conversation.note(`step ${String(i)}`);

  assert.match(conversation.contextBlock(), /Earlier in this session:/);
});

test('a cleared conversation says nothing at all', () => {
  const conversation = new Conversation();
  conversation.add('user', 'anything');
  conversation.note('a fact');
  conversation.clear();

  assert.equal(conversation.contextBlock(), '');
  assert.equal(conversation.length, 0);
});
