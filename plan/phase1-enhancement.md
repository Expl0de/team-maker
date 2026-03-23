# Phase 1 Enhancement Plan

## Overview

Post anti-pattern (AP1-AP5) enhancements to polish the existing system, fix edge cases, and improve UX.

---

## Findings

### HIGH — Critical Issues

**P1-1. WebSocket Reconnection Without State Sync** [Small]
- On reconnect (`app.js:640-715`), client reattaches but never requests fresh state (usage, agent state, events). Client shows stale data after network blips.
- **Fix**: After `ws.onopen`, send state refresh requests (usage, events, context).

**P1-2. MCP Config File Cleanup on Errors** [Small]
- If team creation fails after writing `/tmp/team-maker-mcp-{id}.json`, the temp file is orphaned. Same on process crashes.
- **Fix**: Use try/finally; add cleanup in team destruction path (`teamManager.js:145-146, 320-322`).

**P1-3. Session Kill Race Condition** [Small]
- `session.kill()` calls `this.pty.kill()` but PTY data handlers may fire after status is set to "exited", causing scrollback corruption.
- **Fix**: Add flag to ignore onData/onExit callbacks after kill (`sessionManager.js:530-548`).

**P1-4. Silent Error Swallowing in WebSocket Broadcast** [Small]
- Bare `try/catch {}` in `index.js:36-43` silently discards all broadcast errors. Broken connections invisible.
- **Fix**: Log errors at debug level when broadcast fails.

**P1-5. Silent Error Swallowing in App.js Event Handlers** [Small]
- Multiple `try/catch (e) {}` blocks in `app.js:652-699` discard errors. Malformed server messages cause silent UI hangs.
- **Fix**: Log errors to console; show user-facing toast for critical failures.

---

### MEDIUM — Performance & Robustness

**P1-6. Global 5-Second Polling on Usage** [Medium]
- `app.js:2552` runs `setInterval(refreshSidebarTokens, 5000)` even with no teams. Scales poorly.
- **Fix**: Only poll when teams exist; increase to 15s for background; pause when tab hidden.

**P1-7. Memory Leak in Usage Auto-Refresh** [Small]
- `usageRefreshInterval` set on Usage tab open (`app.js:1886`), cleared on tab switch (`app.js:735`). Never cleared on window close.
- **Fix**: Clear interval on `window.beforeunload`; add guard in `stopUsageAutoRefresh()`.

**P1-8. JSONL Watcher Polling at 3 Seconds** [Medium]
- Each session polls JSONL every 3s (`jsonlParser.js:206`) plus fs.watch. 10 agents = 10 pollers.
- **Fix**: Increase to 5-10s for idle agents; add backoff when no new events detected.

**P1-9. Context Store LRU Eviction is O(n)** [Small]
- `_evictLRU()` in `contextStore.js:37-55` does linear scan every store, even when under limits.
- **Fix**: Only evict when over budget; use sorted structure for LRU tracking.

**P1-10. Event Buffer Scales with Agent Count** [Medium]
- 500 events per session x 10 agents = 5000 events in memory. No cleanup on team deletion.
- **Fix**: Cap total events per team; clean up on team destruction.

---

### MEDIUM — UX & Error Handling

**P1-11. No Error Feedback on Team Creation Failure** [Medium]
- If fetch fails or server returns 400+, create button stays in loading state forever.
- **Fix**: Add error toast on failure; show specific error messages from server response.

**P1-12. No Timeout on Fetch Calls** [Medium]
- 30+ fetch calls in `app.js` have no timeout. Server hang = frozen UI.
- **Fix**: Wrap fetch in `Promise.race` with 10s timeout; show "Server not responding" toast.

**P1-13. File Read Endpoint Symlink Bypass** [Small]
- `index.js:396-419` validates path with `resolve()` but doesn't check symlinks. Could read outside cwd.
- **Fix**: Use `realpath()` after `resolve()`; reject if outside allowed directory.

**P1-14. No Validation of Initial Prompt Length** [Small]
- Team creation accepts unlimited prompts. A 10MB prompt would crash Claude CLI or cause huge usage.
- **Fix**: Limit to 5000 chars client-side; warn on server if > 2000 chars.

**P1-15. Modal Double-Submit** [Small]
- Create Team modal has no disabled state during submission. User can click multiple times, spawning duplicates.
- **Fix**: Disable modal buttons during fetch; add spinner; re-enable on error.

**P1-16. Idle Toast on Already-Stopped Teams** [Small]
- Idle kill toast shown even if user already stopped the team. Confusing.
- **Fix**: Check team status before showing idle kill toast (`app.js:1855`).

---

### MEDIUM — Missing Features

**P1-17. No Health Check Endpoint** [Small]
- No way to check if server is up. Users see blank UI if server is down.
- **Fix**: Add `/api/health` returning `{ok: true}`; check on app load; show banner if down.

**P1-18. No Graceful Shutdown** [Medium]
- Shutting down server leaves orphaned PTY processes. State is flushed (`index.js:696-721`) but processes aren't terminated.
- **Fix**: SIGTERM all sessions; wait up to 5s for clean exit before hard kill.

**P1-19. No Session CWD Validation** [Small]
- POST `/api/sessions` accepts any `cwd` without checking existence.
- **Fix**: Validate cwd exists and is readable; return 400 if invalid.

**P1-20. Resize Race on WebSocket Attach** [Small]
- `index.js:667-670` calls `resize()` immediately. If terminal hasn't attached yet, resize is lost.
- **Fix**: Buffer pending resize; apply on attach.

---

### LOW — Nice-to-Have

**P1-21. No Persistent Tab Selection** [Small]
- Switching teams resets to first tab. No localStorage persistence of active tab.
- **Fix**: Store active team/session in localStorage; restore on load.

**P1-22. No Search/Filter in Events Tab** [Small]
- Events tab has type/agent dropdowns but no full-text search. Hard to find specific tool calls at 500 events.
- **Fix**: Add text input to filter by tool name, file path, etc.

**P1-23. Inaccurate Context Token Estimation** [Small]
- `contextStore.js:69` estimates tokens as `content.length / 4`. Inaccurate for code vs prose.
- **Fix**: Extract actual token counts from Claude API usage data if available.

**P1-24. No Team Export/Import** [Medium]
- No way to backup or share team configs.
- **Fix**: Add `/api/teams/{id}/export` and `/api/import` endpoints.

**P1-25. Idle Warning Can't Be Dismissed** [Small]
- No way to dismiss idle warning or reset timer manually if agent is intentionally waiting.
- **Fix**: Add "Keep alive" button in toast; or add mute per-agent.

**P1-26. Manual Clear Agent Context** [Medium]
- Completed agents accumulate large context (50-100K tokens). Every subsequent interaction re-sends the full history, wasting tokens. Users have no way to reset a finished agent's context.
- **Fix**: Add `/clear` command support per agent session. Expose via a vertical `...` (kebab) menu button on each agent in the agent list sidebar. Menu options: "Clear context", and potentially "Restart". Server-side: send `/clear` to the agent's PTY; client-side: reset scrollback and show a "Context cleared" indicator.

**P1-27. Auto-Clear Agent Context When Task Done + Context Large** [Medium] — **REMOVED**
- Was: auto-send `/clear` when agent goes idle and context exceeds 50K tokens.
- Removed: caused unexpected `/clear` injections mid-conversation. Manual clear via kebab menu (P1-26) is sufficient.

---

## Implementation Progress

_Tasks will be tracked here as findings are implemented._

---

## Priority Order

| # | Finding | Effort | Status |
|---|---------|--------|--------|
| P1-1 | WebSocket reconnection state sync | Small | ✅ Done |
| P1-2 | MCP config file cleanup | Small | ✅ Done |
| P1-3 | Session kill race condition | Small | ✅ Done |
| P1-4 | Silent broadcast errors | Small | ✅ Done |
| P1-5 | Silent app.js error swallowing | Small | ✅ Done |
| P1-6 | Usage polling efficiency | Medium | ✅ Done |
| P1-7 | Usage auto-refresh memory leak | Small | ✅ Done |
| P1-8 | JSONL watcher polling frequency | Medium | ✅ Done |
| P1-9 | Context store LRU O(n) scan | Small | ✅ Done |
| P1-10 | Event buffer scaling | Medium | ✅ Done |
| P1-11 | Team creation error feedback | Medium | ✅ Done |
| P1-12 | Fetch timeout protection | Medium | ✅ Done |
| P1-13 | File read symlink bypass | Small | ✅ Done |
| P1-14 | Prompt length validation | Small | ✅ Done |
| P1-15 | Modal double-submit | Small | ✅ Done |
| P1-16 | Idle toast on stopped teams | Small | ✅ Done |
| P1-17 | Health check endpoint | Small | ✅ Done |
| P1-18 | Graceful shutdown | Medium | ✅ Done |
| P1-19 | Session CWD validation | Small | ✅ Done |
| P1-20 | Resize race on attach | Small | ✅ Done |
| P1-21 | Persistent tab selection | Small | ✅ Done |
| P1-22 | Events tab search/filter | Small | ✅ Done |
| P1-23 | Token estimation accuracy | Small | ✅ Done |
| P1-24 | Team export/import | Medium | ✅ Done |
| P1-25 | Idle warning dismissal | Small | ✅ Done |
| P1-26 | Clear agent context (kebab menu) | Medium | ✅ Done |
| P1-27 | Auto-clear on task done + large context | Medium | ❌ Removed |
