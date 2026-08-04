/**
 * The system prompt is paid for on every single call, so both its contents and
 * its size are worth pinning down.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as features from '../src/features.ts';
import { estimateTokens } from '../src/profile.ts';
import { EVIDENCE_STAGE, EXPLORE_STAGE, systemPrompt } from '../src/prompts.ts';

test('the system prompt states the working directory', () => {
  // Replacing the provider's default prompt also drops its environment section.
  // Without this line the model guesses absolute paths from filesystem root and
  // burns two failed reads before finding any file — measured at ~2 extra turns
  // and roughly double the input tokens on a one-line edit.
  const prompt = systemPrompt('/Users/sumo/some-project');

  assert.match(prompt, /Working directory: \/Users\/sumo\/some-project/);
  assert.match(prompt, /relative to it/i);
});

test('the system prompt tells the model it has no shell', () => {
  // The harness runs commands; a model that believes otherwise wastes a turn
  // discovering the tool is absent.
  assert.match(systemPrompt('/tmp'), /no shell/i);
});

test('the system prompt carries the operator profile', () => {
  assert.match(systemPrompt('/tmp'), /duplicate an existing helper/i);
});

test('the system prompt stays small', () => {
  // It rides every call, so growth here is charged on every turn of every stage.
  const size = estimateTokens(systemPrompt('/Users/sumo/some-project'));
  assert.ok(size < 400, `system prompt is ~${size} tokens; keep it under 400`);
});

afterEach(() => {
  features.set({ skeletonContext: true });
});

test('a survey stage mentions the skeleton only when the flag is on', () => {
  features.set({ skeletonContext: false });
  assert.doesNotMatch(EXPLORE_STAGE('add search'), /skeleton/i);
  assert.doesNotMatch(EVIDENCE_STAGE('crashes on save'), /skeleton/i);

  features.set({ skeletonContext: true });
  assert.match(EXPLORE_STAGE('add search'), /skeleton/i);
  assert.match(EVIDENCE_STAGE('crashes on save'), /skeleton/i);
});

test('the skeleton hint names the way to get a body', () => {
  // Bug #22 was a stage reading a whole file when the pack had already
  // selected it; the hint only earns its tokens if it says what to do instead.
  features.set({ skeletonContext: true });
  assert.match(EXPLORE_STAGE('add search'), /naming its symbol/i);
  assert.match(EVIDENCE_STAGE('crashes on save'), /naming its symbol/i);
});

test('switching the flag off leaves the rest of the prompt untouched', () => {
  features.set({ skeletonContext: false });
  const explore = EXPLORE_STAGE('add search', ['src/a.ts'], 'context block\n\n');

  assert.match(explore, /^context block\n\n/);
  assert.match(explore, /Task: add search/);
  assert.match(explore, /Trust the file listing above over a Glob/);
});

test('a writable prompt is an exact prefix of the read-only variant of the same stage', () => {
  // The read-only notice is the only thing that differs between the two, and it
  // now sits last. A provider that caches its own request by longest-common-
  // prefix gets nothing from a shared ending, so what matters is that role,
  // working directory and profile — everything before the notice — are
  // byte-identical, which "one is an exact prefix of the other" proves directly.
  const writable = systemPrompt('/tmp/some-project', true);
  const readOnly = systemPrompt('/tmp/some-project', false);

  assert.ok(
    readOnly.startsWith(writable),
    'the read-only prompt should extend the writable one rather than diverge partway through',
  );
  assert.ok(readOnly.length > writable.length);
});

test('the evidence stage asks for a reproduction test, and says it is optional', () => {
  const prompt = EVIDENCE_STAGE('crashes on save');

  assert.match(prompt, /test file/i);
  assert.match(prompt, /harness writes and runs it/i, 'says who runs it, not just who does not');
  assert.match(prompt, /null/i, 'optionality is spelled out, not implied');
  assert.match(prompt, /expected to fail/i);
});
