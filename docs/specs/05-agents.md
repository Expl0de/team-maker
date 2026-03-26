# Agent Orchestration

> **Spec Status**: [ ] Draft
> **Last Updated**: 2026-03-26

## Purpose

Define the multi-agent orchestration system: MCP server architecture, all MCP tools with full schemas, agent lifecycle, task board state machine, messaging flow, context store usage patterns, project memory persistence, and the orchestrator pattern.

## Scope

Covers the agent orchestration layer built on top of the core session/team infrastructure. For backend implementation details, see [03-backend.md](03-backend.md). For API contracts, see [02-contracts.md](02-contracts.md).

---

## Components / Features

### MCP Server Architecture
> Status: [ ] Pending

**Purpose**: Extend Claude Code with team management tools via the Model Context Protocol.

**Responsibilities**:
- Run as a separate Node.js process per team
- Expose 17 tools to the Claude Code CLI
- Proxy all tool calls to the Team Maker HTTP server via REST

**Interfaces**:
- Input: Tool calls from Claude Code CLI (via stdio JSON-RPC)
- Output: Tool results (text responses)

**Behavior / Rules**:

**Process Architecture**:
```
Claude Code CLI
    ├── stdin/stdout ──► MCP Server (mcpServer.js)
    │                         │
    │                         └── HTTP fetch() ──► Team Maker Express Server
    │                                                    │
    │                                              localhost:3456
    └── PTY terminal I/O ──► Team Maker Session
```

**Configuration**:
- MCP config file: `/tmp/team-maker-mcp-{teamId}.json`
- Written by `teamManager._ensureMcpConfig()` on team/agent creation
- Config structure:
```json
{
  "mcpServers": {
    "team-maker": {
      "command": "node",
      "args": ["/path/to/server/mcpServer.js"],
      "env": {
        "TEAM_ID": "<uuid>",
        "TEAM_MAKER_PORT": "3456"
      }
    }
  }
}
```

**Server Setup**:
- Uses `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport)
- Server name: "team-maker", version: "1.0.0"
- All parameters validated with Zod schemas (required by SDK)
- TEAM_ID from environment (required, exits if missing)
- BASE_URL: `http://localhost:{PORT}` (PORT from TEAM_MAKER_PORT env, default 3456)

**Error Handling**:
- All tools wrapped in try/catch
- Errors returned as: `{ content: [{ type: "text", text: "Error: {message}" }], isError: true }`
- Non-200 HTTP responses also return `isError: true`

**Acceptance Criteria**:
- [ ] MCP server starts and connects via stdio
- [ ] All 17 tools registered and callable
- [ ] Tool calls correctly proxied to HTTP server
- [ ] Errors propagated back to Claude Code
- [ ] TEAM_ID scoping ensures team isolation

**Open Questions**: None

---

### MCP Tools — Agent Management

#### spawn_agent
> Status: [ ] Pending

**Purpose**: Spawn a new agent in the team.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| name | z.string() | Yes | Display name for the agent |
| prompt | z.string() | Yes | Task/instruction prompt injected on startup |
| model | z.string() | No | Explicit model override (e.g. "claude-sonnet-4-6") |
| taskComplexity | z.enum(["low","medium","high"]) | No | Auto-select model from team's routing table |

**Behavior**:
1. POST /api/teams/{TEAM_ID}/agents with { name, prompt, model, taskComplexity }
2. Server creates session via teamManager.addAgent()
3. Model selection: explicit model > routing table[complexity] > team default
4. Session spawned with autoAccept=true, MCP config, initialPrompt
5. Returns agent ID and model info

**Return**: `Agent "{name}" spawned with ID: {id} (model: {model})`

**Acceptance Criteria**:
- [ ] Agent spawned with correct name and prompt
- [ ] Model routing applies correctly
- [ ] Agent appears in list_agents output

---

#### list_agents
> Status: [ ] Pending

**Purpose**: List all agents in the team with their status.

**Parameters**: None

**Behavior**: GET /api/teams/{TEAM_ID}/agents → formats each agent as one line

**Return**: `- {name} ({id}) [{status}] role={role}` per agent, or "No agents in team."

**Acceptance Criteria**:
- [ ] All team agents listed
- [ ] Status and role shown per agent
- [ ] Session ID included for use with other tools

---

### MCP Tools — Messaging

#### send_message
> Status: [ ] Pending

**Purpose**: Send a message to another agent. Dual delivery: queued server-side + instant PTY injection.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| agentId | z.string() | Yes | Recipient's session ID |
| message | z.string() | Yes | Message text |
| fromAgentId | z.string() | No | Sender's session ID (for tracking) |

**Behavior**:
1. POST /api/messages/send with { from, to, message, teamId }
2. Server enqueues in MessageQueue (persistent)
3. Server injects into recipient PTY: `\n📨 Message from {fromName}:\n{message}\r`
4. Broadcasts { type: "team-message" } to WebSocket clients

**Return**: `Message sent to {toName} (queued as {messageId})`

**Acceptance Criteria**:
- [ ] Message delivered instantly via PTY injection
- [ ] Message queued for later retrieval
- [ ] Sender name resolved from session ID
- [ ] WebSocket broadcast triggers UI update

---

#### check_inbox
> Status: [ ] Pending

**Purpose**: Retrieve unread messages for the calling agent.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| agentId | z.string() | Yes | Your own session ID |

**Behavior**: GET /api/messages/inbox?agentId={id} → returns unread messages

**Return**: Formatted list with message IDs, sender names, timestamps, and content. Or "No unread messages."

**Acceptance Criteria**:
- [ ] Returns only unread messages
- [ ] Message IDs included for mark_read
- [ ] Sender names resolved

---

#### mark_read
> Status: [ ] Pending

**Purpose**: Acknowledge messages after processing.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| messageId | z.string() | Yes | Message ID or "all" |
| agentId | z.string() | No | Required when messageId="all" |

**Behavior**: POST /api/messages/read with { messageId, agentId, teamId }

**Return**: Confirmation text (e.g., "Marked 3 message(s) as read")

**Acceptance Criteria**:
- [ ] Single message marked as read
- [ ] "all" marks all unread messages for the agent
- [ ] Marked messages excluded from future check_inbox

---

### MCP Tools — Task Board

#### create_task
> Status: [ ] Pending

**Purpose**: Create a task on the team's shared task board.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| title | z.string() | Yes | Short task title |
| description | z.string() | No | Detailed description |
| complexity | z.enum(["low","medium","high"]) | No | For model routing (default: medium) |
| dependsOn | z.array(z.string()) | No | Task IDs that must complete first |
| fromAgentId | z.string() | No | Creator's session ID |

**Behavior**: POST /api/teams/{TEAM_ID}/tasks

**Return**: `Task created: "{title}" (ID: {id})`

**Acceptance Criteria**:
- [ ] Task created with pending status
- [ ] Dependencies recorded
- [ ] Complexity stored for routing
- [ ] Creator name resolved from session ID

---

#### claim_task
> Status: [ ] Pending

**Purpose**: Claim a pending task. Dependencies must be completed first.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | z.string() | Yes | Task to claim |
| agentId | z.string() | Yes | Your session ID |

**Behavior**:
1. POST /api/teams/{TEAM_ID}/tasks/{taskId}/claim with { agentId }
2. Server checks: task must be pending, all dependsOn must be completed
3. Sets status to "assigned", records assignee

**Return**: `Claimed task: "{title}" — now assigned to you. Start working on it.`

**Error Cases**:
- Task not pending: "Task is {status}, not pending"
- Unmet dependencies: "Blocked by unfinished dependencies: {list}"

**Acceptance Criteria**:
- [ ] Pending tasks can be claimed
- [ ] Non-pending tasks rejected
- [ ] Unmet dependencies reported with names
- [ ] Assignee recorded

---

#### complete_task
> Status: [ ] Pending

**Purpose**: Mark a task as completed with a result summary.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | z.string() | Yes | Task to complete |
| agentId | z.string() | Yes | Your session ID |
| result | z.string() | Yes | Summary of what was accomplished |

**Behavior**: Sets status to "completed", stores result

**Return**: `Task completed: "{title}"`

**Acceptance Criteria**:
- [ ] Only assigned/in_progress tasks can be completed
- [ ] Only the assigned agent can complete
- [ ] Result summary stored
- [ ] Dependent tasks become claimable

---

#### fail_task
> Status: [ ] Pending

**Purpose**: Mark a task as failed so the orchestrator can reassign it.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | z.string() | Yes | Task that failed |
| agentId | z.string() | Yes | Your session ID |
| reason | z.string() | Yes | Why the task failed |

**Behavior**: Sets status to "failed", clears assignee (allows reassignment), stores reason

**Return**: `Task failed: "{title}" — reason: {reason}`

**Acceptance Criteria**:
- [ ] Only assigned/in_progress tasks can be failed
- [ ] Assignee cleared for reassignment
- [ ] Failure reason stored
- [ ] Task can be retried later

---

#### get_tasks
> Status: [ ] Pending

**Purpose**: View the team's task board with optional filters.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| status | z.string() | No | Filter by status |
| assignedTo | z.string() | No | Filter by assignee |

**Behavior**: GET /api/teams/{TEAM_ID}/tasks with query params

**Return**: Formatted task list showing:
- `[STATUS] [complexity] Title (ID) → Assignee (depends on: deps)`
- `Description`
- `Result:` or `Reason:` if applicable
- Summary: `{"total":N,"pending":N,...}`

**Acceptance Criteria**:
- [ ] All tasks listed with full metadata
- [ ] Filters work by status and assignee
- [ ] Summary counts included
- [ ] Dependencies shown

---

### MCP Tools — Context Store

#### store_context
> Status: [ ] Pending

**Purpose**: Share knowledge with the team to prevent redundant file reads.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| key | z.string() | Yes | Descriptive key (e.g., "package.json-deps") |
| content | z.string() | Yes | Analysis/knowledge to store |
| summary | z.string() | No | One-line discovery summary |
| fromAgentId | z.string() | No | Storer's session ID |

**Behavior**: POST /api/teams/{TEAM_ID}/context → upserts entry

**Return**: `Context stored: "{key}" (~{tokens} tokens). Other agents can find it with list_context() or query_context("{key}").`

**Acceptance Criteria**:
- [ ] Context stored with token estimation
- [ ] Existing key updated (upsert)
- [ ] WebSocket event broadcast
- [ ] LRU eviction if over limits

---

#### query_context
> Status: [ ] Pending

**Purpose**: Search the team's shared context by keywords.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | z.string() | Yes | Space-separated keywords |

**Behavior**: GET /api/teams/{TEAM_ID}/context/query?q={query} → keyword match on keys + summaries

**Return**: Matching entries with full content, scores, and storer names. Or "No context found matching..."

**Acceptance Criteria**:
- [ ] Keyword matching works on keys and summaries
- [ ] Full content returned for matches
- [ ] Results ranked by relevance score
- [ ] Access counts updated

---

#### list_context
> Status: [ ] Pending

**Purpose**: Discover what knowledge the team already has.

**Parameters**: None

**Behavior**: GET /api/teams/{TEAM_ID}/context → keys + summaries, no full content

**Return**: Entry list with key, token count, storer name, access count. Or "No shared context stored yet."

**Acceptance Criteria**:
- [ ] All entries listed with metadata
- [ ] No full content returned (lightweight)
- [ ] Helps agents decide whether to query or read files

---

### MCP Tools — Project Memory

#### store_project_memory
> Status: [ ] Pending

**Purpose**: Persist knowledge across teams for the same project.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| key | z.string() | Yes | Descriptive key (e.g., "arch-overview") |
| content | z.string() | Yes | Analysis/findings to persist |
| summary | z.string() | No | One-line summary (shown in future team prompts) |

**Behavior**: POST /api/teams/{TEAM_ID}/project-memory → writes to `<cwd>/.team-maker/project-memory.json`

**Return**: `Project memory stored: "{key}". Future teams on this project will see this in their context.`

**Acceptance Criteria**:
- [ ] Entry persisted in project directory
- [ ] Available to future teams via snapshot
- [ ] Summary appears in orchestrator prompt
- [ ] No secrets stored (guideline, not enforced)

---

#### query_project_memory
> Status: [ ] Pending

**Purpose**: Search project memory across keys, summaries, and content.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| query | z.string() | Yes | Search keywords |

**Behavior**: POST /api/teams/{TEAM_ID}/project-memory/query

**Return**: Matching entries with full content and relevance scores. Or "No project memory found matching..."

**Acceptance Criteria**:
- [ ] Searches across keys, summaries, and content
- [ ] Includes deprecated entries (still searchable)
- [ ] Results ranked by score

---

#### list_project_memory
> Status: [ ] Pending

**Purpose**: Discover what previous teams have documented.

**Parameters**: None

**Behavior**: GET /api/teams/{TEAM_ID}/project-memory → keys + summaries

**Return**: Entry list with key, summary, stored-by label, last updated date. Or "No project memory stored yet."

**Acceptance Criteria**:
- [ ] All entries listed including deprecated
- [ ] Deprecated entries marked
- [ ] Summary and storer info shown

---

#### deprecate_project_memory
> Status: [ ] Pending

**Purpose**: Mark a project memory entry as stale when it no longer reflects reality.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| key | z.string() | Yes | Key to deprecate |
| reason | z.string() | No | Why it's stale |

**Behavior**: DELETE /api/teams/{TEAM_ID}/project-memory/{key} → soft-deprecate (not hard delete)

**Return**: `Project memory entry "{key}" marked as deprecated. It will no longer appear in future team prompts.`

**Acceptance Criteria**:
- [ ] Entry marked deprecated (not deleted)
- [ ] Excluded from future team prompt snapshots
- [ ] Still searchable via query_project_memory
- [ ] Reason recorded

---

### Agent Lifecycle
> Status: [ ] Pending

**Purpose**: Define the complete lifecycle of agents from creation to completion.

**Responsibilities**:
- Agent spawning and initialization
- State tracking throughout execution
- Communication patterns
- Idle management and cleanup

**Interfaces**:
- Input: Orchestrator commands (spawn_agent, send_message)
- Output: Task results, messages, context

**Behavior / Rules**:

**Lifecycle Stages**:

```
1. SPAWN
   Orchestrator calls spawn_agent(name, prompt)
   → TeamManager.addAgent() creates session
   → node-pty spawns Claude CLI with --mcp-config
   → Auto-accept trust dialog
   → Inject initial prompt after ready signal

2. INITIALIZE
   Agent processes initial prompt
   → Discovers own session ID via list_agents()
   → Checks list_context() and list_project_memory() for prior knowledge
   → Agent state: starting → working

3. WORK
   Agent claims tasks via claim_task()
   → Executes work (reads files, writes code, etc.)
   → Stores findings via store_context()
   → Agent state cycles: working ↔ tool_calling ↔ thinking

4. REPORT
   Agent completes task via complete_task(result)
   → Sends message to orchestrator via send_message()
   → Agent state: working → idle (after turn_complete)

5. IDLE
   Agent waits for next task assignment
   → 5 min idle → warning event
   → 10 min idle → auto-kill
   → Orchestrator can send new task or let agent be killed

6. EXIT
   PTY process exits (normal completion or kill)
   → Agent state: → completed
   → Session cleaned up
```

**Agent States** (tracked from JSONL events):
| State | Trigger | Description |
|-------|---------|-------------|
| starting | Session created | CLI initializing, loading MCP server |
| working | assistant_message or tool_result | Actively processing |
| idle | turn_complete | Waiting for input |
| tool_calling | tool_call | Executing a tool |
| thinking | thinking block | Extended thinking |
| completed | PTY exit | Session finished |

**Acceptance Criteria**:
- [ ] Agents progress through all lifecycle stages
- [ ] State tracking reflects actual agent activity
- [ ] Idle management prevents resource waste
- [ ] Clean exit and resource cleanup

**Open Questions**: None

---

### Task Board State Machine
> Status: [ ] Pending

**Purpose**: Define the formal state machine for task transitions.

**Responsibilities**:
- Enforce valid state transitions
- Manage dependency resolution
- Support failure recovery

**Interfaces**:
- Input: MCP tool calls (create, claim, complete, fail, retry)
- Output: State changes, events

**Behavior / Rules**:

**State Diagram**:
```
                    ┌─────────────────────────────────┐
                    │                                 │
                    v                                 │
              ┌──────────┐                            │
  create ──►  │ PENDING  │ ◄── retry ── ┌────────┐   │
              └────┬─────┘              │ FAILED │   │
                   │                    └────┬───┘   │
              claim│                         │       │
                   v                    fail │       │
              ┌──────────┐                   │       │
              │ ASSIGNED │ ──────────────────┘       │
              └────┬─────┘                           │
                   │                                 │
              start│                                 │
                   v                                 │
              ┌─────────────┐                        │
              │ IN_PROGRESS │ ── fail ──► FAILED ────┘
              └──────┬──────┘
                     │
                complete
                     │
                     v
              ┌───────────┐
              │ COMPLETED │
              └───────────┘
```

**Transition Rules**:
| From | Action | To | Conditions |
|------|--------|----|-----------|
| — | create | pending | — |
| pending | claim | assigned | All dependsOn completed |
| assigned | start | in_progress | Same agent |
| assigned | complete | completed | Same agent |
| assigned | fail | failed | Same agent; clears assignee |
| in_progress | complete | completed | Same agent |
| in_progress | fail | failed | Same agent; clears assignee |
| failed | retry | pending | — (clears failReason, assignee) |

**Dependency Resolution**:
- Tasks have `dependsOn: string[]` (task IDs)
- `claimTask()` checks all deps: each must exist AND be "completed"
- Unmet deps reported with task titles and statuses
- No circular dependency detection (orchestrator responsibility)

**Complexity-Based Routing**:
- Tasks have `complexity: "low"|"medium"|"high"` (default: medium)
- `getRecommendedModel(taskId, routingTable)` returns model for task's complexity
- Used by orchestrator when spawning agents with `taskComplexity` param

**Acceptance Criteria**:
- [ ] All valid transitions work
- [ ] Invalid transitions rejected with error
- [ ] Dependencies checked on claim
- [ ] Failed tasks retain history (failReason) after retry
- [ ] Complexity stored and queryable

**Open Questions**: None

---

### Messaging Flow
> Status: [ ] Pending

**Purpose**: Define the complete message delivery and retrieval flow.

**Responsibilities**:
- Instant delivery via PTY injection
- Reliable queuing for later retrieval
- Message history and read tracking

**Interfaces**:
- Input: send_message tool call
- Output: PTY injection, queue entry, WebSocket broadcast

**Behavior / Rules**:

**Send Flow**:
```
Agent A calls send_message(agentId=B, message="Hello")
    │
    ├──► MCP Server: POST /api/messages/send { from: A, to: B, message: "Hello", teamId }
    │
    ├──► messageQueue.enqueue() → persisted in stateStore
    │
    ├──► sessionB.injectInput("\n📨 Message from AgentA:\nHello\r")
    │    (Agent B receives message INSTANTLY in their PTY terminal)
    │
    └──► broadcast { type: "team-message", ... }
         (Frontend messages panel updates in real-time)
```

**Receive Flow (instant)**:
```
Agent B's PTY receives:
    📨 Message from AgentA:
    Hello

Agent B's Claude Code CLI processes this as user input
and responds accordingly.
```

**Receive Flow (queued, backup)**:
```
Agent B calls check_inbox(agentId=B)
    │
    ├──► MCP Server: GET /api/messages/inbox?agentId=B
    │
    ├──► Returns all unread messages with IDs
    │
    └──► Agent B calls mark_read(messageId) to acknowledge
```

**Message Format in PTY**:
```
\n📨 Message from {fromName}:\n{content}\r
```
- `\n` prefix for visual separation
- `📨` emoji prefix for easy identification
- `\r` at end to submit as user input (after 300ms delay)

**Acceptance Criteria**:
- [ ] Messages delivered instantly via PTY
- [ ] Messages also queued for reliable retrieval
- [ ] Read status tracked
- [ ] History queryable per agent and per team

**Open Questions**: None

---

### Context Store Usage Patterns
> Status: [ ] Pending

**Purpose**: Define recommended patterns for using the shared context store effectively.

**Responsibilities**:
- Guide agents on when/how to store context
- Define key naming conventions
- Optimize token usage across agents

**Interfaces**:
- Input: Agent analysis work
- Output: Shared knowledge entries

**Behavior / Rules**:

**Recommended Workflow**:
1. **First agent (Architect)** reads codebase files
2. Stores structured findings: `store_context("src-architecture", analysis, "Component map and data flows")`
3. **Subsequent agents** check `list_context()` before reading files
4. If relevant context exists: `query_context("architecture")` → use findings
5. If not: read files, then `store_context()` for the next agent

**Key Naming Conventions**:
- `package.json-deps` — dependency analysis
- `src-architecture` — codebase structure
- `api-routes` — REST endpoint inventory
- `auth-flow` — authentication flow analysis
- `test-results` — test execution results

**Limits to Be Aware Of**:
- 500KB total content
- 200 max entries
- LRU eviction (oldest by lastUpdated)
- Token estimation: ~3.3 chars/token (code), ~4.5 (prose)

**Anti-Patterns**:
- Storing entire file contents (too large, read directly instead)
- Storing every intermediate result (noise, evicts useful entries)
- Not checking context before reading files (wasteful)

**Acceptance Criteria**:
- [ ] Agents check context before reading files
- [ ] First agent stores codebase analysis
- [ ] Subsequent agents reuse stored context
- [ ] Key names are descriptive and consistent

**Open Questions**: None

---

### Project Memory Persistence
> Status: [ ] Pending

**Purpose**: Define how knowledge persists across teams for the same project.

**Responsibilities**:
- Persist significant findings for future teams
- Inject prior knowledge into new team orchestrator prompts
- Manage stale entries via deprecation

**Interfaces**:
- Input: Agent findings (via store_project_memory)
- Output: Snapshot in orchestrator prompt, searchable memory

**Behavior / Rules**:

**Storage Location**: `<cwd>/.team-maker/project-memory.json`

**Lifecycle**:
```
Team 1: Architect analyzes codebase
    │
    ├──► store_project_memory("arch-overview", analysis, "Full codebase architecture map")
    │
    └──► Team 1 completes

Team 2: New team on same project
    │
    ├──► TeamManager loads ProjectMemoryStore(cwd).snapshot()
    │         → "- arch-overview: Full codebase architecture map"
    │
    ├──► Snapshot injected into orchestrator prompt:
    │         "## Prior Project Knowledge
    │          Previous teams documented:
    │          - arch-overview: Full codebase architecture map"
    │
    ├──► Orchestrator tells agents to check project memory
    │
    └──► Agents call query_project_memory("architecture") → reuse findings
```

**Snapshot Generation**:
- `snapshot()`: filters out deprecated entries, returns `- key: summary` bullets
- Returns `null` if no active entries
- Injected into `buildOrchestratorPrompt()` as "Prior Project Knowledge" section

**Deprecation Flow**:
```
Agent discovers entry is outdated
    │
    ├──► deprecate_project_memory("arch-overview", "Refactored in v2")
    │         → Sets deprecated: true, reason, timestamp
    │
    ├──► Entry excluded from future snapshot()
    │
    └──► Entry still searchable via query_project_memory()
```

**Gitignore Protection**:
- `.team-maker/.gitignore` ignores `*/` (session artifact dirs)
- Allows `project-memory.json` to be committed if desired

**Acceptance Criteria**:
- [ ] Memory persists across team sessions
- [ ] Snapshot appears in new team orchestrator prompts
- [ ] Deprecated entries excluded from snapshot
- [ ] .gitignore protects session dirs

**Open Questions**: None

---

### Orchestrator Pattern
> Status: [ ] Pending

**Purpose**: Define the behavior pattern for Agent 0 (the orchestrator).

**Responsibilities**:
- Receive and understand user tasks
- Plan work breakdown on the task board
- Spawn agents on demand
- Coordinate work and communication
- Handle failures and blockers
- Report results to the user

**Interfaces**:
- Input: User prompt, agent messages, task events
- Output: Tasks, agent spawns, messages, user communication

**Behavior / Rules**:

**Orchestrator Workflow**:
```
1. RECEIVE PROMPT
   ├── Read and understand user's task
   ├── Check prior project knowledge (list_project_memory)
   ├── Summarize understanding to user
   └── WAIT for user go-ahead (do NOT start automatically)

2. PLAN (after user confirms)
   ├── Break task into concrete tasks (create_task)
   ├── Set dependencies between tasks (dependsOn)
   ├── Tag complexity for model routing (low/medium/high)
   └── Review plan with get_tasks()

3. EXECUTE
   ├── Spawn first agent for tasks with no dependencies
   │   ├── Use spawn_agent with taskComplexity
   │   └── Send task assignment via send_message
   ├── WAIT for agent to complete (check_inbox / receive message)
   ├── On task completion:
   │   ├── Check for newly unblocked tasks
   │   ├── Spawn next agent if needed
   │   └── Relay information between agents if needed
   └── On task failure:
       ├── Assess failure reason
       ├── Reassign or create new task
       └── Spawn replacement agent if needed

4. COMPLETE
   ├── Verify all tasks completed (get_tasks)
   ├── Instruct agent to store_project_memory (for future teams)
   └── Report final status to user
```

**Critical Rules**:
1. **Do NOT build anything yourself** — delegate all implementation to agents
2. **Do NOT spawn all agents upfront** — only when tasks are unblocked
3. **Do NOT proceed without waiting** — wait for agent responses
4. **Use MCP tools, NOT Claude Code built-in tools** (Agent, TodoWrite, etc.)
5. **Efficiency**: kill idle agents, don't keep agents with no tasks

**Anti-Patterns**:
- Spawning all 4 agents at once (wastes resources)
- Implementing code directly (orchestrator's job is coordination)
- Using Claude Code's built-in Agent/Task tools (different system)
- Starting work before user confirms (user might want to adjust plan)

**Acceptance Criteria**:
- [ ] Orchestrator waits for user confirmation before starting
- [ ] Tasks created with proper dependencies
- [ ] Agents spawned only when tasks are unblocked
- [ ] Orchestrator coordinates, does not implement
- [ ] All tasks tracked through to completion

**Open Questions**: None

---

### Smart Model Routing
> Status: [ ] Pending

**Purpose**: Automatically select the appropriate Claude model based on task complexity.

**Responsibilities**:
- Map complexity levels to model IDs
- Apply routing at agent spawn time
- Support per-team configuration

**Interfaces**:
- Input: Task complexity, team routing table
- Output: Model selection for agent spawn

**Behavior / Rules**:

**Default Routing Table**:
| Complexity | Model | Use Cases |
|-----------|-------|-----------|
| low | claude-haiku-4-5-20251001 | Coordination, status checks, simple file reads |
| medium | claude-sonnet-4-6 | Standard coding, reviews, testing |
| high | claude-opus-4-6 | Architecture, complex debugging, multi-file refactors |

**Selection Priority** (highest to lowest):
1. Explicit `model` parameter on spawn_agent
2. Routing table lookup by `taskComplexity`
3. Team-level default model
4. No model specified (Claude Code default)

**Configuration**:
- Set on team creation via `modelRouting` param
- Updatable via PUT /api/teams/{teamId}/model-routing
- Viewable via GET /api/teams/{teamId}/model-routing (includes defaults)

**Acceptance Criteria**:
- [ ] Default routing table applied when enabled
- [ ] Per-team override works
- [ ] Explicit model always takes precedence
- [ ] Complexity tag on tasks informs routing

**Open Questions**: None
