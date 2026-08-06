/**
 * Requests whose correct mode is known, kept as evidence rather than as tests.
 *
 * These were assertions once. Every one of them pinned down a real misroute —
 * a polite request read as a question and answered instead of acted on, a JSDoc
 * `@throws` tag read as a crash report, an instruction to search the web sent
 * to a stage with no web tool. The rules that made each of those cases pass are
 * gone; routing is a model call now, so none of this can be asserted offline.
 *
 * Deleting them would have thrown away the only labelled record of what the
 * harness has actually got wrong. They are kept here instead, in the shape an
 * evaluation wants: run the classifier over `ROUTING_CASES` and count. That run
 * costs real money and needs a provider, which is why nothing in `npm test`
 * does it — `intent.test.ts` only checks that this file stays well-formed.
 *
 * Add a row whenever a misroute is found and fixed. A case that no longer
 * reflects what the harness should do is worth deleting; a case that is merely
 * inconvenient is the whole point.
 */

import type { Label } from '../src/intent.ts';

export interface RoutingCase {
  readonly text: string;
  readonly mode: Label;
  /** Why this row exists, when it is not obvious from the text. */
  readonly note?: string;
}

export const ROUTING_CASES: readonly RoutingCase[] = [
  // Questions. Answer from the repository, change nothing.
  { text: 'what does applyTax do?', mode: 'chat' },
  { text: 'how many functions are in cart.js', mode: 'chat' },
  { text: 'where is subtotal defined', mode: 'chat' },
  { text: 'explain the pricing logic', mode: 'chat' },
  { text: 'is this function used anywhere', mode: 'chat' },
  { text: 'walk me through how the cart totals get computed', mode: 'chat' },
  { text: 'which of these two paths runs first', mode: 'chat' },
  { text: 'is there a reason this uses a map instead of an object', mode: 'chat' },
  { text: 'does anything else depend on this helper', mode: 'chat' },
  { text: 'can you explain how applyDiscount works', mode: 'chat', note: 'polite, still a question' },
  { text: 'could you tell me where the cart total is computed', mode: 'chat' },
  { text: 'please show me the test conventions here', mode: 'chat' },

  // Questions *about* failure-flavoured behaviour. The hardest class: every
  // content word here also appears in a bug report, and only the speech act
  // separates them. A static embedding could not, and neither could a regex.
  { text: 'what happens when the queue is empty', mode: 'chat' },
  { text: 'how does this behave if the input is malformed', mode: 'chat' },
  { text: 'what does it do when the connection times out', mode: 'chat' },
  { text: 'is it expected that this returns nothing for large inputs', mode: 'chat' },
  { text: 'how is a duplicate key handled here', mode: 'chat' },
  { text: 'does this retry on failure or give up', mode: 'chat' },
  { text: 'how does it decide something has gone wrong', mode: 'chat' },

  // Mechanical edits. The shape of the change is already known.
  { text: 'fix the typo in the README', mode: 'do', note: '"fix" is not a bug here' },
  { text: 'rename sum to total', mode: 'do' },
  { text: 'add a jsdoc comment to subtotal', mode: 'do', note: '"add" is not a feature here' },
  { text: 'bump the version to 2.0', mode: 'do' },
  { text: 'format this file', mode: 'do' },
  { text: 'add the missing import', mode: 'do' },
  { text: 'create a README section', mode: 'do' },
  { text: 'drop the unused import at the top', mode: 'do' },
  { text: 'that variable name is misleading, give it a better one', mode: 'do' },
  { text: 'the wording in that error message could be clearer', mode: 'do' },
  { text: 'could you rename this variable', mode: 'do', note: 'polite instruction, not a question' },
  { text: 'can you please change the license file to apache-2.0', mode: 'do' },

  // Tidying. An edit, not an investigation.
  { text: 'the receiptLine function duplicates logic, clean it up', mode: 'do' },
  { text: 'simplify this function', mode: 'do' },
  { text: 'dedupe the money formatting', mode: 'do' },
  { text: 'extract this into a helper', mode: 'do' },
  { text: 'these two blocks are nearly identical, pull them together', mode: 'do' },
  { text: 'would you clean up the duplicated helpers', mode: 'do' },

  // Documentation edits that name failure words. Five stages at high effort
  // once went into rewriting a comment because `@throws` matched a bug pattern.
  { text: 'rewrite that jsdoc on getNote: drop the @param and @throws tags', mode: 'do' },
  { text: 'add an @error tag to the parseCart docstring', mode: 'do' },
  { text: 'remove the @throws annotation from these helpers', mode: 'do' },

  // Breakage. Something behaves wrongly and the cause is not yet known.
  { text: 'the cart total is wrong', mode: 'fix' },
  { text: 'subtotal throws on empty input', mode: 'fix' },
  { text: 'this crashes when qty is zero', mode: 'fix' },
  { text: 'applyTax returns NaN', mode: 'fix' },
  { text: 'getNote throws on an empty id', mode: 'fix', note: 'prose, not a doc tag' },
  { text: 'the parser has a bug', mode: 'fix' },
  { text: 'the totals come out different on the second run', mode: 'fix' },
  { text: 'this behaves differently on ci than it does locally', mode: 'fix' },
  { text: 'it stops responding once the queue fills up', mode: 'fix', note: 'mirror of the chat case' },
  { text: 'sometimes the output is empty and i cannot tell why', mode: 'fix' },
  { text: 'this used to work before the last change', mode: 'fix' },
  { text: 'two of the tests pass alone but not together', mode: 'fix' },
  { text: 'why does applyTax return NaN?', mode: 'fix', note: 'a question, but about a failure' },

  // Hard failures, named without any failure word at all.
  { text: 'there is a race condition in the checkout flow', mode: 'fix' },
  { text: 'deadlock in the worker pool', mode: 'fix' },
  { text: 'memory leak in the cache', mode: 'fix' },
  { text: 'the tests are flaky', mode: 'fix' },

  // New capability.
  { text: 'add a discount function', mode: 'feature' },
  { text: 'implement bulk pricing', mode: 'feature' },
  { text: 'support multiple currencies', mode: 'feature' },
  { text: 'implement a docs endpoint', mode: 'feature', note: 'real work near a doc word' },
  { text: 'add oauth login', mode: 'feature' },
  { text: 'i want you to implement a checkout endpoint', mode: 'feature' },
  { text: 'we need a way to undo the last operation', mode: 'feature' },
  { text: 'users should be able to filter by date range', mode: 'feature' },
  { text: 'there should be a way to run these in parallel', mode: 'feature' },
  { text: 'make it possible to plug in a different backend', mode: 'feature' },
  { text: 'refactor the pricing module', mode: 'feature', note: 'restructuring, nothing broken' },
  { text: 'migrate to the new API', mode: 'feature' },
  { text: 'add a web search feature to the app', mode: 'feature', note: 'building search, not searching' },
  { text: 'implement web search over the notes', mode: 'feature' },

  // Off this machine. The only mode that can leave the repository.
  { text: 'search web and see if there are any alternatives for this project', mode: 'research' },
  { text: 'search the web for alternatives to this project', mode: 'research' },
  { text: 'look online for a maintained fork', mode: 'research' },
  { text: 'check the internet for the current pricing', mode: 'research' },
  { text: 'can you google whether this API still exists', mode: 'research' },
  { text: 'find out online what replaced this library', mode: 'research' },
  { text: 'what is the newest node LTS?', mode: 'research' },
  { text: 'how does the zod 4 api differ from zod 3', mode: 'research' },
  { text: 'is picocolors still maintained', mode: 'research' },

  // Searches that are not web searches. Each carries half the old pattern.
  { text: 'search the codebase for callers of applyTax', mode: 'chat' },
  { text: 'find the function that formats money', mode: 'chat' },
  { text: 'check whether the online flag is set', mode: 'chat' },
  { text: 'fix the web scraper', mode: 'fix' },
];
