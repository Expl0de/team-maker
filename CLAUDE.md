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

- **Spec Driven Development** — `docs/specs/` is the authoritative source of truth for this project's design. Every feature, endpoint, and behavior is described in a spec file before it is built. When a question arises about how something works, **read the relevant spec file first** before reading source code.

  **SDD cycle** (all new features and significant changes must follow this flow):
  1. **Spec** — Write or update the spec block (Purpose, Responsibilities, Interfaces, Behavior/Rules, Acceptance Criteria). Set status to `[ ] Pending`.
  2. **Approve** — User reviews and approves the spec. No implementation until approved.
  3. **Build** — Implement against the spec. Status moves to `[~] In Progress`.
  4. **Validate** — Run all acceptance criteria. Pass → `[✓] Validated`. Any fail → `[!] Failed`, return to Build.
  5. **Document** — Scribe marks all criteria done, advances status, updates `docs/specs/README.md` and `CLAUDE.md` if needed.

  > Hotfixes may skip step 1–2 only if the existing spec already covers the expected behavior.

  **Status markers** (appear on component blocks and on individual `- [ ]` acceptance criteria):

  | Marker | Meaning |
  |--------|---------|
  | `[ ] Pending` | Planned or exists but not yet SDD-validated |
  | `[~] In Progress` | Currently being built or changed |
  | `[x] Done` | Implemented and believed correct |
  | `[✓] Validated` | Tested and confirmed to match the spec |
  | `[!] Failed` | Validation failed — needs fix |

  **Spec files** — read the relevant file when a question touches its area:

  | File | Read when you need to know about… |
  |------|-----------------------------------|
  | [`docs/specs/00-overview.md`](docs/specs/00-overview.md) | High-level purpose, key concepts, glossary (Session, Team, Agent, Orchestrator, MCP, Task Board, Context Store, Project Memory, Model Routing) |
  | [`docs/specs/01-architecture.md`](docs/specs/01-architecture.md) | Component map, data flow diagrams, module dependency graph, NPM dependencies |
  | [`docs/specs/02-contracts.md`](docs/specs/02-contracts.md) | All REST endpoints (URL, method, request/response shapes), WebSocket message types, MCP tool schemas |
  | [`docs/specs/03-backend.md`](docs/specs/03-backend.md) | Server module internals — PTY lifecycle, session management, state persistence, JSONL parsing, message queue, context store, project memory |
  | [`docs/specs/04-frontend.md`](docs/specs/04-frontend.md) | UI components — tab management, xterm.js terminal setup, WebSocket client, modals, events/usage panels, Catppuccin theme |
  | [`docs/specs/05-agents.md`](docs/specs/05-agents.md) | Agent orchestration — MCP server architecture, all 17 MCP tools, agent lifecycle, task state machine, orchestrator pattern, model routing |

  When you change behavior covered by a spec, update the relevant spec file **and** advance the component status marker to reflect the new state. Also update `docs/specs/README.md` if the file-level status changed.

- **ES Modules** — The project uses `"type": "module"` in package.json. Use `import`/`export`, not `require`.
- **No TypeScript** — Pure JavaScript throughout.
- **node-pty pinned to 0.10.x** — v1.x prebuilds are broken on some macOS setups. Do not upgrade.
- **macOS-specific** — The folder browse feature uses `osascript` (AppleScript). The default Claude CLI path is `/Users/tung/.local/bin/claude` (overridable via `CLAUDE_PATH` env var).
- **Catppuccin Mocha theme** — The UI uses Catppuccin Mocha colors consistently across CSS and xterm.js terminal theme.
