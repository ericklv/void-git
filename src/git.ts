import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type RefType = 'head' | 'remote' | 'tag';

export interface Ref {
  name: string;
  full: string;
  type: RefType;
  hash: string;
  upstream?: string;
  track?: string;
  worktree?: string;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  main: boolean;
  current: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface CommitRef {
  name: string;
  type: RefType | 'detached';
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
  refs: CommitRef[];
}

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  message: string;
  files: FileChange[];
}

export type OpState = 'rebase' | 'cherry-pick' | 'revert' | 'merge' | null;

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseEntry {
  hash: string;
  action: RebaseAction;
  message?: string;
}

export interface RebasePlan {
  base: string | null;
  commits: { hash: string; subject: string; message: string }[];
}

const FS = '\x1f';
const RS = '\x1e';

export class GitError extends Error {}

export function runGit(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env }, maxBuffer: 512 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new GitError((stderr || stdout || err.message).trim())) : resolve(stdout)),
    );
    child.stdin?.end(opts.input);
  });
}

function parseDecorations(deco: string): CommitRef[] {
  const refs: CommitRef[] = [];
  for (let part of deco.split(', ').filter(Boolean)) {
    if (part === 'HEAD') {
      refs.push({ name: 'HEAD', type: 'detached' });
      continue;
    }
    if (part.startsWith('HEAD -> ')) part = part.slice(8);
    if (part.startsWith('tag: ')) part = part.slice(5);
    if (part.startsWith('refs/heads/')) refs.push({ name: part.slice(11), type: 'head' });
    else if (part.startsWith('refs/remotes/')) {
      if (!part.endsWith('/HEAD')) refs.push({ name: part.slice(13), type: 'remote' });
    } else if (part.startsWith('refs/tags/')) refs.push({ name: part.slice(10), type: 'tag' });
  }
  return refs;
}

export class Git {
  private gitDirCache?: string;

  constructor(readonly root: string) {}

  run(args: string[], opts?: { env?: NodeJS.ProcessEnv; input?: string }): Promise<string> {
    return runGit(this.root, args, opts);
  }

  async log(max: number, ref: string | null): Promise<Commit[]> {
    const args = [
      '-c', 'log.showSignature=false', 'log', '--date-order', '--decorate=full', `-n${max}`,
      `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%s${FS}%D${RS}`,
    ];
    if (ref) args.push(ref);
    else args.push('--exclude=refs/stash', '--all');
    args.push('--');
    const out = await this.run(args);
    return out
      .split(RS)
      .map((s) => s.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, parents, author, email, date, subject, deco] = rec.split(FS);
        return { hash, parents: parents ? parents.split(' ') : [], author, email, date: +date, subject, refs: parseDecorations(deco ?? '') };
      });
  }

  async refs(): Promise<Ref[]> {
    const out = await this.run([
      'for-each-ref',
      '--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track)',
      'refs/heads', 'refs/remotes', 'refs/tags',
    ]);
    const refs: Ref[] = [];
    for (const line of out.split('\n').filter(Boolean)) {
      const [full, obj, peeled, upstream, track] = line.split(FS);
      const hash = peeled || obj;
      if (full.startsWith('refs/heads/')) refs.push({ name: full.slice(11), full, type: 'head', hash, upstream: upstream || undefined, track: track || undefined });
      else if (full.startsWith('refs/remotes/')) {
        if (!full.endsWith('/HEAD')) refs.push({ name: full.slice(13), full, type: 'remote', hash });
      } else refs.push({ name: full.slice(10), full, type: 'tag', hash });
    }
    return refs;
  }

  async worktreeList(): Promise<Worktree[]> {
    const self = path.normalize(this.root);
    const out = await this.run(['worktree', 'list', '--porcelain']);
    return out
      .split('\n\n')
      .filter((b) => b.startsWith('worktree '))
      .map((block, i) => {
        const lines = block.split('\n');
        const get = (k: string) => lines.find((l) => l === k || l.startsWith(k + ' '));
        const p = path.normalize(get('worktree')!.slice(9));
        const branch = get('branch')?.slice(7) ?? null;
        return {
          path: p,
          head: get('HEAD')?.slice(5) ?? null,
          branch: branch?.startsWith('refs/heads/') ? branch.slice(11) : branch,
          main: i === 0,
          current: p === self,
          locked: !!get('locked'),
          prunable: !!get('prunable'),
        };
      });
  }

  /** branch name -> path of every other worktree that has it checked out */
  async worktrees(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const w of await this.worktreeList()) if (w.branch && !w.current) map.set(w.branch, w.path);
    return map;
  }

  async head(): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '-q', '--verify', 'HEAD'])).trim() || null;
    } catch {
      return null;
    }
  }

  async currentBranch(): Promise<string | null> {
    try {
      return (await this.run(['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
    } catch {
      return null;
    }
  }

  async gitDir(): Promise<string> {
    if (!this.gitDirCache) this.gitDirCache = (await this.run(['rev-parse', '--absolute-git-dir'])).trim();
    return this.gitDirCache;
  }

  async state(): Promise<OpState> {
    const dir = await this.gitDir();
    const has = (f: string) => fs.existsSync(path.join(dir, f));
    if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (has('REVERT_HEAD')) return 'revert';
    if (has('MERGE_HEAD')) return 'merge';
    return null;
  }

  async details(hash: string): Promise<CommitDetails> {
    const out = await this.run(['show', '-s', `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ce${FS}%ct${FS}%B`, hash]);
    const [h, parents, author, email, date, committer, committerEmail, commitDate, message] = out.split(FS);
    const parentList = parents ? parents.split(' ') : [];
    const diffArgs = ['diff-tree', '-r', '-M', '-z', '--name-status', '--no-commit-id'];
    const raw = await this.run(parentList.length ? [...diffArgs, parentList[0], h] : [...diffArgs, '--root', h]);
    const tok = raw.split('\0');
    const files: FileChange[] = [];
    for (let i = 0; i < tok.length - 1; ) {
      const status = tok[i++];
      if (!status) continue;
      if (status[0] === 'R' || status[0] === 'C') files.push({ status, oldPath: tok[i++], path: tok[i++] });
      else files.push({ status, path: tok[i++] });
    }
    return { hash: h, parents: parentList, author, email, date: +date, committer, committerEmail, commitDate: +commitDate, message: message.trimEnd(), files };
  }

  async fullMessage(hash: string): Promise<string> {
    return (await this.run(['log', '-1', '--format=%B', hash])).trimEnd();
  }

  async parents(hash: string): Promise<string[]> {
    return (await this.run(['rev-list', '--parents', '-n1', hash])).trim().split(' ').slice(1);
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    try {
      await this.run(['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }

  // builds the commit list from `fromHash` (inclusive) to HEAD, oldest first; rejects ranges with merges
  async rebasePlan(fromHash: string): Promise<RebasePlan> {
    if (await this.state()) throw new GitError('Another git operation is in progress.');
    if (!(await this.isAncestor(fromHash, 'HEAD'))) throw new GitError('The commit is not part of the current branch.');
    const base = (await this.parents(fromHash))[0] ?? null;
    const range = base ? `${base}..HEAD` : 'HEAD';
    if ((await this.run(['rev-list', '--merges', range])).trim()) {
      throw new GitError('The range contains merge commits; rebasing across merges is not supported.');
    }
    const out = await this.run(['log', '--reverse', `--format=%H${FS}%s${FS}%B${RS}`, range]);
    const commits = out
      .split(RS)
      .map((s) => s.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, subject, message] = rec.split(FS);
        return { hash, subject, message: message.trimEnd() };
      });
    return { base, commits };
  }

  // runs `git rebase -i` with a pre-written todo; reword is implemented as pick + exec amend
  async interactiveRebase(base: string | null, entries: RebaseEntry[], tmpDir: string): Promise<void> {
    fs.mkdirSync(tmpDir, { recursive: true });
    const fwd = (p: string) => p.replace(/\\/g, '/');
    const lines: string[] = [];
    entries.forEach((e, i) => {
      if (e.action === 'reword') {
        const msgFile = path.join(tmpDir, `msg-${i}.txt`);
        fs.writeFileSync(msgFile, e.message ?? '');
        lines.push(`pick ${e.hash}`, `exec git commit --amend --only --allow-empty --no-verify -F "${fwd(msgFile)}"`);
      } else {
        lines.push(`${e.action} ${e.hash}`);
      }
    });
    const todo = path.join(tmpDir, 'todo.txt');
    fs.writeFileSync(todo, lines.join('\n') + '\n');
    await this.run(['rebase', '-i', '--autostash', base ?? '--root'], {
      env: { GIT_SEQUENCE_EDITOR: `cp "${fwd(todo)}"`, GIT_EDITOR: 'true' },
    });
  }

  async amendMessage(message: string): Promise<void> {
    await this.run(['commit', '--amend', '--only', '--allow-empty', '--no-verify', '-F', '-'], { input: message });
  }
}
