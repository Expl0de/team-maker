# Contracts & Interfaces

> **Spec Status**: [ ] Draft
> **Last Updated**: 2026-03-26

## Purpose

Define all inter-component contracts: REST API endpoints, WebSocket message types, and MCP tool schemas. This is the single source of truth for all communication interfaces in Team Maker.

## Scope

Covers every API endpoint, every WebSocket message type (both directions), and every MCP tool with full parameter and return type schemas.

---

## REST API Endpoints

### Sessions

#### POST /api/sessions — Create Session
> Status: [ ] Pending

**Request Body**:
```json
{
  "name": "string (optional)",
  "cwd": "string (optional, must be valid directory)",
  "autoAccept": "boolean (optional)",
  "initialPrompt": "string (optional)",
  "model": "string (optional, e.g. 'claude-sonnet-4-6')"
}
```

**Response** (200):
```json
{
  "id": "uuid",
  "name": "string",
  "status": "running",
  "exitCode": null,
  "createdAt": "ISO8601",
  "cwd": "string",
  "teamId": null,
  "role": null,
  "agentIndex": null,
  "model": "string|null",
  "usage": { "bytesIn": 0, "bytesOut": 0, "durationMs": 0 },
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "totalTokens": 0 },
  "clientCount": 0,
  "agentState": "starting",
  "lastToolCall": null
}
```

**Errors**: 400 (cwd not a directory / cwd not readable)

---

#### GET /api/sessions — List Sessions
> Status: [ ] Pending

**Response** (200): `Session[]` (same shape as POST response)

---

#### GET /api/sessions/:id — Get Session
> Status: [ ] Pending

**Response** (200): `Session` object
**Errors**: 404 (Session not found)

---

#### DELETE /api/sessions/:id — Destroy Session
> Status: [ ] Pending

**Response** (200): `{ "ok": true }`
**Errors**: 404 (Session not found)

---

#### POST /api/sessions/:id/resize — Resize PTY
> Status: [ ] Pending

**Request Body**:
```json
{
  "cols": "integer (1-500)",
  "rows": "integer (1-500)"
}
```

**Response** (200): `{ "ok": true }`
**Errors**: 404 (Session not found), 400 (Invalid cols/rows)

---

#### POST /api/sessions/:id/clear — Clear Agent Context
> Status: [ ] Pending

**Request Body**: None

**Response** (200):
```json
{
  "ok": true,
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "totalTokens": 0 }
}
```

**Errors**: 404 (Session not found), 400 (Session not running)

**Side Effects**: Broadcasts `{ type: "team-update", event: "context-cleared" }` over WebSocket

---

#### POST /api/sessions/:id/input — Inject PTY Input
> Status: [ ] Pending

**Request Body**:
```json
{
  "text": "string (required, max 10000 chars)"
}
```

**Response** (200): `{ "ok": true }`
**Errors**: 404 (Session not found), 400 (text required / text too long)

**Behavior**: Appends `\r` to text before injecting into PTY.

---

### Teams

#### POST /api/teams — Create Team
> Status: [ ] Pending

**Request Body**:
```json
{
  "name": "string (required)",
  "cwd": "string (optional, must be valid directory)",
  "prompt": "string (required, max 5000 chars)",
  "roles": "Role[] (optional, defaults to built-in 4 roles)",
  "model": "string (optional, team-level default model)",
  "modelRouting": "{ low: string, medium: string, high: string } (optional)"
}
```

**Role schema**:
```json
{
  "id": "string",
  "title": "string",
  "responsibility": "string",
  "description": "string",
  "model": "string (optional, role-level override)"
}
```

**Response** (200):
```json
{
  "team": {
    "id": "uuid",
    "name": "string",
    "cwd": "string",
    "prompt": "string",
    "roles": "Role[]",
    "mainAgentId": "uuid",
    "agentIds": ["uuid"],
    "createdAt": "ISO8601",
    "status": "running",
    "model": "string|null",
    "modelRouting": "object|null",
    "sessionId": "YYYYMMDD-HHmmss"
  },
  "mainAgent": "Session object"
}
```

**Errors**: 400 (name/prompt required, cwd invalid, prompt too long)

**Side Effects**: Broadcasts `{ type: "team-update", event: "team-created" }`

---

#### GET /api/teams — List Teams
> Status: [ ] Pending

**Response** (200): `Team[]`

---

#### GET /api/teams/:teamId — Get Team
> Status: [ ] Pending

**Response** (200): `Team` object
**Errors**: 404

---

#### DELETE /api/teams/:teamId — Destroy Team
> Status: [ ] Pending

**Response** (200): `{ "ok": true }`
**Errors**: 404

**Side Effects**: Kills all agent sessions, clears messages/tasks/context/files, broadcasts `{ type: "team-update", event: "team-deleted" }`

---

#### GET /api/teams/:teamId/export — Export Team Config
> Status: [ ] Pending

**Response** (200):
```json
{
  "_format": "team-maker-export-v1",
  "name": "string",
  "cwd": "string",
  "prompt": "string",
  "roles": "Role[]",
  "model": "string|null",
  "modelRouting": "object|null",
  "exportedAt": "ISO8601"
}
```

---

#### POST /api/teams/import — Import Team Config
> Status: [ ] Pending

**Request Body**: Same shape as export response (name and prompt required)
**Response** (200): `{ team, mainAgent }` (same as POST /api/teams)
**Errors**: 400 (invalid data, prompt too long, cwd invalid)

---

#### POST /api/teams/:teamId/relaunch — Relaunch Stopped Team
> Status: [ ] Pending

**Response** (200): `{ team, mainAgent }`
**Errors**: 404 (Team not found or already running)

**Side Effects**: Broadcasts `{ type: "team-update", event: "team-relaunched" }`

---

#### GET /api/teams/:teamId/model-routing — Get Model Routing
> Status: [ ] Pending

**Response** (200):
```json
{
  "modelRouting": "{ low, medium, high }|null",
  "defaults": {
    "low": "claude-haiku-4-5-20251001",
    "medium": "claude-sonnet-4-6",
    "high": "claude-opus-4-6"
  }
}
```

---

#### PUT /api/teams/:teamId/model-routing — Update Model Routing
> Status: [ ] Pending

**Request Body**:
```json
{
  "modelRouting": { "low": "string", "medium": "string", "high": "string" }
}
```

**Response** (200): `{ "ok": true, "modelRouting": { ... } }`
**Errors**: 400 (modelRouting required), 404

**Side Effects**: Broadcasts `{ type: "team-update", event: "model-routing-updated" }`

---

#### POST /api/teams/:teamId/agents — Spawn Agent
> Status: [ ] Pending

**Request Body**:
```json
{
  "name": "string (required)",
  "prompt": "string (required)",
  "model": "string (optional, explicit override)",
  "taskComplexity": "'low'|'medium'|'high' (optional, for routing table)"
}
```

**Response** (200): `Session` object
**Errors**: 400 (name/prompt required), 404 (Team not found)

**Model Selection Priority**: explicit model > routing table[taskComplexity] > team default

**Side Effects**: Broadcasts `{ type: "team-update", event: "agent-added" }`

---

#### GET /api/teams/:teamId/agents — List Team Agents
> Status: [ ] Pending

**Response** (200): `Session[]` (agents in team, with `{ id, status: "unknown" }` for dead sessions)
**Errors**: 404

---

#### DELETE /api/teams/:teamId/agents/:agentId — Remove Agent
> Status: [ ] Pending

**Response** (200): `{ "ok": true }`
**Errors**: 404

**Side Effects**: Kills PTY, broadcasts `{ type: "team-update", event: "agent-removed" }`

---

#### POST /api/teams/:teamId/agents/:agentId/restart — Restart Agent
> Status: [ ] Pending

**Response** (200):
```json
{
  "ok": true,
  "oldId": "uuid (previous session ID)",
  "agent": "Session object (new session)"
}
```

**Errors**: 404

**Side Effects**: Destroys old session, creates new one with same prompt/model. Notifies orchestrator of ID change via PTY injection. Broadcasts `{ type: "team-update", event: "agent-restarted" }`

---

#### POST /api/teams/:teamId/agents/:agentId/keep-alive — Reset Idle Timer
> Status: [ ] Pending

**Response** (200): `{ "ok": true }`
**Errors**: 404

---

#### GET /api/teams/:teamId/usage — Get Usage Stats
> Status: [ ] Pending

**Response** (200):
```json
{
  "team": "Team object",
  "agents": [{
    "id": "uuid",
    "name": "string",
    "role": "main|agent",
    "agentIndex": "number|null",
    "status": "running|exited",
    "usage": { "bytesIn": 0, "bytesOut": 0, "durationMs": 0 },
    "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "totalTokens": 0 }
  }],
  "totals": {
    "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0,
    "cost": 0, "totalTokens": 0, "bytesIn": 0, "bytesOut": 0, "durationMs": 0
  }
}
```

---

### Messages

#### POST /api/messages/send — Send Message
> Status: [ ] Pending

**Request Body**:
```json
{
  "from": "string (optional, sender agent ID)",
  "to": "string (required, recipient agent ID)",
  "message": "string (required)",
  "teamId": "string (optional)"
}
```

**Response** (200): `{ "ok": true, "messageId": "uuid", "toName": "string" }`
**Errors**: 400 (to/message required), 404 (Recipient not found)

**Side Effects**: Enqueues message + injects `\n📨 Message from {name}:\n{content}\r` into recipient PTY. Broadcasts `{ type: "team-message" }`.

---

#### GET /api/messages/inbox?agentId= — Get Unread Messages
> Status: [ ] Pending

**Response** (200):
```json
{
  "messages": [{
    "id": "uuid",
    "from": "string",
    "fromName": "string",
    "content": "string",
    "timestamp": "ISO8601"
  }]
}
```

---

#### POST /api/messages/read — Mark Messages Read
> Status: [ ] Pending

**Request Body**:
```json
{
  "messageId": "string (required — message ID or 'all')",
  "agentId": "string (required when messageId='all')"
}
```

**Response** (200): `{ "ok": true, "message": "string" }`
**Errors**: 400 (messageId required, agentId required for all), 404 (Message not found)

---

#### GET /api/teams/:teamId/messages — Get Team Message History
> Status: [ ] Pending

**Response** (200): `Message[]` sorted by timestamp
```json
[{
  "id": "uuid", "from": "string", "to": "string",
  "fromName": "string", "toName": "string",
  "teamId": "string", "content": "string",
  "timestamp": "ISO8601", "read": "boolean"
}]
```

---

### Tasks

#### POST /api/teams/:teamId/tasks — Create Task
> Status: [ ] Pending

**Request Body**:
```json
{
  "title": "string (required)",
  "description": "string (optional)",
  "complexity": "'low'|'medium'|'high' (optional, default 'medium')",
  "dependsOn": "string[] (optional, task IDs)",
  "createdBy": "string (optional, agent ID)"
}
```

**Response** (200):
```json
{
  "task": {
    "id": "uuid", "title": "string", "description": "string",
    "status": "pending", "complexity": "medium",
    "assignedTo": null, "assignedToName": null,
    "dependsOn": [], "result": null, "failReason": null,
    "createdBy": "string|null", "createdByName": "string|null",
    "teamId": "string", "createdAt": "ISO8601", "updatedAt": "ISO8601"
  }
}
```

**Errors**: 400 (title required), 404 (Team not found)

---

#### GET /api/teams/:teamId/tasks — List Tasks
> Status: [ ] Pending

**Query Params**: `?status=pending|assigned|in_progress|completed|failed`, `?assignedTo=agentId`

**Response** (200):
```json
{
  "tasks": "Task[]",
  "summary": { "total": 0, "pending": 0, "assigned": 0, "in_progress": 0, "completed": 0, "failed": 0 }
}
```

---

#### POST /api/teams/:teamId/tasks/:taskId/claim — Claim Task
> Status: [ ] Pending

**Request Body**: `{ "agentId": "string (required)" }`
**Response** (200): `{ "task": Task }`
**Errors**: 400 (agentId required, task not pending, unmet dependencies)

**Behavior**: Sets status to "assigned", sets assignedTo/assignedToName.

---

#### POST /api/teams/:teamId/tasks/:taskId/complete — Complete Task
> Status: [ ] Pending

**Request Body**: `{ "agentId": "string (required)", "result": "string (optional)" }`
**Response** (200): `{ "task": Task }`
**Errors**: 400 (wrong status, wrong agent)

**Behavior**: Sets status to "completed", stores result.

---

#### POST /api/teams/:teamId/tasks/:taskId/fail — Fail Task
> Status: [ ] Pending

**Request Body**: `{ "agentId": "string (required)", "reason": "string (optional)" }`
**Response** (200): `{ "task": Task }`
**Errors**: 400 (wrong status, wrong agent)

**Behavior**: Sets status to "failed", clears assignedTo (allows reassignment).

---

#### POST /api/teams/:teamId/tasks/:taskId/retry — Retry Failed Task
> Status: [ ] Pending

**Request Body**: None
**Response** (200): `{ "task": Task }`
**Errors**: 400 (task not failed)

**Behavior**: Resets status to "pending", clears failReason/assignedTo.

---

### Context Store

#### POST /api/teams/:teamId/context — Store Context Entry
> Status: [ ] Pending

**Request Body**:
```json
{
  "key": "string (required)",
  "content": "string (required)",
  "summary": "string (optional)",
  "storedBy": "string (optional, agent ID)"
}
```

**Response** (200):
```json
{
  "entry": {
    "key": "string", "content": "string", "summary": "string",
    "storedBy": "string|null", "storedByName": "string|null",
    "teamId": "string", "tokens": "number",
    "lastUpdated": "ISO8601", "accessCount": 0
  }
}
```

**Behavior**: Upserts — updates existing entry if key matches.

---

#### GET /api/teams/:teamId/context — List Context Entries
> Status: [ ] Pending

**Response** (200):
```json
{
  "entries": [{ "key": "string", "summary": "string", "storedByName": "string", "tokens": 0, "accessCount": 0, "lastUpdated": "ISO8601" }],
  "stats": { "totalEntries": 0, "totalBytes": 0, "maxBytes": 512000, "usagePercent": 0 }
}
```

---

#### GET /api/teams/:teamId/context/query?q= — Search Context
> Status: [ ] Pending

**Query Params**: `q` (required, keywords)
**Response** (200): `{ "results": [{ key, content, summary, score, storedByName, tokens, accessCount }] }`

---

#### GET /api/teams/:teamId/context/:key — Get Context Entry
> Status: [ ] Pending

**Response** (200): `{ "entry": { full entry with content } }`
**Errors**: 404

---

#### DELETE /api/teams/:teamId/context/:key — Delete Context Entry
> Status: [ ] Pending

**Response** (200): `{ "ok": true }`
**Errors**: 404

---

### Project Memory

#### GET /api/project-memory?cwd= — Preview Project Memory
> Status: [ ] Pending

**Query Params**: `cwd` (required)
**Response** (200):
```json
{
  "entries": [{
    "key": "string", "summary": "string", "storedBy": "string",
    "lastUpdated": "ISO8601", "tags": [], "deprecated": false, "deprecatedReason": ""
  }]
}
```

---

#### POST /api/teams/:teamId/project-memory — Store Memory Entry
> Status: [ ] Pending

**Request Body**:
```json
{
  "key": "string (required)",
  "content": "string (required)",
  "summary": "string (optional)",
  "agentLabel": "string (optional)"
}
```

**Response** (200): `{ "entry": { content, summary, storedBy, lastUpdated, tags, deprecated } }`
**Errors**: 400 (key/content required, no cwd), 404

---

#### GET /api/teams/:teamId/project-memory — List Memory Entries
> Status: [ ] Pending

**Response** (200): `{ "entries": [{ key, summary, storedBy, lastUpdated, tags, deprecated, deprecatedReason }] }`

---

#### GET /api/teams/:teamId/project-memory/:key — Get Memory Entry
> Status: [ ] Pending

**Response** (200): `{ "entry": { key, content, summary, storedBy, lastUpdated, ... } }`
**Errors**: 404

---

#### POST /api/teams/:teamId/project-memory/query — Search Memory
> Status: [ ] Pending

**Request Body**: `{ "query": "string (required)" }`
**Response** (200): `{ "results": [{ key, score, content, summary, storedBy, deprecated }] }`

---

#### DELETE /api/teams/:teamId/project-memory/:key — Deprecate Memory Entry
> Status: [ ] Pending

**Request Body**: `{ "reason": "string (optional)" }`
**Response** (200): `{ "entry": { ...entry with deprecated: true } }`
**Errors**: 404

**Behavior**: Soft deprecation — entry remains searchable but excluded from snapshot().

---

### Events & Files

#### GET /api/teams/:teamId/events — Get Agent Events
> Status: [ ] Pending

**Query Params**: `?type=tool_call|tool_result|assistant_message|turn_complete|thinking`, `?sessionId=uuid`, `?limit=number`

**Response** (200):
```json
{
  "events": [{
    "type": "string",
    "sessionId": "uuid",
    "sessionName": "string",
    "teamId": "string",
    "agentState": "string",
    "timestamp": "ISO8601",
    "...event-specific fields"
  }]
}
```

---

#### GET /api/teams/:teamId/files — Get Touched Files
> Status: [ ] Pending

**Response** (200):
```json
{
  "files": [{
    "path": "string (absolute)",
    "relativePath": "string",
    "agentName": "string",
    "sessionId": "uuid",
    "operation": "created|edited",
    "timestamp": "ISO8601"
  }]
}
```

---

#### GET /api/teams/:teamId/files/read?path= — Read File Content
> Status: [ ] Pending

**Query Params**: `path` (required, absolute path)
**Response** (200): `{ "path": "string", "content": "string" }`
**Errors**: 400 (no path), 403 (outside team directory / symlink traversal), 404 (file not found)

**Security**: Validates path is within team's cwd after resolving symlinks.

---

### Templates & Other

#### GET /api/templates — List Templates
> Status: [ ] Pending

**Response** (200): `[{ "id": "uuid", "name": "string", "roles": Role[], "createdAt": "ISO8601" }]`

---

#### POST /api/templates — Save Template
> Status: [ ] Pending

**Request Body**: `{ "name": "string (required)", "roles": "Role[] (required)" }`
**Response** (200): `Template` object

---

#### DELETE /api/templates/:id — Delete Template
> Status: [ ] Pending

**Response** (200): `{ "ok": true }`
**Errors**: 404

---

#### GET /api/health — Health Check
> Status: [ ] Pending

**Response** (200): `{ "ok": true, "uptime": "number (seconds)" }`

---

#### GET /api/browse-folder — macOS Finder Dialog
> Status: [ ] Pending

**Response** (200): `{ "path": "string" }` or `{ "cancelled": true }`

**Behavior**: Launches macOS Finder dialog via `osascript`. Timeout: 60 seconds.

---

#### GET /api/builtin-roles — Get Role Definitions
> Status: [ ] Pending

**Response** (200):
```json
{
  "builtin": [
    { "id": "architect", "title": "Architect", "responsibility": "Research & Planning", "description": "..." },
    { "id": "builder", "title": "Builder", "responsibility": "Core Implementation", "description": "..." },
    { "id": "validator", "title": "Validator", "responsibility": "Testing & Validation", "description": "..." },
    { "id": "scribe", "title": "Scribe", "responsibility": "Documentation & Refinement", "description": "..." }
  ],
  "extra": [
    { "id": "devops", "title": "DevOps", "responsibility": "Infrastructure & Deployment", "description": "..." },
    { "id": "security", "title": "Security Auditor", "responsibility": "Security & Compliance", "description": "..." },
    { "id": "designer", "title": "Designer", "responsibility": "UI/UX Design", "description": "..." },
    { "id": "reviewer", "title": "Reviewer", "responsibility": "Code Review & Quality", "description": "..." }
  ]
}
```

---

## WebSocket Protocol

### Connection
> Status: [ ] Pending

- **URL**: `ws://localhost:{PORT}` (same port as HTTP server, default 3456)
- **Origin Validation**: Only `https?://(localhost|127.0.0.1)(:\d+)?` origins accepted; no-origin (non-browser clients) allowed
- **Max Payload**: 64KB

### Client → Server Messages

#### attach — Attach to Session Terminal
> Status: [ ] Pending

```json
{ "type": "attach", "sessionId": "uuid" }
```

**Server Response Sequence**:
1. Sends scrollback buffer as raw string (if any)
2. `{ "type": "attached", "sessionId": "uuid" }`
3. `{ "type": "activity", "sessionId": "uuid", "active": boolean }`
4. `{ "type": "agent_state", "sessionId": "uuid", "state": "string", "lastToolCall": object|null }`
5. Applies any buffered resize from before attach

**Error**: `{ "type": "error", "message": "Session not found" }`

---

#### resize — Resize Terminal
> Status: [ ] Pending

```json
{ "type": "resize", "cols": "integer (1-500)", "rows": "integer (1-500)" }
```

**Behavior**: If session attached, resizes immediately. If not yet attached, buffers for later.

---

#### input — Terminal Input
> Status: [ ] Pending

```json
{ "type": "input", "data": "string" }
```

**Behavior**: Forwards data to attached session's PTY.

---

#### Raw String — Terminal Input (fallback)
> Status: [ ] Pending

Non-JSON messages are treated as raw terminal input and forwarded to the attached session.

---

### Server → Client Messages (Per-Session)

#### Raw Terminal Data
> Status: [ ] Pending

Raw string/binary PTY output. Not JSON-wrapped.

---

#### attached — Session Attached Confirmation
> Status: [ ] Pending

```json
{ "type": "attached", "sessionId": "uuid" }
```

---

#### exit — Session Exited
> Status: [ ] Pending

```json
{ "type": "exit", "exitCode": "integer" }
```

---

#### question — Permission Dialog Detected
> Status: [ ] Pending

```json
{ "type": "question", "sessionId": "uuid" }
```

**Triggers**: PTY pattern match (permission keywords) or stuck tool call (8s without result).
**Debounce**: 3 seconds minimum between alerts.

---

#### activity — PTY Output Activity
> Status: [ ] Pending

```json
{ "type": "activity", "sessionId": "uuid", "active": "boolean" }
```

**Behavior**: `active: true` when output arrives, `active: false` after 3 seconds of silence.

---

#### agent_state — Agent State Change
> Status: [ ] Pending

```json
{
  "type": "agent_state",
  "sessionId": "uuid",
  "state": "starting|working|idle|tool_calling|thinking|completed",
  "lastToolCall": { "name": "string", "input": "object" } | null
}
```

---

### Server → Client Messages (Broadcast)

#### team-update — Team Lifecycle Events
> Status: [ ] Pending

```json
{
  "type": "team-update",
  "teamId": "uuid",
  "event": "team-created|team-deleted|team-relaunched|agent-added|agent-removed|agent-restarted|model-routing-updated|context-cleared",
  "team": "Team object (on create/relaunch)",
  "agent": "Session object (on create/add/restart)",
  "agentId": "uuid (on remove)",
  "oldAgentId": "uuid (on restart)",
  "modelRouting": "object (on routing update)",
  "sessionId": "uuid (on context-cleared)",
  "tokenUsage": "object (on context-cleared)"
}
```

---

#### agent-event — Structured Agent Events
> Status: [ ] Pending

```json
{
  "type": "agent-event",
  "teamId": "uuid",
  "event": {
    "type": "assistant_message|tool_call|tool_result|thinking|turn_complete",
    "sessionId": "uuid",
    "sessionName": "string",
    "teamId": "uuid",
    "agentState": "string",
    "timestamp": "ISO8601",
    "text": "string (assistant_message)",
    "toolName": "string (tool_call)",
    "toolUseId": "string (tool_call/tool_result)",
    "input": "object (tool_call, summarized)",
    "isError": "boolean (tool_result)",
    "contentPreview": "string (tool_result)",
    "length": "number (thinking, chars)",
    "model": "string (turn_complete)"
  }
}
```

---

#### agent-idle — Idle Timeout Events
> Status: [ ] Pending

```json
{
  "type": "agent-idle",
  "teamId": "uuid",
  "event": {
    "type": "agent_idle_warning|agent_idle_killed",
    "sessionId": "uuid",
    "sessionName": "string",
    "teamId": "uuid",
    "idleMs": "number"
  }
}
```

**Behavior**: On `agent_idle_killed`, agent is removed from team's agent list.

---

#### team-task — Task Board Events
> Status: [ ] Pending

```json
{
  "type": "team-task",
  "teamId": "uuid",
  "event": "task-created|task-claimed|task-started|task-completed|task-failed|task-retried",
  "task": "Task object"
}
```

---

#### team-context — Context Store Events
> Status: [ ] Pending

```json
{
  "type": "team-context",
  "teamId": "uuid",
  "event": "stored|invalidated",
  "entry": { "key": "string", "summary": "string", "storedByName": "string", "tokens": 0, "accessCount": 0, "lastUpdated": "ISO8601" }
}
```

---

#### team-message — New Message
> Status: [ ] Pending

```json
{
  "type": "team-message",
  "teamId": "uuid",
  "message": {
    "id": "uuid", "from": "uuid", "to": "uuid",
    "fromName": "string", "toName": "string",
    "content": "string", "timestamp": "ISO8601"
  }
}
```

---

## MCP Tool Schemas

All tools are exposed by `server/mcpServer.js` via StdioServerTransport. Parameters use Zod schemas (required by @modelcontextprotocol/sdk). Tools communicate with the Team Maker HTTP server via REST API calls to `http://localhost:{PORT}`.

### spawn_agent
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| name | z.string() | Yes | Name for the new agent |
| prompt | z.string() | Yes | Task/prompt for the agent |
| model | z.string() | No | Explicit model override |
| taskComplexity | z.enum(["low","medium","high"]) | No | Auto-select model from routing table |

**Returns**: `Agent "{name}" spawned with ID: {id} (model: {model})`
**REST**: POST /api/teams/{TEAM_ID}/agents

---

### list_agents
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| (none) | | | |

**Returns**: `- {name} ({id}) [{status}] role={role}` per agent
**REST**: GET /api/teams/{TEAM_ID}/agents

---

### send_message
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| agentId | z.string() | Yes | Recipient session ID |
| message | z.string() | Yes | Message text |
| fromAgentId | z.string() | No | Sender session ID |

**Returns**: `Message sent to {toName} (queued as {messageId})`
**REST**: POST /api/messages/send

---

### check_inbox
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| agentId | z.string() | Yes | Your own session ID |

**Returns**: Formatted list of unread messages or "No unread messages."
**REST**: GET /api/messages/inbox?agentId={agentId}

---

### mark_read
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| messageId | z.string() | Yes | Message ID or "all" |
| agentId | z.string() | No | Required when messageId="all" |

**Returns**: Confirmation text
**REST**: POST /api/messages/read

---

### create_task
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | z.string() | Yes | Task title |
| description | z.string() | No | Detailed description |
| complexity | z.enum(["low","medium","high"]) | No | For model routing |
| dependsOn | z.array(z.string()) | No | Prerequisite task IDs |
| fromAgentId | z.string() | No | Creator agent ID |

**Returns**: `Task created: "{title}" (ID: {id})`
**REST**: POST /api/teams/{TEAM_ID}/tasks

---

### claim_task
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| taskId | z.string() | Yes | Task to claim |
| agentId | z.string() | Yes | Your session ID |

**Returns**: `Claimed task: "{title}" — now assigned to you.`
**REST**: POST /api/teams/{TEAM_ID}/tasks/{taskId}/claim

---

### complete_task
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| taskId | z.string() | Yes | Task to complete |
| agentId | z.string() | Yes | Your session ID |
| result | z.string() | Yes | Summary of work done |

**Returns**: `Task completed: "{title}"`
**REST**: POST /api/teams/{TEAM_ID}/tasks/{taskId}/complete

---

### fail_task
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| taskId | z.string() | Yes | Task that failed |
| agentId | z.string() | Yes | Your session ID |
| reason | z.string() | Yes | Failure reason |

**Returns**: `Task failed: "{title}" — reason: {reason}`
**REST**: POST /api/teams/{TEAM_ID}/tasks/{taskId}/fail

---

### get_tasks
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| status | z.string() | No | Filter by status |
| assignedTo | z.string() | No | Filter by assignee |

**Returns**: Formatted task list with status, complexity, deps, results + summary
**REST**: GET /api/teams/{TEAM_ID}/tasks

---

### store_context
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| key | z.string() | Yes | Descriptive key |
| content | z.string() | Yes | Content to store |
| summary | z.string() | No | One-line summary |
| fromAgentId | z.string() | No | Storer agent ID |

**Returns**: `Context stored: "{key}" (~{tokens} tokens).`
**REST**: POST /api/teams/{TEAM_ID}/context

---

### query_context
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| query | z.string() | Yes | Search keywords |

**Returns**: Matching entries with full content
**REST**: GET /api/teams/{TEAM_ID}/context/query?q={query}

---

### list_context
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| (none) | | | |

**Returns**: Entry keys with summaries, tokens, access counts
**REST**: GET /api/teams/{TEAM_ID}/context

---

### store_project_memory
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| key | z.string() | Yes | Descriptive key |
| content | z.string() | Yes | Content to store |
| summary | z.string() | No | One-line summary |

**Returns**: `Project memory stored: "{key}".`
**REST**: POST /api/teams/{TEAM_ID}/project-memory

---

### query_project_memory
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| query | z.string() | Yes | Search keywords |

**Returns**: Matching entries with full content
**REST**: POST /api/teams/{TEAM_ID}/project-memory/query

---

### list_project_memory
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| (none) | | | |

**Returns**: Entry keys with summaries
**REST**: GET /api/teams/{TEAM_ID}/project-memory

---

### deprecate_project_memory
> Status: [ ] Pending

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| key | z.string() | Yes | Key to deprecate |
| reason | z.string() | No | Why it's stale |

**Returns**: `Project memory entry "{key}" marked as deprecated.`
**REST**: DELETE /api/teams/{TEAM_ID}/project-memory/{key}
