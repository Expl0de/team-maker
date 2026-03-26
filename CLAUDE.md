# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Team Maker is a web-based manager for running multiple Claude Code CLI instances from a browser. It spawns PTY-backed Claude Code processes and streams terminal I/O over WebSocket to an xterm.js frontend.

## Commands

- **Start server**: `npm start` (runs on http://localhost:3456)
- No build step, linter, or test suite configured.

## Architecture

```
Browser (xterm.js) <--WebSocket--> Express Server <--PTY--> Claude Code CLI
```

**Server modules** (all in `server/`):
- **index.js** — Express HTTP + WebSocket server. REST endpoints for session/team/task CRUD, `/api/browse-folder` via `osascript`, WebSocket terminal I/O proxy.
- **sessionManager.js** — Singleton managing PTY-backed Claude CLI processes. 100KB scrollback, question detection (ANSI-stripped pattern matching), `{type:"question"}` WebSocket events.
- **teamManager.js** — Team CRUD, orchestrator spawn, sub-agent management, MCP config generation, model routing (ceiling semantics).
- **taskBoard.js** — Task state machine (pending → assigned → in_progress → completed/failed), dependency resolution, complexity-based model routing.
- **messageQueue.js** — Inter-agent messaging: server-side queue + PTY injection for instant delivery.
- **contextStore.js** — Team-scoped key-value knowledge store. 500KB cap with LRU eviction.
- **stateStore.js** — JSON persistence with dot-path get/set, debounced writes to disk.
- **jsonlParser.js** — JSONL log parser. `fs.watch` + adaptive polling; structured source of truth for agent activity.
- **promptBuilder.js** — Orchestrator prompt generation. Built-in and custom role definitions.
- **projectMemoryStore.js** — File-based project memory persisted at `<cwd>/.team-maker/project-memory.json`.
- **templateStore.js** — Team role template CRUD.
- **mcpServer.js** — MCP sidecar (StdioServerTransport). Exposes 17 tools that proxy to the REST API.

**Frontend** (`public/`): Vanilla HTML/CSS/JS, no build step. xterm.js from CDN. `app.js` manages tabs, WebSocket connections, terminal instances, working-directory modal, Web Audio alerts, and stuck-agent overlay.

## Key Conventions

- **Spec Driven Development** — `docs/specs/` is the source of truth for this project's design. See [`docs/specs/README.md`](docs/specs/README.md) for the full workflow (Spec → Approve → Build → Validate → Document) and status marker conventions (`[ ] Pending`, `[~] In Progress`, `[x] Done`, `[✓] Validated`, `[!] Failed`). Spec files by area:
  - `00-overview.md` — feature list and project goals
  - `01-architecture.md` — component map and data flows
  - `02-contracts.md` — REST endpoints and MCP tool schemas
  - `03-backend.md` — server module implementation details
  - `04-frontend.md` — UI components
  - `05-agents.md` — agent orchestration and model routing
  When you change behavior covered by a spec, update the relevant spec file **and** advance the component status marker to reflect the new state.

- **ES Modules** — The project uses `"type": "module"` in package.json. Use `import`/`export`, not `require`.
- **No TypeScript** — Pure JavaScript throughout.
- **node-pty pinned to 0.10.x** — v1.x prebuilds are broken on some macOS setups. Do not upgrade.
- **macOS-specific** — The folder browse feature uses `osascript` (AppleScript). The default Claude CLI path is `/Users/tung/.local/bin/claude` (overridable via `CLAUDE_PATH` env var).
- **Catppuccin Mocha theme** — The UI uses Catppuccin Mocha colors consistently across CSS and xterm.js terminal theme.
