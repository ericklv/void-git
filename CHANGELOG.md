# Changelog

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
