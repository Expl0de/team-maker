import pty from "node-pty";
import { v4 as uuidv4 } from "uuid";

const MAX_SCROLLBACK = 100 * 1024; // 100KB

class Session {
  constructor({ id, name, cwd, autoAccept, initialPrompt }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.status = "running";
    this.exitCode = null;
    this.createdAt = new Date();
    this.scrollback = "";
    this.clients = new Set();
    this.usage = { bytesIn: 0, bytesOut: 0 };

    const claudePath = process.env.CLAUDE_PATH || "/Users/tung/.local/bin/claude";
    const args = [];
    if (autoAccept) args.push("--permission-mode", "auto");

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

    this.pty.onData((data) => {
      this.usage.bytesOut += data.length;
      this.scrollback += data;
      if (this.scrollback.length > MAX_SCROLLBACK) {
        this.scrollback = this.scrollback.slice(-MAX_SCROLLBACK);
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
    // for the CLI to finish startup before typing the prompt
    setTimeout(() => {
      if (this.status === "running") {
        this.pty.write(prompt + "\r");
      }
    }, 5000);
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

  kill() {
    if (this.status === "running") {
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

  create({ name, cwd, autoAccept, initialPrompt } = {}) {
    const id = uuidv4();
    this.instanceCounter++;
    const sessionName = name || `Instance ${this.instanceCounter}`;
    const session = new Session({ id, name: sessionName, cwd, autoAccept, initialPrompt });
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
