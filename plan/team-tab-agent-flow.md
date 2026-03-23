# Plan: Team Tab — Agent List & Console

## Context

When a team has many agents, the tab bar becomes overcrowded with individual agent tabs (Main, Agent 1, Agent 2, ...). The user wants to consolidate all agent tabs into a single **"Team"** tab that shows a list of agents, with the ability to click any agent to view its console.

Currently: `[Usage] [Messages] [Tasks] [Events] [Context] [Files] [Main] [Agent 1] [Agent 2] [Agent 3] ...`
Goal: `[Team] [Usage] [Messages] [Tasks] [Events] [Context] [Files]` — all agent consoles accessed via the Team tab's agent list.

## Design

### Layout: Split-Panel Team Tab

When the Team tab is active, the panel area splits into two sections:

```
┌─────────────────────────────────────────────────────────┐
│ [Team]  [Usage] [Messages] [Tasks] [Events] [Context]   │
├────────────────────────┬────────────────────────────────┤
│   AGENT LIST           │     AGENT CONSOLE (xterm)      │
│                        │                                │
│  ┌──────────────────┐  │  ┌────────────────────────────┐│
│  │ 🤖 Main          │  │  │ $ claude --model ...       ││
│  │    working        │  │  │ > Working on feature...    ││
│  └──────────────────┘  │  │                            ││
│  ┌──────────────────┐  │  │                            ││
│  │ 🤖 Agent 1       │  │  │                            ││
│  │    idle           │  │  │                            ││
│  └──────────────────┘  │  │                            ││
│  ┌──────────────────┐  │  │                            ││
│  │ 🤖 Agent 2       │  │  │                            ││
│  │    tool_calling   │  │  │                            ││
│  └──────────────────┘  │  │                            ││
│  ┌──────────────────┐  │  │                            ││
│  │ 🤖 Agent 3       │  │  │                            ││
│  │    thinking       │  │  └────────────────────────────┘│
│  └──────────────────┘  │                                │
│                        │  Selected: Main                │
└────────────────────────┴────────────────────────────────┘
```

- **Left panel (~300px)**: Scrollable agent list — Main at top, spawned agents listed below
- **Right panel (flex-grow)**: The selected agent's xterm terminal, fully interactive

### Agent Node Design

Each node is a card showing:
- **Role badge**: `🤖 main` or `🤖 1`, `🤖 2`, etc.
- **Agent name**: e.g., "Feature Implementer"
- **Status indicator**: colored dot (green=running, gray=exited) + state text (working/idle/thinking/tool_calling)
- **Tool badge** (when tool_calling): shows current tool name
- **Question indicator**: yellow pulse when awaiting permission
- **Model**: small text showing which model (if available)
- Click highlights the node and shows its console on the right

## Files to Modify

### 1. `public/index.html`
- Add `#team-panel` wrapper inside `#terminal-container` (similar to existing panels)
- Structure: flex container with `#team-agent-list` (left) and `#team-console-area` (right)

### 2. `public/css/style.css`
- Add styles for `.tab-team`, `#team-panel`, `#team-agent-list`, `.agent-node`, `.agent-node.selected`, `.agent-node.active`, split-panel layout
- Status-specific styles (`.state-working`, `.state-idle`, `.state-thinking`, `.state-tool_calling`)

### 3. `public/js/app.js`
Key changes:

**a) Replace individual agent tabs with a single Team tab:**
- New `createTeamTab()` function (similar to `createUsageTab()`)
- New `switchToTeamTab()` function
- New `teamTabActive` state variable
- Team tab is first in tab bar (before Usage)

**b) Hide individual agent tabs:**
- In `attachSession()`: still create terminal wrappers and WebSocket connections (these are needed), but do NOT create visible tabs in the tab bar
- Instead, register the session and render/update its node in the agent list

**c) Agent list rendering:**
- `renderTeamAgentList()` — rebuilds the agent list for the active team
  - Iterates sessions for the active team
  - Creates agent node cards with status, name, role info
  - Main listed first, then agents in order

**d) Agent console selection:**
- `selectAgentInList(sessionId)` — highlights node, shows terminal in right panel
  - Moves the existing terminal wrapper into `#team-console-area`
  - Calls `fitAddon.fit()` to resize terminal to new container
  - Updates selected state visually

**e) Real-time updates:**
- `handleAgentState()` — update node status badge in agent list (in addition to existing logic)
- `handleActivityUpdate()` — update node working indicator
- `handleQuestionAlert()` — update node question indicator
- `handleTeamUpdate()` for `agent-added` — add new node to agent list
- `handleTeamUpdate()` for `agent-removed` — remove node from agent list

**f) Update `selectTeam()`:**
- Show Team tab instead of individual agent tabs
- Auto-select main agent's console on team switch

**g) Update `switchTab()`/`switchToXxxTab()` functions:**
- Add `teamTabActive` flag handling (same pattern as other meta-tabs)

## Implementation Sequence

1. Add HTML structure for team panel in `index.html`
2. Add CSS styles for team panel, agent list, agent nodes
3. Add `createTeamTab()` and `switchToTeamTab()` in `app.js`
4. Modify `attachSession()` to skip creating tab bar tabs (create list nodes instead)
5. Add `renderTeamAgentList()` and `selectAgentInList()`
6. Update `selectTeam()` to use Team tab
7. Wire up real-time state updates to refresh agent list nodes
8. Update all `switchToXxxTab()` functions to handle `teamTabActive`

## Verification

1. `npm start` and open http://localhost:3456
2. Create a new team — should see Team tab (no individual agent tabs)
3. Team tab shows agent list with Main agent node
4. Click Main node — console appears on right
5. When agents are spawned, new nodes appear in the list
6. Agent state changes (working/idle/tool_calling) update in real-time on nodes
7. Question alerts pulse yellow on the node
8. Switching between meta-tabs (Usage, Messages, etc.) and back to Team tab preserves state
9. Multiple teams: switching teams updates the agent list correctly
