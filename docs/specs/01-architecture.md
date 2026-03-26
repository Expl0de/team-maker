# Architecture

> **Spec Status**: [ ] Draft
> **Last Updated**: 2026-03-26

## Purpose

Define the full component map of Team Maker, how components connect, data flows, and dependency relationships. This document serves as the architectural reference for all implementation work.

## Scope

Covers all runtime components from the browser frontend through the server to the Claude Code CLI processes, including the MCP server sidecar architecture. For REST API, WebSocket, and MCP tool contracts, see [02-contracts.md](02-contracts.md). For detailed backend implementation, see [03-backend.md](03-backend.md) and [04-frontend.md](04-frontend.md).

## High-Level Architecture

```
+------------------------------------------------------------------+
|                         Browser (Frontend)                        |
|  +------------------+  +-------------------+  +----------------+ |
|  | xterm.js         |  | Tab / Sidebar     |  | Panels:        | |
|  | Terminal per      |  | Management        |  | Usage, Tasks,  | |
|  | Agent Session     |  | (vanilla JS)      |  | Messages,      | |
|  +--------+---------+  +-------------------+  | Events, Files, | |
|           |                                    | Context, Team  | |
|           | WebSocket (ws://)                  +----------------+ |
+-----------+------------------------------------------------------+
            |
            v
+------------------------------------------------------------------+
|                     Express HTTP Server (index.js)                |
|  +------------------+  +-------------------+  +----------------+ |
|  | WebSocket Server |  | REST API          |  | Event          | |
|  | (ws library)     |  | (~45 endpoints)   |  | Broadcasting   | |
|  +--------+---------+  +--------+----------+  +-------+--------+ |
|           |                     |                      |          |
|  +--------v---------------------v----------------------v--------+ |
|  |                    Core Server Modules                       | |
|  |  +----------------+  +---------------+  +------------------+ | |
|  |  | SessionManager |  | TeamManager   |  | MessageQueue     | | |
|  |  | (PTY lifecycle)|  | (teams, MCP   |  | (agent msgs)     | | |
|  |  +-------+--------+  | config, model |  +------------------+ | |
|  |          |            | routing)      |  +------------------+ | |
|  |          |            +---------------+  | TaskBoard        | | |
|  |          |            +---------------+  | (task states)    | | |
|  |          |            | ContextStore  |  +------------------+ | |
|  |          |            | (team KV)     |  +------------------+ | |
|  |          |            +---------------+  | ProjectMemory    | | |
|  |          |            +---------------+  | Store (per-cwd)  | | |
|  |          |            | StateStore    |  +------------------+ | |
|  |          |            | (persistence) |  +------------------+ | |
|  |          |            +---------------+  | TemplateStore    | | |
|  |          |                               +------------------+ | |
|  +----------+---------------------------------------------------+ |
|             |                                                     |
+-------------+-----------------------------------------------------+
              |
              v  node-pty spawn
+------------------------------------------------------------------+
|                    Claude Code CLI Process                        |
|  +------------------+           +------------------------------+ |
|  | PTY (xterm-256)  |           | MCP Server (mcpServer.js)    | |
|  | Terminal I/O     |           | StdioServerTransport          | |
|  +------------------+           | 17 tools → REST calls to     | |
|                                 | Team Maker HTTP server        | |
|  +------------------+           +------------------------------+ |
|  | JSONL Log File   |                                            |
|  | ~/.claude/...    |                                            |
|  +------------------+                                            |
+------------------------------------------------------------------+
```

## Data Flow Diagrams

### Terminal I/O Flow

```
User types in browser
        |
        v
xterm.js → WebSocket { type: "input", data } → Express WS handler
        |
        v
session.write(data) → node-pty → Claude Code CLI stdin
        |
        v
Claude Code CLI stdout → node-pty onData → session.pty.onData
        |
        +---> Append to scrollback buffer (100KB cap)
        +---> Strip ANSI → rolling plain buffer → question detection
        +---> Broadcast raw data to all attached WebSocket clients
        |
        v
WebSocket → xterm.js terminal.write(data) → rendered in browser
```

### Agent Event Flow (JSONL-based)

```
Claude Code CLI writes JSONL log
        |
        v
JsonlWatcher (fs.watch + adaptive poll 3-10s)
        |
        v
extractEvents(entry) → [assistant_message, tool_call, tool_result, thinking, turn_complete, usage]
        |
        v
session._handleJsonlEvent(event)
        |
        +---> Update agent state (starting/working/idle/tool_calling/thinking/completed)
        +---> Update token usage counters
        +---> Track pending tool calls (permission detection)
        +---> Store in circular event buffer (500 max)
        +---> Broadcast { type: "agent_state" } to session clients
        |
        v
sessionManager.onAgentEvent → broadcast { type: "agent-event" } to ALL WebSocket clients
```

### MCP Tool Call Flow

```
Agent calls MCP tool (e.g., send_message)
        |
        v
Claude Code CLI → StdioServerTransport → mcpServer.js tool handler
        |
        v
fetch(`http://localhost:${PORT}/api/...`)  ← REST call to Team Maker server
        |
        v
Express route handler → Core module (MessageQueue/TaskBoard/etc.)
        |
        v
Response → mcpServer.js → { content: [{ type: "text", text: "..." }] }
        |
        v
Claude Code CLI receives tool result
```

### Message Delivery Flow

```
Agent A calls send_message(agentId=B, message="...")
        |
        v
mcpServer.js → POST /api/messages/send { from: A, to: B, message }
        |
        +--> messageQueue.enqueue() → persist to stateStore
        |
        +--> sessionB.injectInput("\n📨 Message from A:\n" + message + "\r")
        |         (instant PTY injection)
        |
        +--> broadcast { type: "team-message" } to all WebSocket clients
        |         (UI update)
        v
Agent B receives message in PTY terminal (instant)
Agent B can also check_inbox() to retrieve from queue (backup)
```

### Team Creation Flow

```
User clicks "New Team" → fills modal → clicks "Create Team"
        |
        v
POST /api/teams { name, cwd, prompt, roles, model, modelRouting }
        |
        v
teamManager.create()
        |
        +--> Generate team UUID + session ID (timestamp-based)
        +--> Write MCP config to /tmp/team-maker-mcp-{teamId}.json
        +--> sessionManager.create({ role: "main", autoAccept: true })
        |         → spawns node-pty → claude CLI with --mcp-config
        |
        +--> buildOrchestratorPrompt({ taskPrompt, roles, sessionId, ... })
        |         → includes MCP tool docs, sub-agent template, prior knowledge
        |
        +--> session._injectPrompt(orchestratorPrompt)
        |         → waits for CLI ready signal → pastes prompt → Enter
        |
        +--> persistTeam() → stateStore
        +--> broadcast { type: "team-update", event: "team-created" }
```

## Components / Features

### Express HTTP Server
> Status: [ ] Pending

**Purpose**: Central HTTP server handling REST API requests and WebSocket connections.

**Responsibilities**:
- Serve static frontend files from `public/`
- Handle ~45 REST API endpoints across 10 resource groups
- Manage WebSocket connections with origin validation
- Initialize all persistence layers on startup
- Broadcast events to connected clients
- Graceful shutdown (SIGINT/SIGTERM)

**Interfaces**:
- Input: HTTP requests, WebSocket messages
- Output: JSON responses, WebSocket broadcasts, PTY process management

**Behavior / Rules**:
- Runs on port 3456 (configurable via PORT env var)
- WebSocket origin restricted to localhost (anti-DNS-rebinding)
- Max WebSocket payload: 64KB
- JSON body parsing via express.json()
- CWD validation (must exist, must be directory) on session/team creation

**Acceptance Criteria**:
- [ ] All REST endpoints return correct responses
- [ ] WebSocket connections establish and stream terminal data
- [ ] Origin validation blocks non-localhost connections
- [ ] Graceful shutdown kills all PTY processes and flushes state

**Open Questions**: None

---

### SessionManager + Session
> Status: [ ] Pending

**Purpose**: Manage the lifecycle of PTY-backed Claude Code CLI processes.

**Responsibilities**:
- Spawn node-pty processes running the Claude CLI
- Maintain scrollback buffer (100KB) per session
- Track connected WebSocket clients per session
- Watch JSONL logs for structured events
- Detect permission dialogs (PTY patterns + stuck tool calls)
- Track agent state and token usage
- Manage idle timeouts for team agents

**Interfaces**:
- Input: Create/destroy commands, PTY data, JSONL events
- Output: WebSocket messages (terminal data, state changes, alerts)

**Behavior / Rules**:
- PTY spawned with `xterm-256color`, 120x30 default size
- Claude CLI args: `--session-id`, optionally `--permission-mode auto`, `--mcp-config`, `--model`
- Auto-accept workspace trust dialog (waits for "trust" in output, sends Enter)
- Prompt injection: waits for ready signal (`>` prompt or known patterns), then pastes + Enter
- JSONL watcher started on first PTY output
- Agent states: starting → working ↔ idle ↔ tool_calling ↔ thinking → completed
- Idle timeout: 5min warning, 10min auto-kill (sub-agents only, 2min grace period on startup)
- Health check ping every 5min for team agents idle >4min

**Acceptance Criteria**:
- [ ] Sessions spawn PTY processes with correct arguments
- [ ] Scrollback buffer is maintained and sent to new clients
- [ ] Agent state transitions are tracked from JSONL events
- [ ] Permission dialogs trigger question alerts
- [ ] Idle agents are warned at 5min and killed at 10min

**Open Questions**: None

---

### TeamManager + Team
> Status: [ ] Pending

**Purpose**: Manage multi-agent teams and their configuration.

**Responsibilities**:
- Create/destroy/relaunch teams
- Generate MCP config files for team agents
- Spawn orchestrator with built prompt
- Add/remove/restart sub-agents
- Configure model routing per team
- Persist team state for server restarts

**Interfaces**:
- Input: REST API calls, orchestrator MCP tool calls
- Output: Session creation, MCP config files, state persistence

**Behavior / Rules**:
- MCP config at `/tmp/team-maker-mcp-{teamId}.json` with TEAM_ID + TEAM_MAKER_PORT env vars
- Orchestrator prompt includes full MCP tool documentation and sub-agent template
- Model routing: low → Haiku, medium → Sonnet, high → Opus (configurable)
- Model priority: explicit model > routing table > team default
- Teams restored as "stopped" on server restart (PTY processes don't survive)
- Relaunch creates new orchestrator session with same config

**Acceptance Criteria**:
- [ ] Teams are created with orchestrator and correct MCP config
- [ ] Sub-agents can be spawned with model routing
- [ ] Teams persist across server restarts
- [ ] Stopped teams can be relaunched

**Open Questions**: None

---

### TaskBoard
> Status: [ ] Pending

**Purpose**: Track work items across a team of agents with dependency management.

**Responsibilities**:
- CRUD operations on tasks
- Enforce state machine transitions
- Check dependency satisfaction before claiming
- Track complexity for model routing
- Persist tasks via StateStore

**Interfaces**:
- Input: REST API calls (proxied from MCP tools)
- Output: Task state, WebSocket broadcast events

**Behavior / Rules**:
- States: pending → assigned → in_progress → completed | failed
- Claiming requires all dependsOn tasks to be completed
- Failed tasks can be retried (reset to pending)
- Complexity: low/medium/high (maps to model routing)

**Acceptance Criteria**:
- [ ] Tasks transition through all valid states
- [ ] Dependencies block claiming until satisfied
- [ ] Task events broadcast over WebSocket
- [ ] Tasks persist across server restarts

**Open Questions**: None

---

### MessageQueue
> Status: [ ] Pending

**Purpose**: Enable inter-agent communication with both instant delivery and reliable queuing.

**Responsibilities**:
- Queue messages by recipient agent ID
- Support instant delivery via PTY injection
- Track read/unread status
- Provide team-level message history
- Persist via StateStore

**Interfaces**:
- Input: REST API calls (proxied from MCP tools)
- Output: PTY injection to recipient, WebSocket broadcast

**Behavior / Rules**:
- Dual delivery: queue + PTY injection for instant receipt
- PTY injection format: `\n📨 Message from {name}:\n{content}\r`
- Messages indexed by recipient for O(1) inbox lookup
- mark_read supports single message or "all" for an agent

**Acceptance Criteria**:
- [ ] Messages delivered instantly via PTY injection
- [ ] Messages retrievable via check_inbox
- [ ] Read status tracked per message
- [ ] Messages persist across server restarts

**Open Questions**: None

---

### ContextStore
> Status: [ ] Pending

**Purpose**: Shared key-value knowledge store to prevent redundant work across agents.

**Responsibilities**:
- Store and retrieve context entries by key
- Keyword search across keys and summaries
- Track access counts and timestamps
- Enforce storage limits with LRU eviction

**Interfaces**:
- Input: REST API calls (proxied from MCP tools)
- Output: Context entries, WebSocket broadcast events

**Behavior / Rules**:
- 500KB total content cap, 200 max entries
- LRU eviction when limits exceeded
- Token estimation: code ~3.3 chars/token, prose ~4.5
- Access count incremented on query/get (affects LRU priority)

**Acceptance Criteria**:
- [ ] Context can be stored, queried, and retrieved
- [ ] LRU eviction works when limits exceeded
- [ ] Context persists across server restarts
- [ ] Events broadcast on store/invalidate

**Open Questions**: None

---

### StateStore
> Status: [ ] Pending

**Purpose**: Persistent JSON storage for all server state.

**Responsibilities**:
- Read/write JSON state file
- Support dot-path get/set/delete operations
- Debounce disk writes
- Handle corruption with backup + recovery

**Interfaces**:
- Input: get/set/delete calls from all server modules
- Output: JSON file at ~/.team-maker/state.json

**Behavior / Rules**:
- Default state schema: { version, teams, messages, tasks, contexts, files, templates, settings }
- Debounced writes (500ms) to reduce disk I/O
- File permissions: 0o600 (state file), 0o700 (directory)
- Corruption: backup corrupted file, start fresh with default state

**Acceptance Criteria**:
- [ ] State persists across server restarts
- [ ] Debounced writes reduce disk I/O
- [ ] Corrupted state file triggers backup + recovery
- [ ] All modules can read/write state independently

**Open Questions**: None

---

### ProjectMemoryStore
> Status: [ ] Pending

**Purpose**: File-based persistent memory scoped to a project working directory.

**Responsibilities**:
- Store/retrieve memory entries per project
- Support keyword search across entries
- Provide snapshot for orchestrator prompt injection
- Soft-deprecate stale entries

**Interfaces**:
- Input: REST API calls (proxied from MCP tools)
- Output: JSON file at `<cwd>/.team-maker/project-memory.json`

**Behavior / Rules**:
- Not a singleton — instantiated per cwd
- Creates .gitignore to protect session dirs but allow project-memory.json
- Deprecated entries excluded from snapshot() but remain searchable
- Snapshot injected into new team orchestrator prompts

**Acceptance Criteria**:
- [ ] Memory entries persist in project directory
- [ ] Prior knowledge appears in new team orchestrator prompts
- [ ] Deprecated entries excluded from active snapshot
- [ ] .gitignore created automatically

**Open Questions**: None

---

### JsonlParser + JsonlWatcher
> Status: [ ] Pending

**Purpose**: Parse Claude Code JSONL log files for structured agent events.

**Responsibilities**:
- Watch JSONL files for new content (fs.watch + polling)
- Parse entries and extract typed events
- Summarize tool inputs/outputs for display

**Interfaces**:
- Input: JSONL file at `~/.claude/projects/<project-hash>/<sessionId>.jsonl`
- Output: Typed events (assistant_message, tool_call, tool_result, thinking, turn_complete, usage)

**Behavior / Rules**:
- Adaptive polling: 3s active → 10s idle (backs off after consecutive empty reads)
- Incremental reads (tracks bytes read offset)
- Concurrent read protection
- Tool input summarization truncates large payloads

**Acceptance Criteria**:
- [ ] Events extracted from JSONL in real-time
- [ ] Adaptive polling reduces resource usage during idle
- [ ] All event types correctly parsed
- [ ] Tool inputs summarized without losing key information

**Open Questions**: None

---

### Frontend (Browser)
> Status: [ ] Pending

**Purpose**: Browser-based UI for managing teams, viewing terminals, and monitoring agent activity.

**Responsibilities**:
- Render xterm.js terminals per agent session
- Manage tabs (team, agents, usage, messages, tasks, events, context, files)
- Handle team/agent creation modals with role editor
- Display real-time events, state indicators, and alerts
- Persist active tab selection in localStorage

**Interfaces**:
- Input: User interaction, WebSocket messages
- Output: REST API calls, WebSocket messages, terminal rendering

**Behavior / Rules**:
- Vanilla HTML/CSS/JS, no framework or build step
- CDN dependencies: xterm.js 5.5.0, marked 15.0.7, DOMPurify 3.2.4
- Catppuccin Mocha theme throughout
- Question detection: yellow pulsing tab dot + Web Audio alert beep
- Activity indicator: green dot pulse when PTY producing output
- Toast notifications for idle warnings/kills

**Acceptance Criteria**:
- [ ] Terminals render correctly with real-time I/O
- [ ] All panels show correct real-time data
- [ ] Modals support team/agent creation with all options
- [ ] Question alerts trigger visual and audio indicators
- [ ] Tab state persists across page reloads

**Open Questions**: None

## Dependency Graph

```
Frontend (browser)
    │
    ├── CDN: xterm.js, marked, DOMPurify
    │
    └── WebSocket + REST ──► Express HTTP Server (index.js)
                                    │
                    ┌───────────────┼───────────────────────┐
                    │               │                       │
                    v               v                       v
            SessionManager    TeamManager              StateStore
                │                   │                   (JSON file)
                │                   │                       ^
                ├── node-pty        ├── promptBuilder        │
                │                   │                       │
                ├── JsonlWatcher    ├── ProjectMemoryStore   │
                │   (jsonlParser)   │   (per-cwd JSON)      │
                │                   │                       │
                v                   v                       │
            Claude Code CLI    MCP Config File              │
                │               (/tmp/*.json)               │
                │                                           │
                ├── JSONL Log ──────────────────────────────│
                │                                           │
                └── MCP Server (mcpServer.js)               │
                        │                                   │
                        └── REST calls ──► Express Server   │
                                │                           │
                        ┌───────┼───────────┐               │
                        v       v           v               │
                   MessageQueue TaskBoard ContextStore ─────┘
                                            │
                                    TemplateStore ──────────┘
```

### NPM Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^5.1.0 | HTTP server and REST API |
| ws | ^8.18.0 | WebSocket server |
| node-pty | ^0.10.1 | Pseudo-terminal for Claude CLI (pinned, v1.x broken on macOS) |
| @modelcontextprotocol/sdk | ^1.27.1 | MCP server framework |
| uuid | ^11.1.0 | UUID generation for sessions, teams, etc. |
| zod | (transitive via MCP SDK) | Schema validation for MCP tools |
