# Per-Agent Model Selection

## Goal
Allow each agent in a team to use a different Claude model (Opus, Sonnet, Haiku), configurable per-role in the team modal and per-agent when spawning individually.

## Model Options
- **Default** (empty — uses whatever Claude Code defaults to)
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001`

## Changes

### 1. server/sessionManager.js — Accept `model`, pass `--model` to CLI
- Add `model` to `Session` constructor destructuring (line 93)
- Store `this.model = model || null`
- If `model` is set, push `"--model", model` to `args` array (after line 124)
- Add `model` to `toJSON()` output
- Add `model` to `SessionManager.create()` destructuring (line 377) and pass through

### 2. server/teamManager.js — Pass model through team/agent creation
- `create()`: accept `model` (team-level default), store on team object
- When spawning agents from roles, use `role.model` if set, otherwise fall back to team-level `model`
- `addAgent()`: accept `model`, pass to `sessionManager.create()`

### 3. server/index.js — Extract `model` from request bodies
- `POST /api/sessions` (line 48): destructure `model`, pass to `sessionManager.create()`
- `POST /api/teams` (line 112): destructure `model`, pass to `teamManager.create()`
- `POST /api/teams/:teamId/agents` (line 137): destructure `model`, pass to `teamManager.addAgent()`

### 4. public/index.html — Add model dropdowns to modals
- **New Team modal**: add a team-level default model `<select id="model-select">` (above the role editor)
- **New Agent modal**: add `<select id="agent-model-select">`
- Options for both: Default, Opus (claude-opus-4-6), Sonnet (claude-sonnet-4-6), Haiku (claude-haiku-4-5-20251001)

### 5. public/js/app.js — Wire up model selects
- Grab DOM refs for `#model-select` and `#agent-model-select`
- **Role edit form** (`renderRoleEditForm`): add a model `<select>` per role so each role can override the team default
- **Role data model**: add `model` field to role objects (stored alongside title, responsibility, description)
- `createNewTeam()`: read team-level model, include in POST body; each role's model is already in the roles array
- `spawnNewAgent()`: read agent model select, include in POST body
- `renderRoleItem()`: show model badge next to role title (e.g. "Opus", "Sonnet") when set

### 6. public/css/style.css — Style model selects
- Style model `<select>` in role edit form to match existing inputs
- Style model badge in role item display (small pill/tag)
- Style modal-level model select consistent with other modal fields

## Example Result
When creating a team, the role list would look like:

| # | Role         | Model   |
|---|-------------|---------|
| 1 | Orchestrator | Opus    |
| 2 | Architect    | Opus    |
| 3 | Implementer  | Sonnet  |
| 4 | Test Writer  | Haiku   |

The team-level model select acts as the default for any role that doesn't specify one.
