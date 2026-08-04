/**
 * The BERT WordPiece tokenizer the router's embedding table was built with.
 *
 * Written out rather than pulled in because it is the only piece of the model
 * that is code, and it is about a hundred lines. A dependency here would be a
 * dependency on someone else's build of a native or WASM runtime, which is the
 * one thing this whole approach exists to avoid — the router has to work on
 * every architecture without a compiler.
 *
 * It follows `tokenizer.json` from the upstream model exactly: a BertNormalizer
 * (clean, lowercase, strip accents), a BertPreTokenizer (split on whitespace and
 * punctuation), then greedy longest-match WordPiece with a `##` continuation
 * prefix. Deviating anywhere produces ids that index the wrong rows, which does
 * not fail — it silently embeds nonsense.
 */

const UNK = '[UNK]';
const PREFIX = '##';
/** Upstream refuses to sub-tokenise anything longer and emits [UNK] instead. */
const MAX_WORD_CHARS = 100;

/**
 * `clean_text` + `lowercase` + `strip_accents`.
 *
 * Accent stripping is on because the upstream normaliser leaves `strip_accents`
 * null, which BERT resolves to "follow lowercase" — and lowercase is true.
 */
function normalise(text: string): string {
  return (
    text
      // Null and the replacement character are deleted outright, as upstream
      // `clean_text` does, before anything else looks at the string.
      // eslint-disable-next-line no-control-regex -- matching NUL is the point
      .replace(/[\u0000\uFFFD]/gu, '')
      // Other control characters are dropped. The three that count as
      // whitespace are left for the collapse below to turn into spaces.
      // eslint-disable-next-line no-control-regex -- matching them is the point
      .replace(/(?![\t\n\r])[\u0000-\u001F\u007F]/gu, '')
      // Tabs, newlines and runs of spaces all become one space, so the
      // pre-tokeniser has a single thing to split on.
      .replace(/\s+/gu, ' ')
      .toLowerCase()
      // NFD splits a letter from its accent, so the accents can be removed as
      // their own category.
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '')
      .trim()
  );
}

/** True for the characters BERT treats as punctuation, which is broader than \p{P}. */
function isPunctuation(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  ) {
    return true;
  }
  return /\p{P}|\p{S}/u.test(ch);
}

/**
 * Splits on whitespace, then peels punctuation off as separate tokens.
 *
 * This is why `@throws` and `throws` tokenise differently, and why the router
 * can tell a documentation tag from a description of a crash — the `@` survives
 * as its own token rather than being folded into the word.
 */
export function preTokenize(text: string): string[] {
  const out: string[] = [];
  for (const chunk of normalise(text).split(' ')) {
    if (chunk.length === 0) continue;
    let current = '';
    for (const ch of chunk) {
      if (isPunctuation(ch)) {
        if (current.length > 0) out.push(current);
        out.push(ch);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}

/** Greedy longest-match-first WordPiece, as the model was trained with. */
export function wordPiece(word: string, vocab: ReadonlyMap<string, number>): number[] {
  if (word.length > MAX_WORD_CHARS) return [vocab.get(UNK) ?? 0];

  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let matched: number | undefined;
    while (start < end) {
      const piece = start === 0 ? word.slice(start, end) : `${PREFIX}${word.slice(start, end)}`;
      const id = vocab.get(piece);
      if (id !== undefined) {
        matched = id;
        break;
      }
      end -= 1;
    }
    // One unmatchable piece makes the whole word unknown — a partial
    // decomposition would embed something the model never saw as that word.
    if (matched === undefined) return [vocab.get(UNK) ?? 0];
    ids.push(matched);
    start = end;
  }
  return ids;
}

/** Text to vocabulary ids. Unknown words collapse to a single [UNK]. */
export function encode(text: string, vocab: ReadonlyMap<string, number>): number[] {
  return preTokenize(text).flatMap((word) => wordPiece(word, vocab));
}
