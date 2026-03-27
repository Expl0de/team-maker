import pty from "node-pty";
import { v4 as uuidv4 } from "uuid";
import { join } from "path";
import { homedir } from "os";
import { JsonlWatcher } from "./jsonlParser.js";
import stateStore from "./stateStore.js";

const MAX_SCROLLBACK = 100 * 1024; // 100KB
const MAX_EVENTS = 500; // max structured events kept per session
const PLAIN_BUFFER_SIZE = 8192; // 8KB rolling buffer for pattern detection
const PROMPT_INJECT_TIMEOUT = 15000; // fallback timeout if ready signal not detected
const PROMPT_SETTLE_DELAY = 300; // delay between paste and Enter after ready detected
const IDLE_WARN_MS = 5 * 60 * 1000; // 5 minutes idle → warning
const IDLE_KILL_MS = 10 * 60 * 1000; // 10 minutes idle → auto-kill

// Strip ANSI escape sequences and control characters from terminal data
function stripAnsi(str) {
  return str
    // CSI sequences: ESC [ ... final_byte
    .replace(/\x1b\[[\x20-\x3f]*[\x30-\x3f]*[\x40-\x7e]/g, "")
    // OSC sequences: ESC ] ... (ST or BEL)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // ESC + single char (e.g. ESC =, ESC >)
    .replace(/\x1b[\x20-\x7e]/g, "")
    // Remaining lone ESC
    .replace(/\x1b/g, "")
    // Control chars except newline/tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/**
 * Derive the Claude Code JSONL log file path for a session.
 * Claude Code stores logs at: ~/.claude/projects/<project-hash>/<sessionId>.jsonl
 * where <project-hash> is the cwd with "/" replaced by "-".
 */
function getJsonlPath(cwd, sessionId) {
  const normalizedCwd = cwd.replace(/\/+$/, ""); // strip trailing slashes
  const projectHash = "-" + normalizedCwd.replace(/^\//, "").replace(/[/.]/g, "-");
  return join(homedir(), ".claude", "projects", projectHash, `${sessionId}.jsonl`);
}

// PTY-based question detection (legacy fallback for permission prompts).
// Permission dialogs are CLI-internal TUI elements not logged in JSONL,
// so PTY regex matching remains necessary for these. JSONL-based state
// tracking (AP3) handles all other agent state (working/idle/tool_calling).
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

class Session {
  constructor({ id, name, cwd, autoAccept, initialPrompt, teamId, role, agentIndex, mcpConfigPath, model }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.teamId = teamId || null;
    this.role = role || null; // "main" | "agent"
    this.agentIndex = agentIndex || null;
    this.model = model || null;
    this.initialPrompt = initialPrompt || null;
    this.status = "running";
    this.exitCode = null;
    this.createdAt = new Date();
    this.scrollback = "";
    this.clients = new Set();
    this.usage = { bytesIn: 0, bytesOut: 0 };
    this.tokenUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };
    this._lastQuestionAlert = 0; // debounce timestamp
    this._plainBuffer = ""; // rolling buffer of stripped text for pattern matching
    this._questionCheckTimer = null; // delayed check for split PTY chunks
    this._lastOutputTime = Date.now(); // track last PTY output for idle detection
    this._healthCheckInterval = null; // rare health-check ping for stuck agents
    this._active = false; // whether the session is actively producing output
    this._activityTimer = null; // timer to detect when output stops

    // JSONL log file path — we pass --session-id to Claude CLI so the log file
    // is at a predictable path: ~/.claude/projects/<project-hash>/<id>.jsonl
    this._jsonlPath = getJsonlPath(cwd || process.env.HOME, id);
    console.log(`[Session ${id}] JSONL path: ${this._jsonlPath}`);

    // Structured event log from JSONL (AP3 control plane)
    this._events = []; // circular buffer of structured events
    this._eventListeners = new Set(); // callbacks for real-time event broadcast
    this._agentState = "starting"; // starting | working | idle | tool_calling | completed
    this._lastToolCall = null; // most recent tool call for display
    this._pendingToolCalls = new Map(); // toolUseId → { timestamp, toolName }
    this._permissionCheckTimer = null; // timer for stuck tool call heuristic

    // Idle timeout tracking (AP5-A: auto-kill idle agents)
    this._idleStartTime = null; // when agent entered idle state
    this._idleWarned = false; // whether we've sent the 5min warning
    this._idleCheckTimer = null; // periodic idle check interval
    this._idleListeners = new Set(); // callbacks for idle events (warning/kill)
    this._killed = false; // P1-3: flag to ignore PTY callbacks after kill

    // JSONL watcher replaces interval-based polling — watches file for appends
    this._jsonlWatcher = new JsonlWatcher(this._jsonlPath, (event) => {
      this._handleJsonlEvent(event);
    });

    const claudePath = process.env.CLAUDE_PATH || "claude";
    const args = ["--session-id", id];
    if (autoAccept) args.push("--permission-mode", "auto");
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
    if (model) args.push("--model", model);

    this.pty = pty.spawn(claudePath, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: cwd || process.env.HOME,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    // Auto-accept the workspace trust dialog
    if (autoAccept) {
      this._autoAcceptTrust();
    }

    // If an initial prompt is provided, send it after Claude starts up
    if (initialPrompt) {
      this._injectPrompt(initialPrompt);
    }

    // Start health-check ping for team agents (rare, only for stuck detection)
    if (teamId) {
      this._startHealthCheck();
      this._startIdleCheck();
    }

    this.pty.onData((data) => {
      if (this._killed) return; // P1-3: ignore data after kill
      this.usage.bytesOut += data.length;
      this._lastOutputTime = Date.now();
      this.scrollback += data;
      if (this.scrollback.length > MAX_SCROLLBACK) {
        this.scrollback = this.scrollback.slice(-MAX_SCROLLBACK);
      }

      // Track activity state — mark active when output arrives,
      // mark idle after 3s of silence
      if (!this._active) {
        this._active = true;
        this._broadcastStatus();
      }
      clearTimeout(this._activityTimer);
      this._activityTimer = setTimeout(() => {
        this._active = false;
        this._broadcastStatus();
      }, 3000);

      // Accumulate stripped text into rolling buffer for pattern detection
      this._plainBuffer += stripAnsi(data);
      if (this._plainBuffer.length > PLAIN_BUFFER_SIZE) {
        this._plainBuffer = this._plainBuffer.slice(-PLAIN_BUFFER_SIZE);
      }

      // Start JSONL watcher on first output (Claude CLI has started)
      if (!this._jsonlWatcher._pollTimer) {
        this._jsonlWatcher.start();
      }

      // Check for question/dialog patterns (debounced to 3s)
      this._checkForQuestion();
      // Also schedule a delayed check to catch prompts split across PTY chunks
      clearTimeout(this._questionCheckTimer);
      this._questionCheckTimer = setTimeout(() => {
        this._checkForQuestion();
      }, 500);

      for (const ws of this.clients) {
        try {
          ws.send(data);
        } catch {}
      }
    });

    this.pty.onExit(({ exitCode }) => {
      if (this._killed) return; // P1-3: ignore exit after kill
      this.status = "exited";
      this.exitCode = exitCode;
      this._agentState = "completed";
      // Final JSONL read to capture last events before exit
      this._jsonlWatcher.stop();
      // Do one last read to capture anything written just before exit
      this._jsonlWatcher._readNewLines().catch(() => {});
      for (const ws of this.clients) {
        try {
          ws.send(JSON.stringify({ type: "exit", exitCode }));
        } catch {}
      }
    });
  }

  /**
   * Wait for a pattern in PTY output, then call the callback.
   * Falls back to the callback after timeoutMs if the pattern never matches.
   */
  _waitForOutput(pattern, timeoutMs, callback) {
    let buffer = "";
    let resolved = false;

    const resolve = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(fallback);
      disposable.dispose();
      callback();
    };

    const disposable = this.pty.onData((data) => {
      buffer += stripAnsi(data);
      // Keep buffer bounded
      if (buffer.length > 4096) buffer = buffer.slice(-4096);
      if (pattern.test(buffer)) {
        resolve();
      }
    });
    const fallback = setTimeout(() => {
      console.log(`[Session ${this.id}] _waitForOutput timed out after ${timeoutMs}ms, proceeding with fallback`);
      resolve();
    }, timeoutMs);
  }

  _autoAcceptTrust() {
    // Wait for the workspace trust dialog to actually appear before accepting.
    // Matches "trust" or "Trust" in the output (e.g. "Do you trust the files in this folder?")
    this._waitForOutput(/[Tt]rust/, 5000, () => {
      if (this.status === "running") {
        this.pty.write("\r");
      }
    });
  }

  _injectPrompt(prompt) {
    // Wait for Claude CLI to be ready (shows the input prompt indicator)
    // before pasting. The ready signal is typically a ">" prompt or the
    // end of the startup sequence where output settles.
    // We detect readiness by looking for a period of output silence after
    // initial startup, or the presence of common ready indicators.
    const readyPattern = /(?:^|\n)\s*>\s*$|Type .* to|How can I help|What would you like/;

    this._waitForOutput(readyPattern, PROMPT_INJECT_TIMEOUT, () => {
      if (this.status !== "running") return;
      // Small settle delay to let the TUI fully render the input area
      setTimeout(() => {
        if (this.status !== "running") return;
        this.pty.write(prompt);
        // Wait for pasted text to be processed before pressing Enter
        setTimeout(() => {
          if (this.status === "running") {
            this.pty.write("\r");
          }
        }, PROMPT_SETTLE_DELAY);
      }, 200);
    });
  }

  /**
   * Handle a structured event from the JSONL watcher.
   * Updates token usage, agent state, and broadcasts to listeners.
   */
  _handleJsonlEvent(event) {
    // Update token usage from JSONL (replaces interval-based polling)
    if (event.type === "usage") {
      this.tokenUsage.inputTokens += event.inputTokens;
      this.tokenUsage.outputTokens += event.outputTokens;
      this.tokenUsage.cacheRead += event.cacheRead;
      this.tokenUsage.cacheWrite += event.cacheWrite;
      this.tokenUsage.totalTokens =
        this.tokenUsage.inputTokens +
        this.tokenUsage.outputTokens +
        this.tokenUsage.cacheRead +
        this.tokenUsage.cacheWrite;
      // Don't store usage events in the event log — they're internal
      return;
    }

    // Update agent state based on event type
    const prevState = this._agentState;
    switch (event.type) {
      case "tool_call":
        this._agentState = "tool_calling";
        this._lastToolCall = { name: event.toolName, input: event.input };
        // Track this tool call as pending for permission detection
        if (event.toolUseId) {
          this._pendingToolCalls.set(event.toolUseId, {
            timestamp: Date.now(),
            toolName: event.toolName,
          });
          this._schedulePermissionCheck();
        }
        break;
      case "tool_result":
        this._agentState = "working";
        // Tool completed — remove from pending
        if (event.toolUseId) {
          this._pendingToolCalls.delete(event.toolUseId);
        }
        break;
      case "assistant_message":
        this._agentState = "working";
        break;
      case "turn_complete":
        this._agentState = "idle";
        break;
      case "thinking":
        this._agentState = "thinking";
        break;
    }

    // Track idle start time for AP5-A idle timeout
    if (this._agentState === "idle" && prevState !== "idle") {
      this._idleStartTime = Date.now();
      this._idleWarned = false;

    } else if (this._agentState !== "idle") {
      this._idleStartTime = null;
      this._idleWarned = false;
    }

    // Tag the event with session metadata
    const taggedEvent = {
      ...event,
      sessionId: this.id,
      sessionName: this.name,
      teamId: this.teamId,
      agentState: this._agentState,
    };

    // Store in circular buffer
    this._events.push(taggedEvent);
    if (this._events.length > MAX_EVENTS) {
      this._events.shift();
    }

    // Broadcast to listeners (WebSocket clients)
    for (const listener of this._eventListeners) {
      try {
        listener(taggedEvent);
      } catch {}
    }

    // Broadcast state change
    if (this._agentState !== prevState) {
      for (const ws of this.clients) {
        try {
          ws.send(JSON.stringify({
            type: "agent_state",
            sessionId: this.id,
            state: this._agentState,
            lastToolCall: this._lastToolCall,
          }));
        } catch {}
      }
    }
  }

  onEvent(listener) {
    this._eventListeners.add(listener);
    return () => this._eventListeners.delete(listener);
  }

  getEvents() {
    return this._events;
  }

  /**
   * Check the rolling plain-text buffer for question/permission patterns.
   * Only inspects the tail of the buffer to reduce false positives from
   * assistant text earlier in the output.
   */
  _checkForQuestion() {
    const now = Date.now();
    if (now - this._lastQuestionAlert < 3000) return; // debounce
    const tailWindow = this._plainBuffer.slice(-500);
    const matched = QUESTION_PATTERNS.find((re) => re.test(tailWindow));
    if (matched) {
      this._emitQuestionAlert();
    }
  }

  /**
   * Broadcast a question alert to all connected WebSocket clients.
   * Debounced to avoid spamming (minimum 3s between alerts).
   */
  _emitQuestionAlert() {
    const now = Date.now();
    if (now - this._lastQuestionAlert < 3000) return; // debounce
    this._lastQuestionAlert = now;
    this._plainBuffer = ""; // Clear buffer so same text doesn't re-trigger
    for (const ws of this.clients) {
      try {
        ws.send(JSON.stringify({ type: "question", sessionId: this.id }));
      } catch {}
    }
  }

  /**
   * Schedule a check for stuck tool calls (JSONL-based permission detection).
   * If a tool_call has no matching tool_result after 8 seconds, the agent
   * is likely blocked on a permission dialog.
   */
  _schedulePermissionCheck() {
    clearTimeout(this._permissionCheckTimer);
    this._permissionCheckTimer = setTimeout(() => {
      const now = Date.now();
      for (const [, info] of this._pendingToolCalls) {
        if (now - info.timestamp > 8000) {
          this._emitQuestionAlert();
          break;
        }
      }
    }, 8000);
  }

  _broadcastStatus() {
    for (const ws of this.clients) {
      try {
        ws.send(JSON.stringify({ type: "activity", sessionId: this.id, active: this._active }));
      } catch {}
    }
  }

  _startHealthCheck() {
    // Rare health-check ping (every 5 minutes) — only fires if agent is idle >4 minutes.
    // This is a safety net for stuck agents, NOT a communication mechanism.
    // Normal inter-agent messaging uses send_message (PTY injection) which is instant.
    const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
    const IDLE_THRESHOLD = 4 * 60 * 1000; // 4 minutes
    const startDelay = 60000; // 60s — give agent time to process initial prompt
    setTimeout(() => {
      if (this.status !== "running") return;
      this._healthCheckInterval = setInterval(() => {
        if (this.status !== "running") {
          clearInterval(this._healthCheckInterval);
          this._healthCheckInterval = null;
          return;
        }
        const idleMs = Date.now() - this._lastOutputTime;
        if (idleMs > IDLE_THRESHOLD) {
          const ping = "Health check: If you have pending tasks, continue working. If you are waiting for input, say so.";
          this.pty.write(ping);
          setTimeout(() => {
            if (this.status === "running") {
              this.pty.write("\r");
            }
          }, 500);
        }
      }, HEALTH_CHECK_INTERVAL);
    }, startDelay);
  }

  _startIdleCheck() {
    // Check every 30s if this agent has been idle too long.
    // Only applies to sub-agents (role === "agent"), not the orchestrator.
    const CHECK_INTERVAL = 30 * 1000;
    const startDelay = 2 * 60 * 1000; // 2min — let agent finish initial prompt
    setTimeout(() => {
      if (this.status !== "running") return;
      this._idleCheckTimer = setInterval(() => {
        if (this.status !== "running" || this.role !== "agent") {
          clearInterval(this._idleCheckTimer);
          this._idleCheckTimer = null;
          return;
        }
        if (!this._idleStartTime) return;

        const idleMs = Date.now() - this._idleStartTime;

        if (idleMs >= IDLE_KILL_MS) {
          // Auto-kill after 10 minutes idle
          console.log(`[Session ${this.id}] Auto-killing after ${Math.round(idleMs / 1000)}s idle`);
          clearInterval(this._idleCheckTimer);
          this._idleCheckTimer = null;
          for (const listener of this._idleListeners) {
            try { listener({ type: "agent_idle_killed", sessionId: this.id, sessionName: this.name, teamId: this.teamId, idleMs }); } catch {}
          }
          this.kill();
        } else if (idleMs >= IDLE_WARN_MS && !this._idleWarned) {
          // Warn at 5 minutes idle
          this._idleWarned = true;
          console.log(`[Session ${this.id}] Idle warning after ${Math.round(idleMs / 1000)}s`);
          for (const listener of this._idleListeners) {
            try { listener({ type: "agent_idle_warning", sessionId: this.id, sessionName: this.name, teamId: this.teamId, idleMs }); } catch {}
          }
        }
      }, CHECK_INTERVAL);
    }, startDelay);
  }

  /**
   * Suspend background monitoring timers (health-check and idle-check).
   * PTY process and session status are NOT affected. Idempotent.
   */
  suspendMonitoring() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
    if (this._idleCheckTimer) {
      clearInterval(this._idleCheckTimer);
      this._idleCheckTimer = null;
    }
  }

  /**
   * Restart background monitoring timers after a pause.
   * Only proceeds if session.status === "running".
   */
  resumeMonitoring() {
    if (this.status !== "running") return;
    this._startHealthCheck();
    this._startIdleCheck();
  }

  /**
   * Clear the session's structured event buffer and reset the JSONL watcher
   * read offset so the next poll re-reads from the start of the log.
   * Also clears persisted file-modification data for this session's team.
   * Safe to call on exited sessions.
   */
  clearFileTracking() {
    this._events = [];
    if (this._jsonlWatcher) {
      this._jsonlWatcher.clearTracking();
    }
    if (this.teamId) {
      stateStore.set(`files.${this.teamId}`, {});
    }
  }

  // P1-25: Reset idle timer (keep alive)
  resetIdle() {
    this._idleStartTime = null;
    this._idleWarned = false;
  }

  onIdleEvent(listener) {
    this._idleListeners.add(listener);
    return () => this._idleListeners.delete(listener);
  }

  write(data) {
    if (this.status === "running") {
      this.usage.bytesIn += data.length;
      this.pty.write(data);
    }
  }

  resize(cols, rows) {
    if (this.status === "running") {
      this.pty.resize(cols, rows);
    }
  }

  addClient(ws) {
    this.clients.add(ws);
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  injectInput(text) {
    if (this.status === "running") {
      this.pty.write(text);
    }
  }

  // P1-26: Clear agent context — sends /clear to CLI and resets local buffers
  clearContext() {
    const prevTokens = { ...this.tokenUsage };
    if (this.status === "running") {
      // Send Escape first to cancel any in-progress input, then /clear + Enter
      this.pty.write("\x1b");
      setTimeout(() => {
        if (this.status === "running") {
          this.pty.write("/clear\r");
        }
      }, 100);
    }
    // Reset local scrollback and plain buffer
    this.scrollback = "";
    this._plainBuffer = "";
    // Reset idle tracking since context was just cleared
    this._idleStartTime = null;
    this._idleWarned = false;
    return { tokenUsage: prevTokens };
  }

  kill() {
    if (this.status === "running") {
      this._killed = true; // P1-3: prevent callbacks from firing after kill
      if (this._healthCheckInterval) {
        clearInterval(this._healthCheckInterval);
        this._healthCheckInterval = null;
      }
      if (this._idleCheckTimer) {
        clearInterval(this._idleCheckTimer);
        this._idleCheckTimer = null;
      }
      clearTimeout(this._questionCheckTimer);
      this._questionCheckTimer = null;
      clearTimeout(this._permissionCheckTimer);
      this._permissionCheckTimer = null;
      this._pendingToolCalls.clear();
      this._jsonlWatcher.stop();
      this.pty.kill();
      this.status = "exited";
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      exitCode: this.exitCode,
      createdAt: this.createdAt.toISOString(),
      cwd: this.cwd,
      teamId: this.teamId,
      role: this.role,
      agentIndex: this.agentIndex,
      model: this.model,
      usage: {
        bytesIn: this.usage.bytesIn,
        bytesOut: this.usage.bytesOut,
        durationMs: Date.now() - this.createdAt.getTime(),
      },
      tokenUsage: { ...this.tokenUsage },
      clientCount: this.clients.size,
      agentState: this._agentState,
      lastToolCall: this._lastToolCall,
    };
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.instanceCounter = 0;
    this._eventListeners = new Set(); // global event listeners for all sessions
    this._idleEventListeners = new Set(); // global idle event listeners (warning/kill)
  }

  /**
   * Register a listener for agent events from ALL sessions.
   * Listener receives (event) where event includes sessionId, teamId, etc.
   */
  onAgentEvent(listener) {
    this._eventListeners.add(listener);
    return () => this._eventListeners.delete(listener);
  }

  /**
   * Register a listener for idle events (warning/kill) from ALL sessions.
   */
  onIdleEvent(listener) {
    this._idleEventListeners.add(listener);
    return () => this._idleEventListeners.delete(listener);
  }

  create({ name, cwd, autoAccept, initialPrompt, teamId, role, agentIndex, mcpConfigPath, model } = {}) {
    const id = uuidv4();
    this.instanceCounter++;
    const sessionName = name || `Instance ${this.instanceCounter}`;
    const session = new Session({ id, name: sessionName, cwd, autoAccept, initialPrompt, teamId, role, agentIndex, mcpConfigPath, model });
    this.sessions.set(id, session);

    // Wire up event forwarding to global listeners
    session.onEvent((event) => {
      for (const listener of this._eventListeners) {
        try {
          listener(event);
        } catch {}
      }
    });

    // Wire up idle event forwarding
    session.onIdleEvent((event) => {
      for (const listener of this._idleEventListeners) {
        try {
          listener(event);
        } catch {}
      }
    });

    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  destroy(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
      return true;
    }
    return false;
  }
}

export default new SessionManager();
