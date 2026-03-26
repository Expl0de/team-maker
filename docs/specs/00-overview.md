# System Overview

> **Spec Status**: [ ] Draft
> **Last Updated**: 2026-03-26

## Purpose

Team Maker is a web-based manager for running multiple Claude Code CLI instances from a browser. It provides a unified interface for spawning, monitoring, and coordinating PTY-backed Claude Code processes, streaming terminal I/O over WebSocket to an xterm.js frontend. It enables multi-agent orchestration where a team of specialized AI agents collaborates on complex software engineering tasks.

## Scope

This document covers the high-level system purpose, target users, key concepts, and glossary. For detailed architecture, see [01-architecture.md](01-architecture.md). For API contracts, see [02-contracts.md](02-contracts.md).

## Key Concepts / Glossary

### Core Concepts

| Term | Definition |
|------|-----------|
| **Session** | A single Claude Code CLI process running inside a PTY (pseudo-terminal). Each session has a unique UUID, a scrollback buffer, and one or more WebSocket clients attached for real-time terminal I/O. |
| **PTY (Pseudo-Terminal)** | A virtual terminal device that allows Team Maker to spawn and interact with the Claude Code CLI as if it were running in a real terminal. Implemented via `node-pty`. |
| **xterm.js** | A browser-based terminal emulator that renders the PTY output in the frontend. Loaded from CDN with fit and web-links addons. |
| **WebSocket** | Bidirectional communication channel between the browser and server for real-time terminal data, events, and control messages. |
| **Team** | A named group of agent sessions working together on a shared task. Each team has a working directory, a prompt describing the task, agent roles, and a model routing configuration. |
| **Agent** | A Claude Code CLI session that is part of a team. Agents have roles (e.g., Architect, Builder) and communicate via MCP tools. |
| **Orchestrator (Agent 0)** | The main agent in a team. Receives the user's task, breaks it down, creates tasks on the task board, spawns sub-agents, assigns work, and coordinates completion. The orchestrator does not write code itself. |
| **Sub-Agent (Agent 1-N)** | Agents spawned by the orchestrator to perform specific roles. Each receives a prompt with role-specific instructions and the team's MCP tools. |

### Communication & Coordination

| Term | Definition |
|------|-----------|
| **MCP (Model Context Protocol)** | A protocol for extending Claude Code with external tools. Team Maker runs an MCP server per team that provides 17 tools for agent management, messaging, task board, context sharing, and project memory. |
| **MCP Server** | A Node.js process (`server/mcpServer.js`) spawned per team via StdioServerTransport. It receives tool calls from Claude Code and proxies them to the Team Maker HTTP server via REST API. |
| **Task Board** | A shared kanban-style board for tracking work items. Tasks have states (pending → assigned → in_progress → completed | failed), dependencies, complexity levels, and assignees. |
| **Message Queue** | Inter-agent messaging system. Messages are both queued server-side (for later retrieval via `check_inbox`) and injected directly into the recipient's PTY for instant delivery. |
| **Context Store** | A team-scoped key-value store for sharing knowledge between agents. The first agent (typically the Architect) analyzes the codebase and stores findings so other agents don't re-read the same files. Capped at 500KB with LRU eviction. |
| **Project Memory** | A file-based persistent store at `<cwd>/.team-maker/project-memory.json`. Unlike the context store, project memory survives across teams. Future teams on the same project see prior findings in their orchestrator prompt. |

### Agent States & Lifecycle

| Term | Definition |
|------|-----------|
| **Agent State** | Tracked via JSONL log parsing. States: `starting` → `working` → `idle` → `tool_calling` → `thinking` → `completed`. |
| **JSONL Log** | Claude Code writes structured logs to `~/.claude/projects/<project-hash>/<sessionId>.jsonl`. Team Maker watches these for real-time agent state tracking, token usage, and tool call monitoring. |
| **Question Detection** | Two mechanisms detect when an agent needs human attention: (1) PTY pattern matching for permission dialogs, and (2) JSONL-based stuck-tool-call heuristic (8s timeout). Triggers a yellow pulsing dot and audio alert. |
| **Idle Timeout** | Sub-agents are auto-killed after 10 minutes of idle time (5-minute warning first). Prevents resource waste from stuck or completed agents. |
| **Scrollback Buffer** | Each session maintains a 100KB rolling buffer of PTY output, sent to newly-connecting WebSocket clients so they see recent terminal history. |

### Infrastructure

| Term | Definition |
|------|-----------|
| **StateStore** | Persistent JSON file at `~/.team-maker/state.json`. Stores teams, messages, tasks, context entries, file records, templates, and settings. Uses debounced writes (500ms) with corruption recovery. |
| **Model Routing** | Maps task complexity to Claude models: low → Haiku, medium → Sonnet, high → Opus. Configurable per team. Agents can be spawned with explicit model override or auto-selected via task complexity. |
| **Role** | A predefined agent specialization. Built-in roles: Architect, Builder, Validator, Scribe. Extra roles: DevOps, Security Auditor, Designer, Reviewer. Roles can be customized and saved as templates. |
| **Template** | A saved team role configuration that can be reused when creating new teams. |

## Components / Features

### Web-Based Terminal Management
> Status: [ ] Pending

**Purpose**: Provide a browser-based interface for managing multiple Claude Code CLI sessions.

**Responsibilities**:
- Spawn PTY-backed Claude Code processes
- Stream terminal I/O over WebSocket in real-time
- Render terminal output via xterm.js
- Support terminal resize, input injection, and scrollback

**Interfaces**: Browser ↔ WebSocket ↔ Express Server ↔ node-pty ↔ Claude Code CLI

**Behavior / Rules**:
- Sessions are identified by UUID
- Scrollback buffer capped at 100KB
- WebSocket origin validation (localhost only)
- Max WebSocket payload: 64KB

**Acceptance Criteria**:
- [ ] User can create a session with optional working directory and model
- [ ] Terminal renders PTY output in real-time
- [ ] Session scrollback is preserved and sent to reconnecting clients
- [ ] Session can be destroyed, killing the PTY process

**Open Questions**: None

---

### Multi-Agent Team Orchestration
> Status: [ ] Pending

**Purpose**: Enable coordinated multi-agent workflows for complex software engineering tasks.

**Responsibilities**:
- Create teams with configurable roles and model routing
- Spawn an orchestrator (Agent 0) that manages the workflow
- Support on-demand sub-agent spawning by the orchestrator
- Provide inter-agent communication via messaging and task board
- Share knowledge between agents via context store

**Interfaces**: User ↔ Orchestrator ↔ Sub-Agents (via MCP tools → REST API)

**Behavior / Rules**:
- Orchestrator receives user prompt, breaks into tasks, spawns agents as needed
- Sub-agents only spawned when concrete tasks are ready (no idle agents)
- Agents communicate via send_message (instant PTY injection + queued backup)
- Task board enforces dependency ordering
- Context store prevents redundant file reads across agents
- Idle sub-agents auto-killed after 10 minutes

**Acceptance Criteria**:
- [ ] User can create a team with a task prompt and agent roles
- [ ] Orchestrator receives the prompt and waits for user go-ahead
- [ ] Sub-agents can be spawned, assigned tasks, and communicate
- [ ] Task board tracks work through completion
- [ ] Teams can be stopped and relaunched

**Open Questions**: None

---

### MCP Server Integration
> Status: [ ] Pending

**Purpose**: Extend Claude Code with team management tools via the Model Context Protocol.

**Responsibilities**:
- Run an MCP server per team (StdioServerTransport)
- Expose 17 tools for agent management, messaging, tasks, context, and project memory
- Proxy tool calls to the Team Maker HTTP server via REST API

**Interfaces**: Claude Code CLI ↔ MCP Server (stdio) ↔ Team Maker HTTP Server (localhost REST)

**Behavior / Rules**:
- MCP config written to /tmp/team-maker-mcp-{teamId}.json
- TEAM_ID and TEAM_MAKER_PORT passed via environment variables
- All tool parameters validated with Zod schemas
- Tools return formatted text responses

**Acceptance Criteria**:
- [ ] All 17 MCP tools function correctly
- [ ] Tool calls are properly proxied to the HTTP server
- [ ] Error responses are propagated back to the calling agent

**Open Questions**: None

---

### Persistent State & Project Memory
> Status: [ ] Pending

**Purpose**: Preserve team state across server restarts and share knowledge across teams.

**Responsibilities**:
- Persist teams, messages, tasks, context, and templates to disk
- Restore state on server startup
- Maintain project-level memory that survives across teams
- Inject prior knowledge into new team orchestrator prompts

**Interfaces**: All server modules ↔ StateStore (JSON file) | ProjectMemoryStore (per-cwd JSON file)

**Behavior / Rules**:
- StateStore: ~/.team-maker/state.json with debounced writes (500ms)
- ProjectMemoryStore: <cwd>/.team-maker/project-memory.json with .gitignore
- Soft deprecation for stale project memory entries
- Corruption recovery with automatic backups

**Acceptance Criteria**:
- [ ] Server restart preserves team definitions (teams restored as "stopped")
- [ ] Messages, tasks, and context are restored from state
- [ ] Project memory persists across teams and appears in new team prompts
- [ ] Corrupted state file triggers backup + fresh start

**Open Questions**: None

---

### Real-Time Event Monitoring
> Status: [ ] Pending

**Purpose**: Provide visibility into agent activity via structured events.

**Responsibilities**:
- Parse Claude Code JSONL logs for structured events
- Track agent states (starting, working, idle, tool_calling, thinking, completed)
- Monitor token usage per agent and per team
- Detect permission dialogs and stuck tool calls
- Broadcast events over WebSocket for real-time UI updates

**Interfaces**: JSONL Watcher ↔ Session ↔ WebSocket ↔ Frontend (Events/Usage panels)

**Behavior / Rules**:
- JSONL watcher uses fs.watch + adaptive polling (3-10s)
- Events: assistant_message, tool_call, tool_result, thinking, turn_complete, usage
- Circular buffer of 500 events per session
- Question detection: PTY regex patterns + stuck tool call heuristic (8s)
- Token usage aggregated from JSONL usage events

**Acceptance Criteria**:
- [ ] Agent states update in real-time in the UI
- [ ] Token usage is tracked and displayed per agent
- [ ] Permission dialogs trigger visual + audio alerts
- [ ] Events panel shows filterable structured event log

**Open Questions**: None
