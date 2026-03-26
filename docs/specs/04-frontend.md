# Frontend

> **Spec Status**: [ ] Draft
> **Last Updated**: 2026-03-26

## Purpose

Define the browser-based frontend: tab management, xterm.js terminal lifecycle, WebSocket client behavior, modals, visual alerts, theming, and all UI panels.

## Scope

Covers all files in `public/`: `index.html`, `css/style.css`, `js/app.js`, `usage.html`. For backend API contracts consumed by the frontend, see [02-contracts.md](02-contracts.md).

## Key Concepts

- **Vanilla Stack**: No framework, no build step, no bundler. Pure HTML/CSS/JS.
- **CDN Dependencies**: xterm.js, marked, DOMPurify loaded from jsdelivr CDN.
- **State Management**: JavaScript Maps and variables in `app.js` (no store library).
- **Real-Time Updates**: WebSocket connection for terminal data + broadcast events.

---

## Components / Features

### Application Layout
> Status: [ ] Pending

**Purpose**: Overall page structure with sidebar, tab bar, and content area.

**Responsibilities**:
- Header with team name, agent count, action buttons
- Sidebar with team list
- Tab bar for switching between panels
- Main content area for active panel

**Interfaces**:
- Input: User clicks, WebSocket events
- Output: DOM updates, REST API calls

**Behavior / Rules**:

**Layout Structure** (from index.html):
```
<header>
  <h1>Team Maker</h1>
  <div>#session-count | + New Agent (disabled by default) | + New Team</div>
</header>
<div #app-layout>
  <aside #sidebar>
    <div #sidebar-header>Teams | Import button</div>
    <div #team-list></div>
  </aside>
  <div #main-content>
    <nav #tab-bar></nav>
    <main #terminal-container>
      <div #empty-state>...</div>
      <div #usage-panel>...</div>
      <div #messages-panel>...</div>
      <div #tasks-panel>...</div>
      <div #events-panel>...</div>
      <div #context-panel>...</div>
      <div #files-panel>...</div>
      <div #team-panel>...</div>
    </main>
  </div>
</div>
<footer #status-bar>
  <span #status-text>Ready</span>
</footer>
```

**Acceptance Criteria**:
- [ ] Layout renders correctly at various viewport sizes
- [ ] Sidebar shows team list with status indicators
- [ ] Tab bar switches between panels
- [ ] Empty state shown when no teams exist

**Open Questions**: None

---

### Sidebar — Team List
> Status: [ ] Pending

**Purpose**: Display all teams with status indicators and selection.

**Responsibilities**:
- List all teams from server
- Show running/stopped status
- Handle team selection
- Support team import

**Interfaces**:
- Input: GET /api/teams, WebSocket team-update events
- Output: Team selection, UI updates

**Behavior / Rules**:
- Teams fetched on page load via `GET /api/teams`
- Each team shows name and status (running/stopped)
- Clicking a team selects it and loads its agents/panels
- Import button triggers file input for team config JSON
- Stopped teams can be relaunched from sidebar context

**Acceptance Criteria**:
- [ ] Teams listed in sidebar
- [ ] Running/stopped status indicated
- [ ] Team selection loads agents and panels
- [ ] Import creates new team from exported config

**Open Questions**: None

---

### Tab Management
> Status: [ ] Pending

**Purpose**: Navigate between agent terminals and utility panels within a team.

**Responsibilities**:
- Render tabs for: Team Overview, each agent, Usage, Messages, Tasks, Events, Context, Files
- Track active tab per team
- Persist tab selection across page reloads

**Interfaces**:
- Input: User clicks, agent spawns/removes
- Output: Panel visibility, terminal focus

**Behavior / Rules**:

**Tab Types**:
1. **Team** — Team overview with flow graph + mini console
2. **Agent tabs** — One per agent session (terminal)
3. **Usage** — Token/cost breakdown
4. **Messages** — Inter-agent message timeline
5. **Tasks** — Task board visualization
6. **Events** — Structured JSONL events with filters
7. **Context** — Shared context store + project memory
8. **Files** — Files touched by agents

**State Variables**:
```javascript
teams: Map<teamId, { id, name, agentIds[] }>
sessions: Map<sessionId, { id, name, teamId, role, terminal, fitAddon, ws, tabEl, wrapperEl, status }>
activeTeamId: string|null
activeSessionId: string|null
usageTabActive, messagesTabActive, tasksTabActive, eventsTabActive, contextTabActive, filesTabActive, teamTabActive: boolean
```

**Tab Persistence** (localStorage):
- `tm_activeTeamId` — last selected team
- `tm_activeTab` — last selected tab name (`"team"`, `"usage"`, `"session:{id}"`, etc.)
- Saved on every tab switch
- Restored on page load

**Acceptance Criteria**:
- [ ] Tabs render for all panel types
- [ ] Only one panel visible at a time
- [ ] Tab selection persisted in localStorage
- [ ] Agent tabs added/removed as agents spawn/exit
- [ ] Tab names update with agent names

**Open Questions**: None

---

### xterm.js Terminal Instances
> Status: [ ] Pending

**Purpose**: Render PTY output for each agent session in a browser terminal emulator.

**Responsibilities**:
- Create xterm.js Terminal instance per session
- Configure theme and addons
- Manage terminal lifecycle (create, attach, resize, dispose)
- Handle terminal input

**Interfaces**:
- Input: WebSocket terminal data, user keyboard input
- Output: WebSocket input messages, terminal rendering

**Behavior / Rules**:

**CDN Dependencies**:
- `@xterm/xterm@5.5.0` — core terminal
- `@xterm/addon-fit@0.10.0` — auto-fit to container
- `@xterm/addon-web-links@0.11.0` — clickable URLs

**Terminal Configuration**:
- Font family: system monospace
- Font size: 13 (typical)
- Theme: Catppuccin Mocha colors (see Theme section)
- Cursor style: block

**Addon Setup**:
- FitAddon: auto-resizes terminal to container, sends resize via WebSocket
- WebLinksAddon: makes URLs in terminal clickable

**Lifecycle**:
1. **Create**: New Terminal + FitAddon + WebLinksAddon → attach to DOM wrapper
2. **Attach**: WebSocket opens → send `{ type: "attach", sessionId }` → receive scrollback → render
3. **Input**: Terminal `onData` → send to WebSocket
4. **Resize**: FitAddon.fit() → send `{ type: "resize", cols, rows }` via WebSocket
5. **Dispose**: Close WebSocket → terminal.dispose() → remove DOM elements

**Acceptance Criteria**:
- [ ] Terminal renders PTY output correctly
- [ ] User input forwarded via WebSocket
- [ ] Terminal auto-resizes with FitAddon
- [ ] URLs are clickable via WebLinksAddon
- [ ] Terminal properly disposed on agent removal

**Open Questions**: None

---

### WebSocket Client
> Status: [ ] Pending

**Purpose**: Manage WebSocket connections for terminal I/O and event streaming.

**Responsibilities**:
- Establish WebSocket connection to server
- Handle per-session terminal connections
- Process broadcast events
- Reconnect on connection loss

**Interfaces**:
- Input: Server WebSocket messages (terminal data, JSON events)
- Output: WebSocket messages (attach, resize, input)

**Behavior / Rules**:

**Connection**:
- URL: `ws://localhost:{PORT}` (same origin as page)
- One WebSocket per terminal session for terminal I/O
- Broadcast events received on all connections

**Message Types Received**:
- Raw string: terminal data → `terminal.write(data)`
- `{ type: "attached" }`: session attached confirmation
- `{ type: "exit", exitCode }`: session exited → update status
- `{ type: "question", sessionId }`: permission dialog → yellow dot + audio alert
- `{ type: "activity", sessionId, active }`: PTY activity → green dot
- `{ type: "agent_state", sessionId, state, lastToolCall }`: agent state badge
- `{ type: "team-update", ... }`: team lifecycle → refresh UI
- `{ type: "agent-event", ... }`: agent event → events panel
- `{ type: "agent-idle", ... }`: idle event → toast notification
- `{ type: "team-task", ... }`: task event → tasks panel
- `{ type: "team-context", ... }`: context event → context panel
- `{ type: "team-message", ... }`: message → messages panel

**Fetch Wrapper** (`fetchWithTimeout`):
- Wraps fetch with AbortController
- Default timeout: 10 seconds
- Used for all REST API calls

**Acceptance Criteria**:
- [ ] WebSocket connects and streams terminal data
- [ ] All broadcast event types handled
- [ ] Fetch timeout prevents hanging requests
- [ ] UI updates in response to WebSocket events

**Open Questions**: None

---

### Working Directory Modal (New Team)
> Status: [ ] Pending

**Purpose**: Modal dialog for creating a new team with all configuration options.

**Responsibilities**:
- Collect team name, working directory, prompt, model, roles
- Support Finder browse for directory selection
- Preview project memory for selected directory
- Role editor with template picker

**Interfaces**:
- Input: User form input
- Output: POST /api/teams

**Behavior / Rules**:

**Modal Fields**:
1. **Team Name**: text input, e.g. "Feature Build"
2. **Working Directory**: text input + Browse button (macOS Finder via `GET /api/browse-folder`)
3. **Project Memory Preview**: auto-fetches via `GET /api/project-memory?cwd=` when cwd changes
4. **Team Prompt** (required): textarea, max ~5000 chars
5. **Default Model**: select (Default, Opus, Sonnet, Haiku)
6. **Smart Model Routing**: checkbox toggle + low/medium/high model selects
7. **Agent Roles**: role editor (see below)

**Role Editor**:
- Template picker: select from saved templates or "Standard 4-Agent"
- Role list: drag-reorderable cards with title, responsibility, description, optional model override
- Add Role: blank role card
- Quick-add: dropdown of extra roles (DevOps, Security, Designer, Reviewer)
- Save Template: saves current roles as named template
- Delete Template: removes selected template

**Modal Actions**:
- Cancel: closes modal
- Create Team: validates (prompt required), sends POST /api/teams

**Acceptance Criteria**:
- [ ] All fields render and accept input
- [ ] Browse button opens Finder dialog
- [ ] Project memory preview loads for valid cwd
- [ ] Role editor supports add/remove/reorder/template
- [ ] Validation requires prompt before creation
- [ ] Smart model routing configurable

**Open Questions**: None

---

### New Agent Modal
> Status: [ ] Pending

**Purpose**: Modal for spawning a new agent in the active team.

**Responsibilities**:
- Collect agent name, prompt, model
- Spawn agent via API

**Interfaces**:
- Input: User form input
- Output: POST /api/teams/{teamId}/agents

**Behavior / Rules**:

**Modal Fields**:
1. **Agent Name**: text input
2. **Agent Prompt** (required): textarea
3. **Model**: select (Default, Opus, Sonnet, Haiku)

**Enabled**: Only when a running team is selected ("+ New Agent" button in header).

**Acceptance Criteria**:
- [ ] Modal opens from header button
- [ ] Agent spawned in active team
- [ ] New agent tab appears automatically

**Open Questions**: None

---

### Question Dialog Detection & Alerts
> Status: [ ] Pending

**Purpose**: Visual and audio alerts when an agent needs human attention.

**Responsibilities**:
- Show yellow pulsing dot on agent tab
- Play Web Audio alert sound
- Handle alert dismissal

**Interfaces**:
- Input: `{ type: "question", sessionId }` WebSocket message
- Output: Visual indicator (CSS animation), audio beep

**Behavior / Rules**:

**Visual Alert**:
- Agent tab dot changes to yellow
- CSS pulse animation on the dot
- Persists until user switches to that agent's tab

**Audio Alert**:
- Web Audio API generated beep
- Short tone (sine wave)
- Played on each question event (respects browser autoplay policy)

**Trigger Sources**:
1. PTY pattern detection (permission dialogs)
2. Stuck tool call detection (8s timeout from JSONL)

**Acceptance Criteria**:
- [ ] Yellow dot appears on agent tab on question event
- [ ] Audio beep plays on question event
- [ ] Alert cleared when user views the agent
- [ ] Multiple agents can have alerts simultaneously

**Open Questions**: None

---

### Agent State Indicators
> Status: [ ] Pending

**Purpose**: Show real-time agent activity status in the UI.

**Responsibilities**:
- Display agent state badges (starting, working, idle, etc.)
- Show activity indicator (green dot pulse)
- Show tool call information

**Interfaces**:
- Input: `{ type: "agent_state" }` and `{ type: "activity" }` WebSocket messages
- Output: DOM updates (badges, dots, labels)

**Behavior / Rules**:

**State Badges** (from agent_state events):
- `starting` — shown during CLI startup
- `working` — actively processing
- `idle` — waiting for input/task
- `tool_calling` — executing a tool (shows tool name)
- `thinking` — extended thinking
- `completed` — session finished

**Activity Dot** (from activity events):
- Green pulsing dot when `active: true` (PTY producing output)
- No dot when `active: false` (3s silence)

**Tracked In**: `agentStates` Map: sessionId → { state, lastToolCall }

**Acceptance Criteria**:
- [ ] State badges update in real-time
- [ ] Activity dot shows during PTY output
- [ ] Tool call name displayed during tool_calling state
- [ ] States tracked per agent independently

**Open Questions**: None

---

### Team Overview Panel
> Status: [ ] Pending

**Purpose**: Visual overview of team with agent flow graph and mini console.

**Responsibilities**:
- Render agent nodes in a flow graph layout
- Show agent state/status on each node
- Provide mini terminal console for selected agent
- Support agent actions (restart, remove, keep-alive)

**Interfaces**:
- Input: Agent data, state events
- Output: DOM rendering, REST API calls (restart/remove/keep-alive)

**Behavior / Rules**:

**Flow Graph** (#team-flow-graph):
- Nodes represent agents
- Shows: name, role, state badge, status
- Clickable to select agent for mini console

**Mini Console** (#team-console-area):
- Shows selected agent's terminal in a smaller view
- Placeholder text when no agent selected

**Agent Actions**:
- Restart: POST /api/teams/{teamId}/agents/{agentId}/restart
- Remove: DELETE /api/teams/{teamId}/agents/{agentId}
- Keep Alive: POST /api/teams/{teamId}/agents/{agentId}/keep-alive
- Clear Context: POST /api/sessions/{id}/clear

**Acceptance Criteria**:
- [ ] Flow graph shows all team agents
- [ ] Agent nodes show current state
- [ ] Mini console renders selected agent's terminal
- [ ] Agent actions (restart/remove/keep-alive) work

**Open Questions**: None

---

### Usage Panel
> Status: [ ] Pending

**Purpose**: Display token usage and cost breakdown for the team.

**Responsibilities**:
- Fetch and display team-wide usage totals
- Show per-agent usage breakdown table
- Auto-refresh while panel is active

**Interfaces**:
- Input: GET /api/teams/{teamId}/usage
- Output: HTML rendering (summary cards + agent table)

**Behavior / Rules**:
- Fetches usage data from API when panel activated
- Auto-refresh interval while panel visible
- Summary cards: Total Cost, Total Tokens, Input/Output/Cache tokens, Duration, Data I/O
- Agent table: per-agent breakdown with status dot, role badge, all token/byte/duration columns

**Formatting Helpers**:
- `formatTokens(n)`: 1.2M, 45.3k, or raw number
- `formatCost(n)`: $0.0042
- `formatDuration(ms)`: 2h 15m, 3m 42s, or 5s
- `formatBytes(b)`: 1.2 MB, 45.3 KB, or raw bytes

**Acceptance Criteria**:
- [ ] Team totals displayed in summary cards
- [ ] Per-agent table shows all usage metrics
- [ ] Auto-refresh updates data while visible
- [ ] Formatting handles all magnitude ranges

**Open Questions**: None

---

### Messages Panel
> Status: [ ] Pending

**Purpose**: Display inter-agent message timeline for the team.

**Responsibilities**:
- Fetch and display team message history
- Show real-time new messages via WebSocket
- Format with sender/recipient names and timestamps

**Interfaces**:
- Input: GET /api/teams/{teamId}/messages, `team-message` WebSocket events
- Output: HTML message timeline

**Behavior / Rules**:
- Messages fetched on panel activation
- New messages appended in real-time from WebSocket
- Each message shows: fromName → toName, timestamp, content
- Stored in `teamMessages` Map by teamId

**Acceptance Criteria**:
- [ ] Message history loads on panel activation
- [ ] New messages appear in real-time
- [ ] Messages show sender, recipient, and timestamp
- [ ] Content rendered safely (DOMPurify)

**Open Questions**: None

---

### Tasks Panel
> Status: [ ] Pending

**Purpose**: Visualize the task board for the team.

**Responsibilities**:
- Fetch and display tasks with status/assignee/dependencies
- Update in real-time from WebSocket events
- Support task actions (retry failed tasks)

**Interfaces**:
- Input: GET /api/teams/{teamId}/tasks, `team-task` WebSocket events
- Output: HTML task list with status indicators

**Behavior / Rules**:
- Tasks fetched on panel activation
- Real-time updates from WebSocket (task-created, task-completed, etc.)
- Tasks show: status badge, title, description, assignee, dependencies, result/fail reason
- Summary counters: total, pending, assigned, in_progress, completed, failed
- Retry button on failed tasks (POST .../retry)

**Acceptance Criteria**:
- [ ] Tasks displayed with all metadata
- [ ] Status badges color-coded
- [ ] Real-time updates from WebSocket
- [ ] Retry button resets failed tasks to pending

**Open Questions**: None

---

### Events Panel
> Status: [ ] Pending

**Purpose**: Display structured JSONL events from agent sessions with filtering.

**Responsibilities**:
- Fetch and display agent events
- Filter by event type, agent, and search text
- Update in real-time from WebSocket

**Interfaces**:
- Input: GET /api/teams/{teamId}/events, `agent-event` WebSocket events
- Output: Filtered event list with details

**Behavior / Rules**:

**Filters** (in #events-panel-header):
1. Event type: All, Tool calls, Tool results, Messages, Completions, Thinking
2. Agent: All agents, or specific agent (populated from team's agents)
3. Search: free-text search across event content

**Event Rendering**:
- `tool_call`: tool name + summarized input
- `tool_result`: tool use ID + error flag + content preview
- `assistant_message`: text content
- `turn_complete`: model name
- `thinking`: thinking length in chars

**Real-Time Updates**: New events prepended from WebSocket `agent-event` messages

**Acceptance Criteria**:
- [ ] Events displayed with correct formatting
- [ ] Filters work (type, agent, search)
- [ ] Real-time events appear without refresh
- [ ] Agent filter populated from team's agents

**Open Questions**: None

---

### Context Panel
> Status: [ ] Pending

**Purpose**: Display shared context store entries and project memory.

**Responsibilities**:
- Fetch and display context store entries
- Show project memory entries
- Update in real-time from WebSocket

**Interfaces**:
- Input: GET /api/teams/{teamId}/context, GET /api/teams/{teamId}/project-memory, `team-context` WebSocket events
- Output: HTML context entry list

**Behavior / Rules**:
- Context entries show: key, summary, stored by, token count, access count
- Project memory section shown below context entries
- Real-time updates when new context stored
- Stored in `teamContexts` Map by teamId

**Acceptance Criteria**:
- [ ] Context entries listed with metadata
- [ ] Project memory entries shown separately
- [ ] Real-time updates from WebSocket
- [ ] Token counts and access counts displayed

**Open Questions**: None

---

### Files Panel
> Status: [ ] Pending

**Purpose**: Display files touched by agents with content viewer.

**Responsibilities**:
- Fetch and display files modified by agents
- Show file content on click
- Track which agent modified each file

**Interfaces**:
- Input: GET /api/teams/{teamId}/files, GET /api/teams/{teamId}/files/read?path=
- Output: File list + content viewer

**Behavior / Rules**:
- Files fetched on panel activation
- Each file shows: relative path, agent name, operation (created/edited), timestamp
- Clicking a file fetches and displays its content
- Content displayed in a code block or similar
- Stored in `teamFiles` Map by teamId

**Acceptance Criteria**:
- [ ] Modified files listed with metadata
- [ ] File content viewable on click
- [ ] Agent attribution shown per file
- [ ] Files sorted by most recent modification

**Open Questions**: None

---

### Catppuccin Mocha Theme
> Status: [ ] Pending

**Purpose**: Consistent dark theme across all UI elements using the Catppuccin Mocha palette.

**Responsibilities**:
- Apply theme colors to all CSS
- Configure xterm.js terminal theme

**Interfaces**:
- Input: CSS variables / direct color values
- Output: Styled UI

**Behavior / Rules**:

**Core Palette** (from style.css):
| Role | Color | Hex |
|------|-------|-----|
| Base (body bg) | Mocha Base | #1e1e2e |
| Header/Mantle | Mocha Mantle | #181825 |
| Sidebar/Crust | Mocha Crust | #11111b |
| Surface 0 | Borders, subtle bg | #313244 |
| Surface 1 | Hover states | #45475a |
| Text | Primary text | #cdd6f4 |
| Subtext | Secondary text | #6c7086 |
| Mauve | Primary accent (buttons, h1) | #cba6f7 |
| Lavender | Hover accent | #b4befe |
| Green | Success, running | #a6e3a1 |
| Yellow | Warning, question alert | #f9e2af |
| Red | Error, failed, danger | #f38ba8 |
| Blue | Info, links | #89b4fa |

**xterm.js Theme** (applied in Terminal constructor):
- Background: #1e1e2e (Base)
- Foreground: #cdd6f4 (Text)
- Cursor: #f5e0dc (Rosewater)
- ANSI colors mapped to Catppuccin palette

**Acceptance Criteria**:
- [ ] All UI elements use Catppuccin Mocha colors
- [ ] Terminal theme matches overall UI
- [ ] No default/browser colors leak through
- [ ] Sufficient contrast for readability

**Open Questions**: None

---

### CDN Dependencies
> Status: [ ] Pending

**Purpose**: External libraries loaded from CDN (no local bundling).

**Responsibilities**:
- Load xterm.js and addons for terminal rendering
- Load marked for Markdown rendering
- Load DOMPurify for HTML sanitization

**Interfaces**:
- Input: CDN URLs in index.html
- Output: Global library objects

**Behavior / Rules**:

**Dependencies** (from index.html):
| Library | Version | CDN URL | Purpose |
|---------|---------|---------|---------|
| @xterm/xterm | 5.5.0 | jsdelivr | Terminal emulator (CSS + JS) |
| @xterm/addon-fit | 0.10.0 | jsdelivr | Auto-fit terminal to container |
| @xterm/addon-web-links | 0.11.0 | jsdelivr | Clickable URLs in terminal |
| marked | 15.0.7 | jsdelivr | Markdown → HTML rendering |
| DOMPurify | 3.2.4 | jsdelivr | Sanitize HTML output |

**Load Order** (in index.html):
1. `<head>`: xterm CSS, app CSS, DOMPurify
2. `<body>` (bottom): marked, xterm JS, addon-fit, addon-web-links, app.js

**Acceptance Criteria**:
- [ ] All CDN libraries load successfully
- [ ] No local copies of libraries needed
- [ ] Version pinning prevents unexpected breaks
- [ ] Libraries used correctly (DOMPurify on user-facing content)

**Open Questions**: None

---

### Toast Notifications
> Status: [ ] Pending

**Purpose**: Transient notifications for important events (idle warnings, kills).

**Responsibilities**:
- Display temporary notification messages
- Auto-dismiss after timeout
- Handle duplicate prevention

**Interfaces**:
- Input: `agent-idle` WebSocket events
- Output: DOM toast elements

**Behavior / Rules**:
- Idle warning: "Agent {name} has been idle for {time}"
- Idle kill: "Agent {name} was auto-killed after {time} idle"
- Deduplication via `handledIdleEvents` Set (prevents duplicate toasts from multiple WS connections)
- Auto-dismiss after a few seconds

**Acceptance Criteria**:
- [ ] Toast appears on idle warning/kill events
- [ ] Duplicate events don't create duplicate toasts
- [ ] Toast auto-dismisses after timeout

**Open Questions**: None
