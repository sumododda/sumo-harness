/**
 * The system prompt is paid for on every single call, so both its contents and
 * its size are worth pinning down.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens } from '../src/profile.ts';
import { systemPrompt } from '../src/prompts.ts';

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
