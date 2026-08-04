/**
 * What each mode looks like, by example.
 *
 * Kept as text rather than as precomputed centroids so it stays reviewable and
 * editable: adding a phrasing is one line here, and the centroids are recomputed
 * on load in well under a millisecond. A committed vector file would be neither.
 *
 * These are deliberately *not* the phrasings `intent.ts` already matches. The
 * rules run first and answer for free, so this classifier only ever sees what
 * they could not — which means the examples that matter are the oblique ones.
 * Restating the rules here would train it on input it will never be shown.
 */

export type Label = 'chat' | 'do' | 'fix' | 'feature';

export const CORPUS: Readonly<Record<Label, readonly string[]>> = {
  // Wants to understand something. Nothing changes on disk.
  chat: [
    'walk me through how the cart totals get computed',
    'i am trying to understand the retry logic here',
    'which of these two paths runs first',
    'is there a reason this uses a map instead of an object',
    'give me the gist of this module',
    'remind me what calls into the scheduler',
    'does anything else depend on this helper',
    'compare how these two functions handle an empty list',
    'what is the difference between these two options',
    'help me understand the ordering here',
    // Questions *about* failure-flavoured behaviour. Without these the chat
    // centroid sits far from anything mentioning an empty queue or a timeout,
    // and "what happens when the queue is empty" was confidently routed to
    // `fix` — a question read as a bug report, because a static embedding
    // carries topic and not speech act. These are the examples that fixed it,
    // and removing them brings the error straight back.
    'what happens when the queue is empty',
    'how does this behave if the input is malformed',
    'what does it do when the connection times out',
    'is it expected that this returns nothing for large inputs',
    'how is a duplicate key handled here',
    'what is supposed to happen when two writers collide',
    'does this retry on failure or give up',
    'how does it decide something has gone wrong',
  ],

  // A small, well-understood change. The shape of the edit is already known.
  do: [
    'the wording in that error message could be clearer',
    'these two blocks are nearly identical, pull them together',
    'this file could use consistent quotes throughout',
    'swap the argument order on that helper so it reads better',
    'drop the unused import at the top',
    'that variable name is misleading, give it a better one',
    'move this constant next to the others',
    'tighten up the docstring on the parser',
    'the indentation in this block is off',
    'shorten that overlong line',
  ],

  // Something is behaving wrongly. The cause is not yet known.
  fix: [
    'the totals come out different on the second run',
    'this behaves differently on ci than it does locally',
    'sometimes the output is empty and i cannot tell why',
    'it stops responding once the queue fills up',
    'the numbers drift after a few thousand iterations',
    'this used to work before the last change',
    'the results come back in a different order each time',
    'it silently does nothing when the input is unusual',
    'two of the tests pass alone but not together',
    'the value is off by a little every time',
  ],

  // New capability that does not exist yet.
  feature: [
    'it would be good if this could also read from a url',
    'we need a way to undo the last operation',
    'users should be able to filter by date range',
    'let us give this a proper configuration file',
    'this ought to work over the network as well',
    'we want an option to export the results',
    'there should be a way to run these in parallel',
    'i want to be able to schedule these ahead of time',
    'extend this so it handles nested groups too',
    'make it possible to plug in a different backend',
  ],
};

/**
 * How difficult each mode's work tends to be, for the ladder.
 *
 * A guess about difficulty is worth less than a guess about mode — the ladder
 * corrects it by running the tests — so this stays coarse rather than being a
 * second classifier.
 */
export const COMPLEXITY: Readonly<Record<Label, 'trivial' | 'moderate' | 'hard'>> = {
  chat: 'trivial',
  do: 'trivial',
  fix: 'moderate',
  feature: 'moderate',
};
