# Void Git

An IntelliJ-style git log for VS Code: a full commit graph with cherry-pick, commit message editing and interactive rebase, all from the context menu.

<!-- screenshot: media/screenshot.png -->

## Features

### Commit graph
- Full graph of all branches
- Multi-select branch filter (HEAD, local, remote, tags) and user filter by author
- Branch and tag labels next to each commit message; the current branch is highlighted
- Text filter by message, author, hash or ref name
- Commit details: full message, author, committer, parents and changed files
- Click a changed file to open its diff
- Multi-selection with Ctrl/Shift-click; arrow keys to move between commits
- Refreshes automatically when branches, HEAD or the operation state change

### Commit actions (right-click a commit)
- Copy revision number
- Checkout revision, new branch, new tag
- Cherry-pick (one or many commits, merges included)
- Revert commit
- Reset current branch to here: soft, mixed, hard or keep
- Edit commit message (amends HEAD; rebases older commits automatically)
- Undo last commit (keeps changes staged)
- Drop commit(s)
- Squash selected commits
- Interactively rebase from here
- Rebase current branch onto the commit

### Interactive rebase
- Reorder commits by dragging or with the arrow buttons
- Pick, reword, edit, squash, fixup or drop each commit
- Edit reworded messages inline
- Local changes are stashed and restored automatically (`--autostash`)

### Branches and tags (right-click a ref in the sidebar or a label in the log)
- Checkout (remote branches create a tracking branch)
- Merge into current branch, rebase current branch onto it
- Push, force push (`--force-with-lease`), pull
- Rename, delete (local, remote and tags)
- Ahead/behind counts against the upstream

### Worktrees
- Worktrees group in the sidebar with branch and state (main, locked, missing)
- Open a worktree in a new window, copy its path, remove it, prune missing ones
- Branches checked out in another worktree are marked; checking one out offers to open that worktree or check out detached

### Conflicts
When a rebase, cherry-pick, revert or merge stops on conflicts, a banner offers **Continue**, **Skip** and **Abort**. Resolve and stage the files first (for example with VS Code's merge editor).

### Multiple repositories
- Repository selector in the toolbar when the workspace has more than one repository
- Optionally follows the repository of the active file

## Usage

Open Void Git in any of these ways:
- The **Void Git** status bar item
- The Void Git button in the Source Control title bar
- The **Void Git** tab in the bottom panel
- Commands: `Void Git: Open Void Git in Editor`, `Void Git: Show Void Git Panel`, `Void Git: Select Repository`

## Settings

| Setting | Default | Description |
|---|---|---|
| `voidGit.pageSize` | `1000` | Number of commits loaded per page. More can be loaded from the bottom of the log. |
| `voidGit.followActiveEditor` | `true` | Switch to the repository of the active file. |

## Requirements

- VS Code 1.90 or newer
- `git` available on `PATH`

## Known limitations

- Interactive rebase, commit message editing, squash and drop are not supported when the range between the commit and HEAD contains merge commits.
- Pushing relies on your existing git credentials (SSH keys or a credential helper); there is no interactive login prompt.

## Development

```sh
mise install
npm install
npm run compile   # or press F5 to launch an Extension Development Host
npm run package   # builds a .vsix
```

## License

[MIT](LICENSE)
