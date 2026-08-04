/**
 * Task state lives in `.sumo/` inside the target repo — owned by the harness,
 * durable, and independent of any provider's session storage. Nothing here
 * depends on which engine ran the task.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoInfo {
  readonly root: string;
  readonly isGit: boolean;
}

/** Finds the repo root, falling back to the current directory outside git. */
export function findRepo(from: string = process.cwd()): RepoInfo {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { root, isGit: true };
  } catch {
    return { root: from, isGit: false };
  }
}

/** A task's own directory: artifacts, ledger, and progress cursor. */
export class TaskState {
  readonly dir: string;
  readonly repo: RepoInfo;
  readonly id: string;

  constructor(repo: RepoInfo, id: string) {
    this.repo = repo;
    this.id = id;
    this.dir = join(repo.root, '.sumo', 'tasks', id);
    mkdirSync(this.dir, { recursive: true });
    hideToolingFromGit(repo);
  }

  /** Deterministic, sortable, and free of clock skew concerns within a run. */
  static newId(kind: string, at: Date = new Date()): string {
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    return `${stamp}-${kind}`;
  }

  write(name: string, contents: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  read(name: string): string | null {
    try {
      return readFileSync(join(this.dir, name), 'utf8');
    } catch {
      return null;
    }
  }

  /** Records progress so an interrupted task can be picked up later. */
  saveProgress(progress: TaskProgress): void {
    this.write('task.json', JSON.stringify(progress, null, 2));
  }

  loadProgress(): TaskProgress | null {
    const raw = this.read('task.json');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TaskProgress;
    } catch {
      return null;
    }
  }

  /** The most recent task in this repo, or null when there is none. */
  static latest(repo: RepoInfo): TaskState | null {
    try {
      const tasks = join(repo.root, '.sumo', 'tasks');
      // Ids start with a sortable timestamp, so the last name is the newest.
      const ids = readdirSync(tasks).sort();
      const id = ids[ids.length - 1];
      return id ? new TaskState(repo, id) : null;
    } catch {
      return null;
    }
  }
}

/** What a task had achieved when it last wrote to disk. */
export interface TaskProgress {
  readonly mode: 'fix' | 'feature' | 'plan' | 'do';
  readonly task: string;
  /** The last stage that completed. */
  readonly stage: string;
  readonly branch?: string | null;
  /** True once the task reached a terminal state. */
  readonly finished: boolean;
  readonly note?: string;
}

/**
 * Keeps sumo's own directories out of git status.
 *
 * Written to `.git/info/exclude` rather than `.gitignore`: the latter is
 * version-controlled, and adding our tooling to someone's committed ignore file
 * would show up in their next diff.
 */
export function hideToolingFromGit(repo: RepoInfo): void {
  if (!repo.isGit) return;
  const excludePath = join(repo.root, '.git', 'info', 'exclude');
  try {
    let current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const lines = new Set(current.split('\n').map((l) => l.trim()));

    // `.codegraph/` belongs here too — the index is a local cache, and leaving
    // it untracked-but-visible clutters every `git status` the user runs.
    const additions = ['.sumo/', '.codegraph/'].filter((dir) => !lines.has(dir));
    if (additions.length === 0) return;

    current = current.replace(/\n?$/, '\n');
    writeFileSync(excludePath, `${current}${additions.join('\n')}\n`, 'utf8');
  } catch {
    // A read-only .git is not worth failing a task over.
  }
}
