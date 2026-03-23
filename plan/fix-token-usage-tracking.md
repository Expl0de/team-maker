# Fix Token/Cost Usage Tracking

## Problem

The usage tab shows bytesIn/bytesOut correctly, but all token fields (inputTokens, outputTokens, cacheRead, cacheWrite, totalTokens) stay at 0 — even though the JSONL log files contain real usage data.

## Root Cause

**The JSONL file path is computed incorrectly**, so `parseJsonlUsage` silently reads from a non-existent file and returns all zeros.

### The Bug: Trailing slash in `cwd` produces wrong directory name

In `server/sessionManager.js`, `getJsonlPath()` does:
```javascript
const projectHash = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
```

When `cwd` has a trailing slash (e.g. `/Users/tung/Documents/Code/test-team-maker/`), the final `/` gets replaced with `-`, producing:
```
-Users-tung-Documents-Code-test-team-maker-
```

But Claude Code actually stores logs at:
```
-Users-tung-Documents-Code-test-team-maker
```

**Evidence from the running test project:**
- Computed path: `~/.claude/projects/-Users-tung-Documents-Code-test-team-maker-/21d2d731....jsonl`
- Actual file:   `~/.claude/projects/-Users-tung-Documents-Code-test-team-maker/21d2d731....jsonl`

The `readFile` call fails silently (caught by `try/catch`), returning `{ inputTokens: 0, outputTokens: 0, ... }`.

## Fix

### Step 1: Strip trailing slashes in `getJsonlPath` (server/sessionManager.js)

```javascript
function getJsonlPath(cwd, sessionId) {
  const normalizedCwd = cwd.replace(/\/+$/, ""); // strip trailing slashes
  const projectHash = "-" + normalizedCwd.replace(/^\//, "").replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", projectHash, `${sessionId}.jsonl`);
}
```

This is the **only change needed** — everything else (parsing logic, API responses, usage page rendering) is already correct.

### Why the rest of the code is fine

- `parseJsonlUsage()` correctly parses `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` from JSONL assistant messages — verified against real data.
- The `_startJsonlPolling()` method correctly polls every 5 seconds and updates `this.tokenUsage`.
- `server/index.js` correctly aggregates `tokenUsage` into team totals in the `/api/teams/:teamId/usage` endpoint.
- `public/usage.html` correctly displays all fields including `totalTokens` fallback.

### Step 2: (Optional) Add debug logging for path resolution

To catch similar issues in the future, add a one-time log when the JSONL path is resolved:
```javascript
console.log(`[Session ${id}] JSONL path: ${this._jsonlPath}`);
```

## Verification

After the fix:
1. Restart the server (`npm start`)
2. Create a new team or reuse existing sessions
3. Open the Usage page — token counts should populate within 5 seconds (the JSONL polling interval)
4. Existing sessions will also start showing data since their JSONL files already exist at the correct path

## Previous Plan Notes (Obsolete)

The previous plan focused on regex-based parsing of terminal output (compactCost, compactTokens patterns). That approach was replaced by JSONL-based parsing, which is already implemented correctly. The only remaining issue is the path bug described above.
