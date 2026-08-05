/**
 * The system prompt is paid for on every single call, so both its contents and
 * its size are worth pinning down.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as features from '../src/features.ts';
import { estimateTokens } from '../src/profile.ts';
import {
  DO_STAGE,
  evidenceParts,
  exploreParts,
  type SingleStage,
  singleStageParts,
  systemPrompt,
} from '../src/prompts.ts';
import { budgetFor, fit, render } from '../src/context/budget.ts';

const SINGLE_STAGES: readonly SingleStage[] = ['do', 'plan', 'chat', 'research'];

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
  assert.doesNotMatch(render(exploreParts('add search')), /skeleton/i);
  assert.doesNotMatch(render(evidenceParts('crashes on save')), /skeleton/i);

  features.set({ skeletonContext: true });
  assert.match(render(exploreParts('add search')), /skeleton/i);
  assert.match(render(evidenceParts('crashes on save')), /skeleton/i);
});

test('the skeleton hint names the way to get a body', () => {
  // Bug #22 was a stage reading a whole file when the pack had already
  // selected it; the hint only earns its tokens if it says what to do instead.
  features.set({ skeletonContext: true });
  assert.match(render(exploreParts('add search')), /naming its symbol/i);
  assert.match(render(evidenceParts('crashes on save')), /naming its symbol/i);
});

test('switching the flag off leaves the rest of the prompt untouched', () => {
  features.set({ skeletonContext: false });
  const explore = render(exploreParts('add search', ['src/a.ts'], 'context block\n\n'));

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

test('every single-stage mode names what it was asked and closes with what to do', () => {
  for (const stage of SINGLE_STAGES) {
    const [task, instructions, ...rest] = singleStageParts(stage, 'add a --json flag');

    assert.deepEqual(rest, [], `${stage} should split in exactly two`);
    assert.equal(task?.region, 'task');
    assert.equal(instructions?.region, 'instructions');
    assert.match(task?.text ?? '', /^(Task|Question): add a --json flag\n\n$/, stage);
    assert.ok((instructions?.text.length ?? 0) > 0, `${stage} has no instructions`);
  }
});

test('a single-stage prompt ends on its instructions, behind whatever context fits', () => {
  // The position that matters. Context goes first because it is what may be
  // dropped; the instructions take the end because that is where a model reads
  // best and they are the part that must not be missed.
  const prompt = render([
    { region: 'pack', text: "Relevant code, from this repository's index:\nfoo\n\n" },
    ...singleStageParts('do', 'add a --json flag'),
  ]);

  assert.ok(prompt.startsWith("Relevant code, from this repository's index:"));
  assert.ok(prompt.endsWith('<path> — <what changed>.'));
  assert.ok(prompt.indexOf('Task: add a --json flag') < prompt.indexOf('Make this change now'));
});

test('`sumo do` and the REPL asking to do something ask for exactly the same thing', () => {
  // One builds its prompt in advance and the other hands the harness its parts.
  // They are two renderings of one instruction, and nothing but this stops an
  // edit to either from quietly making them two different instructions.
  const task = 'add a --json flag to the bench command';
  assert.equal(DO_STAGE(task), render(singleStageParts('do', task)));
});

test('a workflow stage puts the index pack where the budget can shed it', () => {
  const pack = "Relevant code, from this repository's index:\nfoo\n\n";

  for (const parts of [evidenceParts('crashes on save', pack), exploreParts('add search', [], pack)]) {
    assert.deepEqual(
      parts.map((p) => p.region),
      ['pack', 'task', 'instructions'],
      'the pack is the only droppable region a workflow stage has',
    );
  }
});

test('a workflow stage with no index is the same prompt without the pack', () => {
  // `packContext` defaults to '' throughout the workflows, and an empty part
  // would render as nothing while still counting as a region that was present.
  assert.equal(evidenceParts('crashes on save').length, 2);
  assert.equal(render(evidenceParts('crashes on save', '')), render(evidenceParts('crashes on save')));
});

test('the explore file listing is not droppable, because the instructions rely on it', () => {
  // It is the largest region here, so it is the tempting one to shed — and the
  // one that must not be. The instructions tell the model to trust it over a
  // Glob, and `runner.repoFiles` already caps it at 400 entries.
  const parts = exploreParts('add search', ['src/a.ts', 'src/b.ts'], 'pack\n\n');
  const listing = parts.find((p) => p.text.includes('src/a.ts'));

  assert.equal(listing?.region, 'task', 'the listing must ride with the undroppable half');
  assert.match(render(parts), /Trust the file listing above over a Glob/);
});

test('shedding a workflow stage pack leaves the request whole', () => {
  // A pack far past the survey ceiling — four characters to the token, so this
  // is ~15,000 against a budget of 12,000.
  const parts = exploreParts('add search', ['src/a.ts'], `${'x'.repeat(60_000)}\n\n`);
  const { text, dropped } = fit(parts, budgetFor('survey', 128_000));

  assert.deepEqual(dropped, ['pack']);
  assert.match(text, /Task: add search/);
  assert.match(text, /src\/a\.ts/, 'the file listing survives');
  assert.match(text, /Investigate before proposing anything/);
});

test('the evidence stage asks for a reproduction test, and says it is optional', () => {
  const prompt = render(evidenceParts('crashes on save'));

  assert.match(prompt, /test file/i);
  assert.match(prompt, /harness writes and runs it/i, 'says who runs it, not just who does not');
  assert.match(prompt, /null/i, 'optionality is spelled out, not implied');
  assert.match(prompt, /expected to fail/i);
});
