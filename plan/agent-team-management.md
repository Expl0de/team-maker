# Plan: Agent Team Management System

## Context
Transform Team Maker from a flat session manager into a hierarchical team-based agent orchestration system. Currently, sessions are independent — the goal is to group agents into teams where a "main agent" can programmatically spawn and coordinate sub-agents via MCP tools.

## Architecture Overview

```
Sidebar (Teams)  |  Tab Bar (Agents in selected team)  |  Terminal
                 |                                       |
Team 1 [active]  |  [Main Agent] [Agent 2] [Agent 3]   |  xterm.js
Team 2           |                                       |
+ New Team       |                                       |
```

```
Browser <--WS--> Express Server <--PTY--> Claude CLI (main agent)
                      ^                        |
                      |                        v
                      +--- HTTP <--- MCP Server (stdio, spawned by CLI)
                           (spawn_agent, list_agents, send_message)
```

## Implementation

### Phase 1: Backend — Team Data Model

**New file: `server/teamManager.js`**
- `Team` class: `{ id, name, cwd, mainAgentId, agentIds[], createdAt }`
- `TeamManager` singleton with CRUD: `create()`, `get()`, `list()`, `addAgent()`, `removeAgent()`, `destroy()`
- `create({ name, cwd })` flow:
  1. Generate team ID
  2. Write MCP config JSON to `/tmp/team-maker-mcp-<teamId>.json`
  3. Call `sessionManager.create()` with `mcpConfigPath`, `teamId`, `role: "main"`, `autoAccept: true`, and the orchestrator initial prompt
  4. Return team with main agent info
- Orchestrator prompt template (interpolated with team name/cwd/user prompt):
  ```
  You are the orchestrator for team "{teamName}". You have MCP tools:
  - spawn_agent(name, prompt) — spawn a new agent in your team
  - list_agents() — list all agents in your team
  - send_message(agentId, message) — send input to another agent

  Your task: {userPrompt}

  Break this down, spawn specialist agents, and coordinate them.
  ```
- User provides the team prompt at creation time (required field in modal)

**Modify: `server/sessionManager.js`**
- Add `teamId`, `role` ("main"|"agent"), `mcpConfigPath` to Session constructor
- When `mcpConfigPath` is set, add `--mcp-config <path>` to Claude CLI spawn args
- Add these fields to `toJSON()` output
- Add `injectInput(text)` method for the send_message MCP tool
- **Activity tracking**: Track `_lastOutputTime`, `_active` flag, and `_activityTimer`. Mark session active on PTY output; mark idle after 3s of silence. Broadcast `{ type: "activity", sessionId, active }` to WebSocket clients.
- **Server-side wake loop** (`_startWakeLoop`): For team agents, run a 60s interval (after 30s initial delay) that nudges idle agents (no output for 30s+) to check their inbox and shared plan.
- **Improved `_injectPrompt`**: Paste prompt text first, then send `\r` after 500ms delay so the TUI processes pasted content.

### Phase 2: MCP Server

**New file: `server/mcpServer.js`**
- Uses `@modelcontextprotocol/sdk` (official MCP SDK) with stdio transport
- Import `z` from `zod` — tool parameter schemas **must** use Zod instances (e.g. `z.string().describe("...")`) not plain objects. The SDK's `normalizeObjectSchema` rejects plain `{ type: "string" }` objects, resulting in empty `properties: {}`.
- Reads `TEAM_ID` and `TEAM_MAKER_PORT` from env (set by MCP config)
- Tools call back to Express API via `fetch("http://localhost:<port>/api/...")`

**Tools:**
| Tool | Params | Action |
|------|--------|--------|
| `spawn_agent` | `{name, prompt}` | POST `/api/teams/:teamId/agents` |
| `list_agents` | none | GET `/api/teams/:teamId/agents` |
| `send_message` | `{agentId, message}` | POST `/api/sessions/:id/input` |

**MCP config template** (written per-team to `/tmp/`):
```json
{
  "mcpServers": {
    "team-maker": {
      "command": "node",
      "args": ["<absolute-path>/server/mcpServer.js"],
      "env": { "TEAM_ID": "<teamId>", "TEAM_MAKER_PORT": "3456" }
    }
  }
}
```

### Phase 3: API Endpoints

**Modify: `server/index.js`**
- Import `teamManager`
- New endpoints:
  - `POST /api/teams` — create team `{ name, cwd }`, auto-spawns main agent
  - `GET /api/teams` — list all teams
  - `GET /api/teams/:teamId` — get team with agent list
  - `DELETE /api/teams/:teamId` — destroy team and all its agents
  - `POST /api/teams/:teamId/agents` — spawn agent in team `{ name, prompt }` (used by MCP)
  - `GET /api/teams/:teamId/agents` — list agents in team
  - `DELETE /api/teams/:teamId/agents/:agentId` — remove agent
  - `POST /api/sessions/:id/input` — inject text into session PTY
- Add global WebSocket client set for broadcasting `team-update` events
- Broadcast `{ type: "team-update", teamId, event: "agent-added", agent }` when MCP spawns an agent

### Phase 4: Frontend

**Modify: `public/index.html`**
- Restructure layout: `header` → `sidebar + main-content` flex row
- Sidebar: team list + "New Team" button
- Main content: tab bar (scoped to selected team) + terminal container
- Repurpose modal for team creation (add team name field + required prompt field)
- Add "New Agent" button in header (adds agent to current team manually)

**Modify: `public/css/style.css`**
- Sidebar styles (~220px wide, `#11111b` background, team items with active state)
- Two-column flex layout below header
- Team item styles (name, agent count badge, delete button)
- **Activity indicator**: `.status-dot.working` class — blue (`#89b4fa`) pulsing dot with `pulse-working` animation (1.2s ease-in-out) to show active output

**Modify: `public/js/app.js`**
- New state: `teams` Map, `activeTeamId`
- `loadExistingTeams()` replaces `loadExistingSessions()`
- `createNewTeam(name, cwd)` — POST to `/api/teams`, add to sidebar, select it
- `selectTeam(teamId)` — filter tabs to show only that team's agents
- `deleteTeam(teamId)` — DELETE team, clean up all agent tabs/terminals
- Handle `team-update` WebSocket messages to dynamically add agent tabs when MCP spawns agents
- Handle `activity` WebSocket messages — `handleActivityUpdate()` adds/removes `.working` class on tab status dot
- Tab creation/management scoped by `teamId`

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `server/teamManager.js` | **Create** | Team class, TeamManager, MCP config generation, prompt template |
| `server/mcpServer.js` | **Create** | MCP server using @modelcontextprotocol/sdk with spawn_agent, list_agents, send_message |
| `package.json` | **Modify** | Add @modelcontextprotocol/sdk and zod dependencies |
| `server/sessionManager.js` | **Modify** | Add teamId, role, mcpConfigPath to Session; add injectInput() |
| `server/index.js` | **Modify** | Add team API endpoints, input injection, WS broadcast |
| `public/index.html` | **Modify** | Sidebar layout, team creation modal |
| `public/css/style.css` | **Modify** | Sidebar styles, two-column layout |
| `public/js/app.js` | **Modify** | Team-scoped state management, sidebar logic, WS team-update handling |

## Verification
1. Start server with `npm start`
2. Open browser — sidebar should show empty team list
3. Click "New Team" → enter name + browse folder → create
4. Main agent tab should appear and auto-start with orchestrator prompt
5. Main agent should be able to use `spawn_agent` MCP tool
6. New agent tab should appear dynamically in the UI when spawned
7. Switching teams in sidebar should scope the tab bar to that team's agents
8. Deleting a team should kill all its agents
