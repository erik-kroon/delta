# Delta Context Map

Use this map to route changes to the right part of the repo.

## Root

- `package.json`: workspace scripts for Turbo, build, type check, desktop/web dev, and formatting.
- `turbo.json`: task orchestration.
- `bun.lock`: dependency lockfile.
- `README.md`: user-facing setup and feature overview.

## Web App

- `apps/web/src/routes/index.tsx`: main Delta UI route. Contains app state, toolbar, file tree integration, diff workspace integration, preview loading, preferences, keyboard shortcuts, and scroll benchmark hooks.
- `apps/web/src/lib/repository.ts`: shared repository domain types plus browser-preview sample data.
- `apps/web/src/lib/delta-rpc-schema.ts`: Electrobun RPC contract shared with desktop.
- `apps/web/src/lib/delta-client.ts`: client adapter. Uses Electrobun RPC in desktop mode and sample data in browser mode.
- `apps/web/src/styles.css`: application styling.
- `apps/web/src/components/`: small reusable UI pieces.
- `apps/web/vite.config.ts`: Vite/Solid/router build config.

## Desktop App

- `apps/desktop/src/bun/index.ts`: Electrobun window setup and RPC handler wiring.
- `apps/desktop/src/bun/git-state.ts`: Git CLI adapter behavior, repository state assembly, patch generation, file reads, history reads, and OS open/show actions.
- `apps/desktop/electrobun.config.ts`: desktop build config.

## Reference Material

- `ref/pierre`: reference for Pierre libraries and conventions.
- `ref/hunk`, `ref/codiff`: reference diff/TUI projects.

Treat `ref/` as read-only unless the user explicitly asks to modify reference material.

## Common Change Routes

- Add or change repository data shape: update `repository.ts`, `delta-rpc-schema.ts`, desktop RPC handlers, `delta-client.ts`, and any UI consumers.
- Change Git state behavior: start in `git-state.ts`; add or update shared types only if the UI contract changes.
- Change diff rendering: start in `routes/index.tsx`, especially `DiffCodeView`, CodeView options, and diff item construction.
- Change file tree behavior: start in `FileTreePane` inside `routes/index.tsx`.
- Change desktop launch/RPC wiring: start in `apps/desktop/src/bun/index.ts`.
- Change browser-only preview behavior: start in `delta-client.ts` and sample data in `repository.ts`.

## Verification Routes

- Type contract changes: `bun run check-types`
- Build or bundling changes: `bun run build`
- Formatting/lint cleanup: `bun run check`
- UI behavior: run `bun run dev:web` and inspect `http://localhost:3001`
- Desktop behavior: run `bun run dev:desktop`
