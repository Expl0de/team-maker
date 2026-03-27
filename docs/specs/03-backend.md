# Backend

> **Spec Status**: [x] Done
> **Last Updated**: 2026-03-26

## Purpose

Define the backend server implementation: all server modules, their responsibilities, PTY process lifecycle, session management, question detection, REST endpoint implementations, WebSocket handling, and supporting infrastructure.

## Scope

Covers all 11 server-side modules in `server/`. For API contract details, see [02-contracts.md](02-contracts.md). For architecture context, see [01-architecture.md](01-architecture.md).

---

## Components / Features

### Express HTTP Server (server/index.js)
> Status: [x] Done

**Purpose**: Central entry point — HTTP server, WebSocket server, REST API routing, event broadcasting, and lifecycle management.

**Responsibilities**:
- Initialize all persistence layers on startup (stateStore → templateStore → teamManager → messageQueue → taskBoard → contextStore)
- Serve static frontend files from `public/`
- Define ~45 REST API endpoints across 10 resource groups
- Manage WebSocket connections with origin validation
- Wire up event broadcasting: agent events, idle events, task events, context events, messages
- Handle graceful shutdown on SIGINT/SIGTERM

**Interfaces**:
- Input: HTTP requests, WebSocket messages
- Output: JSON responses, WebSocket broadcasts

**Behavior / Rules**:
- Port: 3456 (configurable via `PORT` env var)
- Static files served via `express.static()`
- JSON body parsing via `express.json()`
- WebSocket origin validation: regex `/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/`
- Max WebSocket payload: 64KB
- Global `allWsClients` set tracks all connected WebSocket clients for broadcasting
- `broadcast()` function serializes message and sends to all connected clients

**Startup Sequence**:
1. `stateStore.load()` — load/create `~/.team-maker/state.json`
2. `templateStore.migrateFromLegacy()` — one-time migration from `data/templates.json`
3. `teamManager.restoreFromState()` — restore teams as "stopped"
4. `messageQueue.restoreFromState()` — restore queued messages
5. `taskBoard.restoreFromState()` — restore tasks
6. `contextStore.restoreFromState()` — restore context entries

**Shutdown Sequence** (SIGINT/SIGTERM):
1. Kill all active PTY sessions via `sessionManager.destroy()`
2. Close all WebSocket connections (code 1001)
3. Mark all running teams as "stopped" in stateStore
4. `stateStore.saveNow()` — synchronous flush
5. `setTimeout(() => process.exit(0), 500)` — allow cleanup

**Acceptance Criteria**:
- [x] Server starts and serves on configured port
- [x] All REST endpoints respond correctly
- [x] WebSocket connections established with origin validation
- [x] Events broadcast to all connected clients
- [x] Graceful shutdown kills all processes and flushes state

**Open Questions**: None

---

### PTY Process Lifecycle (server/sessionManager.js)
> Status: [x] Done

**Purpose**: Spawn, manage, and clean up PTY-backed Claude Code CLI processes.

**Responsibilities**:
- Spawn node-pty processes with correct arguments
- Manage scrollback buffer
- Handle PTY data events (output to clients)
- Handle PTY exit events
- Clean up on kill

**Interfaces**:
- Input: Session creation params (name, cwd, autoAccept, initialPrompt, teamId, role, mcpConfigPath, model)
- Output: PTY process, WebSocket data to clients

**Behavior / Rules**:

**PTY Spawn Configuration**:
```
Command: claude (or CLAUDE_PATH env var)
Args: --session-id {uuid}
      --permission-mode auto (if autoAccept)
      --mcp-config {path} (if mcpConfigPath)
      --model {model} (if model)
Terminal: xterm-256color
Size: 120 cols x 30 rows (default)
CWD: provided cwd or process.env.HOME
Env: { ...process.env, TERM: "xterm-256color" }
```

**Auto-Accept Trust Dialog**:
- Waits for "trust" or "Trust" in PTY output (up to 5s timeout)
- Sends `\r` (Enter) to accept
- Only when `autoAccept: true`

**Prompt Injection**:
- Waits for ready signal in PTY output: regex `/(?:^|\n)\s*>\s*$|Type .* to|How can I help|What would you like/`
- Fallback timeout: 15 seconds
- After ready detected: 200ms settle delay → paste prompt text → 300ms delay → `\r` (Enter)

**PTY Data Handler** (onData):
1. Ignore if `_killed` flag set
2. Update `usage.bytesOut` and `_lastOutputTime`
3. Append to scrollback buffer (trim to 100KB if exceeded)
4. Track activity state (active on output, inactive after 3s silence)
5. Strip ANSI → append to rolling plain buffer (8KB)
6. Start JSONL watcher on first output
7. Check for question/dialog patterns (debounced)
8. Schedule delayed question check (500ms, catches split PTY chunks)
9. Broadcast raw data to all attached WebSocket clients

**PTY Exit Handler** (onExit):
1. Ignore if `_killed` flag set
2. Set status to "exited", agentState to "completed"
3. Stop JSONL watcher, do final read
4. Send `{ type: "exit", exitCode }` to all clients

**Kill Process**:
1. Set `_killed = true` (prevents data/exit callbacks)
2. Clear all timers (healthCheck, idleCheck, questionCheck, permissionCheck)
3. Clear pending tool calls map
4. Stop JSONL watcher
5. `pty.kill()` → terminate PTY process
6. Set status to "exited"

**Acceptance Criteria**:
- [x] PTY spawns with correct arguments based on session config
- [x] Auto-accept trust dialog works reliably
- [x] Prompt injection waits for ready signal before pasting
- [x] Scrollback buffer maintained at 100KB cap
- [x] Kill cleans up all timers and resources

**Open Questions**: None

---

### Session Management
> Status: [x] Done

**Purpose**: CRUD operations on sessions, client tracking, and serialization.

**Responsibilities**:
- Create sessions (spawn PTY + configure)
- Get/list/destroy sessions
- Track connected WebSocket clients per session
- Serialize session state for API responses

**Interfaces**:
- Input: Create params, session ID lookups
- Output: Session objects, client management

**Behavior / Rules**:

**SessionManager** (singleton, exported as default):
- `sessions` Map: id → Session
- `instanceCounter`: auto-incrementing for default names
- `_eventListeners`: global listeners for all session events
- `_idleEventListeners`: global listeners for idle events

**Methods**:
- `create(opts)` → Session: Spawns new session, wires event + idle forwarding
- `get(id)` → Session | null
- `list()` → Session[].map(toJSON)
- `destroy(id)` → boolean: Kills session and removes from map

**Session.toJSON()** (API response shape):
```json
{
  "id": "uuid", "name": "string", "status": "running|exited",
  "exitCode": "number|null", "createdAt": "ISO8601", "cwd": "string",
  "teamId": "string|null", "role": "main|agent|null",
  "agentIndex": "number|null", "model": "string|null",
  "usage": { "bytesIn": 0, "bytesOut": 0, "durationMs": 0 },
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "totalTokens": 0 },
  "clientCount": 0, "agentState": "string", "lastToolCall": "object|null"
}
```

**Client Management**:
- `addClient(ws)` — adds WebSocket to `clients` Set
- `removeClient(ws)` — removes WebSocket from Set
- On attach: send scrollback buffer + attached + activity + agent_state messages

**Acceptance Criteria**:
- [x] Sessions created with auto-incrementing names
- [x] WebSocket clients tracked per session
- [x] Destroy kills PTY and removes session
- [x] toJSON includes all relevant state

**Open Questions**: None

---

### Scrollback Buffer
> Status: [x] Done

**Purpose**: Maintain a rolling buffer of PTY output for reconnecting clients.

**Responsibilities**:
- Accumulate PTY output data
- Enforce 100KB size limit
- Send buffer to newly-attaching WebSocket clients

**Interfaces**:
- Input: PTY data events
- Output: Raw string buffer

**Behavior / Rules**:
- Max size: `MAX_SCROLLBACK = 100 * 1024` (100KB)
- On each PTY data event: `scrollback += data`, then trim from front if over limit
- Sent as raw string to client on WebSocket attach (before `attached` message)
- Cleared on `clearContext()` call

**Acceptance Criteria**:
- [x] Buffer accumulates PTY output
- [x] Buffer never exceeds 100KB
- [x] Reconnecting clients receive scrollback
- [x] Clear resets buffer to empty

**Open Questions**: None

---

### Question / Dialog Detection
> Status: [x] Done

**Purpose**: Detect when a Claude Code CLI session requires human attention (permission dialogs, approval prompts).

**Responsibilities**:
- Pattern-match PTY output for permission dialog keywords
- Detect stuck tool calls via JSONL timing heuristic
- Emit question alerts to connected clients

**Interfaces**:
- Input: Stripped PTY output (rolling 8KB buffer), JSONL tool call events
- Output: `{ type: "question", sessionId }` WebSocket message

**Behavior / Rules**:

**PTY Pattern Detection**:
- Rolling plain-text buffer: 8KB (`PLAIN_BUFFER_SIZE`), ANSI-stripped
- Only inspects last 500 chars of buffer (reduce false positives)
- Patterns matched (case-insensitive):
  - `do you want to`, `allow once`, `allow always`, `(y/n)`
  - `allow.*deny`, `wants to`, `allow tool`, `run command`
  - `execute`, `approve`, `permission`, `proceed`, `confirm`
- On match: emit question alert, clear buffer to prevent re-trigger

**JSONL Stuck Tool Call Detection**:
- Track pending tool calls: Map of `toolUseId → { timestamp, toolName }`
- On `tool_call` event: add to pending map, schedule permission check
- On `tool_result` event: remove from pending map
- Permission check: after 8 seconds, if any tool call still pending → emit question alert

**Debouncing**:
- Minimum 3 seconds between question alerts (`_lastQuestionAlert`)
- Delayed check at 500ms after each PTY data event (catches split chunks)

**ANSI Stripping** (`stripAnsi` function):
- Removes CSI sequences: `ESC [ ... final_byte`
- Removes OSC sequences: `ESC ] ... (ST or BEL)`
- Removes ESC + single char
- Removes remaining lone ESC
- Removes control chars except newline/tab

**Acceptance Criteria**:
- [x] Permission dialog keywords trigger question alert
- [x] Stuck tool calls (>8s) trigger question alert
- [x] Debouncing prevents alert spam (3s minimum)
- [x] ANSI stripping correctly extracts plain text
- [x] Split PTY chunks caught by delayed check

**Open Questions**: None

---

### JSONL Event Tracking
> Status: [x] Done

**Purpose**: Parse Claude Code JSONL log files for structured agent activity tracking.

**Responsibilities**:
- Watch JSONL files for new content
- Extract typed events from JSONL entries
- Update agent state machine
- Track token usage
- Broadcast events to listeners

**Interfaces**:
- Input: JSONL file at `~/.claude/projects/<project-hash>/<sessionId>.jsonl`
- Output: Typed events, state updates, token counts

**Behavior / Rules**:

**JSONL Path Derivation** (`getJsonlPath`):
- CWD normalized (strip trailing slashes)
- Project hash: `-` + cwd with leading `/` stripped, then `/` and `.` replaced with `-`
- Path: `~/.claude/projects/{projectHash}/{sessionId}.jsonl`

**JsonlWatcher**:
- Uses `fs.watch()` for instant change detection + polling as fallback
- Adaptive polling: starts at 3s, backs off to 10s when idle, resets on new data
- Incremental reads: tracks `_bytesRead` offset, only processes new content
- Concurrent read protection via `_reading` flag
- Started on first PTY output (not immediately, since file may not exist yet)

**Event Extraction** (`extractEvents`):
- From `"assistant"` entries:
  - `text` blocks → `assistant_message` event
  - `tool_use` blocks → `tool_call` event (with summarized input)
  - `thinking` blocks → `thinking` event (with length)
  - `stop_reason === "end_turn"` → `turn_complete` event
  - `usage` field → `usage` event (token counts)
- From `"user"` entries:
  - `tool_result` blocks → `tool_result` event (with content preview)

**Agent State Machine**:
- `tool_call` → state = `tool_calling`
- `tool_result` → state = `working`
- `assistant_message` → state = `working`
- `turn_complete` → state = `idle`
- `thinking` → state = `thinking`
- PTY exit → state = `completed`

**Token Usage Tracking**:
- Accumulated from JSONL `usage` events (not PTY-based)
- Fields: inputTokens, outputTokens, cacheRead, cacheWrite, totalTokens
- Usage events not stored in event buffer (internal only)

**Event Buffer**:
- Circular buffer: max 500 events per session (`MAX_EVENTS`)
- Events tagged with sessionId, sessionName, teamId, agentState
- Broadcast to session `_eventListeners` and session WebSocket clients

**Tool Input Summarization** (`summarizeToolInput`):
- Read: file_path, offset, limit
- Edit: file_path, changeSize
- Write: file_path, contentLength
- Bash: command (truncated to 200 chars)
- Grep/Glob: pattern, path, type
- Agent: description, subagent_type
- Others: all keys, values truncated to 100 chars

**Acceptance Criteria**:
- [x] JSONL files watched and parsed incrementally
- [x] All event types correctly extracted
- [x] Agent state transitions tracked
- [x] Token usage accumulated accurately
- [x] Adaptive polling reduces resource usage
- [x] Tool inputs summarized without losing key info

**Open Questions**: None

---

### Idle Timeout Management
> Status: [x] Done

**Purpose**: Automatically warn and kill idle sub-agents to prevent resource waste.

**Responsibilities**:
- Track when agents enter idle state
- Warn after 5 minutes idle
- Auto-kill after 10 minutes idle
- Support manual keep-alive reset

**Interfaces**:
- Input: Agent state changes (from JSONL events)
- Output: Idle events (warning/kill) to listeners, PTY kill

**Behavior / Rules**:
- Only applies to sub-agents (`role === "agent"`), not orchestrators
- Check interval: every 30 seconds
- Startup grace period: 2 minutes (let agent process initial prompt)
- Warning at 5 minutes idle (`IDLE_WARN_MS`): emits `agent_idle_warning`
- Kill at 10 minutes idle (`IDLE_KILL_MS`): emits `agent_idle_killed`, calls `kill()`
- Idle tracking resets when agent leaves idle state
- Manual reset via `resetIdle()` (keep-alive API)
- Clear context also resets idle tracking

**Health Check Ping** (separate from idle timeout):
- Every 5 minutes (`HEALTH_CHECK_INTERVAL`), only for team agents
- Only fires if idle > 4 minutes
- Sends: "Health check: If you have pending tasks, continue working."
- Startup delay: 60 seconds

**Acceptance Criteria**:
- [x] Warning at 5 minutes, kill at 10 minutes
- [x] Only sub-agents affected (not orchestrators)
- [x] Startup grace period prevents premature kills
- [x] Keep-alive resets idle timer
- [x] Health check pings stuck agents

**Open Questions**: None

---

### Team Manager (server/teamManager.js)
> Status: [x] Done

**Purpose**: Manage multi-agent teams, their configuration, and agent spawning.

**Responsibilities**:
- Create/destroy/relaunch teams
- Generate MCP config files
- Spawn orchestrator with full prompt
- Add/remove/restart sub-agents
- Configure model routing
- Persist team state

**Interfaces**:
- Input: REST API calls
- Output: Sessions, MCP config files, state persistence

**Behavior / Rules**:

**Team Creation**:
1. Generate team UUID + timestamp-based session ID (YYYYMMDD-HHmmss)
2. Use provided roles or default BUILTIN_ROLES
3. Write MCP config to `/tmp/team-maker-mcp-{teamId}.json`
4. Spawn orchestrator session (role="main", autoAccept=true, no initialPrompt)
5. Load project memory snapshot if cwd available
6. Build orchestrator prompt with session ID, task, roles, prior knowledge
7. Inject prompt into orchestrator session
8. Persist team via stateStore

**MCP Config** (`_ensureMcpConfig`):
```json
{
  "mcpServers": {
    "team-maker": {
      "command": "node",
      "args": ["<path-to>/server/mcpServer.js"],
      "env": { "TEAM_ID": "<teamId>", "TEAM_MAKER_PORT": "<port>" }
    }
  }
}
```

**Model Routing**:
- Default: `{ low: "claude-haiku-4-5-20251001", medium: "claude-sonnet-4-6", high: "claude-opus-4-6" }`
- Model selection: `model` is a **ceiling** — `taskComplexity` selects from routing table, capped by `model`. Both provided: cheaper wins (routing can downgrade, never upgrade above ceiling). Only `model`: used directly. Only `taskComplexity`: routing applies freely. Neither: team default, then no model.
- Configurable per-team via `updateModelRouting()`

**Agent Restart**:
- Destroys old session, spawns new one with same name/prompt/model
- Orchestrator restart: rebuilds full prompt with new session ID
- Updates team.agentIds (replaces old ID with new)
- Persists updated team state

**Team Relaunch** (for stopped teams):
- Creates new orchestrator session with same config
- Rebuilds prompt with new session ID
- Loads fresh project memory snapshot
- Resets agent list to just the new orchestrator

**State Persistence**:
- Teams stored at `stateStore.set("teams.{id}", {...})`
- Restored as "stopped" on server restart (PTY processes don't survive)

**Acceptance Criteria**:
- [x] Teams created with orchestrator and MCP config
- [x] Sub-agents spawned with correct model routing
- [x] Agent restart preserves configuration
- [x] Teams persist and restore across restarts
- [x] Stopped teams can be relaunched

**Open Questions**: None

---

### Team Pause / Resume (server/teamManager.js + server/sessionManager.js + server/index.js)
> Status: [x] Done

**Purpose**: Allow a running team to be suspended (paused) without killing PTY processes, then resumed to restore background monitoring timers. An auto-pause fires automatically when all tasks on the board settle to terminal state.

**Responsibilities**:
- `sessionManager.js` — `Session` class gains `suspendMonitoring()` and `resumeMonitoring()` instance methods
- `teamManager.js` — `TeamManager` gains `pause(teamId)` and `resume(teamId)` methods
- `taskBoard.js` — emits `all-tasks-settled` event after each task completion/failure when no tasks remain in active state
- `index.js` — two new route handlers (POST pause / POST resume); listens for `all-tasks-settled` to trigger auto-pause; broadcasts WS events

**Team Status Values**:
| Status | PTY alive? | Intervals running? | Can relaunch? |
|--------|-----------|-------------------|---------------|
| `"running"` | Yes | Yes | No |
| `"paused"` | Yes | No | No |
| `"stopped"` | No | No | Yes |

**Session.suspendMonitoring()**:
- Calls `clearInterval(this._healthCheckInterval)` and sets `this._healthCheckInterval = null`
- Calls `clearInterval(this._idleCheckTimer)` and sets `this._idleCheckTimer = null`
- Does NOT kill the PTY, change `this.status`, or emit any events
- Safe to call multiple times (no-op if already cleared)

**Session.resumeMonitoring()**:
- Guards: only proceeds if `this.status === "running"`
- Calls `this._startHealthCheck()` and `this._startIdleCheck()`
- Note: these methods already set their own intervals internally; calling them again starts fresh timers

**TeamManager.pause(teamId)**:
- Returns `null` if team not found or `team.status !== "running"`
- Sets `team.status = "paused"`
- Iterates `team.agentIds`, resolves each via `sessionManager.get()`, calls `session.suspendMonitoring()` (skip if session not found)
- Calls `_persistTeam(team)`
- Returns `team`

**TeamManager.resume(teamId)**:
- Returns `null` if team not found or `team.status !== "paused"`
- Sets `team.status = "running"`
- Iterates `team.agentIds`, resolves each via `sessionManager.get()`, calls `session.resumeMonitoring()` (skip if session not found or not `"running"`)
- Calls `_persistTeam(team)`
- Returns `team`

**Auto-Pause — taskBoard.js**:
- After `completeTask()` or `failTask()` modifies a task, compute `getBoardSummary(teamId)`
- If `summary.pending === 0 && summary.assigned === 0 && summary.in_progress === 0 && summary.total > 0`, emit event `{ type: "all-tasks-settled", teamId }`
- Event is internal (EventEmitter); `index.js` subscribes on startup

**Auto-Pause — index.js handler**:
```
taskBoard.on("all-tasks-settled", ({ teamId }) => {
  const team = teamManager.pause(teamId);
  if (team) broadcast({ type: "team-update", event: "team-paused", teamId, source: "auto" });
});
```

**Manual Pause — index.js**:
```
POST /api/teams/:teamId/pause
  → teamManager.pause(teamId) → 400 if null → broadcast team-paused (source: "manual") → 200 { ok, team }

POST /api/teams/:teamId/resume
  → teamManager.resume(teamId) → 400 if null → broadcast team-resumed → 200 { ok, team }
```

**MCP Sidecar**:
- `mcpServer.js` connects via HTTP to the REST API — no changes needed
- All 17 MCP tools remain functional while team is `"paused"`

**Persistence Behavior**:
- `team.status = "paused"` IS written to stateStore by `_persistTeam()`
- On server restart, `restoreFromState()` forces all teams to `"stopped"` regardless of persisted status — this is the existing behavior and is intentional (PTY processes don't survive restarts)

**Acceptance Criteria**:
- [x] `POST /api/teams/:teamId/pause` returns 400 when team status is not `"running"`
- [x] `POST /api/teams/:teamId/pause` sets `team.status = "paused"` and calls `suspendMonitoring()` on all live sessions
- [x] `POST /api/teams/:teamId/resume` returns 400 when team status is not `"paused"`
- [x] `POST /api/teams/:teamId/resume` sets `team.status = "running"` and calls `resumeMonitoring()` on sessions with status `"running"`
- [x] `suspendMonitoring()` clears both `_healthCheckInterval` and `_idleCheckTimer`; PTY remains alive; session status unchanged
- [x] `resumeMonitoring()` restarts health-check and idle-check timers only if `session.status === "running"`
- [x] Calling `suspendMonitoring()` twice does not throw (idempotent)
- [x] Auto-pause fires when all tasks for a team are `completed` or `failed` and total > 0
- [x] Auto-pause does NOT fire if any task is `pending`, `assigned`, or `in_progress`
- [x] Auto-pause does NOT fire if the team has zero tasks
- [x] WS broadcast `{ type: "team-update", event: "team-paused", source: "manual" | "auto" }` sent on pause
- [x] WS broadcast `{ type: "team-update", event: "team-resumed" }` sent on resume
- [x] MCP tools respond normally while team is `"paused"`
- [x] On server restart, a previously paused team is restored as `"stopped"` (existing `restoreFromState()` behavior)

**Open Questions**: None

---

### Task Board (server/taskBoard.js)
> Status: [x] Done

**Purpose**: Shared task tracking with state machine, dependencies, and complexity-based routing.

**Responsibilities**:
- CRUD operations on tasks
- Enforce state machine transitions
- Check dependency satisfaction
- Track complexity for model routing
- Persist via stateStore
- Emit events for WebSocket broadcast

**Interfaces**:
- Input: REST API calls (proxied from MCP tools)
- Output: Task objects, events

**Behavior / Rules**:

**State Machine**:
```
pending ──claim──► assigned ──start──► in_progress ──complete──► completed
                       │                    │
                       └──complete──► completed
                       │                    │
                       └────fail────► failed ──retry──► pending
```

**Dependency Checking** (`_unmetDependencies`):
- On `claimTask`: check all `dependsOn` task IDs
- Each dependency must exist AND have status "completed"
- Returns list of unmet deps with titles and statuses

**Complexity Levels**: `low`, `medium`, `high` (default: medium)
- Used by `getRecommendedModel()` to look up model from routing table

**Task Schema**:
```
id, title, description, status, complexity,
assignedTo, assignedToName, dependsOn[],
result, failReason, createdBy, createdByName,
teamId, createdAt, updatedAt
```

**Events**: task-created, task-claimed, task-started, task-completed, task-failed, task-retried

**Acceptance Criteria**:
- [x] All state transitions enforced
- [x] Dependencies block claiming until satisfied
- [x] Failed tasks can be retried
- [x] Events emitted for all transitions
- [x] Tasks persist via stateStore

**Open Questions**: None

---

### Message Queue (server/messageQueue.js)
> Status: [x] Done

**Purpose**: Inter-agent messaging with dual delivery (instant + queued).

**Responsibilities**:
- Queue messages indexed by recipient
- Track read/unread status
- Provide inbox and history queries
- Persist via stateStore
- Emit events for WebSocket broadcast

**Interfaces**:
- Input: REST API calls
- Output: Message objects, events

**Behavior / Rules**:

**Message Schema**:
```
id (UUID), from, to, fromName, toName, teamId,
content (string), timestamp (ISO8601), read (boolean)
```

**Dual Delivery** (in index.js route handler):
1. `messageQueue.enqueue()` — persistent queue
2. `session.injectInput()` — instant PTY injection with `📨` prefix

**Indexing**:
- `_queues` Map: agentId → message[] (for inbox lookups)
- `_messages` Map: messageId → message (for mark-read by ID)

**Methods**:
- `enqueue(from, to, content, opts)` → message
- `getUnread(agentId)` → unread messages
- `markRead(messageId)` → boolean
- `markAllRead(agentId)` → count
- `getHistory(agentId)` → all messages sent/received
- `getTeamMessages(teamId)` → all team messages

**Cleanup**: `clearTeam(teamId)` removes all messages and rebuilds queue index

**Acceptance Criteria**:
- [x] Messages queued and retrievable
- [x] Read status tracked per message
- [x] mark-all-read works correctly
- [x] Team cleanup removes all related messages
- [x] Messages persist via stateStore

**Open Questions**: None

---

### Context Store (server/contextStore.js)
> Status: [x] Done

**Purpose**: Team-scoped shared knowledge store to prevent redundant file reads.

**Responsibilities**:
- Store/retrieve context by key
- Keyword search
- LRU eviction when limits exceeded
- Token estimation
- Persist via stateStore

**Interfaces**:
- Input: REST API calls
- Output: Context entries, events

**Behavior / Rules**:

**Limits**:
- `MAX_TOTAL_BYTES = 500 * 1024` (500KB)
- `MAX_ENTRIES = 200`

**Token Estimation**:
- Code-like content (~3.3 chars/token): detected by frequency of `{}();=<>` characters
- Prose-like content (~4.5 chars/token): default
- Code ratio threshold: 0.03 (3% of chars are code signals)

**LRU Eviction**:
- Triggered on store when over budget
- Sorts by `lastUpdated` timestamp (oldest first)
- Evicts oldest until within both byte and entry limits
- Short-circuits if already within limits

**Search** (`query`):
- Splits query into lowercase terms
- Matches against `key + summary` (not content)
- Score = number of matching terms
- Results sorted by score, then accessCount
- Bumps accessCount and lastUpdated on match
- Limited to top 10 results by default

**Access Tracking**:
- `accessCount` incremented on query match and direct get
- `lastUpdated` refreshed on access (affects LRU priority)

**Acceptance Criteria**:
- [x] Context stored, queried, and retrieved
- [x] LRU eviction works at limits
- [x] Token estimation reasonable for code vs prose
- [x] Access tracking affects eviction priority
- [x] Persists via stateStore

**Open Questions**: None

---

### State Store (server/stateStore.js)
> Status: [x] Done

**Purpose**: Persistent JSON storage for all server-side state.

**Responsibilities**:
- Read/write JSON state file
- Dot-path navigation for nested properties
- Debounce disk writes
- Handle corruption

**Interfaces**:
- Input: get/set/delete calls from all modules
- Output: JSON file at `~/.team-maker/state.json`

**Behavior / Rules**:

**File Location**: `~/.team-maker/state.json`
- Directory created with mode 0o700
- File written with mode 0o600

**Default Schema**:
```json
{
  "version": 1,
  "teams": {},
  "messages": {},
  "tasks": {},
  "contexts": {},
  "files": {},
  "templates": [],
  "settings": {}
}
```

**Dot-Path Operations**:
- `get("teams.abc.name")` → traverses nested objects
- `set("teams.abc.name", "X")` → creates intermediary objects as needed
- `delete("teams.abc")` → deletes key from parent

**Write Debouncing**:
- `DEBOUNCE_MS = 500`
- `_scheduleSave()`: sets timeout, no-op if timer already pending
- `saveNow()`: cancels pending timer, writes immediately (used on shutdown)
- `_writeSync()`: synchronous JSON.stringify + writeFileSync

**Corruption Recovery**:
- On JSON parse error: backup corrupted file as `state.json.backup-{timestamp}`
- Start fresh with default state
- Log warning with error message

**Forward Compatibility**:
- On load: ensure all expected top-level keys from DEFAULT_STATE exist
- Missing keys added with default values

**Acceptance Criteria**:
- [x] State persists across server restarts
- [x] Dot-path get/set/delete work correctly
- [x] Writes debounced to 500ms
- [x] Corruption detected and recovered
- [x] File permissions are restrictive

**Open Questions**: None

---

### Project Memory Store (server/projectMemoryStore.js)
> Status: [x] Done

**Purpose**: File-based persistent memory scoped to a project working directory, surviving across teams.

**Responsibilities**:
- Store/retrieve memory entries
- Keyword search
- Soft deprecation
- Generate snapshots for prompt injection
- Manage .gitignore

**Interfaces**:
- Input: REST API calls
- Output: JSON file at `<cwd>/.team-maker/project-memory.json`

**Behavior / Rules**:

**File Structure**:
- Directory: `<cwd>/.team-maker/`
- Memory file: `project-memory.json`
- .gitignore: ignores `*/` (session dirs) but keeps `project-memory.json`

**Entry Schema**:
```json
{
  "content": "string",
  "summary": "string",
  "storedBy": "string (e.g. 'Architect (20260315-120000)')",
  "lastUpdated": "ISO8601",
  "tags": [],
  "deprecated": false,
  "deprecatedReason": "",
  "deprecatedAt": "ISO8601 (if deprecated)"
}
```

**Not a Singleton**: Instantiated per cwd — `new ProjectMemoryStore(cwd)`

**Soft Deprecation**:
- Sets `deprecated: true` + reason + timestamp
- Deprecated entries excluded from `snapshot()` but included in `list()` and `query()`
- No hard delete

**Snapshot** (for prompt injection):
- Filters out deprecated entries
- Returns bullet list: `- {key}: {summary}`
- Returns null if no active entries

**Acceptance Criteria**:
- [x] Memory entries persist in project directory
- [x] Snapshot injected into new team prompts
- [x] Deprecated entries excluded from snapshot
- [x] .gitignore created automatically
- [x] Query searches across keys, summaries, and content

**Open Questions**: None

---

### Prompt Builder (server/promptBuilder.js)
> Status: [x] Done

**Purpose**: Generate the orchestrator prompt that drives multi-agent coordination.

**Responsibilities**:
- Define built-in and extra role definitions
- Build comprehensive orchestrator prompt

**Interfaces**:
- Input: Team config (name, sessionId, cwd, prompt, roles, orchestratorSessionId, projectMemorySnapshot)
- Output: Full orchestrator prompt string

**Behavior / Rules**:

**Built-in Roles** (BUILTIN_ROLES):
1. **Architect**: Research & Planning
2. **Builder**: Core Implementation
3. **Validator**: Testing & Validation
4. **Scribe**: Documentation & Refinement

**Extra Roles** (EXTRA_ROLES):
5. **DevOps**: Infrastructure & Deployment
6. **Security Auditor**: Security & Compliance
7. **Designer**: UI/UX Design
8. **Reviewer**: Code Review & Quality

**Orchestrator Prompt Structure**:
1. Prior project knowledge section (if snapshot available)
2. Identity: "You are Agent 0 — The Orchestrator"
3. Critical warning: use MCP tools, NOT Claude Code built-in tools
4. Full MCP tool documentation (17 tools)
5. Step 1: Initialize session, wait for user signal
6. Step 2: Plan tasks on board (with complexity tagging)
7. Step 3: Spawn sub-agents on demand
8. Sub-agent prompt template (with placeholders for N, Role, Responsibility)
9. Step 4: Assign tasks to agents
10. Ongoing responsibilities (wait, monitor, coordinate, handle failures)
11. Critical: use Team Maker agents only
12. User's task prompt
13. Critical: do NOT start automatically
14. Role definitions
15. Shared artifacts path

**Acceptance Criteria**:
- [x] Orchestrator prompt includes all MCP tool documentation
- [x] Sub-agent template includes correct session IDs
- [x] Prior knowledge section included when available
- [x] Prompt emphasizes using MCP tools, not built-in tools

**Open Questions**: None

---

### Template Store (server/templateStore.js)
> Status: [x] Done

**Purpose**: CRUD for team role configuration templates, including team-level configuration (prompt, model, routing).

**Responsibilities**:
- Load/save/delete templates
- Migrate from legacy file format
- Store and restore team configuration alongside roles

**Interfaces**:
- Input: REST API calls
- Output: Template objects via stateStore

**Behavior / Rules**:

**Template Schema**:
```json
{
  "id": "uuid",
  "name": "string",
  "roles": "Role[]",
  "prompt": "string (optional, null if not provided)",
  "model": "string (optional, null if not provided)",
  "modelRouting": "{ low: string, medium: string, high: string } (optional, null if not provided)",
  "createdAt": "ISO8601"
}
```

**save() Method Signature**:
```javascript
save({ name, roles, prompt, model, modelRouting }) → Template
```
- All parameters except `name` and `roles` are optional
- If `prompt`/`model`/`modelRouting` not provided, stored as `null`
- Creates UUID and ISO8601 timestamp automatically

**Legacy Migration**: On first load, checks `data/templates.json` and imports to stateStore if not already migrated.

**Storage**: Array at `stateStore.get("templates")`

**Acceptance Criteria**:
- [x] Templates can be created, listed, and deleted
- [x] Legacy migration runs once
- [x] Templates persist via stateStore
- [x] New template fields (prompt, model, modelRouting) are stored and restored
- [x] Graceful degradation: old templates without these fields work correctly

**Open Questions**: None

---

### Folder Browse via osascript
> Status: [x] Done

**Purpose**: Native macOS Finder dialog for selecting working directories.

**Responsibilities**:
- Launch Finder folder picker
- Return selected path

**Interfaces**:
- Input: GET /api/browse-folder
- Output: `{ path }` or `{ cancelled: true }`

**Behavior / Rules**:
- Uses `osascript -e` to run AppleScript
- Script: `set chosenFolder to choose folder with prompt "..."; return POSIX path of chosenFolder`
- Timeout: 60 seconds
- macOS-only feature
- Error/cancel returns `{ cancelled: true }`

**Acceptance Criteria**:
- [x] Finder dialog opens on macOS
- [x] Selected path returned as POSIX path
- [x] Cancel handled gracefully
- [x] Timeout prevents hanging

**Open Questions**: None

---

### WebSocket Connection Handling
> Status: [x] Done

**Purpose**: Manage WebSocket connections for real-time terminal I/O and event streaming.

**Responsibilities**:
- Accept WebSocket connections with origin validation
- Handle attach/resize/input messages
- Forward PTY data to attached clients
- Track global client set for broadcasting

**Interfaces**:
- Input: WebSocket connections, JSON/raw messages
- Output: Terminal data, JSON event messages

**Behavior / Rules**:

**Connection Setup**:
- Origin validation via `verifyClient` callback
- Allowed: localhost/127.0.0.1 origins, or no origin (non-browser clients)
- Added to `allWsClients` set for broadcasting

**Message Handling**:
- JSON messages parsed; non-JSON treated as raw terminal input
- `attach`: get session, add client, send scrollback + state messages, apply buffered resize
- `resize`: validate bounds (1-500), resize session or buffer for later
- `input`: forward to attached session's PTY

**Connection Close**:
- Remove from `allWsClients`
- Remove from attached session's clients

**Acceptance Criteria**:
- [x] Origin validation blocks cross-origin connections
- [x] Attach sends scrollback and current state
- [x] Resize buffered when no session attached
- [x] Raw input forwarded to PTY
- [x] Close cleans up client references

**Open Questions**: None
