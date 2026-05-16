# Delta Context

Delta is a local Git diff viewer for reviewing repository changes. It combines a Solid web UI with an Electrobun desktop shell backed by the local `git` CLI.

## Domain Terms

- Repository: the Git repository being reviewed. The desktop shell resolves the repository root from the launch path.
- Review source: either the current working tree or a commit ref.
- Repository state: the full data snapshot used by the UI: changed files, tree files, source, root, launch path, and generation time.
- Review workspace: the UI session module that owns repository state, selection, preview file loading, viewed state, collapsed state, refresh, and review navigation.
- Changed file: a path with Git status, optional old path, fingerprint, and one or more diff sections.
- Diff section: one patch for a changed file. Current kinds are `staged`, `unstaged`, and `commit`.
- Tree files: repository paths used to populate the file tree, including tracked files, untracked files, and relevant renamed paths.
- Preview file: a non-changed tree file loaded as full contents for read-only display.
- Viewed state: per-repository local UI state that records a changed file fingerprint as reviewed.
- Collapsed state: in-memory UI state that hides a file's diff body.
- Browser preview: non-Electrobun mode using sample repository data so the web app can run in a regular browser.

## Invariants

- Web code should treat `RepositoryState` as immutable input from the client.
- File fingerprints represent the visible diff/file content version used for viewed state and render caching.
- Repository file paths must stay inside the repository root before reading from disk.
- Untracked text files need synthetic patches because plain `git diff` does not emit their content.
- Binary files should avoid text contents in RPC responses and diff rendering.
- Commit sources must resolve to verified commits before file or state reads.

## External Libraries

- `@pierre/trees`: file tree rendering and selection.
- `@pierre/diffs`: diff parsing and `CodeView` rendering.
- `electrobun`: desktop shell and webview RPC.
- `@tanstack/solid-router`: route generation and routing.
- `@tanstack/solid-hotkeys`: keyboard shortcuts.

## Current Context Gaps

- No issue tracker or label convention is recorded yet.
- No ADRs are recorded yet.
- No fixture repository tests are present for Git state behavior.
