# Repository Guidelines

## Project Structure & Module Organization
- Source lives in `src/` (CLI entry `cli.ts`, setup wizard, proxy, updater, Azure config helpers). Build output is emitted to `dist/` via TypeScript.
- User-facing examples are in `examples/`; reusable MCP assets and plugins sit under `plugins/`.
- Automation helpers reside in `scripts/`; configuration generated at runtime is stored in `~/.claude-azure/config.json` (keep secrets out of the repo).

## Build, Test, and Development Commands
- `npm install` – install dependencies.
- `npm run build` – type-check and emit JS to `dist/` using `tsc` with `strict` settings.
- `npm run dev` – watch-mode rebuilds during local development.
- `npm start` – run the compiled CLI (`dist/cli.js`). After linking, invoke with `claude-azure`.
- There is no dedicated test suite yet; manually exercise the CLI with `claude-azure --setup` and `claude-azure --verbose` after changes.

## Coding Style & Naming Conventions
- TypeScript, ES2022 target, NodeNext modules; prefer async/await and explicit types over `any`.
- Follow Prettier/TypeScript defaults (2-space indent, single quotes via TS/Prettier defaults); keep imports ordered by path clarity, not alphabetized.
- Filenames are kebab-case (`proxy.ts`, `wizard.ts`); CLI flags and config keys use kebab-case. Avoid committing generated files outside `dist/`.

## Testing Guidelines
- No automated tests today; add focused unit/integration tests alongside future additions (e.g., `src/__tests__` or `tests/`) when introducing non-trivial logic.
- When modifying provider translation or proxy behavior, validate against Azure, OpenAI, and Anthropic flows using sample requests in `examples/`.
- Before submitting, run `npm run build` and a smoke pass of `claude-azure --setup` to ensure the wizard and proxy still connect.

## Commit & Pull Request Guidelines
- Commit messages: short, imperative, and specific (e.g., “Add model router mode for Azure API Management”). Avoid multi-topic commits.
- Pull requests should include: a brief summary of behavior changes, manual test notes or examples run, and any config implications (sanitize endpoints/keys).
- Reference related issues or upstream Claude Code changes when applicable; attach screenshots or logs for UX or setup wizard changes.

## Security & Configuration Tips
- Never commit API keys or endpoints; redact `~/.claude-azure/config.json` in logs. Treat sample outputs as sensitive if they contain deployment names.
- Prefer environment-variable overrides for local experimentation; reset with `claude-azure --reset` before sharing reproduction steps.
