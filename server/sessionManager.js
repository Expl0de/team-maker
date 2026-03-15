import pty from "node-pty";
import { v4 as uuidv4 } from "uuid";

const MAX_SCROLLBACK = 100 * 1024; // 100KB
const PLAIN_BUFFER_SIZE = 2048; // rolling buffer for pattern detection
const WAKE_INTERVAL_MS = 60 * 1000; // 60 seconds between wake-up nudges

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

// Patterns that indicate Claude Code is asking a question / waiting for input
const QUESTION_PATTERNS = [
  /do you want/i,
  /allow once/i,
  /allow always/i,
  /\(y\/n\)/i,
  /\byes\b.*\bno\b/i,
  /\bdeny\b/i,
  /\breject\b/i,
  /\ballow\b.*\bdeny\b/i,
];

class Session {
  constructor({ id, name, cwd, autoAccept, initialPrompt, teamId, role, mcpConfigPath }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.teamId = teamId || null;
    this.role = role || null; // "main" | "agent"
    this.status = "running";
    this.exitCode = null;
    this.createdAt = new Date();
    this.scrollback = "";
    this.clients = new Set();
    this.usage = { bytesIn: 0, bytesOut: 0 };
    this._lastQuestionAlert = 0; // debounce timestamp
    this._plainBuffer = ""; // rolling buffer of stripped text for pattern matching
    this._lastOutputTime = Date.now(); // track last PTY output for idle detection
    this._wakeInterval = null; // server-side wake-up timer for agents
    this._active = false; // whether the session is actively producing output
    this._activityTimer = null; // timer to detect when output stops

    const claudePath = process.env.CLAUDE_PATH || "/Users/tung/.local/bin/claude";
    const args = [];
    if (autoAccept) args.push("--permission-mode", "auto");
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);

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

    // Start server-side wake-up interval for team agents
    if (teamId) {
      this._startWakeLoop();
    }

    this.pty.onData((data) => {
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

      // Check for question/dialog patterns (debounced to 3s)
      const now = Date.now();
      if (now - this._lastQuestionAlert > 3000) {
        const matched = QUESTION_PATTERNS.find((re) => re.test(this._plainBuffer));
        if (matched) {
          this._lastQuestionAlert = now;
          // Clear buffer so same text doesn't re-trigger
          this._plainBuffer = "";
          for (const ws of this.clients) {
            try {
              ws.send(JSON.stringify({ type: "question", sessionId: this.id }));
            } catch {}
          }
        }
      }

      for (const ws of this.clients) {
        try {
          ws.send(data);
        } catch {}
      }
    });

    this.pty.onExit(({ exitCode }) => {
      this.status = "exited";
      this.exitCode = exitCode;
      for (const ws of this.clients) {
        try {
          ws.send(JSON.stringify({ type: "exit", exitCode }));
        } catch {}
      }
    });
  }

  _autoAcceptTrust() {
    // The workspace trust dialog appears on first launch in a directory.
    // Send Enter after a short delay to accept it.
    setTimeout(() => {
      if (this.status === "running") {
        this.pty.write("\r");
      }
    }, 2000);
  }

  _injectPrompt(prompt) {
    // Claude Code TUI continuously renders, so we wait a fixed delay
    // for the CLI to finish startup before typing the prompt.
    // We paste the text first, then press Enter after a short delay
    // so the TUI input has time to process the pasted content.
    setTimeout(() => {
      if (this.status === "running") {
        this.pty.write(prompt);
        setTimeout(() => {
          if (this.status === "running") {
            this.pty.write("\r");
          }
        }, 500);
      }
    }, 5000);
  }

  _broadcastStatus() {
    for (const ws of this.clients) {
      try {
        ws.send(JSON.stringify({ type: "activity", sessionId: this.id, active: this._active }));
      } catch {}
    }
  }

  _startWakeLoop() {
    // Wait for initial prompt to finish before starting the wake loop
    const startDelay = 30000; // 30s — give agent time to process initial prompt
    setTimeout(() => {
      if (this.status !== "running") return;
      this._wakeInterval = setInterval(() => {
        if (this.status !== "running") {
          clearInterval(this._wakeInterval);
          this._wakeInterval = null;
          return;
        }
        // Only nudge if agent has been idle (no output for 30+ seconds)
        const idleMs = Date.now() - this._lastOutputTime;
        if (idleMs > 30000) {
          const nudge = "Check your inbox (AGENT_COMMUNICATE.md) and shared plan (MULTI_AGENT_PLAN.md) now. If you have pending tasks, work on them. If idle, report status to Agent 0.";
          this.pty.write(nudge);
          setTimeout(() => {
            if (this.status === "running") {
              this.pty.write("\r");
            }
          }, 500);
        }
      }, WAKE_INTERVAL_MS);
    }, startDelay);
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

  kill() {
    if (this.status === "running") {
      if (this._wakeInterval) {
        clearInterval(this._wakeInterval);
        this._wakeInterval = null;
      }
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
      usage: {
        bytesIn: this.usage.bytesIn,
        bytesOut: this.usage.bytesOut,
        durationMs: Date.now() - this.createdAt.getTime(),
      },
      clientCount: this.clients.size,
    };
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.instanceCounter = 0;
  }

  create({ name, cwd, autoAccept, initialPrompt, teamId, role, mcpConfigPath } = {}) {
    const id = uuidv4();
    this.instanceCounter++;
    const sessionName = name || `Instance ${this.instanceCounter}`;
    const session = new Session({ id, name: sessionName, cwd, autoAccept, initialPrompt, teamId, role, mcpConfigPath });
    this.sessions.set(id, session);
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
