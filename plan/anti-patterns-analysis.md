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

## Anti-Pattern 2: File-Based Message Passing

### Where
- `server/promptBuilder.js` — defines the file protocol in orchestrator prompt
- Agents read/write `.team-maker/<sessionId>/AGENT_COMMUNICATE.md` and `MULTI_AGENT_PLAN.md`

### Why It's an Anti-Pattern
- **No atomicity**: Two agents can write to `MULTI_AGENT_PLAN.md` simultaneously. The last write wins, silently dropping the other agent's update. There's no file locking mechanism.
- **No delivery guarantee**: Agent A appends a message to Agent B's `AGENT_COMMUNICATE.md`. There's no acknowledgment. Agent A doesn't know if B read it, processed it, or even exists anymore.
- **Full re-read on every check**: Agents must re-read the entire communication file each wake cycle to find new messages. As the conversation grows, this consumes more tokens linearly. A 50-message conversation file uses ~2000 tokens just to re-read.
- **No message ordering or deduplication**: Messages are appended as markdown text. If an agent crashes and restarts, it has no way to know which messages it already processed.
- **Context window pollution**: Long communication files compete with the agent's actual task context for space in the context window.

### Chosen: Option A — Structured message queue (server-side)

**Why Option A:** Option C (pure PTY injection) is what `send_message` already does, but it has no read receipts, no message history, and messages interleave with agent work. Option B still has race conditions. Option A gives us:
- Unread-only delivery (no re-reading entire files — massive token savings)
- Message history stored server-side (feeds the visualization/observability goal)
- Delivery confirmation (agents know if messages were received)
- Foundation for the task board (Anti-Pattern 4)

### Implementation Plan
1. **`server/messageQueue.js`** — New `MessageQueue` class
   - In-memory message store per agent (Map of agentId → message array)
   - Each message: `{ id, from, to, content, timestamp, read: false }`
   - Methods: `enqueue(from, to, content)`, `getUnread(agentId)`, `markRead(agentId, messageId)`, `getHistory(agentId)`
   - Broadcast message events over WebSocket for UI message log
2. **`server/mcpServer.js`** — New MCP tools
   - `check_inbox()` — returns only unread messages with IDs, replaces file-based inbox reads
   - `mark_read(messageId)` — acknowledges receipt, enables delivery tracking
   - Update `send_message` — route through MessageQueue instead of direct PTY injection, queue enqueue + PTY notify
3. **`server/promptBuilder.js`** — Update agent prompts
   - Remove file-based communication instructions (AGENT_COMMUNICATE.md references)
   - Replace with MCP-based messaging instructions: "Use `check_inbox()` to read messages, `send_message()` to send, `mark_read()` to acknowledge"
   - Keep `MULTI_AGENT_PLAN.md` for now (replaced in Anti-Pattern 4 with task board)
4. **Frontend** — Add message log panel
   - New WebSocket event type for messages (`{type: "message", from, to, content, timestamp}`)
   - Display message flow in UI alongside terminals (visual communication trace)

### Impact
- Eliminates race conditions and lost messages
- Reduces per-cycle token usage by 50-80% (no full file re-reads)
- Enables delivery confirmation
- **Prerequisite for:** Anti-Pattern 4 (task board builds on this messaging infrastructure)

---

## Anti-Pattern 3: PTY as the Control Plane

### Where
- `server/sessionManager.js` lines 122-134 (PTY spawn)
- `server/sessionManager.js` lines 238-253 (prompt injection via PTY write)
- `server/sessionManager.js` lines 160-220 (ANSI stripping + question detection)

### Why It's an Anti-Pattern
- **Timing-dependent**: Initial prompt injection waits 5 seconds (`setTimeout(5000)`) for CLI startup, then 500ms between pasting text and pressing Enter. If the CLI is slow (cold start, network lag), the prompt arrives before the CLI is ready and gets lost silently.
- **Fragile parsing**: Question detection relies on regex patterns matching against ANSI-stripped terminal output: `Do you want to`, `Allow`, `yes/no`, `(y/n)`, etc. Any CLI output format change (new prompt wording, different dialog style) breaks detection silently.
- **No structured data exchange**: The server reads raw terminal bytes. It cannot distinguish between:
  - Agent task output ("I created file X")
  - Agent status updates ("Working on step 3...")
  - Agent errors ("Failed to read file")
  - Agent-to-agent communication content
  - CLI system messages (permission prompts, warnings)
- **Scrollback as state**: The 100KB scrollback buffer is the only record of what happened. There's no structured event log, no way to query "what did Agent 2 do in step 3?" without parsing terminal text.
- **Resize sensitivity**: PTY dimensions (cols/rows) affect line wrapping, which affects ANSI stripping and pattern matching. A narrow terminal might break multi-line prompt detection.

### Chosen: Option C — Hybrid approach

**Why Option C:** Option B (SDK/API) would require paying per-token via the Anthropic API, losing the cost advantage of running under a Claude Pro/Max flat-rate subscription. Option A (JSONL-only) loses the terminal UI that is Team Maker's key differentiator. Option C keeps both:
- PTY stays for the user-facing terminal view (xterm.js) — the real-time observability users love
- JSONL parsing added as a parallel structured channel for the control plane
- Already partially implemented (token tracking reads JSONL) — extend to capture tool calls, completions, errors
- No subscription cost change — still runs under Claude Pro/Max

### Implementation Plan
1. **`server/sessionManager.js`** — Extend JSONL parsing
   - Current: polls JSONL for token/cost metrics only
   - Extend to extract: assistant messages, tool calls (name + args + result), errors, completion signals
   - Emit structured events over WebSocket: `{type: "agent_event", event: "tool_call"|"message"|"error", data: {...}}`
   - Use JSONL events as source of truth for agent activity state (active/idle/blocked/completed)
2. **Frontend** — Structured event log panel
   - New panel alongside terminals showing agent activity as structured events
   - Filter by agent, event type, time range
   - Clickable tool calls showing args and results
   - Replace question detection regex with structured JSONL-based detection where possible
3. **Deprecate PTY-based state tracking**
   - Keep ANSI stripping + question detection as fallback
   - Prefer JSONL-sourced events for all orchestration decisions
   - PTY becomes display-only; JSONL becomes the control plane

### Impact
- Eliminates timing-dependent failures
- Enables structured event logging and querying
- Makes the system resilient to CLI output format changes
- **Preserves free subscription model** — no API costs

---

## Anti-Pattern 4: No Task State Machine

### Where
- `server/teamManager.js` — teams track `agentIds` and `mainAgentId` but no task state
- `server/sessionManager.js` — sessions track `status` (running/exited) but not task progress
- Orchestrator prompt in `server/promptBuilder.js` — task coordination is entirely in free-form agent text

### Why It's an Anti-Pattern
- **No crash recovery**: If the server restarts, all team state is lost. Sessions are in-memory only. The PTY processes die with the server. There's no way to resume a multi-agent task.
- **No progress tracking**: The only way to know task status is to read terminal scrollback. There's no structured representation of "Agent 2 completed subtask X, Agent 3 is working on Y."
- **No retry logic**: If an agent fails (PTY crashes, CLI error, context window exhaustion), the orchestrator has no mechanism to detect this and reassign the work. The team just has a dead agent.
- **No completion detection**: The system doesn't know when the overall task is done. The orchestrator might declare completion in its terminal output, but the server doesn't parse or act on this.
- **No dependency tracking**: If Task B depends on Task A, there's no mechanism to ensure A completes before B starts. It's entirely up to the orchestrator agent to manage this via free-form text reasoning.

### Chosen: Option A — Server-side task board

**Why Option A:** This is the biggest win for the project's two core goals — **agent flow flexibility** and **visualization**. Option C (workflow engine) would mean a heavy rewrite and external dependency. Option B (persistent state) is a subset of Option A. The task board gives:
- Visible task flow in the UI (watch tasks move through states in real-time)
- Manual intervention capability (reassign/retry tasks from the UI)
- Structured dependency tracking (no more free-form text coordination)
- Replaces `MULTI_AGENT_PLAN.md` with something agents and humans can both interact with
- Foundation for future workflow graph visualization

### Implementation Plan
1. **`server/taskBoard.js`** — New `TaskBoard` class
   - Task states: `pending` → `assigned` → `in_progress` → `completed` | `failed`
   - Task schema: `{ id, title, description, status, assignedTo, dependsOn[], result, createdBy, timestamps }`
   - Methods: `createTask()`, `claimTask()`, `completeTask()`, `failTask()`, `getBoard()`, `getTasksByAgent()`
   - Dependency resolution: task can only be claimed if all `dependsOn` tasks are `completed`
   - Broadcast task state changes over WebSocket for real-time UI updates
2. **`server/mcpServer.js`** — New MCP tools
   - `create_task(title, description, dependsOn[])` — orchestrator creates tasks
   - `claim_task(taskId)` — agent claims a pending task
   - `complete_task(taskId, result)` — agent marks task done with summary
   - `fail_task(taskId, reason)` — agent marks task failed (enables reassignment)
   - `get_tasks(filter?)` — query current task board state
3. **`server/promptBuilder.js`** — Update orchestrator prompt
   - Remove `MULTI_AGENT_PLAN.md` file-based planning instructions
   - Replace with task board MCP tool instructions
   - Orchestrator creates tasks → sub-agents claim and execute → report completion
4. **Frontend** — Task board panel
   - Kanban-style columns: Pending | In Progress | Completed | Failed
   - Tasks show assignee, dependencies, timestamps
   - Click to view result/failure reason
   - Future: manual drag-and-drop for task reassignment

### Impact
- Enables crash recovery and task reassignment
- Provides structured progress visibility in the UI
- Reduces orchestrator token waste from managing state in free-form text
- **Depends on:** Anti-Pattern 2 fix (message queue infrastructure)

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

#### Phase A: Lazy Agent Spawning — do first (low effort, immediate savings)

**Problem:** All agents spawn at team creation even if the orchestrator hasn't figured out what to assign them yet. Idle agents consume context window tokens doing nothing.

**Implementation Plan:**
1. **`server/promptBuilder.js`** — Update orchestrator prompt
   - Change from "spawn all agents immediately" to "spawn agents when you have a task ready for them"
   - Add instruction: "Use `spawn_agent` only when you have a concrete task. Don't spawn agents speculatively."
2. **`server/sessionManager.js`** — Add idle timeout
   - Track `lastActivityTimestamp` per session (already partially exists via activity detection)
   - New method: `checkIdleAgents(teamId)` — if agent idle >5 minutes and has no pending tasks (via task board from AP4), send a warning message; if idle >10 minutes, auto-kill
   - Emit `{type: "agent_idle_warning"}` and `{type: "agent_idle_killed"}` WebSocket events
3. **`server/teamManager.js`** — Remove eager spawn
   - Team creation spawns only the orchestrator (Agent 0)
   - Orchestrator spawns sub-agents as needed via MCP `spawn_agent`
4. **Frontend** — Show idle status
   - Dim idle agent tabs, show idle duration badge
   - Toast notification when agent is auto-killed for idleness

**Estimated savings:** 20-40% reduction in idle token waste for teams where not all agents are needed simultaneously.

---

#### Phase B: Shared Context Store — do second (medium effort, LangChain integration point)

**Problem:** Each agent independently reads the same project files (package.json, README, key source files) to build context. A 4-agent team reading the same 10 files = 4x the token cost for identical information.

**Implementation Plan:**
1. **`server/contextStore.js`** — New `ContextStore` class
   - In-memory Map: `key → { content, summary, tokens, lastUpdated, accessCount }`
   - Methods:
     - `store(key, content, summary)` — agent stores a context snippet after reading a file or completing analysis
     - `query(query)` — keyword match against keys and summaries, return top-N results
     - `list()` — return all stored context keys with summaries (for agent discovery)
     - `invalidate(key)` — remove stale entries when files change
   - Persisted to `~/.team-maker/state.json` under `contexts` key (via StateStore from prerequisite)
   - Size cap: 500KB total stored content, LRU eviction
2. **`server/mcpServer.js`** — New MCP tools
   - `store_context(key, content, summary)` — agent shares knowledge with the team
   - `query_context(query)` — agent retrieves shared knowledge instead of re-reading files
   - `list_context()` — agent discovers what knowledge is already available
3. **`server/promptBuilder.js`** — Update agent prompts
   - Add instruction: "Before reading project files, check `list_context()` and `query_context()` to see if another agent already summarized them."
   - Orchestrator prompt: "After the architect analyzes the codebase, have them `store_context()` their findings so other agents don't repeat the work."
4. **Frontend** — Context store panel (optional)
   - Show shared context entries: key, summary, which agent stored it, access count
   - Visualization of knowledge flow between agents

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
| **2** | **AP2: File Messaging** | **A: Server-side message queue** | Medium | Reliable comms, message history, delivery tracking | 🔜 Next |
| **3** | **AP4: No Task State** | **A: Server-side task board** | Medium | Flow control, visualization, dependency tracking | Blocked by 2 |
| **4** | **AP3: PTY Control Plane** | **C: Hybrid (PTY display + JSONL control)** | Medium | Structured events, resilience, keeps free subscription | Planned |
| **5a** | **AP5-A: Lazy Spawning** | **On-demand spawn + idle timeout** | Low | 20-40% idle token savings | Planned |
| **5b** | **AP5-B: Shared Context** | **In-memory store → LangChain vector DB** | Medium | 30-50% duplicate read savings, LangChain foundation | Planned |
| **5c** | **AP5-C: Smart Model Routing** | **Per-task model selection** | Medium | 40-60% coordination cost reduction | Deferred (needs AP4) |

### Dependency chain
```
AP1 (done) → Persistence Layer (done) → AP2 (message queue) → AP4 (task board) → AP5-C (smart model routing)
                                               ↓                     ↓
                                          AP5-A (lazy spawn)    AP5-B (shared context → LangChain)
                                          (can start anytime)

                                       AP3 (hybrid JSONL) — independent, can parallel with AP4
```
- ~~**Persistence Layer** is the prerequisite — AP2 and AP4 need somewhere to store messages and tasks~~ ✅ Done
- AP2 (message queue) is foundational — AP4 (task board) builds on its infrastructure
- AP3 (hybrid JSONL) is independent and can be done in parallel with AP4
- AP5-A (lazy spawning) has no hard dependencies — can be done anytime after AP1
- AP5-B (shared context) uses the persistence layer, best done after AP4 so agents have tasks to contextualize
- AP5-C (smart model routing) requires AP4 task board for task complexity metadata

### Design constraint
Team Maker runs agents as Claude Code CLI processes under a **Pro/Max flat-rate subscription**. All architectural decisions preserve this model — no migration to the Anthropic API (pay-per-token) unless building a commercial product. This is why Option C (hybrid) was chosen for AP3 instead of Option B (SDK/API).

---

## Architecture Vision: Before and After

### Current Architecture
```
Browser (xterm.js)
  ↕ WebSocket (raw terminal bytes)
Express Server
  ↕ PTY stdin/stdout (unstructured text)
Claude Code CLI instances
  ↕ File system (AGENT_COMMUNICATE.md, MULTI_AGENT_PLAN.md)
Agent-to-Agent communication (polling, file-based)
```

### Proposed Architecture
```
Browser (xterm.js + task board UI + message log)
  ↕ WebSocket (terminal bytes + structured events)
Express Server (with MessageQueue + TaskBoard + StateStore)
  ↕ PTY (display only) + JSONL (structured state) + MCP (control plane)
  ↕ ~/.team-maker/state.json (persistence — teams, messages, tasks, templates)
Claude Code CLI instances
  ↕ MCP tools (check_inbox, create_task, complete_task, query_context)
Agent-to-Agent communication (event-driven, server-mediated)
```

Key differences:
- PTY is demoted to display-only; structured data flows through MCP and JSONL
- Server mediates all inter-agent communication (no direct file sharing)
- Task state is server-managed with persistence
- Agents are nudged only when there's actual work (event-driven, not polling)
- Shared context store provides future LangChain/vector DB integration point
- All changes preserve the Claude Pro/Max subscription model (no API costs)

### Future: LangChain Integration Path
```
Shared Context Store (in-memory)
  → Replace with LangChain vector store (FAISS/Chroma/Pinecone)
  → query_context() MCP tool does semantic search over project knowledge
  → Agents get relevant context without each one reading the same files
  → RAG pipeline: project files → embeddings → vector DB → agent queries
```
