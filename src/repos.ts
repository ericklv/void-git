import * as path from 'path';
import * as vscode from 'vscode';
import { runGit } from './git';

const KEY = 'voidGit.repo';

export class RepoManager implements vscode.Disposable {
  private readonly currentEmitter = new vscode.EventEmitter<void>();
  private readonly listEmitter = new vscode.EventEmitter<void>();
  /** fires when the selected repository changes */
  readonly onDidChange = this.currentEmitter.event;
  /** fires when repositories are opened or closed */
  readonly onDidChangeList = this.listEmitter.event;
  private cache?: Promise<string[]>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()));
    void this.watchGitExtension();
  }

  private invalidate(): void {
    this.cache = undefined;
    this.listEmitter.fire();
  }

  private async gitApi(): Promise<any | undefined> {
    try {
      const ext = vscode.extensions.getExtension('vscode.git');
      if (!ext) return undefined;
      return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    } catch {
      return undefined;
    }
  }

  private async watchGitExtension(): Promise<void> {
    const api = await this.gitApi();
    if (!api) return;
    this.disposables.push(api.onDidOpenRepository(() => this.invalidate()), api.onDidCloseRepository(() => this.invalidate()));
  }

  list(): Promise<string[]> {
    this.cache ??= this.discover();
    return this.cache;
  }

  private async discover(): Promise<string[]> {
    const found = new Set<string>();
    const api = await this.gitApi();
    for (const r of api?.repositories ?? []) found.add(path.normalize(r.rootUri.fsPath));
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      try {
        found.add(path.normalize((await runGit(f.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim()));
      } catch {
        // not a repository
      }
    }
    return [...found].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }

  async current(): Promise<string | undefined> {
    const repos = await this.list();
    const saved = this.ctx.workspaceState.get<string>(KEY);
    return saved && repos.includes(saved) ? saved : repos[0];
  }

  async set(root: string): Promise<void> {
    if (root === (await this.current())) return;
    await this.ctx.workspaceState.update(KEY, root);
    this.currentEmitter.fire();
  }

  // returns the innermost known repository containing the file
  async repoFor(file: string): Promise<string | undefined> {
    const f = path.normalize(file);
    return (await this.list())
      .filter((r) => f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep))
      .sort((a, b) => b.length - a.length)[0];
  }

  async pick(): Promise<void> {
    const repos = await this.list();
    if (!repos.length) {
      vscode.window.showWarningMessage('No git repositories found in the workspace.');
      return;
    }
    const choice = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: path.basename(r), description: r, root: r })),
      { placeHolder: 'Select repository' },
    );
    if (choice) await this.set(choice.root);
  }

  dispose(): void {
    this.currentEmitter.dispose();
    this.listEmitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
