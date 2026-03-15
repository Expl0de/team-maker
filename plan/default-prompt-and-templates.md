# Plan: Default Orchestrator Prompt with Dynamic Agent Roles & Templates

## Context

Currently, when a team is created, the orchestrator (Agent 0) receives a minimal 7-line prompt in `server/teamManager.js` (lines 60-67). The user has a much more comprehensive prompt (`plan/prompt-example/prompt-v1.md`) that defines a full multi-agent workflow with session init, directory structure, agent roles, communication protocols, and wake loops — and has validated this approach works well in practice (see `.team-maker/` in test-team-maker).

**Goal**: Make the comprehensive prompt the default, with a UI for dynamically configuring agent roles and saving/loading team templates.

## Key Observations from Real Example

From `test-team-maker/.team-maker/20260315-120000/`:
- **Communication is file-based**: Agents write to each other's `AGENT_COMMUNICATE.md` and update `MULTI_AGENT_PLAN.md` — this is the primary coordination mechanism and works well
- **MCP `spawn_agent` creates agents**, but inter-agent coordination uses the file system
- **The orchestrator creates the directory structure** (`.team-maker/<sessionid>/`) at session start
- **Wake loop nudges drive the poll cycle** — agents check inbox every ~60s
- **Problem observed**: Idle agents keep spamming status messages after all tasks complete (should be addressed in the prompt)

## Implementation

### 1. Orchestrator Prompt Builder — `server/promptBuilder.js` (NEW)

A module that generates the full orchestrator prompt by combining:
- Agent identity & session init instructions (create `.team-maker/<sessionid>/` directory structure)
- MCP tool descriptions (`spawn_agent`, `list_agents`, `send_message`)
- Agent role definitions (dynamic, from the roles array)
- Communication protocol (file-based with `AGENT_COMMUNICATE.md` + `MULTI_AGENT_PLAN.md`)
- Wake loop behavior (server-managed nudge, agent checks inbox/plan)
- The user's task prompt
- Sub-agent spawn prompt template (what prompt to give each spawned agent)
- Idle behavior: agents should stop polling after reporting "all tasks complete" once

**Function**: `buildOrchestratorPrompt({ teamName, sessionId, cwd, taskPrompt, roles, wakeInterval })`

The `wakeInterval` (in seconds, default 60) is included in the prompt so agents know the polling frequency.

The prompt adapts `prompt-v1.md` with these decisions:
- **File-based communication is primary** — `AGENT_COMMUNICATE.md` for direct messages, `MULTI_AGENT_PLAN.md` for shared status (proven working in real tests)
- MCP `spawn_agent` for creating agents (instead of "open a new terminal")
- MCP `send_message` mentioned only as fallback for urgent PTY-level messages
- **Auto-spawn all configured roles** at startup — Agent 0 spawns every role in the list immediately
- Dynamic role definitions from the `roles` array
- "Stop polling when done" instruction to reduce idle spam

### 2. Built-in Role Definitions — `server/promptBuilder.js`

Hardcoded default roles (matching prompt-v1.md):
```js
const BUILTIN_ROLES = [
  { id: "architect", title: "Architect", responsibility: "Research & Planning", description: "System exploration, requirements analysis, architecture planning, design documents. Focus: Understanding the big picture and creating the roadmap." },
  { id: "builder", title: "Builder", responsibility: "Core Implementation", description: "Feature development, main implementation work, core functionality. Focus: Building the actual solution based on plans." },
  { id: "validator", title: "Validator", responsibility: "Testing & Validation", description: "Writing tests, validation scripts, debugging, quality assurance. Focus: Ensuring code quality and catching issues early." },
  { id: "scribe", title: "Scribe", responsibility: "Documentation & Refinement", description: "Documentation creation, code refinement, usage guides, examples. Focus: Making the work understandable and maintainable." },
];
```

Additional quick-add roles: DevOps, Security Auditor, Designer, Reviewer.

### 3. Template Persistence — `server/templateStore.js` (NEW)

Simple JSON file storage at `data/templates.json`:
```js
// Template shape:
{ id, name, roles: [{ id, title, responsibility, description }], createdAt }
```

Exports: `loadAll()`, `save({ name, roles })`, `remove(id)`, `get(id)`

### 4. Backend Changes

**`server/teamManager.js`** — Modify `create()`:
- Accept `roles` and `wakeInterval` parameters
- Import and call `buildOrchestratorPrompt()` instead of inline template
- Store `roles` and `wakeInterval` on Team object
- Generate a session ID (timestamp-based like `20260315-120000`) for directory naming
- Pass `sessionId` and `wakeInterval` to prompt builder for `.team-maker/<sessionId>/` paths
- Pass `wakeInterval` to `sessionManager.create()` for the wake loop timer

**`server/sessionManager.js`** — Two changes:
- Update wake nudge message (line 193) to reference checking inbox and shared plan files
- Make `WAKE_INTERVAL_MS` configurable: accept `wakeInterval` (in seconds) in the session constructor, default 60s. Use it for both the interval timer and the idle threshold

**`server/index.js`** — Add endpoints:
- `GET /api/templates` — list saved templates
- `POST /api/templates` — save template `{ name, roles }`
- `DELETE /api/templates/:id` — delete template
- `GET /api/builtin-roles` — return BUILTIN_ROLES for quick-add
- Update `POST /api/teams` to accept `roles` array and `wakeInterval` (seconds, default 60)

### 5. Frontend — Team Creation Modal

**`public/index.html`** — Expand modal with role editor section:

```
[Team Name]
[Working Directory + Browse]
[Team Prompt textarea]

── Wake Interval ────────────────────────
[Wake interval: [60] seconds]

── Agent Roles ──────────────────────────
[Template: (dropdown) Custom ▾ | Standard 4-Agent | ...saved...] [Save] [Delete]

┌─ Role List (scrollable) ─────────────────────┐
│ [1] Architect — Research & Planning     [Edit][✕] │
│ [2] Builder — Core Implementation       [Edit][✕] │
│ [3] Validator — Testing & Validation    [Edit][✕] │
│ [4] Scribe — Documentation & Refinement [Edit][✕] │
└───────────────────────────────────────────────┘
[+ Add Role]  [Quick-add: Architect | Builder | ... ▾]

[Cancel] [Create Team]
```

Clicking "Edit" on a role expands it inline with title, responsibility, and description fields.

**`public/js/app.js`** — New functions:
- `currentRoles` array state for the modal
- `renderRoleList()` — render role entries with edit/remove
- `addRole(role)` / `removeRole(index)` — modify roles
- `loadTemplates()` — fetch and populate dropdown
- `saveTemplate(name)` / `deleteTemplate(id)` — template CRUD
- `applyTemplate(templateId)` — load template roles into editor
- Update `showNewTeamModal()` to init with default 4 roles
- Update `createNewTeam()` to send `{ name, cwd, prompt, roles, wakeInterval }`

**`public/css/style.css`** — Styles for:
- Role editor section (inside modal, scrollable list, max-height ~200px)
- Role item rows (compact, with inline actions)
- Role edit form (expanded state with inputs)
- Template picker row
- Widen modal to ~640px

### 6. Files Summary

| File | Action | Description |
|------|--------|-------------|
| `server/promptBuilder.js` | **Create** | Orchestrator prompt generation from template + roles |
| `server/templateStore.js` | **Create** | Template persistence (JSON file) |
| `server/teamManager.js` | **Modify** | Accept roles, use promptBuilder, store roles on Team |
| `server/sessionManager.js` | **Modify** | Configurable wake interval, update nudge message |
| `server/index.js` | **Modify** | Add template endpoints, pass roles to team creation |
| `public/index.html` | **Modify** | Add role editor section to team creation modal |
| `public/js/app.js` | **Modify** | Role editor logic, template picker, send roles |
| `public/css/style.css` | **Modify** | Role editor styling |

### 7. Build Sequence

1. `server/promptBuilder.js` — Core prompt generation (no dependencies)
2. `server/templateStore.js` — Template persistence (no dependencies)
3. `server/teamManager.js` — Wire up prompt builder + accept roles
4. `server/sessionManager.js` — Configurable wake interval + update nudge message
5. `server/index.js` — Template API endpoints + update team creation
6. `public/index.html` — Role editor HTML
7. `public/css/style.css` — Role editor styles
8. `public/js/app.js` — Role editor logic + template picker

### 8. Verification

1. `npm start` and open browser
2. Click "+ New Team" — modal should show role editor with 4 default roles and wake interval input (default 60s)
3. Edit/add/remove roles — UI should update dynamically
4. Change wake interval — value should be sent to backend
5. Create team — Agent 0 should receive comprehensive prompt with correct roles and wake interval
6. Agent 0 should create `.team-maker/<sessionid>/` directory structure and spawn agents via MCP
7. Agents should communicate via file-based protocol (AGENT_COMMUNICATE.md)
8. Save a template — should persist and appear in dropdown on next modal open
9. Load a saved template — roles should populate in the editor
10. Delete a template — should be removed from dropdown
