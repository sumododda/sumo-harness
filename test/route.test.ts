/**
 * The local router: an embedding table on disk, standing between the free rules
 * and the paid classifier.
 *
 * Two properties are worth testing and they are not equally important. That it
 * answers is a saving; that it is never *confidently wrong* is a correctness
 * property, because a wrong route can send an edit to a read-only stage or a
 * question through five stages of a bug workflow. The margin exists to buy the
 * second at the cost of the first, so the held-out set below asserts zero
 * errors and only a floor on coverage.
 *
 * The examples here are deliberately not the ones in `src/route/corpus.ts`, and
 * deliberately not phrasings the rules already answer — the model only ever sees
 * what the rules declined, so anything else would measure the wrong thing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/intent.ts';
import { CORPUS, type Label } from '../src/route/corpus.ts';
import { embedder } from '../src/route/embed.ts';
import { localRoutingAvailable, routeLocally } from '../src/route/local.ts';
import { encode, preTokenize } from '../src/route/tokenizer.ts';

const HELD_OUT: Readonly<Record<Label, readonly string[]>> = {
  chat: [
    'can you clarify what happens when the queue is empty',
    'i cannot follow what this loop is doing',
    'talk me through the ordering guarantees here',
    'i am curious how the cache decides to evict',
    'which part of this decides the timeout',
    'is there a reason it swallows that error',
    'how do these two modules talk to each other',
    'what decides the batch size at runtime',
    'i want to understand the locking strategy',
    'where does the default value come from',
    'what assumptions does this make about input',
    'how expensive is this operation roughly',
  ],
  do: [
    'this comment no longer matches the code under it',
    'the spacing here is inconsistent with the rest',
    'give that parameter a name that says what it holds',
    'collapse these two nearly identical branches',
    'that string should be a named constant',
    'use one style of quotes throughout this file',
    'those imports are in a strange order',
    'that nested ternary would read better as an if',
    'this helper is only used once, inline it',
    'the type here could be narrower',
    'this magic number deserves a name',
    'drop the redundant else after the return',
  ],
  fix: [
    'the output changes depending on the machine',
    'it hangs partway through with no message',
    'every so often the count comes back too low',
    'results differ between the first and second call',
    'memory keeps climbing until it dies',
    'the totals stop matching after a while',
    'it quietly returns nothing for large inputs',
    'the ordering is not stable across runs',
    'two of these pass alone but not together',
    'the file ends up truncated now and then',
    'duplicate entries appear after a retry',
    'the cache returns stale data occasionally',
  ],
  feature: [
    'we could do with a dry run switch',
    'it should be possible to resume where it left off',
    'let people supply their own template',
    'support reading the config from the environment',
    'it would help to have progress reporting',
    'give this a way to run against many files',
    'allow the output format to be chosen',
    'there ought to be a preview before applying',
    'we want to plug in a different storage backend',
    'add a way to filter before writing',
    'expose this as a library not just a cli',
    'provide a summary at the end of a run',
  ],
};

/** Only what the rules decline reaches the model, so only that is measured. */
function deferred(): [string, Label][] {
  return (Object.entries(HELD_OUT) as [Label, readonly string[]][])
    .flatMap(([label, texts]) => texts.map((text) => [text, label] as [string, Label]))
    .filter(([text]) => classify(text) === null);
}

test('the model ships with the package and loads', () => {
  assert.ok(localRoutingAvailable(), 'model/embeddings.bin and model/vocab.txt must be present');
  const model = embedder();
  assert.ok(model);
  assert.equal(model.dims, 256);
});

test('the router is never confidently wrong on held-out phrasings', () => {
  // The property the margin exists to buy. A free wrong answer is worse than a
  // cheap right one, so this is the assertion that must not be relaxed to make
  // the coverage number below look better.
  const wrong: string[] = [];
  for (const [text, want] of deferred()) {
    const route = routeLocally(text);
    if (route && route.label !== want) {
      wrong.push(`${route.label} (want ${want}, margin ${route.margin.toFixed(3)}): ${text}`);
    }
  }
  assert.deepEqual(wrong, [], 'confidently wrong routes');
});

test('and still answers enough of them to be worth shipping', () => {
  const seen = deferred();
  const answered = seen.filter(([text]) => routeLocally(text) !== null).length;
  // Measured at 28% when the margin was set. A floor rather than a target: the
  // margin is allowed to become more conservative, but silently answering
  // nothing would make the whole file dead weight and should fail here.
  assert.ok(
    answered / seen.length >= 0.2,
    `answered ${String(answered)}/${String(seen.length)} — too few to justify the model`,
  );
});

test('degenerate input never reaches a writable mode', () => {
  // Declining is one safe answer and `chat` is another — it is read-only and on
  // the cheapest tier, so a string of question marks landing there costs
  // nothing and breaks nothing. What must never happen is junk acquiring write
  // access, so that is what this asserts rather than insisting on null.
  for (const input of ['', '   ', '?????', '!!!', 'zzzqqq', '...', '???!!!']) {
    const route = routeLocally(input);
    if (route === null) continue;
    assert.equal(route.label, 'chat', `${JSON.stringify(input)} must not become writable work`);
  }
});

test('every corpus example routes to its own label', () => {
  // A sanity check on the embedding path rather than on generalisation: if an
  // example that helped build a centroid does not land on it, something in the
  // tokenizer or the table is wrong.
  for (const [label, examples] of Object.entries(CORPUS) as [Label, readonly string[]][]) {
    for (const example of examples) {
      const route = routeLocally(example);
      if (route) assert.equal(route.label, label, example);
    }
  }
});

test('the tokenizer splits punctuation off, which is how @throws survives', () => {
  // The router inherits this from the rules' hardest bug: `@throws` is a
  // documentation tag, not a report of a crash, and the two are only
  // distinguishable if the `@` is its own token.
  assert.deepEqual(preTokenize('@throws'), ['@', 'throws']);
  assert.deepEqual(preTokenize('Hello, World!'), ['hello', ',', 'world', '!']);
  assert.deepEqual(preTokenize('  spaced   out  '), ['spaced', 'out']);
});

test('the tokenizer lowercases and strips accents, as the table was built', () => {
  // Ids index rows. Normalising differently from upstream does not fail — it
  // silently embeds the wrong vectors, which is far worse.
  assert.deepEqual(preTokenize('CAFÉ'), ['cafe']);
  assert.deepEqual(preTokenize('Ünicode'), ['unicode']);
});

test('an unknown word falls back to a single [UNK] rather than nonsense', () => {
  const model = embedder();
  assert.ok(model);
  const vocab = new Map<string, number>([
    ['[UNK]', 100],
    ['the', 1],
  ]);
  assert.deepEqual(encode('the', vocab), [1]);
  assert.deepEqual(encode('zzzqqq', vocab), [100]);
});

test('embedding is deterministic and unit length', () => {
  const model = embedder();
  assert.ok(model);
  const a = model.embed('the cart total is wrong');
  const b = model.embed('the cart total is wrong');
  assert.ok(a && b);
  assert.deepEqual([...a], [...b], 'same text must embed identically');

  let norm = 0;
  for (const value of a) norm += value * value;
  assert.ok(Math.abs(norm - 1) < 1e-5, `expected unit length, got ${String(Math.sqrt(norm))}`);
});
