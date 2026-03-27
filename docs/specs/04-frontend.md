# Frontend

> **Spec Status**: [x] Done
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
> Status: [x] Done

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
- [x] Layout renders correctly at various viewport sizes
- [x] Sidebar shows team list with status indicators
- [x] Tab bar switches between panels
- [x] Empty state shown when no teams exist

**Open Questions**: None

---

### Sidebar — Team List
> Status: [x] Done

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
- [x] Teams listed in sidebar
- [x] Running/stopped status indicated
- [x] Team selection loads agents and panels
- [x] Import creates new team from exported config

**Open Questions**: None

---

### Team Pause / Resume UI (public/js/app.js + public/index.html + public/css/style.css)
> Status: [x] Done

**Purpose**: Expose pause and resume controls so users can manually suspend a team without killing it, and restore it later. Surface auto-pause notifications when the task board settles.

**Responsibilities**:
- Render a Pause button for `"running"` teams, Resume button for `"paused"` teams, Relaunch button for `"stopped"` teams
- Call `POST /api/teams/:teamId/pause` or `POST /api/teams/:teamId/resume` on user action
- Handle `team-paused` and `team-resumed` WS broadcast events to update local state without page reload
- Show `"paused"` badge in the team sidebar item (alongside the agent-count badge)
- Display an informational toast when auto-pause fires (`source === "auto"`)
- Disable New Agent button for paused teams
- Show "Team paused" empty state when active team is paused and user navigates to terminal area

**Interfaces**:
- Input: User clicks (Pause / Resume buttons), WS events `{ type: "team-update", event: "team-paused" | "team-resumed" }`
- Output: `POST /api/teams/:teamId/pause`, `POST /api/teams/:teamId/resume`, DOM updates, toast notifications

**Behavior / Rules**:

**Sidebar Team Item Buttons** (`renderTeamItem()`):
| Team Status | Button shown |
|-------------|-------------|
| `"running"` | Pause (⏸) |
| `"paused"` | Resume (▶) |
| `"stopped"` | Relaunch (↺) |

- Only one of the three state buttons is shown at a time
- Pause and Resume buttons appear in the same position as the existing Relaunch button
- Delete button is always shown regardless of status

**Status Badge** (`renderTeamItem()`):
- `"running"` → show agent count badge (existing behavior)
- `"paused"` → show `"paused"` badge with Catppuccin Yellow color (`#f9e2af`)
- `"stopped"` → show `"stopped"` badge (existing behavior)

**New Agent Button**:
- Disabled when active team status is `"running"` → no change
- Disabled when active team status is `"paused"` (same guard as `"stopped"`)

**Empty State**:
- When a paused team is selected and no terminal is active, `#empty-state` shows:
  `"Team \"<name>\" is paused — click ▶ to resume"`

**Usage Auto-Refresh**:
- On `team-paused` event: call `stopUsageAutoRefresh()` if the paused team is the active team
- On `team-resumed` event: call `startUsageAutoRefresh()` if the resumed team is the active team

**Stuck-Agent Overlay**:
- Do not show the stuck-agent overlay for sessions belonging to a paused team (same guard as `"stopped"` check already in place for `agent_idle_killed` and `agent_idle_warning` events)

**WS Event Handling**:
- `{ type: "team-update", event: "team-paused", teamId, source }`:
  1. Update local `teams.get(teamId).status = "paused"`
  2. Re-render the team sidebar item
  3. If `source === "auto"`: show toast "Team paused — all tasks completed"
  4. If paused team is currently active: update empty state
- `{ type: "team-update", event: "team-resumed", teamId }`:
  1. Update local `teams.get(teamId).status = "running"`
  2. Re-render the team sidebar item
  3. If resumed team is currently active: refresh agent list and update empty state

**Acceptance Criteria**:
- [x] Pause button (⏸) renders in sidebar for `"running"` teams
- [x] Resume button (▶) renders in sidebar for `"paused"` teams
- [x] Relaunch button (↺) renders in sidebar only for `"stopped"` teams (no change to existing)
- [x] Clicking Pause calls `POST /api/teams/:teamId/pause`; on success, sidebar re-renders with `"paused"` badge and Resume button (no page reload)
- [x] Clicking Resume calls `POST /api/teams/:teamId/resume`; on success, sidebar re-renders with agent-count badge and Pause button (no page reload)
- [x] `"paused"` badge uses Catppuccin Yellow to visually distinguish from `"stopped"` (red/muted)
- [x] New Agent button is disabled when active team is `"paused"`
- [x] Empty state for a paused active team shows the pause message with resume instruction
- [x] WS event `team-paused` updates local state and sidebar without page reload
- [x] WS event `team-resumed` updates local state and sidebar without page reload
- [x] Auto-pause toast "Team paused — all tasks completed" shown only when `source === "auto"`
- [x] Usage auto-refresh stops when active team receives `team-paused` event
- [x] Usage auto-refresh restarts when active team receives `team-resumed` event
- [x] Idle warning / idle-killed overlays are suppressed for sessions in a paused team

**Open Questions**: None

---

### Tab Management
> Status: [x] Done

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
- [x] Tabs render for all panel types
- [x] Only one panel visible at a time
- [x] Tab selection persisted in localStorage
- [x] Agent tabs added/removed as agents spawn/exit
- [x] Tab names update with agent names

**Open Questions**: None

---

### xterm.js Terminal Instances
> Status: [x] Done

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
- [x] Terminal renders PTY output correctly
- [x] User input forwarded via WebSocket
- [x] Terminal auto-resizes with FitAddon
- [x] URLs are clickable via WebLinksAddon
- [x] Terminal properly disposed on agent removal

**Open Questions**: None

---

### WebSocket Client
> Status: [x] Done

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
- [x] WebSocket connects and streams terminal data
- [x] All broadcast event types handled
- [x] Fetch timeout prevents hanging requests
- [x] UI updates in response to WebSocket events

**Open Questions**: None

---

### Working Directory Modal (New Team)
> Status: [x] Done

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
- [x] All fields render and accept input
- [x] Browse button opens Finder dialog
- [x] Project memory preview loads for valid cwd
- [x] Role editor supports add/remove/reorder/template
- [x] Validation requires prompt before creation
- [x] Smart model routing configurable

**Open Questions**: None

---

### New Agent Modal
> Status: [x] Done

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
- [x] Modal opens from header button
- [x] Agent spawned in active team
- [x] New agent tab appears automatically

**Open Questions**: None

---

### Question Dialog Detection & Alerts
> Status: [x] Done

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
- [x] Yellow dot appears on agent tab on question event
- [x] Audio beep plays on question event
- [x] Alert cleared when user views the agent
- [x] Multiple agents can have alerts simultaneously

**Open Questions**: None

---

### Starting / Stuck-Agent Overlay
> Status: [x] Done

**Purpose**: Block terminal interaction while an agent is initializing, and allow dismissal if the agent gets stuck in the starting state.

**Responsibilities**:
- Display an overlay on the terminal wrapper when `agentState === "starting"`
- Show a spinner and status message during normal startup
- Add a close/dismiss button after 15 seconds if the agent is still starting
- Auto-remove the overlay once the agent leaves "starting" state
- Also remove the overlay from the team console embedded terminal when dismissed

**Interfaces**:
- Input: `agentState` from session data on tab creation; MutationObserver detects removal
- Output: `.starting-overlay` DOM element with `.starting-spinner` + `.starting-text`; optional `.starting-close-btn`

**Behavior / Rules**:
- Overlay added only when `!data.agentState || data.agentState === "starting"` at tab creation time
- After 15s (`closeTimer`): a "Close" button is appended to the overlay — only if the overlay is still connected to the DOM
- Close button removes the overlay from both the main terminal wrapper and the embedded team console wrapper
- MutationObserver cancels the 15s timer if the overlay is removed before it fires (normal startup path)
- Visual style: Catppuccin Mocha theme (overlay background, spinner, text match overall UI palette)

**Acceptance Criteria**:
- [x] Overlay appears on terminal wrapper when agent state is "starting"
- [x] Spinner and "Agent is starting…" message shown during startup
- [x] After 15s, Close button appears if agent is still stuck in starting state
- [x] Close button dismisses overlay in both main and team-console embedded views
- [x] Overlay auto-removed when agent transitions out of "starting" state (MutationObserver)
- [x] 15s timer cancelled on normal startup (no spurious close button)

**Open Questions**: None

---

### Agent State Indicators
> Status: [x] Done

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
- [x] State badges update in real-time
- [x] Activity dot shows during PTY output
- [x] Tool call name displayed during tool_calling state
- [x] States tracked per agent independently

**Open Questions**: None

---

### Team Overview Panel
> Status: [x] Done

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
- [x] Flow graph shows all team agents
- [x] Agent nodes show current state
- [x] Mini console renders selected agent's terminal
- [x] Agent actions (restart/remove/keep-alive) work

**Open Questions**: None

---

### Usage Panel
> Status: [x] Done

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
- [x] Team totals displayed in summary cards
- [x] Per-agent table shows all usage metrics
- [x] Auto-refresh updates data while visible
- [x] Formatting handles all magnitude ranges

**Open Questions**: None

---

### Messages Panel
> Status: [x] Done

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
- [x] Message history loads on panel activation
- [x] New messages appear in real-time
- [x] Messages show sender, recipient, and timestamp
- [x] Content rendered safely (DOMPurify)

**Open Questions**: None

---

### Tasks Panel
> Status: [x] Done

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
- [x] Tasks displayed with all metadata
- [x] Status badges color-coded
- [x] Real-time updates from WebSocket
- [x] Retry button resets failed tasks to pending

**Open Questions**: None

---

### Events Panel
> Status: [x] Done

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
- [x] Events displayed with correct formatting
- [x] Filters work (type, agent, search)
- [x] Real-time events appear without refresh
- [x] Agent filter populated from team's agents

**Open Questions**: None

---

### Context Panel
> Status: [x] Done

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
- [x] Context entries listed with metadata
- [x] Project memory entries shown separately
- [x] Real-time updates from WebSocket
- [x] Token counts and access counts displayed

**Open Questions**: None

---

### Files Panel
> Status: [x] Done

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
- [x] Modified files listed with metadata
- [x] File content viewable on click
- [x] Agent attribution shown per file
- [x] Files sorted by most recent modification

**Open Questions**: None

---

### Files Panel — Git Diff Toggle
> Status: [✓] Validated

**Purpose**: Allow users to toggle between the current file content and its git diff when an agent has edited a file, making it easy to inspect exactly what changed without leaving the browser.

**Responsibilities**:
- When `viewFile()` is invoked, concurrently fetch the git diff via `GET /api/git-diff`
- If the file has changes (`hasDiff: true`), render a **"View Diff" toggle** (On/Off) in the file viewer header
- When the toggle is **On**: show diff view and reveal the Format selector ("Unified" | "Split")
- When the toggle is **Off** (default): show file content only; Format selector is hidden
- Apply Catppuccin Mocha colors to all diff-specific elements
- Omit the toggle entirely when the file has no changes (no visual noise added)

**Interfaces**:
- Input:
  - `GET /api/git-diff?file=<absolutePath>&cwd=<teamCwd>` → `{ diff: string, hasDiff: boolean }`
  - User clicks "View Diff" toggle (flips On/Off)
  - User clicks Format selector ("Unified" | "Split") — only accessible while toggle is On
- Output:
  - "View Diff" toggle button rendered inside `.file-viewer-header` (only when `hasDiff: true`)
  - Format selector rendered inside `.file-viewer-header` (visible only when toggle is On)
  - `.file-viewer-content` re-rendered with diff or file content on toggle flip
- State (per open file, not persisted):
  - `diffToggleOn` — `false` (default) or `true`
  - `currentDiffFormat` — `"unified"` (default) or `"split"`
  - `cachedDiffText` — raw diff string returned by the API (cached to avoid re-fetching on format/toggle changes)

**Behavior / Rules**:

**"View Diff" Toggle**:
- Single On/Off button labeled "View Diff" in `.file-viewer-header`, rendered only when `hasDiff: true`
- Default state on file open: **Off** (file content shown)
- Visual distinction between states: Off = default border style; On = Catppuccin Mauve accent (`#cba6f7`) border/text
- Toggle is ephemeral — not preserved when the user navigates Back or switches files
- Flipping Off re-renders file content from already-fetched data (no new API call)
- Flipping On renders the diff using `cachedDiffText` (no new API call if diff already fetched)

**Unified Diff Format**:
- Added lines (`+`): Catppuccin Green text (`#a6e3a1`) on a green-tinted row background (`rgba(166,227,161,0.10)`)
- Removed lines (`-`): Catppuccin Red text (`#f38ba8`) on a red-tinted row background (`rgba(243,139,168,0.10)`)
- Hunk header lines (`@@`): Catppuccin Blue text (`#89b4fa`), dimmed background (`rgba(137,180,250,0.08)`)
- Context lines (` `): default text color (`#cdd6f4`)
- Line numbers (old | new) displayed in the gutter; absent lines shown as empty gutter cells
- Rendered in a `<pre>` block matching existing file-line styling

**Split Diff Format**:
- Two equal-width columns in a side-by-side layout: **Before** (left) and **After** (right)
- Column header labels "Before" / "After" in Catppuccin Subtext color (`#6c7086`)
- Removed lines highlighted in the left column (red tint); added lines in the right column (green tint)
- Rows with no counterpart (net insertions or deletions) show an empty, slightly dimmed cell on the absent side
- Each column scrolls independently (synchronized scrolling is a nice-to-have, not required)

**Fetching**:
- `GET /api/git-diff` called concurrently with the file read when `viewFile()` is invoked
- `cwd` is taken from the active team's working directory (available in team state)
- If the diff request fails for any reason, silently skip the toggle — file view renders normally
- Diff text cached in `cachedDiffText`; format changes and toggle flips re-render from the cache (no new API call)

**Format Selector**:
- Two small buttons ("Unified" | "Split") visible inside `.file-viewer-header` only when the "View Diff" toggle is **On**
- The active format button is visually distinguished (Catppuccin Mauve accent `#cba6f7`)
- Changing format immediately re-renders from `cachedDiffText` — no new network request

**Acceptance Criteria**:
- [x] `GET /api/git-diff?file=<path>&cwd=<cwd>` is called when a file is opened in the Files Tab
- [x] "View Diff" toggle button appears in the file viewer header when `hasDiff: true`
- [x] No toggle is rendered when the file has no git diff (`hasDiff: false`)
- [x] Toggle defaults to Off (file content shown) on file open
- [x] Clicking the toggle turns it On and switches `.file-viewer-content` to diff view
- [x] Clicking the toggle again turns it Off and restores file content (no re-fetch)
- [x] Toggle On state is visually distinct from Off state (Mauve accent)
- [x] Format selector ("Unified" | "Split") appears only when toggle is On
- [x] Unified view: added lines are green, removed lines are red, hunk headers are blue
- [x] Split view: old content renders in the left column, new content in the right column
- [x] Switching formats re-renders from the cached diff (no additional API call)
- [x] A diff API fetch failure silently omits the toggle (file view renders normally)
- [x] Back button still navigates back to the file list (existing behavior preserved)
- [x] All diff UI elements (toggle, format selector, diff lines) use Catppuccin Mocha colors

**Open Questions**: None

---

### Catppuccin Mocha Theme
> Status: [x] Done

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
- [x] All UI elements use Catppuccin Mocha colors
- [x] Terminal theme matches overall UI
- [x] No default/browser colors leak through
- [x] Sufficient contrast for readability

**Open Questions**: None

---

### CDN Dependencies
> Status: [x] Done

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
- [x] All CDN libraries load successfully
- [x] No local copies of libraries needed
- [x] Version pinning prevents unexpected breaks
- [x] Libraries used correctly (DOMPurify on user-facing content)

**Open Questions**: None

---

### Toast Notifications
> Status: [x] Done

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
- [x] Toast appears on idle warning/kill events
- [x] Duplicate events don't create duplicate toasts
- [x] Toast auto-dismisses after timeout

**Open Questions**: None

---

### Usage Page (usage.html)
> Status: [x] Done

**Purpose**: Standalone HTML page providing usage documentation for Team Maker.

**Responsibilities**:
- Render usage instructions and documentation independently of the main app
- Load without requiring the main app or server to be running

**Interfaces**:
- Input: None (static page)
- Output: Rendered HTML documentation

**Behavior / Rules**:
- Served as a static file from `public/usage.html`
- Independent of `index.html` and `app.js`
- Accessible at `/usage.html`

**Acceptance Criteria**:
- [x] Page loads at /usage.html
- [x] Content is readable and accurate
- [x] Page loads independently without the main app running

**Open Questions**: None
