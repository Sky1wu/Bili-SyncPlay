# Contributing

This repository uses a monorepo structure with shared protocol code, a browser extension, and a WebSocket server. The main contribution constraints below are intended to keep structural refactors and new feature work from drifting back into the same maintenance problems that were recently cleaned up.

## Workflow

- Run `npm run lint`, `npm run format:check`, `npm run build`, and `npm test` before merging structural changes.
- When refactoring, update or add regression tests in the same change.
- Keep formatting-only changes separate from behavior changes whenever practical.

## Commit Conventions

- Prefer Conventional Commit style prefixes such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, and `ci:`.
- Keep the subject line concise and focused on the primary change in that commit.
- A single commit should represent one reviewable unit of change.
- Do not hide behavior changes inside `chore:` or `docs:` commits.
- Use `refactor:` only when behavior is intended to stay unchanged; if behavior changes, use a more accurate prefix.

## Structural Constraints

- Keep entry files thin. `index.ts` files should mainly handle bootstrap, wiring, and a small amount of high-level orchestration.
- Before adding more branching logic to an entry file, prefer extracting pure helpers, state stores, or controllers.
- Do not reintroduce large mixed files that combine template strings, DOM updates, business rules, and message dispatch in one place.
- Keep popup rendering, popup actions, and popup state management separated.

## Shared Sources Of Truth

- Shared URL normalization must remain centralized.
- Protocol types and guards must remain centralized under `@bili-syncplay/protocol`.
- Server environment parsing must remain centralized in the server config layer.
- Preserve public import stability for `@bili-syncplay/protocol`; internal refactors should still export through the package root.

## Testing Focus

Refactors that touch these areas should include regression coverage:

- extension sync flow
- popup state and rendering flow
- server config loading
- protocol validation
- server room lifecycle and admin routing

## Documentation

- Update `README.md` and `README.zh-CN.md` when developer-facing commands or workflows change.
- Update relevant files under `docs/` when a structural refactor changes the intended architecture or module boundaries.
