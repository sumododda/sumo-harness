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
  /**
   * A previous run's artifact for this task, when one still applies.
   *
   * The stage cache already covers the common case — an identical retry replays
   * for nothing — but it is keyed on the exact prompt and can be cleared or
   * evicted, and then a task that failed late pays to redo the work all over
   * again. That is the case this covers: the same task, against the same
   * repository, has the same answer whether or not anything remembered it.
   * `explore.md` (plan, feature) and `evidence.md` (fix) are both this kind of
   * artifact, hence `filename` rather than a name baked in.
   *
   * The fingerprint is what makes it safe. These artifacts describe files, so
   * reusing them across a change to those files would be worse than redoing the
   * work — it would be confidently wrong. Matching fingerprints mean the
   * repository is byte-for-byte what it was when the artifact was written.
   */
  static findArtifact(repo: RepoInfo, task: string, fingerprint: string, filename: string): string | null {
    try {
      const tasks = join(repo.root, '.sumo', 'tasks');
      // Newest first: the most recent artifact for an unchanged repo is as good
      // as any older one, and stops the scan sooner.
      for (const id of readdirSync(tasks).sort().reverse()) {
        const prior = new TaskState(repo, id);
        if (prior.read('fingerprint.txt')?.trim() !== fingerprint) continue;
        if (prior.loadProgress()?.task !== task) continue;
        const artifact = prior.read(filename);
        if (artifact && artifact.trim().length > 0) return artifact;
      }
    } catch {
      // No task directory yet, or an unreadable one. Redoing the work is always
      // correct; it is only slower.
    }
    return null;
  }

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
  /**
   * Set only when the task stopped exactly at its approval gate — rejected, or
   * the revision limit was hit — with the gate's own artifact saved beside this
   * file (`rootcause.md`/`rootcause.display.md` for `fix`, `plan.md`/
   * `plan.display.md` for `feature`) ready to re-show.
   *
   * Every other stop reason — evidence or root-cause producing nothing, the
   * ladder giving up after approval — leaves this unset, so `/resume` falls
   * back to a full re-run. Deliberately not inferred from `note`: that text is
   * for a person, and matching it would break the moment its wording changes.
   */
  readonly resumable?: 'gate';
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
