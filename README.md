# Team Maker

A web-based manager for running multiple Claude Code CLI instances from a browser with team-based agent orchestration. Spawn PTY-backed Claude Code processes and stream terminal I/O over WebSocket to an xterm.js frontend.

![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Multi-Session Terminal** — Run multiple Claude Code CLI instances side-by-side in browser tabs
- **Team Orchestration** — Group agents into teams with an orchestrator (Agent 0) that coordinates sub-agents via MCP tools
- **Role-Based Agents** — Built-in roles (Architect, Builder, Validator, Scribe) and custom role definitions
- **File-Based Communication** — Agents communicate through shared markdown files (`AGENT_COMMUNICATE.md`, `MULTI_AGENT_PLAN.md`)
- **Template System** — Save and reuse team role configurations
- **Activity Tracking** — Visual indicators for agent activity, question prompts, and exit states
- **Audio Alerts** — Web Audio notification when an agent asks a permission question
- **Catppuccin Mocha Theme** — Dark theme across the UI and terminal

## Architecture

```
Browser (xterm.js) ──WebSocket──▶ Express Server ──PTY──▶ Claude Code CLI
                                       │
                                       ├── Session Manager (PTY lifecycle, scrollback, activity)
                                       ├── Team Manager (agent spawning, MCP config)
                                       ├── MCP Server (spawn_agent, list_agents, send_message)
                                       ├── Prompt Builder (orchestrator prompts, role definitions)
                                       └── Template Store (JSON persistence)
```

## Prerequisites

- **macOS** (uses `osascript` for native Finder folder dialog)
- **Node.js** >= 18
- **Claude Code CLI** installed at `~/.local/bin/claude` (or set `CLAUDE_PATH` env var)

## Getting Started

```bash
# Clone the repository
git clone <repo-url>
cd team-maker

# Install dependencies
npm install

# Start the server
npm start
```

Open **http://localhost:3456** in your browser.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `CLAUDE_PATH` | `/Users/tung/.local/bin/claude` | Path to Claude Code CLI binary |

## Usage

### Individual Sessions

1. Click **+ New Agent** to spawn a standalone Claude Code session
2. Select a working directory via the native Finder dialog
3. Interact with the terminal directly in the browser tab

### Team Orchestration

1. Click **+ New Team** in the sidebar
2. Configure:
   - **Team name** and **working directory**
   - **Task prompt** — describe what the team should accomplish
   - **Roles** — use built-in defaults or customize via the role editor
   - **Wake interval** — how often agents poll for new messages (10-600s, default 60s)
3. The orchestrator (Agent 0) spawns automatically and:
   - Creates a `.team-maker/<session-id>/` directory structure
   - Writes shared planning documents
   - Spawns sub-agents with tailored role prompts via MCP tools
4. Agents coordinate through file-based communication and shared plan files

### Role Editor

- **Built-in roles**: Architect, Builder, Validator, Scribe
- **Extra roles** (quick-add): DevOps, Security Auditor, Designer, Reviewer
- **Custom roles**: Add your own with title, responsibility, and description
- **Templates**: Save role configurations for reuse across teams

## API Endpoints

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions` | Create a session |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Kill a session |
| `POST` | `/api/sessions/:id/resize` | Resize terminal |
| `POST` | `/api/sessions/:id/input` | Inject PTY input |

### Teams

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/teams` | Create a team |
| `GET` | `/api/teams` | List all teams |
| `GET` | `/api/teams/:teamId` | Get team with agents |
| `DELETE` | `/api/teams/:teamId` | Destroy team and all agents |
| `POST` | `/api/teams/:teamId/agents` | Spawn an agent in team |
| `GET` | `/api/teams/:teamId/agents` | List agents in team |
| `DELETE` | `/api/teams/:teamId/agents/:agentId` | Remove an agent |

### Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/templates` | List saved templates |
| `POST` | `/api/templates` | Save a template |
| `DELETE` | `/api/templates/:id` | Delete a template |
| `GET` | `/api/builtin-roles` | Get built-in and extra roles |

### WebSocket Protocol

**Client to Server:**
- `{type: "attach", sessionId}` — Attach to a session
- `{type: "resize", cols, rows}` — Resize terminal
- `{type: "input", data}` — Send keyboard input

**Server to Client:**
- `{type: "activity", sessionId, active}` — Activity state change
- `{type: "question", sessionId}` — Permission prompt detected
- `{type: "team-update", teamId, event, ...}` — Agent spawned/removed/team deleted
- Raw binary data — Terminal output

## How Team Communication Works

Agents use a file-based protocol to coordinate:

```
.team-maker/<session-id>/
├── memory/
│   └── multi-agent-template.md    # Role definitions reference
├── share/
│   └── MULTI_AGENT_PLAN.md        # Shared task plan and status
└── agent-N/
    └── AGENT_COMMUNICATE.md       # Per-agent message inbox
```

- **Primary**: Agents read/write markdown files for structured communication
- **Fallback**: MCP `send_message` tool for urgent PTY-level input injection
- **Wake loop**: Server periodically nudges agents to check their inbox

## Claude Code Skills for Running This Project

To work effectively with Team Maker using Claude Code, the following skills and configurations are recommended:

### Required Claude Code Settings

- **MCP Servers** — The project dynamically generates MCP configs for team agents. Claude Code must support `--mcp-config` flag (available in recent versions).
- **Auto-accept** — Team agents are spawned with `--dangerously-skip-permissions` for autonomous operation within their working directory.

### Recommended Agent Skills (in CLAUDE.md or Settings)

When Claude Code agents are running as part of a team, they benefit from having these capabilities configured:

1. **File Read/Write** — Agents must freely read and write to the `.team-maker/` directory for communication
2. **Code Exploration** — The Architect agent needs to explore the codebase structure (glob, grep, read)
3. **Code Editing** — The Builder agent needs edit/write permissions for implementation
4. **Test Running** — The Validator agent needs bash access to run test commands
5. **Documentation** — The Scribe agent needs write access for docs and markdown files

### CLAUDE.md Configuration for Managed Projects

For projects where Team Maker spawns agents, include guidance in the project's `CLAUDE.md`:

```markdown
## Multi-Agent Coordination

This project uses Team Maker for multi-agent orchestration.

- Check `.team-maker/<session>/share/MULTI_AGENT_PLAN.md` for current task assignments
- Read your inbox at `.team-maker/<session>/agent-N/AGENT_COMMUNICATE.md`
- Update the shared plan when completing tasks
- Write deliverables to `.team-maker/<session>/share/` for other agents to access
```

### MCP Tools Available to Team Agents

| Tool | Description |
|------|-------------|
| `spawn_agent` | Create a new agent in the team with a name and prompt |
| `list_agents` | List all agents currently in the team |
| `send_message` | Send an urgent message directly to another agent's terminal |

## Tech Stack

- **Backend**: Node.js, Express 5, WebSocket (`ws`), `node-pty`
- **Frontend**: Vanilla HTML/CSS/JS, xterm.js (CDN), Web Audio API
- **Agent Protocol**: MCP (Model Context Protocol) via `@modelcontextprotocol/sdk`
- **Theme**: Catppuccin Mocha

## Known Limitations

- **macOS only** — Folder browse uses `osascript` (AppleScript)
- **node-pty pinned to 0.10.x** — v1.x prebuilds are broken on some macOS setups
- **No authentication** — Intended for local development use only
- **No build step** — Frontend assets served as-is, no bundling or minification

## Project Structure

```
team-maker/
├── server/
│   ├── index.js              # Express HTTP + WebSocket server
│   ├── sessionManager.js     # Session/PTY lifecycle management
│   ├── teamManager.js        # Team creation and agent spawning
│   ├── mcpServer.js          # MCP server (stdio transport)
│   ├── promptBuilder.js      # Orchestrator prompt generation
│   └── templateStore.js      # JSON-based template persistence
├── public/
│   ├── index.html            # Main HTML with modals
│   ├── css/style.css         # Catppuccin Mocha theme
│   └── js/app.js             # Frontend state and WebSocket logic
├── data/
│   └── templates.json        # Saved role templates
├── plan/                     # Design documentation
├── package.json
└── CLAUDE.md                 # Claude Code project instructions
```

## License

MIT
