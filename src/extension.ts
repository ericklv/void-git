import * as vscode from 'vscode';
import { GitContentProvider, SCHEME } from './contentProvider';
import { GraphController } from './controller';
import { RepoManager } from './repos';

export function activate(ctx: vscode.ExtensionContext): void {
  const repos = new RepoManager(ctx);
  const controllers = new Set<GraphController>();
  let editorPanel: vscode.WebviewPanel | undefined;
  const track = (c: GraphController, onDispose: vscode.Event<void>) => {
    controllers.add(c);
    onDispose(() => {
      controllers.delete(c);
      c.dispose();
    });
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(git-merge) Void Git';
  status.tooltip = 'Open Void Git';
  status.command = 'voidGit.open';
  status.show();

  ctx.subscriptions.push(
    status,
    repos,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    vscode.window.registerWebviewViewProvider(
      'voidGit.view',
      { resolveWebviewView: (view) => track(new GraphController(ctx, view.webview, repos), view.onDidDispose) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('voidGit.open', () => {
      if (editorPanel) {
        editorPanel.reveal();
        return;
      }
      const panel = editorPanel = vscode.window.createWebviewPanel('voidGit.panel', 'Void Git', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
      });
      panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
      track(new GraphController(ctx, panel.webview, repos), panel.onDidDispose);
      panel.onDidDispose(() => (editorPanel = undefined));
    }),
    vscode.commands.registerCommand('voidGit.show', () => vscode.commands.executeCommand('voidGit.view.focus')),
    vscode.commands.registerCommand('voidGit.refresh', () => controllers.forEach((c) => c.refresh())),
    vscode.commands.registerCommand('voidGit.selectRepo', () => repos.pick()),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document.uri.scheme !== 'file') return;
      if (!vscode.workspace.getConfiguration('voidGit').get<boolean>('followActiveEditor', true)) return;
      const root = await repos.repoFor(editor.document.uri.fsPath);
      if (root) await repos.set(root);
    }),
  );
}

export function deactivate(): void {}
