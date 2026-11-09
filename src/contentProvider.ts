import * as vscode from 'vscode';
import { runGit } from './git';

export const SCHEME = 'voidgit';

interface Query {
  root: string;
  ref: string | null;
  path: string;
}

export function revisionUri(root: string, ref: string | null, filePath: string): vscode.Uri {
  const query: Query = { root, ref, path: filePath };
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + filePath, query: JSON.stringify(query) });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query) as Query;
    if (!q.ref) return '';
    try {
      return await runGit(q.root, ['show', `${q.ref}:${q.path}`]);
    } catch {
      return '';
    }
  }
}
