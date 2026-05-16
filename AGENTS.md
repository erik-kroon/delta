# Agent Guidance

Use this file as the repo-local entrypoint before making changes.

## Project Shape

Delta is a local Git diff viewer.

- `apps/web`: Solid + Vite UI. It owns the file tree, diff workspace, preferences, preview state, and browser preview fallback data.
- `apps/desktop`: Electrobun shell. It owns local Git RPC handlers, repository state reads, file reads, history reads, and OS open/show actions.
- `ref/`: reference projects. Treat as read-only context unless the user explicitly asks otherwise.

## Commands

- Install: `bun install`
- Web dev server: `bun run dev:web`
- Desktop dev shell: `bun run dev:desktop`
- Type check: `bun run check-types`
- Build: `bun run build`
- Format/lint fix: `bun run check`

Prefer `bun run check-types` for fast verification after TypeScript changes. Run `bun run build` when bundling, Electrobun integration, Vite config, or dependency behavior may be affected.

## Working Rules

- Do not touch unrelated dirty files. This repo is often used from Conductor workspaces with concurrent agent work.
- Keep source-of-truth types in `apps/web/src/lib/repository.ts` and RPC shape in `apps/web/src/lib/delta-rpc-schema.ts`.
- Keep Git CLI behavior in `apps/desktop/src/bun/`; the web app should call through `deltaClient`.
- Preserve browser-preview fallback behavior in `apps/web/src/lib/delta-client.ts` and sample data in `apps/web/src/lib/repository.ts`.
- Generated router output lives in `apps/web/src/routeTree.gen.ts`; avoid manual edits unless the routing tool requires it.

## Skills

- Use `interface-craft` for UI changes in `apps/web`.
- Use `solidjs-best-practices` for Solid reactivity, effects, routing, or component refactors.
- Use `proof-repair` for failing behavior, regressions, and CI/test failures.
- Use `performance-research` before making performance claims or optimization patches.
- Use `module-deepening` before broad architecture refactors.
- Use `repo-context-bootstrap` when these context docs drift or new repo conventions need recording.

## Durable Context

- Domain terms: `CONTEXT.md`
- Code routing map: `CONTEXT-MAP.md`
- Architecture decisions: `docs/adr/`
- Agent workflow notes: `docs/agents/`
