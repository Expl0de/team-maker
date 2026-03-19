# Anti-Pattern 1 Fix: Replace Polling Wake Loop with Event-Driven Messaging

## Chosen Approach: Option C + Rare Health-Check Ping

Remove the wake loop entirely. Rely on `send_message` MCP tool (which already injects text into the receiving agent's PTY via `POST /api/sessions/:id/input`) as the sole communication mechanism. Add a low-frequency health-check ping (every 5 minutes) that only fires if an agent has been completely idle — as a safety net for stuck agents.

### Why This Approach
- `send_message` already delivers messages instantly via PTY injection — the wake loop is redundant
- Simplest to implement: mostly deleting code
- Health-check ping catches edge cases (failed message injection, stuck agents)

### Expected Impact
- ~60-80% reduction in coordination token costs
- Message delivery latency drops from ~30s average to <1s
- Wake interval UI removed (no longer user-configurable since there's no polling)

---

## Implementation Progress

### [x] 1. Update plan file
Write this plan with progress tracking.

### [x] 2. `server/sessionManager.js` — Remove wake loop, add health-check
- Remove `_startWakeLoop()` method entirely
- Remove `_wakeIntervalMs` and `_wakeInterval` fields from constructor
- Add `_startHealthCheck()`: 5-minute interval that only pings if agent is idle >4 minutes AND session is part of a team
- Health-check message is minimal: "Health check: Are you stuck? If you have pending tasks, continue working. If waiting for input, say so."
- Clean up health-check timer in `kill()` and `onExit`

### [x] 3. `server/promptBuilder.js` — Remove wake loop from agent prompts
- Remove "Wake Loop (every N seconds)" section from sub-agent prompt
- Remove "Every N seconds" from Agent 0 responsibilities
- Replace with event-driven instructions: "You will receive messages directly. Process them as they arrive."
- Remove `wakeInterval` parameter from `buildOrchestratorPrompt()`
- Update `send_message` MCP tool description: primary communication channel, not "use sparingly"

### [x] 4. `server/teamManager.js` — Remove wakeInterval plumbing
- Remove `wakeInterval` from `Team` constructor and `toJSON()`
- Remove `wakeInterval` param from `create()` method
- Remove `wakeInterval` from session creation calls

### [x] 5. `server/index.js` — Remove wakeInterval from API
- Remove `wakeInterval` from POST `/api/teams` request body destructuring

### [x] 6. Frontend — Remove wake interval UI
- `public/index.html`: Remove the wake-interval-row div (label + input + unit)
- `public/css/style.css`: Remove `.wake-interval-row`, `.wake-interval-row input`, `.wake-interval-unit` styles
- `public/js/app.js`: Remove `wakeIntervalInput` const, reset in `showNewTeamModal()`, and usage in `createNewTeam()`

### [x] 7. `server/mcpServer.js` — Update send_message description
- Change description to indicate it's the primary inter-agent communication channel
