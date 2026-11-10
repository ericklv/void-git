import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { revisionUri } from './contentProvider';
import { FileChange, Git, RebaseEntry, RefType } from './git';
import { RepoManager } from './repos';

interface RefArg {
  name: string;
  type: RefType | 'detached';
}

interface ActionMsg {
  name: string;
  hashes?: string[];
  ref?: RefArg;
  path?: string;
}

const pageSize = () => vscode.workspace.getConfiguration('voidGit').get<number>('pageSize', 1000);
const short = (h: string) => h.slice(0, 8);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class GraphController implements vscode.Disposable {
  private git?: Git;
  private maxCount = pageSize();
  private filterRefs: string[] = [];
  private filterAuthors: string[] = [];
  private busy = false;
  private refreshTimer?: NodeJS.Timeout;
  private watcher?: vscode.Disposable;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly webview: vscode.Webview,
    private readonly repos: RepoManager,
  ) {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    webview.html = this.html();
    this.disposables.push(
      webview.onDidReceiveMessage((m) => this.onMessage(m)),
      repos.onDidChange(() => this.init()),
      repos.onDidChangeList(() => (this.git ? this.refresh() : this.init())),
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private post(msg: unknown): void {
    void this.webview.postMessage(msg);
  }

  private async init(): Promise<void> {
    const root = await this.repos.current();
    this.watcher?.dispose();
    if (!root) {
      this.git = undefined;
      this.post({ type: 'error', message: 'No git repository found in the workspace.' });
      return;
    }
    this.git = new Git(root);
    this.maxCount = pageSize();
    this.filterRefs = [];
    this.filterAuthors = [];
    const gitDir = await this.git.gitDir();
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,ORIG_HEAD,FETCH_HEAD,packed-refs,refs/**,rebase-merge/**,rebase-apply/**,CHERRY_PICK_HEAD,REVERT_HEAD,MERGE_HEAD}'),
    );
    const schedule = () => {
      if (this.busy) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh(), 400);
    };
    w.onDidChange(schedule);
    w.onDidCreate(schedule);
    w.onDidDelete(schedule);
    this.watcher = w;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const git = this.git;
    if (!git) return;
    try {
      const refs = await git.refs();
      const known = new Set(['HEAD', ...refs.map((r) => r.full)]);
      this.filterRefs = this.filterRefs.filter((r) => known.has(r));
      const [repoList, commits, head, branch, state, worktrees] = await Promise.all([
        this.repos.list(),
        git.log(this.maxCount, this.filterRefs, this.filterAuthors),
        git.head(),
        git.currentBranch(),
        git.state(),
        git.worktreeList(),
      ]);
      for (const r of refs) if (r.type === 'head') r.worktree = worktrees.find((w) => w.branch === r.name && !w.current)?.path;
      this.post({
        type: 'data',
        repo: path.basename(git.root),
        root: git.root,
        repos: repoList.map((r) => ({ root: r, name: path.basename(r) })),
        commits, refs, head, branch, state, worktrees,
        filterRefs: this.filterRefs,
        filterAuthors: this.filterAuthors,
        hasMore: commits.length >= this.maxCount,
      });
    } catch (e) {
      this.post({ type: 'error', message: errorText(e) });
    }
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          return await this.init();
        case 'selectRepo':
          return await this.repos.set(m.root);
        case 'refresh':
          return await this.refresh();
        case 'loadMore':
          this.maxCount += pageSize();
          return await this.refresh();
        case 'setFilter':
          this.filterRefs = m.refs ?? [];
          this.filterAuthors = m.authors ?? [];
          this.maxCount = pageSize();
          return await this.refresh();
        case 'authors':
          return this.post({ type: 'authors', root: this.git?.root, authors: this.git ? await this.git.authors() : [] });
        case 'details':
          return this.post({ type: 'details', details: await this.git!.details(m.hash) });
        case 'openDiff':
          return await this.openDiff(m.hash, m.parent, m.file);
        case 'action':
          return await this.action(m);
        case 'runRebase':
          return void (await this.op('Interactive rebase', () => this.git!.interactiveRebase(m.base, m.entries, this.tmpDir())));
        case 'reword':
          return void (await this.op('Edit commit message', () => this.reword(m.hash, m.message)));
      }
    } catch (e) {
      vscode.window.showErrorMessage(errorText(e));
    }
  }

  private tmpDir(): string {
    return path.join(this.ctx.globalStorageUri.fsPath, 'rebase');
  }

  private async op(title: string, fn: () => Promise<unknown>): Promise<boolean> {
    this.busy = true;
    this.post({ type: 'busy', value: true });
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(`${title} failed: ${errorText(e)}`);
      return false;
    } finally {
      this.busy = false;
      this.post({ type: 'busy', value: false });
      await this.refresh();
    }
  }

  private async confirm(message: string, action: string, detail?: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  private async openDiff(hash: string, parent: string | null, file: FileChange): Promise<void> {
    const root = this.git!.root;
    const s = file.status[0];
    const left = revisionUri(root, s === 'A' ? null : parent, file.oldPath ?? file.path);
    const right = revisionUri(root, s === 'D' ? null : hash, file.path);
    const title = `${path.basename(file.path)} (${parent ? short(parent) : 'root'} ↔ ${short(hash)})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  private async reword(hash: string, message: string): Promise<void> {
    const git = this.git!;
    if (hash === (await git.head())) return git.amendMessage(message);
    const plan = await git.rebasePlan(hash);
    const entries: RebaseEntry[] = plan.commits.map((c) =>
      c.hash === hash ? { hash: c.hash, action: 'reword', message } : { hash: c.hash, action: 'pick' },
    );
    await git.interactiveRebase(plan.base, entries, this.tmpDir());
  }

  private async pushArgs(branch: string, force: boolean): Promise<string[]> {
    const git = this.git!;
    let args: string[];
    try {
      const remote = (await git.run(['config', `branch.${branch}.remote`])).trim();
      const merge = (await git.run(['config', `branch.${branch}.merge`])).trim();
      args = ['push', remote, `refs/heads/${branch}:${merge}`];
    } catch {
      const remotes = (await git.run(['remote'])).split('\n').filter(Boolean);
      if (!remotes.length) throw new Error('No remotes configured.');
      args = ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], branch];
    }
    if (force) args.splice(1, 0, '--force-with-lease');
    return args;
  }

  private async action(m: ActionMsg): Promise<void> {
    const git = this.git;
    if (!git) return;
    const hashes = m.hashes ?? [];
    const hash = hashes[0];
    const ref = m.ref;
    const target = ref ? ref.name : hash;
    const label = ref ? ref.name : hash ? short(hash) : '';
    const noEditor = { env: { GIT_EDITOR: 'true' } };

    switch (m.name) {
      case 'copyHash':
        await vscode.env.clipboard.writeText(hashes.join('\n'));
        return;
      case 'copyName':
        await vscode.env.clipboard.writeText(target);
        return;

      case 'openWorktree': {
        const wt = m.path ?? (await git.worktrees()).get(target);
        if (wt) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt), { forceNewWindow: true });
        return;
      }

      case 'copyPath':
        if (m.path) await vscode.env.clipboard.writeText(m.path);
        return;

      case 'pruneWorktrees':
        await this.op('Prune worktrees', () => git.run(['worktree', 'prune']));
        return;

      case 'removeWorktree': {
        const wt = m.path ?? (await git.worktrees()).get(target);
        if (!wt) return;
        if (!(await this.confirm(`Remove worktree ${path.basename(wt)}?`, 'Remove', `${wt}\n\nThe folder is deleted; branches and commits are kept.`))) return;
        try {
          await git.run(['worktree', 'remove', wt]);
          await this.refresh();
        } catch (e) {
          if (!/modified or untracked|locked/.test(errorText(e))) throw e;
          if (await this.confirm('The worktree has uncommitted changes or is locked. Remove anyway?', 'Force Remove', 'Uncommitted changes in that folder will be lost.')) {
            await this.op('Remove worktree', () => git.run(['worktree', 'remove', '--force', '--force', wt]));
          }
        }
        return;
      }

      case 'checkout': {
        const worktrees = await git.worktrees();
        const branchName = ref?.type === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref?.type === 'head' ? ref.name : undefined;
        const wt = branchName && worktrees.get(branchName);
        if (branchName && wt) {
          const open = 'Open Worktree in New Window';
          const detach = 'Checkout Detached';
          const choice = await vscode.window.showWarningMessage(
            `Branch '${branchName}' is already checked out in another worktree.`,
            { modal: true, detail: wt },
            open,
            detach,
          );
          if (choice === open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt), { forceNewWindow: true });
          else if (choice === detach) await this.op(`Checkout ${branchName} (detached)`, () => git.run(['checkout', '--detach', `refs/heads/${branchName}`]));
          return;
        }
        if (ref?.type === 'remote') {
          const local = ref.name.slice(ref.name.indexOf('/') + 1);
          const exists = await git.run(['show-ref', '--verify', '-q', `refs/heads/${local}`]).then(() => true, () => false);
          await this.op(`Checkout ${local}`, () => git.run(exists ? ['checkout', local] : ['checkout', '--track', ref.name]));
        } else {
          await this.op(`Checkout ${label}`, () => git.run(['checkout', ref?.type === 'tag' ? `refs/tags/${target}` : target]));
        }
        return;
      }

      case 'newBranch': {
        const name = await vscode.window.showInputBox({ prompt: `New branch at ${label}`, placeHolder: 'branch-name' });
        if (name) await this.op(`Create branch ${name}`, () => git.run(['switch', '-c', name.trim(), target]));
        return;
      }

      case 'newTag': {
        const name = await vscode.window.showInputBox({ prompt: `New tag at ${label}`, placeHolder: 'v1.0.0' });
        if (name) await this.op(`Create tag ${name}`, () => git.run(['tag', name.trim(), target]));
        return;
      }

      case 'cherryPick': {
        const merges = await Promise.all(hashes.map(async (h) => (await git.parents(h)).length > 1));
        const args = ['cherry-pick', ...(merges.some(Boolean) ? ['-m', '1'] : []), ...hashes];
        await this.op(`Cherry-pick ${hashes.length > 1 ? hashes.length + ' commits' : label}`, () => git.run(args, noEditor));
        return;
      }

      case 'revert': {
        const isMerge = (await git.parents(hash)).length > 1;
        await this.op(`Revert ${label}`, () => git.run(['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), hash]));
        return;
      }

      case 'reset': {
        const branch = (await git.currentBranch()) ?? 'HEAD';
        const mode = await vscode.window.showQuickPick(
          [
            { label: 'Soft', mode: '--soft', description: 'keep changes staged' },
            { label: 'Mixed', mode: '--mixed', description: 'keep changes unstaged' },
            { label: 'Hard', mode: '--hard', description: 'discard all changes' },
            { label: 'Keep', mode: '--keep', description: 'keep local changes, abort if they conflict' },
          ],
          { placeHolder: `Reset ${branch} to ${label}` },
        );
        if (!mode) return;
        if (mode.mode === '--hard' && !(await this.confirm(`Hard reset ${branch} to ${label}?`, 'Reset', 'Uncommitted changes will be lost.'))) return;
        await this.op(`Reset ${branch}`, () => git.run(['reset', mode.mode, hash]));
        return;
      }

      case 'undo': {
        if ((await git.parents(hash)).length === 0) throw new Error('Cannot undo the root commit.');
        await this.op('Undo commit', () => git.run(['reset', '--soft', 'HEAD~1']));
        return;
      }

      case 'reword': {
        this.post({ type: 'rewordPrompt', hash, message: await git.fullMessage(hash) });
        return;
      }

      case 'interactive': {
        const plan = await git.rebasePlan(hash);
        this.post({ type: 'rebasePlan', ...plan });
        return;
      }

      case 'squash': {
        const plan = await git.rebasePlan(hash);
        const inPlan = new Set(plan.commits.map((c) => c.hash));
        if (!hashes.every((h) => inPlan.has(h))) throw new Error('All selected commits must belong to the current branch.');
        const preset = Object.fromEntries(hashes.slice(1).map((h) => [h, 'squash']));
        this.post({ type: 'rebasePlan', ...plan, preset, squashTarget: hash });
        return;
      }

      case 'drop': {
        const plan = await git.rebasePlan(hash);
        const drop = new Set(hashes);
        if (!hashes.every((h) => plan.commits.some((c) => c.hash === h))) throw new Error('All selected commits must belong to the current branch.');
        if (!(await this.confirm(`Drop ${hashes.length > 1 ? hashes.length + ' commits' : label}?`, 'Drop'))) return;
        const entries: RebaseEntry[] = plan.commits.map((c) => ({ hash: c.hash, action: drop.has(c.hash) ? 'drop' : 'pick' }));
        await this.op('Drop commits', () => git.interactiveRebase(plan.base, entries, this.tmpDir()));
        return;
      }

      case 'rebaseOnto': {
        const branch = await git.currentBranch();
        if (!(await this.confirm(`Rebase ${branch ?? 'HEAD'} onto ${label}?`, 'Rebase'))) return;
        await this.op(`Rebase onto ${label}`, () => git.run(['rebase', '--autostash', target], noEditor));
        return;
      }

      case 'merge': {
        const branch = await git.currentBranch();
        await this.op(`Merge ${label} into ${branch ?? 'HEAD'}`, () => git.run(['merge', '--no-edit', target], noEditor));
        return;
      }

      case 'renameBranch': {
        const name = await vscode.window.showInputBox({ prompt: `Rename ${target}`, value: target });
        if (name && name !== target) await this.op(`Rename ${target}`, () => git.run(['branch', '-m', target, name.trim()]));
        return;
      }

      case 'deleteBranch': {
        if (ref?.type === 'remote') {
          const i = target.indexOf('/');
          if (!(await this.confirm(`Delete remote branch ${target}?`, 'Delete'))) return;
          await this.op(`Delete ${target}`, () => git.run(['push', target.slice(0, i), '--delete', target.slice(i + 1)]));
          return;
        }
        if (!(await this.confirm(`Delete branch ${target}?`, 'Delete'))) return;
        try {
          await git.run(['branch', '-d', target]);
          await this.refresh();
        } catch (e) {
          if (!/not fully merged/.test(errorText(e))) throw e;
          if (await this.confirm(`Branch ${target} is not fully merged. Delete anyway?`, 'Force Delete')) {
            await this.op(`Delete ${target}`, () => git.run(['branch', '-D', target]));
          }
        }
        return;
      }

      case 'deleteTag': {
        if (await this.confirm(`Delete tag ${target}?`, 'Delete')) await this.op(`Delete tag ${target}`, () => git.run(['tag', '-d', target]));
        return;
      }

      case 'push':
      case 'forcePush': {
        const branch = ref?.type === 'head' ? ref.name : await git.currentBranch();
        if (!branch) throw new Error('No branch to push (detached HEAD).');
        const force = m.name === 'forcePush';
        if (force && !(await this.confirm(`Force push ${branch}?`, 'Force Push', 'Uses --force-with-lease.'))) return;
        const args = await this.pushArgs(branch, force);
        await this.op(`Push ${branch}`, () => git.run(args));
        return;
      }

      case 'pull':
        await this.op('Pull', () => git.run(['pull', '--no-edit'], noEditor));
        return;

      case 'fetch':
        await this.op('Fetch', () => git.run(['fetch', '--all', '--prune']));
        return;

      case 'continue':
      case 'skip':
      case 'abort': {
        const s = await git.state();
        if (!s) return;
        await this.op(`${s} --${m.name}`, () => git.run([s, `--${m.name}`], noEditor));
        return;
      }
    }
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const uri = (f: string) => this.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const csp = `default-src 'none'; style-src ${this.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${this.webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('main.css')}">
</head>
<body>
<div id="toolbar">
  <span id="repo"></span><select id="repoSelect" class="hidden" title="Repository"></select>
  <button id="branchBtn" class="filter-btn secondary" title="Filter by branch"></button>
  <button id="userBtn" class="filter-btn secondary" title="Filter by author"></button>
  <input id="search" type="search" placeholder="Filter: message, author, hash">
  <span class="spacer"></span>
  <button data-cmd="fetch" title="git fetch --all --prune">Fetch</button>
  <button data-cmd="pull" title="Pull current branch">Pull</button>
  <button data-cmd="push" title="Push current branch">Push</button>
  <button data-cmd="refresh" title="Refresh">↻</button>
</div>
<div id="banner" class="hidden"></div>
<div id="main">
  <div id="refs" class="pane"></div>
  <div class="splitter" data-target="refs" data-side="left"></div>
  <div id="log" class="pane" tabindex="0">
    <div id="rows"><svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg><div id="list"></div></div>
    <div id="more"></div>
  </div>
  <div class="splitter" data-target="details" data-side="right"></div>
  <div id="details" class="pane"></div>
</div>
<div id="menu" class="hidden"></div>
<div id="picker" class="hidden"></div>
<div id="modal" class="hidden"><div id="dialog"></div></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}
