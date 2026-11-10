# Changelog

## 0.2.0

- Multi-select branch filter: show commits reachable from any combination of HEAD, local branches, remote branches and tags
- Multi-select user filter: show commits from selected authors (matched by email), with commit counts
- Searchable filter pickers with clear action; filters reset when switching repositories
- Stale refs are dropped from the branch filter automatically

## 0.1.0

Initial release.

- Commit graph for all branches or a single ref, with branch/tag labels, text filter and commit details
- Side-by-side diff for changed files
- Commit actions: checkout, new branch/tag, cherry-pick (multi-commit, merge-aware), revert, reset (soft/mixed/hard/keep), undo commit, copy hash
- Commit message editing for HEAD (amend) and older commits (scripted rebase)
- Interactive rebase dialog: reorder, pick, reword, edit, squash, fixup, drop; squash/drop of selected commits
- Ref actions: checkout with tracking, merge, rebase onto, push, force push with lease, pull, fetch, rename, delete
- Worktree support: sidebar group, open in new window, remove, prune, detection of branches checked out elsewhere
- Continue/skip/abort banner for rebase, cherry-pick, revert and merge
- Multi-repository selector and `voidGit.followActiveEditor`
