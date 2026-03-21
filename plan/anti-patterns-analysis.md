# Anti-Pattern Analysis: AI Agent Architecture

## Overview

This document identifies architectural anti-patterns in Team Maker's multi-agent orchestration system and proposes concrete improvements. The core concept (specialized role-based agents collaborating on tasks) is sound — the issues are in the communication and coordination layer.

---

## Anti-Pattern 1: Polling-Based Wake Loop ✅ FIXED

### Status: Completed — see `plan/anti-pattern-1-fix.md`

### Chosen: Option C — Remove wake loop entirely + rare health-check ping
- Removed `_startWakeLoop()`, `_wakeIntervalMs`, and all wake interval plumbing
- Rely solely on MCP `send_message` for inter-agent communication (PTY injection)
- Added 5-minute health-check ping as safety net for stuck agents
- Removed wake interval UI from frontend

### Result
- ~60-80% reduction in coordination token costs
- Message delivery latency dropped from ~30s average to <1s

---

## Prerequisite: Persistence Layer ✅ DONE

### Status: Completed

### Problem
Everything is in-memory. When the server stops, all teams, sessions, message history, and task state are lost. Before building AP2 (message queue) and AP4 (task board), we need somewhere to persist their state — otherwise a server restart wipes all coordination history mid-task.

### Chosen: JSON file store

**Why JSON file:** Zero dependencies, fits the project's vanilla JS / no-build-step philosophy. SQLite would require a native addon (another `node-pty`-style headache on macOS). A JSON file is plenty for a single-user local tool.

### Implementation Plan
1. **`server/stateStore.js`** — New `StateStore` class
   - Store path: `~/.team-maker/state.json` (user home, survives project moves)
   - Load on startup, create with defaults if missing
   - Debounced write on changes (500ms debounce to avoid thrashing on rapid updates)
   - Schema:
     ```json
     {
       "version": 1,
       "teams": {},
       "messages": {},
       "tasks": {},
       "templates": [],
       "settings": {}
     }
     ```
   - Methods: `load()`, `save()`, `get(path)`, `set(path, value)`, `onUpdate(callback)`
   - Graceful handling: if file is corrupted, back up and start fresh with a warning

2. **Integrate with existing modules**
   - `server/teamManager.js` — persist teams on create/delete, restore on startup
   - `server/index.js` — load state on server start, pass store to managers
   - `server/sessionManager.js` — persist session metadata (not PTY state — that dies with the process, but team membership, role, model selection are recoverable)
   - Role templates — currently handled in `index.js` API routes, move to StateStore

3. **What to persist vs. what's ephemeral**
   | Persist (survives restart) | Ephemeral (in-memory only) |
   |---|---|
   | Team definitions (name, roles, prompt, working dir) | Active PTY processes |
   | Role templates | WebSocket connections |
   | Message history (AP2) | Terminal scrollback buffer |
   | Task board state (AP4) | JSONL polling intervals |
   | Settings / preferences | Live token usage counters |

4. **Startup recovery flow**
   - Load `state.json` → restore teams in TeamManager
   - Teams show in sidebar as "stopped" (PTY processes are gone)
   - User can re-launch a team with its previous configuration
   - Message history and task board from previous runs are still visible in the UI
   - No attempt to auto-restart PTY processes (too fragile, user should decide)

### What Was Implemented
- **`server/stateStore.js`** — `StateStore` class persisting to `~/.team-maker/state.json` with debounced writes, corruption recovery with backup, and `get()`/`set()`/`delete()`/`onUpdate()` API
- **`server/teamManager.js`** — Teams persist on create/delete, restored on startup as "stopped". Added `relaunch()` method to re-launch stopped teams
- **`server/index.js`** — State loaded on startup, `POST /api/teams/:teamId/relaunch` endpoint, shutdown handler flushes state and marks teams stopped
- **`server/templateStore.js`** — Migrated from `data/templates.json` to StateStore with one-time migration
- **`server/sessionManager.js`** — Replaced fixed `setTimeout(5000)` prompt injection with event-driven `_waitForOutput()` that detects CLI readiness patterns
- **Frontend** — Stopped teams show dimmed with "stopped" badge, relaunch button (↻), disabled "new agent" for stopped teams

### Impact
- Teams and templates survive server restarts
- Message history (AP2) and task board (AP4) have a persistence backend ready
- Foundation for all subsequent anti-pattern fixes

---

## Anti-Pattern 2: File-Based Message Passing ✅ FIXED

### Status: Completed

### Chosen: Option A — Structured message queue (server-side)

**Why Option A:** Option C (pure PTY injection) is what `send_message` already does, but it has no read receipts, no message history, and messages interleave with agent work. Option B still has race conditions. Option A gives us:
- Unread-only delivery (no re-reading entire files — massive token savings)
- Message history stored server-side (feeds the visualization/observability goal)
- Delivery confirmation (agents know if messages were received)
- Foundation for the task board (Anti-Pattern 4)

### What Was Implemented
1. **`server/messageQueue.js`** — `MessageQueue` class with in-memory + StateStore persistence
   - Per-agent message queues indexed by recipient
   - Each message: `{ id, from, to, fromName, toName, teamId, content, timestamp, read }`
   - Methods: `enqueue()`, `getUnread()`, `markRead()`, `markAllRead()`, `getHistory()`, `getTeamMessages()`, `clearTeam()`
   - Event listeners for WebSocket broadcast on new messages
   - Restored from `~/.team-maker/state.json` on startup

2. **`server/mcpServer.js`** — New MCP tools added
   - `check_inbox(agentId)` — returns only unread messages with IDs
   - `mark_read(messageId, agentId?)` — acknowledges receipt, supports `"all"` to mark all read
   - `send_message` updated — routes through `/api/messages/send` which enqueues + PTY injects
   - Agents pass their own session ID (discoverable via `list_agents()`)

3. **`server/index.js`** — New API endpoints
   - `POST /api/messages/send` — enqueue message + PTY inject for instant delivery
   - `GET /api/messages/inbox?agentId=` — get unread messages for an agent
   - `POST /api/messages/read` — mark messages as read
   - `GET /api/teams/:teamId/messages` — get full message history for a team
   - WebSocket broadcast of `team-message` events on every new message
   - Team deletion cleans up associated messages

4. **`server/promptBuilder.js`** — Agent prompts updated
   - Removed all `AGENT_COMMUNICATE.md` file references and directory creation
   - Added `check_inbox`, `mark_read`, `fromAgentId` to MCP tools documentation
   - Sub-agent prompt includes instructions to discover own session ID via `list_agents()`
   - Kept `MULTI_AGENT_PLAN.md` (replaced in AP4 with task board)

5. **Frontend** — Messages tab added
   - "Messages" tab in tab bar (alongside Usage tab) with unread badge
   - Messages panel showing chronological message flow with sender→recipient, content, timestamp
   - Real-time updates via `team-message` WebSocket events with fade-in animation
   - Auto-scroll to latest message, per-team message history loaded from API

### Impact
- Eliminates race conditions and lost messages from file-based communication
- Reduces per-cycle token usage by 50-80% (no full file re-reads)
- Enables delivery confirmation via `mark_read`
- Visual message flow trace in the UI for debugging agent coordination
- **Prerequisite for:** Anti-Pattern 4 (task board builds on this messaging infrastructure)

---

## Anti-Pattern 3: PTY as the Control Plane ✅ FIXED

### Status: Completed

### Chosen: Option C — Hybrid approach (PTY display + JSONL control)

**Why Option C:** Option B (SDK/API) would require paying per-token via the Anthropic API, losing the cost advantage of running under a Claude Pro/Max flat-rate subscription. Option A (JSONL-only) loses the terminal UI that is Team Maker's key differentiator. Option C keeps both:
- PTY stays for the user-facing terminal view (xterm.js) — the real-time observability users love
- JSONL parsing added as a parallel structured channel for the control plane
- No subscription cost change — still runs under Claude Pro/Max

### What Was Implemented
1. **`server/jsonlParser.js`** — New module with incremental JSONL parsing
   - `JsonlWatcher` class: watches JSONL files via `fs.watch` + 3s polling fallback
   - Only reads new bytes since last read (incremental, not re-reading entire file)
   - `extractEvents()` extracts structured events: `tool_call`, `tool_result`, `assistant_message`, `turn_complete`, `thinking`, `usage`
   - `summarizeToolInput()` / `summarizeToolResult()` — truncate large payloads for display

2. **`server/sessionManager.js`** — Replaced interval-based JSONL polling with `JsonlWatcher`
   - Removed `parseJsonlUsage()` and `_startJsonlPolling()` — token usage now tracked incrementally via `usage` events
   - Added `_handleJsonlEvent()` — updates token usage, tracks `agentState` (starting/working/tool_calling/thinking/idle/completed), stores events in circular buffer (500 max), broadcasts to listeners
   - Added `agentState` and `lastToolCall` to `toJSON()` for API visibility
   - Added `onEvent()` for per-session event listeners, `getEvents()` for event retrieval
   - `SessionManager.onAgentEvent()` — global listener that forwards events from all sessions
   - PTY question detection kept as fallback (permission prompts are CLI-internal, not in JSONL)

3. **`server/index.js`** — New API and WebSocket broadcast
   - `GET /api/teams/:teamId/events` — query structured events with optional `type`, `sessionId`, `limit` filters
   - WebSocket broadcasts `agent-event` messages for real-time frontend updates
   - `agent_state` messages sent to per-session WebSocket clients on state changes

4. **Frontend** — Events panel added
   - "Events" tab (⚡) in tab bar alongside Usage/Messages/Tasks
   - Events panel with filterable event stream: filter by event type, filter by agent
   - Event rendering: tool calls (with name + file/command), tool results (with error status), assistant messages, turn completions, thinking indicators
   - Agent state badges on session tabs: shows current state (working/tool_calling/thinking) with color-coded Catppuccin badges
   - Real-time updates via `agent-event` and `agent_state` WebSocket events with fade-in animation
   - Scrollbar styling consistent with other panels

### Impact
- JSONL is now the structured control plane; PTY is display-only
- Incremental JSONL parsing replaces full-file re-reads (more efficient)
- Structured event log enables querying agent activity ("what tools did Agent 2 use?")
- Agent state visible at a glance via tab badges
- Permission prompt detection preserved via PTY fallback
- **Preserves free subscription model** — no API costs

---

## Anti-Pattern 4: No Task State Machine ✅ FIXED

### Status: Completed

### Chosen: Option A — Server-side task board

### What Was Implemented
1. **`server/taskBoard.js`** — `TaskBoard` class with full state machine
   - Task states: `pending` → `assigned` → `in_progress` → `completed` | `failed`
   - Task schema: `{ id, title, description, status, assignedTo, assignedToName, dependsOn[], result, failReason, createdBy, createdByName, teamId, timestamps }`
   - Methods: `createTask()`, `claimTask()`, `startTask()`, `completeTask()`, `failTask()`, `retryTask()`, `getTeamTasks()`, `getBoardSummary()`, `clearTeam()`
   - Dependency resolution: task can only be claimed if all `dependsOn` tasks are `completed`
   - Event listeners for WebSocket broadcast on task state changes
   - Persisted to `~/.team-maker/state.json` via StateStore, restored on startup

2. **`server/mcpServer.js`** — MCP tools for agent task management
   - `create_task(title, description?, dependsOn?, fromAgentId?)` — orchestrator creates tasks
   - `claim_task(taskId, agentId)` — agent claims a pending task
   - `complete_task(taskId, agentId, result)` — agent marks task done with summary
   - `fail_task(taskId, agentId, reason)` — agent marks task failed (enables reassignment)
   - `get_tasks(status?, assignedTo?)` — query current task board state with filters

3. **`server/index.js`** — REST API endpoints
   - `POST /api/teams/:teamId/tasks` — create task
   - `GET /api/teams/:teamId/tasks` — get tasks with optional filters
   - `POST /api/teams/:teamId/tasks/:taskId/claim` — claim task
   - `POST /api/teams/:teamId/tasks/:taskId/complete` — complete task
   - `POST /api/teams/:teamId/tasks/:taskId/fail` — fail task
   - `POST /api/teams/:teamId/tasks/:taskId/retry` — retry failed task
   - WebSocket broadcast of `task-update` events on every state change
   - Team deletion cleans up associated tasks

4. **`server/promptBuilder.js`** — Orchestrator and sub-agent prompts updated
   - Removed `MULTI_AGENT_PLAN.md` file-based planning instructions
   - Orchestrator prompt: break work into tasks via `create_task`, spawn agents, assign via `send_message`
   - Sub-agent prompt: use `get_tasks` to find work, `claim_task` to claim, `complete_task`/`fail_task` to report

5. **Frontend** — Tasks panel in the UI
   - Tasks panel showing task cards with status, assignee, dependencies, timestamps
   - Real-time updates via `task-update` WebSocket events
   - Retry button for failed tasks

### Impact
- Enables crash recovery and task reassignment
- Provides structured progress visibility in the UI
- Reduces orchestrator token waste from managing state in free-form text
- Foundation for AP5-C (smart model routing based on task complexity)

---

## Anti-Pattern 5: Token Waste Amplification

### Where
- Affects the entire system — compound effect of patterns 1-4

### Why It's an Anti-Pattern
Each agent runs a full Claude Code CLI instance with its own independent context window. The coordination overhead means a significant percentage of tokens are spent on meta-work rather than actual task execution:

| Activity | Token Cost | Frequency |
|----------|-----------|-----------|
| Wake cycle nudge + response | ~500-1000 tokens/agent | Every 60s |
| Full inbox file re-read | ~200-2000 tokens (grows over time) | Every wake cycle |
| Full plan file re-read | ~500-3000 tokens (grows over time) | Every wake cycle |
| Orchestrator re-reading all agent statuses | ~1000-5000 tokens | Every wake cycle |
| Duplicate context (each agent re-understands the project) | ~2000-5000 tokens/agent | On spawn |

**Estimated overhead for a 4-agent team running 30 minutes:**
- Wake cycles: 4 agents x 30 cycles x ~800 tokens = ~96,000 tokens
- File re-reads: 4 agents x 30 cycles x ~1500 tokens = ~180,000 tokens
- Orchestrator coordination: 30 cycles x ~3000 tokens = ~90,000 tokens
- **Total coordination overhead: ~366,000 tokens (~$1-3 depending on model mix)**
- This is often more than the tokens spent on actual task work.

### Chosen: Three-phase approach (A → B → C)

Most token waste is addressed by fixing patterns 1-4. The remaining optimizations build on each other:

---

#### Phase A: Lazy Agent Spawning ✅ DONE

**Problem:** All agents spawn at team creation even if the orchestrator hasn't figured out what to assign them yet. Idle agents consume context window tokens doing nothing.

**What Was Implemented:**
1. **`server/promptBuilder.js`** — Orchestrator prompt updated for lazy spawning
   - Step 3 changed from "Spawn all N agents" to "Spawn Sub-Agents On Demand"
   - Instructs orchestrator: create tasks first, then spawn agents only when tasks are unblocked
   - Added responsibility #11: "Do NOT keep agents around if they have no more tasks"
   - Removed unused `agentCount` variable

2. **`server/sessionManager.js`** — Idle timeout detection for sub-agents
   - Tracks `_idleStartTime` — set when agent enters `idle` state via JSONL events, cleared on any activity
   - 30-second idle check interval (starts after 2min initial delay)
   - **5 minutes idle** → emits `agent_idle_warning` event
   - **10 minutes idle** → emits `agent_idle_killed` event and auto-kills the session
   - Only applies to sub-agents (`role === "agent"`), not the orchestrator
   - `onIdleEvent()` listener API for event forwarding
   - `SessionManager.onIdleEvent()` — global listener that forwards from all sessions

3. **`server/index.js`** — WebSocket broadcast of idle events
   - Broadcasts `agent-idle` messages with event type and session metadata
   - On `agent_idle_killed`, removes the agent from the team's agent list and persists

4. **Frontend** — Idle status display and toast notifications
   - Idle agents get dimmed tabs (`tab-idle` class, 45% opacity)
   - Agent state badge shows "idle" with appropriate styling
   - Toast notification system (slide-in from right, auto-dismiss after 6s)
   - Warning toast (yellow border) at 5 minutes idle
   - Error toast (red border) when agent is auto-stopped at 10 minutes

**Estimated savings:** 20-40% reduction in idle token waste for teams where not all agents are needed simultaneously.

---

#### Phase B: Shared Context Store ✅ DONE

**Problem:** Each agent independently reads the same project files (package.json, README, key source files) to build context. A 4-agent team reading the same 10 files = 4x the token cost for identical information.

**What Was Implemented:**
1. **`server/contextStore.js`** — New `ContextStore` class
   - In-memory Map: `key → { content, summary, tokens, lastUpdated, accessCount, storedBy, storedByName, teamId }`
   - Methods: `store()`, `query()`, `list()`, `get()`, `invalidate()`, `clearTeam()`, `getStats()`
   - Keyword-based search across keys and summaries, sorted by relevance score + access count
   - Persisted to `~/.team-maker/state.json` under `contexts` key via StateStore
   - Size cap: 500KB total stored content, 200 max entries, LRU eviction
   - Event listeners for WebSocket broadcast on context changes

2. **`server/mcpServer.js`** — Three new MCP tools
   - `store_context(key, content, summary?, fromAgentId?)` — agent shares knowledge with the team
   - `query_context(query)` — agent searches shared knowledge by keywords, returns full content
   - `list_context()` — agent discovers what knowledge is already available (keys + summaries)

3. **`server/index.js`** — REST API endpoints
   - `POST /api/teams/:teamId/context` — store a context entry
   - `GET /api/teams/:teamId/context` — list all entries with stats
   - `GET /api/teams/:teamId/context/query?q=` — search by keywords
   - `GET /api/teams/:teamId/context/:key` — get single entry with full content
   - `DELETE /api/teams/:teamId/context/:key` — delete an entry
   - WebSocket broadcast of `team-context` events on every store/invalidate
   - Team deletion cleans up associated context entries

4. **`server/promptBuilder.js`** — Agent prompts updated
   - Orchestrator prompt: added Shared Context Store tools section with context sharing strategy (have architect store findings for other agents)
   - Sub-agent prompt: added context store tools with **IMPORTANT** instruction to check `list_context()` BEFORE reading project files, and `store_context()` after analysis

5. **Frontend** — Context panel (🧠 tab)
   - "Context" tab in tab bar alongside Usage/Messages/Tasks/Events
   - Context panel showing all shared entries with key, summary, author, token count, access count
   - Storage stats bar (entries, bytes used, percentage)
   - Real-time updates via `team-context` WebSocket events
   - Catppuccin Mocha themed with monospace keys

**Estimated savings:** 30-50% reduction in duplicate file-reading tokens.

**Future LangChain upgrade path:**
```
Phase B (now):     ContextStore (in-memory Map, keyword match)
                        ↓ swap backend, same MCP tools
Phase B+ (later):  LangChain VectorStore (FAISS/Chroma/Pinecone)
                   - store_context() → embed + upsert
                   - query_context() → semantic similarity search
                   - Add: LangChain document loaders for auto-indexing project files
                   - Add: RecursiveCharacterTextSplitter for large files
                   - New dependency: langchain, @langchain/community, embedding model
```

The MCP tool interface (`store_context`, `query_context`, `list_context`) stays the same — only the backend changes. Agents don't need prompt updates when switching to vector search.

---

#### Phase C: Smart Model Routing — do last (requires AP4 task board)

**Problem:** Per-agent model selection is static. An Opus agent uses Opus for everything — including trivial coordination messages that Haiku could handle at 1/50th the cost.

**Depends on:** AP4 (task board) — needs task metadata to distinguish "coordination" from "substantive" work.

**Implementation Plan:**
1. **`server/taskBoard.js`** — Add task complexity field
   - Extend task schema: `{ ..., complexity: "low"|"medium"|"high" }`
   - Orchestrator sets complexity when creating tasks
   - `low` = coordination, status checks, simple file reads
   - `medium` = standard coding tasks, reviews
   - `high` = architecture decisions, complex debugging, multi-file refactors
2. **`server/sessionManager.js`** — Dynamic model switching
   - When agent claims a task, check task complexity against a model routing table:
     | Complexity | Model |
     |-----------|-------|
     | `low` | Haiku |
     | `medium` | Sonnet |
     | `high` | Opus |
   - Model routing table configurable per team (UI setting)
   - **Challenge:** Claude Code CLI sets the model at spawn time — mid-session model switching may not be possible without restarting the session. Investigate whether `--model` can be changed via CLI command or if this requires spawning a new session per task.
3. **Alternative if mid-session switching isn't possible:**
   - Maintain a pool of sessions at different model tiers
   - Route tasks to the appropriate session based on complexity
   - This changes the agent model from "one persistent agent" to "task worker pool"
   - More complex but potentially more efficient

**Estimated savings:** 40-60% cost reduction on coordination overhead (Haiku is ~1/50th the cost of Opus).

**Status:** Deferred until AP4 (task board) is implemented and we can test whether Claude Code CLI supports mid-session model switching.

---

## What the Project Does Well

For balance, these patterns are good and worth preserving:

1. **MCP tool integration** — Using the Model Context Protocol for `spawn_agent`, `list_agents`, and `send_message` is the right abstraction. The tools just need better implementations behind them.

2. **Role specialization** — Architect/Builder/Validator/Scribe is a well-thought-out division of labor that maps to real software development workflows. The customizable role editor and templates add flexibility.

3. **Per-agent model selection** — Allowing Haiku for simple agents and Opus for complex ones is cost-aware design. This should be extended to per-task model selection.

4. **Web UI observability** — Seeing all agent terminals simultaneously is genuinely valuable for understanding and debugging multi-agent behavior. Most orchestration frameworks lack this.

5. **Token/cost tracking** — The JSONL polling for usage metrics gives users visibility into what they're spending. The usage dashboard is a good accountability tool.

6. **Template system** — Saving and reusing role configurations reduces setup friction and encourages experimentation with team compositions.

---

## Priority Order for Fixes

| Priority | Item | Chosen Option | Effort | Key Win | Status |
|----------|------|---------------|--------|---------|--------|
| ~~1~~ | ~~AP1: Wake Loop~~ | ~~C: Remove + health-check~~ | ~~Low~~ | ~~60-80% token savings~~ | ✅ Done |
| ~~1.5~~ | ~~Persistence Layer~~ | ~~JSON file store (`~/.team-maker/state.json`)~~ | ~~Low~~ | ~~State survives restarts, foundation for AP2+AP4~~ | ✅ Done |
| ~~2~~ | ~~AP2: File Messaging~~ | ~~A: Server-side message queue~~ | ~~Medium~~ | ~~Reliable comms, message history, delivery tracking~~ | ✅ Done |
| ~~3~~ | ~~AP4: No Task State~~ | ~~A: Server-side task board~~ | ~~Medium~~ | ~~Flow control, visualization, dependency tracking~~ | ✅ Done |
| ~~4~~ | ~~AP3: PTY Control Plane~~ | ~~C: Hybrid (PTY display + JSONL control)~~ | ~~Medium~~ | ~~Structured events, resilience, keeps free subscription~~ | ✅ Done |
| ~~5a~~ | ~~AP5-A: Lazy Spawning~~ | ~~On-demand spawn + idle timeout~~ | ~~Low~~ | ~~20-40% idle token savings~~ | ✅ Done |
| ~~5b~~ | ~~AP5-B: Shared Context~~ | ~~In-memory store → LangChain vector DB~~ | ~~Medium~~ | ~~30-50% duplicate read savings, LangChain foundation~~ | ✅ Done |
| **5c** | **AP5-C: Smart Model Routing** | **Per-task model selection** | Medium | 40-60% coordination cost reduction | Planned (AP4 done) |

### Dependency chain
```
AP1 (done) → Persistence Layer (done) → AP2 (done) → AP4 (done) → AP5-C (smart model routing)
                                               ↓                     ↓
                                          AP5-A (lazy spawn)    AP5-B (shared context → LangChain)
                                          (can start anytime)

                                       AP3 (hybrid JSONL) — ✅ Done
```
- ~~**Persistence Layer** is the prerequisite — AP2 and AP4 need somewhere to store messages and tasks~~ ✅ Done
- ~~AP2 (message queue) is foundational — AP4 (task board) builds on its infrastructure~~ ✅ Done
- ~~AP4 (task board) enables task-level tracking — AP5-C can now use task metadata~~ ✅ Done
- ~~AP3 (hybrid JSONL) is independent — next up~~ ✅ Done
- ~~AP5-A (lazy spawning) has no hard dependencies — can be done anytime~~ ✅ Done
- ~~AP5-B (shared context) uses the persistence layer, best done after AP3~~ ✅ Done
- AP5-C (smart model routing) can now start (AP4 done, AP5-A done)

### Design constraint
Team Maker runs agents as Claude Code CLI processes under a **Pro/Max flat-rate subscription**. All architectural decisions preserve this model — no migration to the Anthropic API (pay-per-token) unless building a commercial product. This is why Option C (hybrid) was chosen for AP3 instead of Option B (SDK/API).

---

## Architecture Vision: Before and After

### Current Architecture (after AP1-AP4 + AP3 + AP5-A + AP5-B)
```
Browser (xterm.js + task board UI + message log + event stream + context panel + toast notifications)
  ↕ WebSocket (terminal bytes + structured events + idle events + context events)
Express Server (with MessageQueue + TaskBoard + ContextStore + StateStore + JsonlWatcher + IdleTimeout)
  ↕ PTY (display only) + JSONL (structured control plane) + MCP (tool interface)
  ↕ ~/.team-maker/state.json (persistence — teams, messages, tasks, contexts, templates)
Claude Code CLI instances (spawned on-demand, auto-killed when idle)
  ↕ MCP tools (check_inbox, create_task, complete_task, store_context, query_context, list_context)
Agent-to-Agent communication (event-driven, server-mediated)
```

Key differences:
- PTY is demoted to display-only; structured data flows through MCP and JSONL
- Server mediates all inter-agent communication (no direct file sharing)
- Task state is server-managed with persistence
- Agents are nudged only when there's actual work (event-driven, not polling)
- Agents are spawned on-demand and auto-killed after 10 minutes idle (AP5-A)
- Shared context store reduces duplicate file reads by 30-50% (AP5-B)
- Context store provides future LangChain/vector DB integration point (swap backend, same MCP tools)
- All changes preserve the Claude Pro/Max subscription model (no API costs)

### Future: LangChain Integration Path
```
Shared Context Store (in-memory)
  → Replace with LangChain vector store (FAISS/Chroma/Pinecone)
  → query_context() MCP tool does semantic search over project knowledge
  → Agents get relevant context without each one reading the same files
  → RAG pipeline: project files → embeddings → vector DB → agent queries
```
