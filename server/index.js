import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import sessionManager from "./sessionManager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

// Browse for folder using native macOS Finder dialog
app.get("/api/browse-folder", async (req, res) => {
  const { execFile } = await import("child_process");
  const script = `
    set chosenFolder to choose folder with prompt "Choose working directory for Claude Code"
    return POSIX path of chosenFolder
  `;
  execFile("osascript", ["-e", script], { timeout: 60000 }, (err, stdout) => {
    if (err) {
      return res.json({ cancelled: true });
    }
    res.json({ path: stdout.trim() });
  });
});

// REST API
app.post("/api/sessions", (req, res) => {
  const { name, cwd } = req.body || {};
  const session = sessionManager.create({ name, cwd });
  res.json(session.toJSON());
});

app.get("/api/sessions", (req, res) => {
  res.json(sessionManager.list());
});

app.get("/api/sessions/:id", (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session.toJSON());
});

app.delete("/api/sessions/:id", (req, res) => {
  const destroyed = sessionManager.destroy(req.params.id);
  if (!destroyed) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

app.post("/api/sessions/:id/resize", (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const { cols, rows } = req.body;
  session.resize(cols, rows);
  res.json({ ok: true });
});

// WebSocket
wss.on("connection", (ws) => {
  let attachedSession = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Raw terminal input
      if (attachedSession) {
        attachedSession.write(raw.toString());
      }
      return;
    }

    switch (msg.type) {
      case "attach": {
        const session = sessionManager.get(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
          return;
        }
        attachedSession = session;
        session.addClient(ws);
        // Send scrollback buffer
        if (session.scrollback) {
          ws.send(session.scrollback);
        }
        ws.send(JSON.stringify({ type: "attached", sessionId: session.id }));
        break;
      }
      case "resize": {
        if (attachedSession) {
          attachedSession.resize(msg.cols, msg.rows);
        }
        break;
      }
      case "input": {
        if (attachedSession) {
          attachedSession.write(msg.data);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (attachedSession) {
      attachedSession.removeClient(ws);
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`Team Maker running at http://localhost:${PORT}`);
});
