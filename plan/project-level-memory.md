# Project-Level Memory

## Problem

Context is currently scoped to `teamId`. When a new team starts on the same working directory, all knowledge accumulated by previous teams is lost — agents must re-analyze the codebase from scratch, wasting tokens and time.

```
Team A (teamId: abc) → /my-project
  contextStore: { key: "arch-analysis", teamId: "abc" }

Team B (teamId: xyz) → /my-project  ← starts fresh, knows nothing
```

## Solution: Project Memory File in cwd

Store project-level memory as `.team-maker/project-memory.json` inside the working directory. This is separate from the existing team-scoped `contextStore`.

```
/my-project/
  .team-maker/
    .gitignore               ← auto-created, ignores */ but keeps project-memory.json
    project-memory.json      ← NEW: persists across all teams on this project
    20260315-120000/         ← existing: per-team session artifacts (gitignored)
      share/
      AGENT_COMMUNICATE.md
```

### Why a file in cwd (not ~/.team-maker/)

- Stays with the project — no absolute path dependency
- Can be committed to git (analogous to `CLAUDE.md`, but auto-maintained by agents)
- New team member clones repo → agents start with project knowledge pre-loaded
- Survives complete server wipes
- Manually inspectable and editable

### .gitignore strategy

Auto-create `.team-maker/.gitignore` on first use:

```gitignore
# Ignore per-session ephemeral artifacts
*/

# Keep project-level memory
!project-memory.json
```

**Caveat**: Remind agents in their prompt that project memory may be committed to git — avoid storing secrets.

## Data Shape

`.team-maker/project-memory.json`:

```json
{
  "arch-overview": {
    "content": "Full architecture description...",
    "summary": "High-level architecture of the project",
    "storedBy": "Architect (20260315-120000)",
    "lastUpdated": "2026-03-26T10:00:00Z",
    "tags": ["architecture", "overview"],
    "deprecated": false
  },
  "key-dependencies": {
    "content": "express@4, node-pty@0.10.x (pinned — v1.x broken on macOS)...",
    "summary": "Key npm dependencies and version constraints",
    "storedBy": "Builder (20260315-120000)",
    "lastUpdated": "2026-03-26T10:05:00Z",
    "tags": ["dependencies"],
    "deprecated": true,
    "deprecatedReason": "Dependencies updated in v2 refactor — see key-dependencies-v2",
    "deprecatedAt": "2026-03-26T12:00:00Z"
  }
}
```

### Deprecation rules

- `deprecated: false` (or absent) — entry is active; included in `snapshot()` and prompt injection
- `deprecated: true` — entry is stale; **excluded from `snapshot()`** (so it is never silently injected into new team prompts), but still visible in `list_project_memory` with a `[DEPRECATED]` flag and still searchable via `query_project_memory`
- An agent can "un-deprecate" an entry implicitly by calling `store_project_memory` with the same key — this overwrites the entry fresh (resets `deprecated` to `false`)

---

## Implementation Status

| # | Description | File(s) | Status |
|---|---|---|---|
| 1 | `ProjectMemoryStore` class | `server/projectMemoryStore.js` | ✅ Done |
| 2 | MCP tools (4) | `server/mcpServer.js` | ✅ Done |
| 3 | REST endpoints (4) | `server/index.js` | ✅ Done |
| 4 | Inject snapshot into orchestrator prompt | `server/promptBuilder.js` | ✅ Done |
| 5 | Load snapshot on team create/restart/relaunch | `server/teamManager.js` | ✅ Done |
| 6 | Orchestrator surfaces prior knowledge to user in opening message | `server/promptBuilder.js` | ✅ Done |
| 7 | UI: modal preview on path entry | `public/js/app.js`, `public/index.html`, `public/css/style.css` | ✅ Done |
| 8 | UI: Team tab sidebar shows live project memory | `public/js/app.js`, `public/css/style.css` | ✅ Done |
| 9 | REST endpoint: preview by cwd (no teamId required) | `server/index.js` | ✅ Done |

**All steps complete.**

---

## Implementation Details

### Step 1 — `server/projectMemoryStore.js` (new file) ✅

A class (not singleton — instantiated per cwd) that reads/writes `.team-maker/project-memory.json`.

Methods:
- `store(key, content, summary, agentLabel)` — upsert an entry; resets `deprecated` to `false`
- `get(key)` — retrieve a single entry
- `list()` — return all entries as `[{ key, summary, storedBy, lastUpdated, deprecated, deprecatedReason }]`
- `query(searchTerms)` — keyword match across keys, summaries, and content; includes deprecated entries flagged with `deprecated: true`
- `snapshot()` — returns a condensed bullet-point summary for prompt injection; skips deprecated entries
- `deprecate(key, reason?)` — soft-mark an entry; sets `deprecated: true`, `deprecatedReason`, `deprecatedAt`
- `ensureGitignore()` — auto-create `.team-maker/.gitignore` if not present

### Step 2 — `server/mcpServer.js` (4 new tools) ✅

Four MCP tools using Zod schemas:

| Tool | Args | Description |
|---|---|---|
| `store_project_memory` | `key`, `content`, `summary?` | Write a finding to project-level memory (resets deprecated status) |
| `query_project_memory` | `query` | Keyword search across project memory (includes deprecated, flagged) |
| `list_project_memory` | — | List all keys + summaries |
| `deprecate_project_memory` | `key`, `reason?` | Soft-mark an entry as stale; excluded from future prompt injection |

These call REST endpoints on the Express server (passing `teamId` so server can resolve `cwd`).

### Step 3 — `server/index.js` (REST endpoints) ✅

```
GET     /api/project-memory?cwd=<path>                  → list by cwd (no teamId — used by modal preview)
POST    /api/teams/:teamId/project-memory                → store
POST    /api/teams/:teamId/project-memory/query          → query
GET     /api/teams/:teamId/project-memory                → list
DELETE  /api/teams/:teamId/project-memory/:key           → deprecate (soft)
```

The `DELETE` endpoint performs a **soft deprecation**, not a hard delete. The request body may optionally include `{ reason: "..." }`.

### Step 4 — `server/promptBuilder.js` (prompts) ✅

**Orchestrator prompt**: When project memory exists, a `## Prior Project Knowledge` section is prepended with the snapshot. If no prior memory exists, the section is omitted entirely.

**Opening instructions**: Orchestrator is explicitly told to list prior knowledge keys+summaries to the user in its opening message, so the user can see context is being reused.

All agent prompts include the full project memory tool list:
- `list_project_memory` / `store_project_memory` / `query_project_memory`
- `deprecate_project_memory(key, reason?)` — mark an entry as stale; excluded from future team prompts but remains searchable.

### Step 5 — `server/teamManager.js` ✅

`create()`, `restartAgent()`, and `relaunch()` all load `new ProjectMemoryStore(cwd).snapshot()` and pass it to `buildOrchestratorPrompt()`. Since `snapshot()` skips deprecated entries, no further changes needed here.

### Steps 6–9 — UI visibility (programmatic, no agent dependency) ✅

Prior knowledge is now surfaced without waiting for Agent 0:

- **Modal preview** (`public/js/app.js` → `loadProjectMemoryPreview`): When the user types or browses to a working directory in the New Team modal, the UI immediately fetches `GET /api/project-memory?cwd=<path>` and renders a preview of all non-deprecated entries below the path field. Triggers on `pathInput` blur and after the Browse button sets a path.

- **Team tab sidebar** (`public/js/app.js` → `renderTeamProjectMemory`): Each time the user switches to the Team tab, the sidebar fetches `GET /api/teams/:teamId/project-memory` and appends a "Project Memory (N)" section at the bottom of the agent flow graph, showing all non-deprecated keys and summaries.

---

## File Change Summary

| File | Change |
|---|---|
| `server/projectMemoryStore.js` | **New** — ProjectMemoryStore class |
| `server/mcpServer.js` | Add 4 tools: `store_project_memory`, `query_project_memory`, `list_project_memory`, `deprecate_project_memory` |
| `server/index.js` | Add 5 REST endpoints (4 team-scoped + 1 cwd-preview) |
| `server/promptBuilder.js` | Inject snapshot in orchestrator prompt; explicit instruction to surface prior knowledge to user; add tool instructions to all agent prompts |
| `server/teamManager.js` | Load project memory snapshot and pass to prompt builder on team create/restart/relaunch |
| `public/index.html` | Add `#project-memory-preview` div in New Team modal |
| `public/js/app.js` | `loadProjectMemoryPreview`, `renderTeamProjectMemory`, `refreshTeamProjectMemory` functions; wire to path input blur, Browse button, and Team tab switch |
| `public/css/style.css` | Styles for modal preview and Team sidebar memory section |

## What Does NOT Change

- Existing `contextStore` (team-scoped) — unchanged, still used for team-internal coordination
- `stateStore` / `state.json` — project memory is stored in cwd, not here
- Session lifecycle, PTY, JSONL watcher — untouched
- MCP config or transport — only adding tools to existing server
