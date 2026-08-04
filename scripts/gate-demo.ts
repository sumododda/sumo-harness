#!/usr/bin/env node
/**
 * The approval gate, on its own, with no model behind it.
 *
 * The gate is the hardest part of the harness to try out, because reaching one
 * normally means paying for a workflow to get there. This runs the real
 * `askApproval` against a fixed proposal so its grammar can be exercised for
 * free — type answers and watch which decision each one produces.
 *
 *   node scripts/gate-demo.ts
 */

import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { askApproval } from '../src/gate.ts';
import { LineReader } from '../src/input.ts';

const PROPOSAL = `Cause:
  applyDiscount treats a whole-number percentage as a fraction, so
  applyDiscount(1000, 25) returns -24000 instead of 750.

Fix:
  fix[1]{file,change}:
    src/lib/cart.js,divide percentOff by 100 when it is greater than 1

Verification:
  the seeded test in tests/cart.test.js passes`;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const input = new LineReader(rl);

process.stdout.write(
  `${pc.dim('Gate demo — no model, no spend. Every answer is real; nothing is sent anywhere.')}\n` +
    `${pc.dim('Try: "drop step 2"  ·  "why that file?"  ·  just Enter  ·  "?"  ·  "y"')}\n`,
);

let shown = false;

for (;;) {
  const decision = await askApproval(
    input,
    {
      title: 'Approve this root cause and fix?',
      // Matches the workflows: once it is on screen, do not reprint it.
      ...(shown ? {} : { body: PROPOSAL }),
    },
    true,
    false,
  );

  if (decision.kind === 'approved') {
    process.stdout.write(pc.green('\n  → approved: the fix stage would run now\n'));
    break;
  }

  if (decision.kind === 'rejected') {
    process.stdout.write(pc.yellow('\n  → stopped: nothing would be written\n'));
    break;
  }

  if (decision.kind === 'discuss') {
    process.stdout.write(
      pc.cyan(`\n  → question: "${decision.question}"\n`) +
        pc.dim('    a discuss stage would answer this; the proposal is untouched\n') +
        pc.dim('    and no revision was spent\n'),
    );
    shown = true;
    continue;
  }

  process.stdout.write(
    pc.magenta(`\n  → revision: "${decision.feedback}"\n`) +
      pc.dim('    the root-cause stage would re-run with that as feedback\n'),
  );
  shown = false;
}

rl.close();
