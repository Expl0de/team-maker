# Team Maker

A web-based manager for running multiple Claude Code CLI instances from a browser. Create teams of AI agents that coordinate through an orchestrator, with each agent running in its own PTY-backed terminal session streamed over WebSocket.

## Features

- **Team Management** — Create teams with an orchestrator agent that can spawn and coordinate sub-agents
- **Multi-Agent Orchestration** — Agents communicate via an MCP server, message queue, and shared task board
- **Live Terminal Streaming** — Full xterm.js terminals in the browser with scrollback, connected over WebSocket
- **Smart Model Routing** — Automatically select Claude models (Haiku/Sonnet/Opus) based on task complexity
- **Question Detection** — Alerts you with audio + visual cues when an agent needs human input
- **Persistence** — Teams, messages, tasks, and context survive server restarts
- **Team Import/Export** — Save and share team configurations as files
- **Catppuccin Mocha Theme** — Dark theme across the entire UI

## Architecture

```
Browser (xterm.js) <── WebSocket ──> Express Server <── PTY ──> Claude Code CLI
                                          │
                                     MCP Server
                                    (per-team tools:
                                     spawn_agent,
                                     send_message,
                                     task board,
                                     context sharing)
```

### Server Components

| File | Purpose |
|------|---------|
| `server/index.js` | Express HTTP + WebSocket server, REST API, static file serving |
| `server/sessionManager.js` | PTY process lifecycle, scrollback buffer, question detection |
| `server/teamManager.js` | Team CRUD, orchestrator prompt building, agent coordination |
| `server/mcpServer.js` | MCP server providing tools to agents (spawn, message, tasks) |
| `server/messageQueue.js` | Inter-agent messaging system |
| `server/taskBoard.js` | Shared task tracking across team agents |
| `server/contextStore.js` | Shared context/knowledge base for teams |
| `server/promptBuilder.js` | Role-based system prompt generation |
| `server/stateStore.js` | JSON file persistence for all state |
| `server/templateStore.js` | Team template storage and management |

### Frontend

Vanilla HTML/CSS/JS in `public/` — no build step, no framework. xterm.js and addons loaded from CDN.

## Prerequisites

- **macOS** (folder browsing uses AppleScript via `osascript`)
- **Node.js** (v18+)
- **Claude Code CLI** installed at `~/.local/bin/claude` (or set `CLAUDE_PATH` env var)

## Installation

```bash
git clone <repo-url>
cd team-maker
npm install
```

> **Note:** `node-pty` is pinned to 0.10.x due to prebuilt binary issues on some macOS setups.

## Usage

```bash
npm start
```

Open http://localhost:3456 in your browser.

### Creating a Team

1. Click **+ New Team**
2. Enter a team name, select a working directory, and optionally customize the prompt/roles
3. An orchestrator agent starts automatically
4. The orchestrator can spawn sub-agents via MCP tools, or you can click **+ New Agent** manually

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to Claude Code CLI binary |

## API

### REST Endpoints

- `GET /api/sessions` — List all sessions
- `POST /api/sessions` — Create a session
- `DELETE /api/sessions/:id` — Delete a session
- `POST /api/sessions/:id/restart` — Restart a session
- `GET /api/teams` — List all teams
- `POST /api/teams` — Create a team
- `DELETE /api/teams/:id` — Delete a team
- `POST /api/teams/:id/agents` — Add an agent to a team
- `POST /api/browse-folder` — Open native macOS folder picker

### WebSocket

Connect to `ws://localhost:3456` with a `sessionId` query parameter to attach to a terminal session. Messages are raw terminal I/O (binary) or JSON control messages.

## License

ISC
