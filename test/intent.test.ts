/**
 * Routing decides what every turn costs, so it is tested exhaustively and
 * offline. A rule that fires here is a model call that never happens.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/intent.ts';

test('questions route to chat on the cheapest tier', () => {
  for (const input of [
    'what does applyTax do?',
    'how many functions are in cart.js',
    'where is subtotal defined',
    'explain the pricing logic',
    'is this function used anywhere',
  ]) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'chat', input);
    assert.equal(intent.rung.tier, 'small', input);
  }
});

test('mechanical edits route to do on the cheapest tier', () => {
  for (const input of [
    'fix the typo in the README',
    'rename sum to total',
    'add a jsdoc comment to subtotal',
    'bump the version to 2.0',
    'format this file',
  ]) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'do', input);
    assert.equal(intent.rung.tier, 'small', input);
  }
});

test('breakage routes to fix', () => {
  for (const input of [
    'the cart total is wrong',
    'subtotal throws on empty input',
    'this crashes when qty is zero',
    'applyTax returns NaN',
  ]) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'fix', input);
  }
});

test('new capability routes to feature', () => {
  for (const input of [
    'add a discount function',
    'implement bulk pricing',
    'support multiple currencies',
  ]) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'feature', input);
  }
});

test('hard problems climb the ladder without being asked', () => {
  const easy = classify('the total is wrong');
  const hard = classify('there is a race condition in the checkout flow');

  assert.ok(easy && hard);
  assert.equal(easy.rung.tier, 'mid');
  assert.equal(easy.rung.effort, 'low');
  // Same mode, but harder — so it thinks harder.
  assert.equal(hard.rung.effort, 'high');
});

test('a typo report is an edit, not a bug hunt', () => {
  // "fix" appears in both, so ordering of the rules matters.
  const intent = classify('fix the typo in the README');
  assert.ok(intent);
  assert.equal(intent.mode, 'do');
  assert.equal(intent.rung.tier, 'small');
});

test('a weak verb does not turn a mechanical edit into a feature', () => {
  // "add" appears in both, so the mechanical noun has to win.
  for (const input of [
    'add a jsdoc comment to subtotal',
    'add a docstring here',
    'create a README section',
    'add the missing import',
  ]) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'do', input);
    assert.equal(intent.rung.tier, 'small', input);
  }
});

test('an unambiguous verb still means real work, even near a doc word', () => {
  const intent = classify('implement a docs endpoint');
  assert.ok(intent);
  assert.equal(intent.mode, 'feature');
});

test('a pinned mode overrides what the text suggests', () => {
  const intent = classify('the total is off by one', 'feature');
  assert.ok(intent);
  assert.equal(intent.mode, 'feature');
  // Asserted on provenance rather than on the wording of the reason: a mode the
  // operator named is ground truth, and the routing log has to be able to tell
  // it apart from a rule that merely matched.
  assert.equal(intent.by, 'you');
});

test('a pinned mode still steps aside for a plain question', () => {
  // Pinning /plan and then asking "what model did you use?" should answer,
  // not run explore and plan stages to reach the same sentence.
  for (const sticky of ['plan', 'feature', 'fix'] as const) {
    const intent = classify('what model did you use?', sticky);
    assert.ok(intent);
    assert.equal(intent.mode, 'chat', sticky);
    assert.equal(intent.rung.tier, 'small', sticky);
  }

  // But a question *about a failure* is still bug work, not idle curiosity.
  const broken = classify('why does applyTax return NaN?', 'fix');
  assert.equal(broken?.mode, 'fix');
});

test('hard failure modes route to fix without needing a failure word', () => {
  // Nobody mentions a deadlock to praise it, so these are bugs even though
  // "broken", "fails", and "error" are all absent.
  for (const input of [
    'there is a race condition in the checkout flow',
    'deadlock in the worker pool',
    'memory leak in the cache',
    'the tests are flaky',
  ]) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'fix', input);
    assert.equal(intent.rung.effort, 'high', input);
  }
});

test('restructuring work routes to feature, not fix', () => {
  // Same difficulty tier as a race condition, but nothing is broken.
  for (const input of ['refactor the pricing module', 'migrate to the new API']) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'feature', input);
    assert.equal(intent.rung.effort, 'high', input);
  }
});

test('tidying routes to an edit, not an investigation', () => {
  // These are common enough that reaching the paid classifier would be waste.
  for (const input of [
    'the receiptLine function duplicates logic, clean it up',
    'simplify this function',
    'dedupe the money formatting',
    'extract this into a helper',
  ]) {
    const intent = classify(input);
    assert.ok(intent, `should classify: ${input}`);
    assert.equal(intent.mode, 'do', input);
  }
});

test('unclassifiable input defers to the classifier rather than guessing', () => {
  assert.equal(classify('the thing with the stuff'), null);
  assert.equal(classify('cart.js'), null);
});

test('empty input never costs anything', () => {
  const intent = classify('   ');
  assert.ok(intent);
  assert.equal(intent.mode, 'chat');
});

test('shell work is recognised so it never costs a model call', async () => {
  const { shellRequest } = await import('../src/intent.ts');

  // These ask the terminal to do something. Stages have no shell by design, so
  // routing them anywhere buys only a paid refusal.
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

test('git requests are answered with the command that runs them', async () => {
  const { shellRequest } = await import('../src/intent.ts');
  assert.equal(shellRequest('git checkout main')?.git, true);
  assert.equal(shellRequest('npm install')?.git, false);
});

test('a polite request is an instruction, not a question', async () => {
  const { classify } = await import('../src/intent.ts');

  // The failure this pins down cost a real turn. "can you please change the
  // license file to apache-2.0" matched the question rule on its opening `can`
  // and routed to chat — a read-only stage. The harness answered a request to
  // change something, changed nothing, and billed for it. English wraps almost
  // every instruction in exactly this form.
  for (const input of [
    'can you please change the license file to apache-2.0 please',
    'could you rename this variable',
    'would you clean up the duplicated helpers',
    'i want you to implement a checkout endpoint',
    'please add a docstring to parseCart',
  ]) {
    const intent = classify(input);
    assert.notEqual(intent?.mode, 'chat', `must not be answered as a question: ${input}`);
  }
});

test('stripping politeness does not turn a question into work', async () => {
  const { classify } = await import('../src/intent.ts');

  // The other direction matters just as much: "can you explain X" is still a
  // question once the manners come off, because `explain` is the actual verb.
  for (const input of [
    'can you explain how applyDiscount works',
    'could you tell me where the cart total is computed',
    'please show me the test conventions here',
  ]) {
    assert.equal(classify(input)?.mode, 'chat', `still a question: ${input}`);
  }
});

test('a pinned chat is never widened into a writable mode', async () => {
  const { classify } = await import('../src/intent.ts');

  // The failure this pins down wrote to a file. `/chat` was excluded from the
  // pinned branch, so it fell through to automatic routing, which classified
  // "delete the parseNote function" as `do` and deleted it. Chat is the one
  // mode that asks for *less* authority — it cannot write — so a pin on it has
  // to hold no matter what the text looks like.
  for (const input of [
    'delete the parseNote function from src/note.ts and replace it with a stub',
    'add a checkout endpoint with tests',
    'the cart total is wrong',
    'rename this variable',
    'refactor the whole module',
  ]) {
    const intent = classify(input, 'chat');
    assert.equal(intent?.mode, 'chat', `pinned chat must hold for: ${input}`);
    assert.equal(intent?.by, 'you', 'and be recorded as the operator naming it');
  }
});

test('pinning a writable mode still steps aside for a plain question', async () => {
  const { classify } = await import('../src/intent.ts');

  // Narrowing to chat is always safe; only widening is the danger.
  assert.equal(classify('what does applyDiscount do', 'feature')?.mode, 'chat');
  assert.equal(classify('add oauth login', 'feature')?.mode, 'feature');
});

test('a documentation tag is not a bug report', async () => {
  const { classify } = await import('../src/intent.ts');

  // The failure this pins down ran five stages at mid/high effort to rewrite a
  // comment. `@throws` and `@error` are JSDoc tag names, and the word-boundary
  // in the breakage pattern sits between the `@` and the word — so naming a tag
  // read as reporting a crash.
  for (const input of [
    'rewrite that jsdoc on getNote: drop the @param and @throws tags',
    'add an @error tag to the parseCart docstring',
    'remove the @throws annotation from these helpers',
  ]) {
    assert.notEqual(classify(input)?.mode, 'fix', `a doc edit, not a bug: ${input}`);
  }

  // And the words themselves still route to fix when they are actually prose.
  // The lookbehind can only suppress a match preceded by `@`, so these are the
  // cases proving it suppressed nothing else.
  for (const input of [
    'getNote throws on an empty id',
    'this throws on startup',
    'the parser has a bug',
  ]) {
    assert.equal(classify(input)?.mode, 'fix', `still a bug report: ${input}`);
  }
});

test('research is pinned unconditionally, because it is a question mode', async () => {
  const { classify } = await import('../src/intent.ts');

  // Every other pinned mode steps aside for a plain question so that pinning
  // /plan and asking "what model was that?" does not run explore and plan.
  // Applied to /research that rule fires on essentially every use and hands the
  // turn to chat, which has no web access — a pin that drops the one capability
  // it was typed to grant.
  for (const input of [
    'what is the newest node LTS?',
    'how does the zod 4 api differ from zod 3',
    'is picocolors still maintained',
  ]) {
    const intent = classify(input, 'research');
    assert.equal(intent?.mode, 'research', `must stay research: ${input}`);
    assert.equal(intent?.by, 'you');
  }
});
