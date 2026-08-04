/**
 * Optional precision layer: real language servers, driven by the harness.
 *
 * An index and a language server answer different questions. The index answers
 * "what code is relevant here" — a search a language server cannot perform. The
 * server answers "where exactly is this defined, and who references it" with
 * compiler-grade accuracy the index only approximates. So search always stays
 * with the index, and only reference questions are upgraded.
 *
 * Both are free of tokens. This one costs startup time instead, which is why it
 * is off unless asked for.
 *
 * Only the three languages this harness supports get a server. Adding more is
 * deliberately not a goal.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createProtocolConnection,
  DefinitionRequest,
  InitializedNotification,
  InitializeRequest,
  type Location as LspLocation,
  ReferencesRequest,
  StreamMessageReader,
  StreamMessageWriter,
  type ProtocolConnection,
  // `/node`, not `/node.js`. 3.18 added an `exports` map that names the subpath
  // without an extension, so the `.js` form resolves only against the older
  // layout — it worked here purely because this machine had 3.17 on disk.
} from 'vscode-languageserver-protocol/node';
import type { CodeContext, Location } from './types.ts';

export type Lang = 'ts' | 'py' | 'go';

interface ServerSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly label: string;
  /** What the user should run to get it. Shown when the binary is absent. */
  readonly install: string;
}

const SERVERS: Record<Lang, ServerSpec> = {
  ts: {
    bin: 'typescript-language-server',
    args: ['--stdio'],
    label: 'TypeScript / JavaScript',
    install: 'npm i -g typescript-language-server typescript',
  },
  py: {
    bin: 'pyright-langserver',
    args: ['--stdio'],
    label: 'Python',
    install: 'npm i -g pyright',
  },
  go: {
    bin: 'gopls',
    args: [],
    label: 'Go',
    install: 'go install golang.org/x/tools/gopls@latest',
  },
};

export interface ServerStatus {
  readonly lang: Lang;
  readonly label: string;
  readonly bin: string;
  readonly installed: boolean;
  readonly install: string;
}

/**
 * Reports which language servers are present.
 *
 * Nothing is installed automatically. These are per-language toolchains — gopls
 * wants Go, pyright wants Node — and quietly putting them on someone's machine
 * is a bigger surprise than telling them what to run.
 */
export function serverStatus(): ServerStatus[] {
  return (Object.keys(SERVERS) as Lang[]).map((lang) => {
    const spec = SERVERS[lang];
    return {
      lang,
      label: spec.label,
      bin: spec.bin,
      installed: onPath(spec.bin),
      install: spec.install,
    };
  });
}

function onPath(bin: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const EXTENSIONS: Record<string, Lang> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.js': 'ts',
  '.jsx': 'ts',
  '.mjs': 'ts',
  '.cjs': 'ts',
  '.py': 'py',
  '.go': 'go',
};

const INIT_TIMEOUT_MS = 10_000;

interface Server {
  readonly connection: ProtocolConnection;
  readonly process: ChildProcess;
  readonly opened: Set<string>;
}

/**
 * Wraps another context, upgrading reference answers when a server is available
 * and silently deferring to the wrapped one when it is not.
 */
export class LspContext implements CodeContext {
  private readonly inner: CodeContext;
  private readonly root: string;
  private readonly enabled: ReadonlySet<Lang>;
  private readonly servers = new Map<Lang, Server | null>();
  private everStarted = false;

  constructor(inner: CodeContext, root: string, enabled: readonly Lang[]) {
    this.inner = inner;
    this.root = root;
    this.enabled = new Set(enabled);
  }

  get ready(): boolean {
    return this.inner.ready;
  }

  /** True only once a server has actually answered something. */
  get precise(): boolean {
    return this.everStarted;
  }

  /** Search is never upgraded — a language server cannot do it. */
  pack(question: string, maxChars?: number): Promise<string> {
    return this.inner.pack(question, maxChars);
  }

  async definition(symbol: string): Promise<Location[]> {
    return this.upgrade(symbol, DefinitionRequest.type.method);
  }

  async references(symbol: string): Promise<Location[]> {
    return this.upgrade(symbol, ReferencesRequest.type.method);
  }

  /**
   * Language-server requests are position-based; this interface is name-based.
   * The index resolves the name to a declaration position, then the server
   * answers precisely from there. The index finds it; the server confirms it.
   */
  private async upgrade(symbol: string, method: string): Promise<Location[]> {
    const anchors = await this.inner.definition(symbol);
    if (anchors.length === 0) return [];

    const results: Location[] = [];
    for (const anchor of anchors) {
      const lang = EXTENSIONS[extname(anchor.file).toLowerCase()];
      if (!lang || !this.enabled.has(lang)) continue;

      const server = await this.serverFor(lang);
      if (!server) continue;

      try {
        const found = await this.query(server, method, anchor, symbol);
        results.push(...found);
      } catch {
        // One failed request must not lose the answer the index already gave.
      }
    }

    return results.length > 0 ? results : this.fallback(method, symbol, anchors);
  }

  private fallback(method: string, symbol: string, anchors: Location[]): Promise<Location[]> {
    return method === DefinitionRequest.type.method
      ? Promise.resolve(anchors)
      : this.inner.references(symbol);
  }

  private async query(
    server: Server,
    method: string,
    anchor: Location,
    symbol: string,
  ): Promise<Location[]> {
    const absolute = isAbsolute(anchor.file) ? anchor.file : join(this.root, anchor.file);
    const uri = pathToFileURL(absolute).toString();

    if (!server.opened.has(uri)) {
      // Awaited rather than fired and forgotten: a notification to a server
      // that has already exited rejects, and an unawaited rejection here would
      // take the whole harness down over an optional precision layer.
      await server.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageIdFor(absolute),
          version: 1,
          text: readFileSync(absolute, 'utf8'),
        },
      });
      server.opened.add(uri);
    }

    // LSP positions are zero-based; the index reports one-based lines.
    const line = Math.max(0, anchor.line - 1);
    const character = columnOf(absolute, line, symbol);

    // `sendRequest` with a method name rather than a typed descriptor answers
    // `unknown`; the cast is what states the shape the LSP spec promises here.
    // ESLint reads the overload differently from `tsc`, which rejects the build
    // without this — the compiler is the authority, so the rule stands down.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const response = (await server.connection.sendRequest(method, {
      textDocument: { uri },
      position: { line, character },
      ...(method === ReferencesRequest.type.method
        ? { context: { includeDeclaration: false } }
        : {}),
    })) as LspLocation[] | LspLocation | null;

    return toLocations(response, symbol);
  }

  /** Spawns a server on first use; null means unavailable for the rest of the run. */
  private async serverFor(lang: Lang): Promise<Server | null> {
    const existing = this.servers.get(lang);
    if (existing !== undefined) return existing;

    const server = await this.start(lang);
    this.servers.set(lang, server);
    if (server) this.everStarted = true;
    return server;
  }

  private async start(lang: Lang): Promise<Server | null> {
    const spec = SERVERS[lang];

    try {
      const child = spawn(spec.bin, [...spec.args], {
        cwd: this.root,
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      // A missing binary surfaces here rather than as an unhandled rejection.
      const spawned = await new Promise<boolean>((resolve) => {
        child.once('error', () => resolve(false));
        child.once('spawn', () => resolve(true));
      });
      // A child process with no `error` listener throws when one fires, and the
      // listener above is spent as soon as it spawns. Language servers die on
      // their own — a bad workspace, an OOM — and none of that should be able
      // to end a session that was only ever using them as an optional upgrade.
      child.on('error', () => {});
      if (!spawned || !child.stdout || !child.stdin) return null;

      const connection = createProtocolConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin),
      );
      connection.listen();

      await withTimeout(
        connection.sendRequest(InitializeRequest.type.method, {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).toString(),
          capabilities: {},
          workspaceFolders: null,
        }),
        INIT_TIMEOUT_MS,
      );
      await connection.sendNotification(InitializedNotification.type.method, {});

      return { connection, process: child, opened: new Set() };
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    for (const server of this.servers.values()) {
      if (!server) continue;
      try {
        server.connection.dispose();
        server.process.kill();
      } catch {
        // A server that already exited needs no shutdown.
      }
    }
    this.servers.clear();
    await this.inner.dispose();
  }
}

function toLocations(
  response: LspLocation[] | LspLocation | null,
  symbol: string,
): Location[] {
  if (!response) return [];
  const list = Array.isArray(response) ? response : [response];

  return list
    .filter((item): item is LspLocation => typeof item?.uri === 'string')
    .map((item) => ({
      // Decoded rather than string-stripped: a URI percent-encodes anything a
      // path may not carry literally, so `src/my tests/a.ts` comes back as
      // `src/my%20tests/a.ts` and stripping the scheme alone leaves a path that
      // does not exist.
      file: pathOf(item.uri),
      line: item.range.start.line + 1,
      symbol,
      source: 'lsp' as const,
    }));
}

function pathOf(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    // Not a file: URI — a server answering about something outside the
    // filesystem is better reported verbatim than mangled.
    return uri;
  }
}

/** Finds the symbol's column on its declaration line, so the server aims true. */
function columnOf(file: string, zeroBasedLine: number, symbol: string): number {
  try {
    const line = readFileSync(file, 'utf8').split('\n')[zeroBasedLine] ?? '';
    const at = line.indexOf(symbol);
    return at >= 0 ? at : 0;
  } catch {
    return 0;
  }
}

function languageIdFor(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    default:
      return 'javascript';
  }
}

/**
 * Fails a request that a server never answers.
 *
 * The timer is cleared once the race settles. Left running it would hold the
 * event loop open, so `sumo` would sit for the full timeout after the user asked
 * it to exit — for a request that had already succeeded.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('lsp timeout')), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
