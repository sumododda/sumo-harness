/**
 * TOON's saving, measured in the unit that actually bills.
 *
 * The harness previously justified this format with character counts. Characters
 * are not a reliable proxy for tokens — a tokenizer can price punctuation and
 * repeated field names quite differently from prose — so the claim is worth
 * exactly as much as a measurement under the real tokenizer, which is what the
 * live half of this file does.
 *
 * The offline half still checks characters, because it has to run without
 * credentials, and says so rather than pretending otherwise.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '@toon-format/toon';
import { getEngine } from '../src/engine/index.ts';

/** A realistic failure table — the payload this format was adopted for. */
const FAILURES = Array.from({ length: 8 }, (_, i) => ({
  test: `test_apply_discount_case_${i}`,
  file: 'src/cart.py',
  line: 12 + i,
  expected: '750',
  actual: '-24000',
  message: 'assert -24000 == 750',
}));

const AS_TOON = encode({ failures: FAILURES });
const AS_JSON = JSON.stringify({ failures: FAILURES });

test('TOON is shorter than minified JSON in characters', () => {
  // ~38% fewer on this payload. Short of the ~50% the ledger sees, because the
  // saving is on repeated *field names* and these rows carry a sentence each —
  // the ratio is a property of the data, not a constant of the format.
  assert.ok(
    AS_TOON.length < AS_JSON.length * 0.7,
    `${AS_TOON.length} vs ${AS_JSON.length} characters`,
  );
});

test('TOON is shorter than minified JSON in tokens', async (t) => {
  const engine = getEngine();
  if (!engine.countTokens) {
    t.skip('provider cannot count tokens');
    return;
  }

  let toonTokens: number;
  let jsonTokens: number;
  try {
    [toonTokens, jsonTokens] = await Promise.all([
      engine.countTokens(AS_TOON),
      engine.countTokens(AS_JSON),
    ]);
  } catch {
    // The endpoint is free but still needs credentials.
    t.skip('no provider credentials; run with an API key to check tokens');
    return;
  }

  // The claim that matters. Characters passing while tokens failed would mean
  // the format was optimising for the wrong unit all along.
  assert.ok(
    toonTokens < jsonTokens,
    `TOON should cost fewer tokens: ${toonTokens} vs ${jsonTokens}`,
  );

  process.stderr.write(
    `\n  measured: ${toonTokens} tokens vs ${jsonTokens} for JSON ` +
      `(${(100 - (toonTokens / jsonTokens) * 100).toFixed(0)}% fewer)\n` +
      `  characters: ${AS_TOON.length} vs ${AS_JSON.length} ` +
      `(${(100 - (AS_TOON.length / AS_JSON.length) * 100).toFixed(0)}% fewer)\n`,
  );
});
