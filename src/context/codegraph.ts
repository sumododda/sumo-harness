/**
 * CodeGraph backend: a tree-sitter symbol and call graph in local SQLite,
 * queried in this process.
 *
 * In-process matters. The same index is also reachable over MCP, but that would
 * add a tool schema to every stage's context and route answers through the
 * model. Here the harness asks the question and pastes the answer into the
 * prompt — no schema, no round trip, no tokens spent deciding what to read.
 */

import { createRequire } from 'node:module';
import type * as CodeGraphModule from '@colbymchenry/codegraph';
import * as features from '../features.ts';
import { LexicalIndex, type RankedFile } from './lexical.ts';
import type { CodeContext, Location } from './types.ts';

/**
 * Loaded through `createRequire` rather than imported.
 *
 * The package is CommonJS and builds its exports at runtime by re-exporting a
 * per-platform bundle, so Node's static analysis cannot see the named exports
 * and a plain `import { CodeGraph }` fails. The type-only import above keeps
 * full typing regardless.
 */
const { CodeGraph } = createRequire(import.meta.url)(
  '@colbymchenry/codegraph',
) as typeof CodeGraphModule;

type CodeGraph = CodeGraphModule.CodeGraph;

/**
 * How far each ring of the pack reaches.
 *
 * Three rings, narrowing: bodies for the few files a task is most likely to be
 * about, signatures for the ring around them, and bare paths beyond that. The
 * outermost ring is the cheapest thing in the pack and the one that most often
 * saves a search — a stage that can see `src/terminal/renderer.ts` exists can
 * Read it directly instead of hunting for it.
 *
 * Reading further is always available and never rationed. The rings decide what
 * arrives without being asked for, not what may be had.
 */
const RING_2 = 10;
const RING_3 = 30;

/** Languages this harness supports. Anything else is not worth indexing. */
const SUPPORTED = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'python', 'go']);

/**
 * The outer ring: files that scored, named but not opened.
 *
 * Costs a line each and answers the question a stage would otherwise spend a
 * search on — where does this live. Ranked order is the information, so it is
 * preserved and no scores are printed: a number invites arithmetic about a
 * relevance figure that means nothing on its own.
 */
function listing(ranked: readonly RankedFile[]): string {
  if (ranked.length <= RING_2) return '';
  const rest = ranked.slice(RING_2, RING_3).map((r) => `  ${r.file}`);
  if (rest.length === 0) return '';
  return (
    `\n\nAlso likely relevant, in order — Read any of these if you need more ` +
    `than the signatures above:\n${rest.join('\n')}`
  );
}

/** Exported for testing: this is layout, and layout is worth checking offline. */
export const listingForTest = listing;

export class CodeGraphContext implements CodeContext {
  readonly ready = true;
  readonly precise = false;

  private readonly graph: CodeGraph;
  private readonly root: string;
  /** Built on first use, then reused for the life of the process. */
  private ranker: LexicalIndex | null = null;
  private rankerTried = false;

  private constructor(graph: CodeGraph, root: string) {
    this.graph = graph;
    this.root = root;
  }

  /**
   * Opens the index, building it first if absent.
   *
   * Returns null rather than throwing: a missing or broken index degrades the
   * harness to reading files, which is slower and dearer but still correct.
   */
  static async open(root: string, allowInit: boolean): Promise<CodeGraphContext | null> {
    try {
      if (CodeGraph.isInitialized(root)) {
        const graph = await CodeGraph.open(root, { sync: true });
        return new CodeGraphContext(graph, root);
      }

      if (!allowInit) return null;

      const graph = await CodeGraph.init(root, { index: true });
      return new CodeGraphContext(graph, root);
    } catch {
      return null;
    }
  }

  async pack(question: string, maxChars = 3_000): Promise<string> {
    try {
      const built = await this.graph.buildContext(question, {
        format: 'markdown',
        maxNodes: 25,
        maxCodeBlocks: 6,
        maxCodeBlockSize: 800,
        searchLimit: 8,
        traversalDepth: 2,
      });

      const text = typeof built === 'string' ? built : JSON.stringify(built);
      const ranked = await this.rank(question);
      const combined = `${await this.skeletonBlock(question, ranked)}${text.trim()}${listing(ranked)}`;
      return clamp(combined, maxChars);
    } catch {
      return '';
    }
  }

  /**
   * The lexical ranking for a question, or an empty list.
   *
   * Built once and kept: the store is read from disk and unchanged files are
   * not re-tokenised, but even that is worth doing once per session rather than
   * once per stage.
   */
  private async rank(question: string): Promise<readonly RankedFile[]> {
    if (!this.rankerTried) {
      this.rankerTried = true;
      this.ranker = await LexicalIndex.open(this.root);
    }
    return this.ranker?.rank(question, RING_3) ?? [];
  }

  /**
   * Signatures without bodies, for a stage deciding whether a file is worth
   * reading in full — a name and a parameter list, not the text that used to
   * cost a whole `Read`. `getNodesInFile` reads the `signature` column the
   * index already extracted; nothing here re-parses the file.
   */
  async skeleton(paths: readonly string[]): Promise<string> {
    const sections: string[] = [];
    for (const path of paths) {
      let nodes: CodeGraphModule.Node[];
      try {
        nodes = this.graph.getNodesInFile(path);
      } catch {
        continue;
      }

      const lines = nodes
        .slice()
        .sort((a, b) => a.startLine - b.startLine)
        .map(skeletonLine)
        .filter((line): line is string => line !== null);

      if (lines.length > 0) sections.push(`${path}\n${lines.join('\n')}`);
    }
    return sections.join('\n\n');
  }

  /**
   * `pack`'s own candidate files, skeletonised — `findRelevantContext` is the
   * search-and-traverse half of `buildContext` without the code-block
   * extraction, so this reuses the exact selection the pack is built from
   * rather than asking the index a second, slightly different question.
   * Best-effort: a failure here must not cost the pack that already
   * succeeded, so it degrades to nothing rather than throwing.
   */
  private async skeletonBlock(
    question: string,
    ranked: readonly RankedFile[],
  ): Promise<string> {
    if (!features.get().skeletonContext) return '';
    try {
      // The ranker chooses when it has an opinion, because it was measured
      // choosing better: on real commits, recall@10 for the files the work
      // actually touched is 50.0% for exact match against 56.5% for this, on a
      // repository of eight thousand files. Where it has nothing to say, the
      // index's own relevance search still does.
      const files =
        ranked.length > 0
          ? ranked.slice(0, RING_2).map((r) => r.file)
          : await this.relevantFiles(question);
      const text = await this.skeleton(files);
      return text ? `Skeletons — signatures only, no bodies:\n${text}\n\n` : '';
    } catch {
      return '';
    }
  }

  /** The index's own idea of which files matter. The fallback, and the old default. */
  private async relevantFiles(question: string): Promise<string[]> {
    const found = await this.graph.findRelevantContext(question, {
      maxNodes: 25,
      searchLimit: 8,
      traversalDepth: 2,
    });
    return [...new Set([...found.nodes.values()].map((n) => n.filePath))];
  }

  async definition(symbol: string): Promise<Location[]> {
    try {
      return this.graph
        .getNodesByName(symbol)
        .filter((node) => SUPPORTED.has(node.language))
        .map((node) => ({
          file: node.filePath,
          line: node.startLine,
          symbol: node.qualifiedName || node.name,
          source: 'index' as const,
        }));
    } catch {
      return [];
    }
  }

  async references(symbol: string): Promise<Location[]> {
    try {
      const found: Location[] = [];
      for (const node of this.graph.getNodesByName(symbol)) {
        for (const usage of this.graph.findUsages(node.id)) {
          const site = (usage as { node?: { filePath?: string; startLine?: number; name?: string } })
            .node;
          if (!site?.filePath) continue;
          found.push({
            file: site.filePath,
            line: site.startLine ?? 0,
            symbol: site.name ?? symbol,
            source: 'index',
          });
        }
      }
      return dedupe(found);
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    try {
      this.graph.close();
    } catch {
      // Closing a already-closed database is not worth reporting.
    }
  }
}

/** Truncates on a line boundary so a code block never ends mid-token. */
function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return `${cut.slice(0, lastBreak > 0 ? lastBreak : maxChars)}\n…(context truncated)`;
}

function dedupe(locations: Location[]): Location[] {
  const seen = new Set<string>();
  return locations.filter((l) => {
    const key = `${l.file}:${l.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The kinds a skeleton names. Everything else — imports, properties, locals — is noise for "what does this file offer". */
const SKELETON_KINDS = new Set<CodeGraphModule.NodeKind>([
  'class',
  'interface',
  'function',
  'method',
  'constant',
]);

/**
 * One line, no body. `constant` is shown by name only, never its initializer —
 * `signature` carries the value for that kind (a template literal ran to
 * hundreds of characters in this very file), which is exactly the body text a
 * skeleton exists to leave out. It is also skipped entirely when unexported:
 * an internal constant is not part of what a file offers.
 */
function skeletonLine(node: CodeGraphModule.Node): string | null {
  if (!SKELETON_KINDS.has(node.kind)) return null;
  if (node.kind === 'constant' && !node.isExported) return null;

  if (node.kind === 'constant') return `  L${node.startLine} const ${node.name}`;

  const modifiers = [node.isStatic && 'static', node.isAsync && 'async'].filter(Boolean).join(' ');
  const prefix = modifiers ? `${modifiers} ` : '';

  if (node.kind === 'class' || node.kind === 'interface') {
    return `  L${node.startLine} ${prefix}${node.kind} ${node.name}`;
  }
  return `  L${node.startLine} ${prefix}${node.name}${node.signature ?? ''}`;
}
