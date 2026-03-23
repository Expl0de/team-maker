# Plan: Improve Question/Permission Detection

## Problem

When Claude CLI asks for permission (tool approvals, file edits, bash commands, etc.), the notification system frequently fails to detect it. Users miss prompts, causing agents to sit idle waiting for input.

## Root Cause Analysis

The current detection relies on **PTY regex pattern matching** against stripped terminal output. This approach has several failure modes:

### 1. Pattern Coverage Gaps
Current `QUESTION_PATTERNS` are:
```
/do you want/i, /allow once/i, /allow always/i, /\(y\/n\)/i,
/\byes\b.*\bno\b/i, /\bdeny\b/i, /\breject\b/i, /\ballow\b.*\bdeny\b/i
```
Claude CLI's actual TUI renders interactive selection widgets with text like:
- `"Allow tool"` — not matched
- `"Run command?"` or `"Execute bash?"` — not matched
- `"Allow Read"`, `"Allow Edit"`, `"Allow Write"`, `"Allow Bash"` — not matched
- Selection widgets showing `❯ Allow once` with arrow-key navigation — the `❯` prefix and ANSI formatting can break matches
- `"wants to"` phrasing (e.g., "Claude wants to read file.js") — not matched

### 2. Text Fragmentation Across PTY Chunks
The TUI renders permission prompts using cursor movement and partial writes. A single prompt like `"Allow once"` may arrive as:
- Chunk 1: `"\x1b[2K\x1b[1G  A"`
- Chunk 2: `"llow on"`
- Chunk 3: `"ce"`

After stripping ANSI, the rolling buffer gets `"  A"` + `"llow on"` + `"ce"` = `"  Allow once"` — but only if all chunks land before the buffer is checked. With the 3-second debounce, this usually works, but during bursts of output the buffer rolls over.

### 3. Rolling Buffer Too Small
`PLAIN_BUFFER_SIZE = 2048` — during heavy output (e.g., reading a large file), the permission prompt text gets pushed out before the check runs.

### 4. False Positives
Patterns like `/\bdeny\b/i` and `/\byes\b.*\bno\b/i` match regular assistant text. Example: Claude writes "you should deny the request" → false alert.

### 5. No JSONL Signal for Permissions
Permission prompts are TUI-internal and never logged to the JSONL file. But we CAN use JSONL indirectly: if a `tool_call` event appears but no `tool_result` follows for several seconds, the agent is likely blocked on a permission dialog.

## Solution: Two-Layer Detection

### Layer 1: Improved PTY Pattern Matching

**Changes to `server/sessionManager.js`:**

#### A. Expand `QUESTION_PATTERNS`

Replace the current patterns with a more comprehensive set based on actual Claude CLI output:

```js
const QUESTION_PATTERNS = [
  // Permission dialog keywords (Claude CLI TUI)
  /do you want to/i,
  /allow once/i,
  /allow always/i,
  /\(y\/n\)/i,
  /\ballow\b.*\bdeny\b/i,
  /wants to/i,                    // "Claude wants to read/edit/write..."
  /allow tool/i,                  // tool permission prompt
  /run command/i,                 // bash command approval
  /execute/i,                     // execution approval
  /approve/i,                     // generic approval prompt
  /permission/i,                  // "needs permission"
  /\bproceed\b/i,                 // "proceed?" prompts
  /\bconfirm\b/i,                 // confirmation dialogs
];
```

#### B. Add negative patterns (anti-false-positive)

Check that the match isn't inside a regular assistant message. We can do this by looking at context: if the matched text appears after an assistant-style prefix (e.g., indented text, markdown), skip it. Simpler approach: only trigger if the pattern appears in the **last ~500 chars** of the buffer (prompts appear at the end of output, not mid-stream).

```js
// Only check the tail of the buffer for question patterns
const tailWindow = this._plainBuffer.slice(-500);
const matched = QUESTION_PATTERNS.find((re) => re.test(tailWindow));
```

#### C. Increase buffer size

```js
const PLAIN_BUFFER_SIZE = 8192; // 8KB rolling buffer (was 2048)
```

#### D. Add delayed accumulation check

Instead of only checking when data arrives, also check after a brief quiet period to catch prompts split across chunks:

```js
// In the onData handler, after accumulating _plainBuffer:
clearTimeout(this._questionCheckTimer);
this._questionCheckTimer = setTimeout(() => {
  this._checkForQuestion();
}, 500); // Check 500ms after last chunk
```

Extract the question-checking logic into a `_checkForQuestion()` method for reuse.

### Layer 2: JSONL-Based "Stuck Tool Call" Heuristic

**Key insight**: When Claude CLI needs permission for a tool call, the sequence in JSONL is:
1. `tool_call` event appears (agent wants to use a tool)
2. ... long pause — waiting for user to approve ...
3. `tool_result` event appears (after approval)

If we see a `tool_call` without a `tool_result` within N seconds, the agent is almost certainly blocked on a permission dialog.

**Changes to `server/sessionManager.js`:**

#### A. Track pending tool calls

```js
// In Session constructor:
this._pendingToolCalls = new Map(); // toolUseId → { timestamp, toolName }
this._permissionCheckTimer = null;
```

#### B. Update `_handleJsonlEvent()`

```js
case "tool_call":
  this._agentState = "tool_calling";
  this._lastToolCall = { name: event.toolName, input: event.input };
  // Track this tool call as pending
  this._pendingToolCalls.set(event.toolUseId, {
    timestamp: Date.now(),
    toolName: event.toolName,
  });
  // Start permission check timer
  this._schedulePermissionCheck();
  break;

case "tool_result":
  this._agentState = "working";
  // Tool completed — remove from pending
  this._pendingToolCalls.delete(event.toolUseId);
  break;
```

#### C. Permission check timer

```js
_schedulePermissionCheck() {
  clearTimeout(this._permissionCheckTimer);
  this._permissionCheckTimer = setTimeout(() => {
    // If any tool calls are still pending after 8 seconds,
    // the agent is likely waiting for permission
    const now = Date.now();
    for (const [toolUseId, info] of this._pendingToolCalls) {
      if (now - info.timestamp > 8000) {
        // Emit question alert
        this._emitQuestionAlert();
        break;
      }
    }
  }, 8000); // 8 seconds after last tool_call
}
```

#### D. Shared alert emission method

Extract the question alert broadcast into a reusable method:

```js
_emitQuestionAlert() {
  const now = Date.now();
  if (now - this._lastQuestionAlert < 3000) return; // debounce
  this._lastQuestionAlert = now;
  this._plainBuffer = "";
  for (const ws of this.clients) {
    try {
      ws.send(JSON.stringify({ type: "question", sessionId: this.id }));
    } catch {}
  }
}
```

## Files to Modify

### 1. `server/sessionManager.js`
- Replace `QUESTION_PATTERNS` array with expanded patterns
- Increase `PLAIN_BUFFER_SIZE` to 8192
- Extract `_checkForQuestion()` and `_emitQuestionAlert()` methods
- Add delayed question check timer (`_questionCheckTimer`)
- Add `_pendingToolCalls` tracking map in constructor
- Update `_handleJsonlEvent()` for tool_call/tool_result tracking
- Add `_schedulePermissionCheck()` method
- Clean up timers in `kill()`

### 2. No frontend changes needed
The frontend already handles `{type: "question"}` messages correctly (yellow pulse, audio alert, flow graph node highlight). The improvements are all server-side detection.

## Implementation Sequence

1. [x] Extract `_checkForQuestion()` and `_emitQuestionAlert()` methods from inline code — DONE: extracted inline onData logic into two reusable methods; `_checkForQuestion()` inspects only the tail 500 chars of the buffer; `_emitQuestionAlert()` handles debounce + broadcast.
2. [x] Expand `QUESTION_PATTERNS` and increase buffer size — DONE: replaced 8 patterns with 13 comprehensive patterns (added `wants to`, `allow tool`, `run command`, `execute`, `approve`, `permission`, `proceed`, `confirm`); removed false-positive-prone `/\byes\b.*\bno\b/i`, `/\bdeny\b/i`, `/\breject\b/i`; increased `PLAIN_BUFFER_SIZE` from 2048 → 8192.
3. [x] Add delayed accumulation check timer — DONE: added `_questionCheckTimer` that fires 500ms after the last PTY chunk, catching prompts split across multiple writes.
4. [x] Add `_pendingToolCalls` map and JSONL-based permission detection — DONE: `_pendingToolCalls` Map tracks `toolUseId → {timestamp, toolName}`; `tool_call` events register pending entries, `tool_result` events clear them; `_schedulePermissionCheck()` fires `_emitQuestionAlert()` if any tool call is pending >8 seconds.
5. [x] Clean up timers in `kill()` — DONE: added cleanup for `_questionCheckTimer`, `_permissionCheckTimer`, and `_pendingToolCalls.clear()` in `kill()`.
6. [ ] Manual testing: start an agent WITHOUT `--permission-mode auto`, trigger tool calls, verify alerts fire

## Verification

1. `npm start` and create a session without auto-accept
2. Ask Claude to read a file → should trigger permission prompt → yellow pulse + alert sound
3. Ask Claude to run a bash command → same
4. Ask Claude to edit a file → same
5. Verify no false positives during normal conversation (Claude writing text that contains words like "deny" or "permission")
6. Verify the JSONL heuristic fires even if PTY patterns miss (e.g., if Claude CLI changes its prompt text in the future)
