/**
 * The code-context seam.
 *
 * Answering "what code matters here" from an index costs zero tokens; letting
 * the model read its way to the same answer costs thousands. Everything above
 * this interface is indifferent to which backend supplied the answer.
 */

export interface Location {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  /** Where this came from, so a summary can say how sure it is. */
  readonly source: 'index' | 'lsp';
}

export interface CodeContext {
  /** True when a usable index exists; false means every answer will be empty. */
  readonly ready: boolean;
  /** Whether precise reference resolution is active. */
  readonly precise: boolean;

  /**
   * A compact, prompt-ready description of the code relevant to a task.
   * Bounded by `maxChars` so it can never crowd out the actual instruction.
   */
  pack(question: string, maxChars?: number): Promise<string>;

  /** Where a symbol is defined. */
  definition(symbol: string): Promise<Location[]>;

  /** Everything that references a symbol. */
  references(symbol: string): Promise<Location[]>;

  dispose(): Promise<void>;
}

/** Used when no index is available. Every answer is empty, nothing throws. */
export const NO_CONTEXT: CodeContext = {
  ready: false,
  precise: false,
  pack: async () => '',
  definition: async () => [],
  references: async () => [],
  dispose: async () => {},
};
