import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import sessionManager from "./sessionManager.js";
import teamManager from "./teamManager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

// Global set of all connected WebSocket clients for broadcasting
const allWsClients = new Set();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of allWsClients) {
    try {
      ws.send(payload);
    } catch {}
  }
}

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
  const { name, cwd, autoAccept, initialPrompt } = req.body || {};
  const session = sessionManager.create({ name, cwd, autoAccept, initialPrompt });
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

// Input injection (used by MCP send_message tool)
app.post("/api/sessions/:id/input", (req, res) => {
  const session = sessionManager.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  session.injectInput(text + "\r");
  res.json({ ok: true });
});

// Team API
app.post("/api/teams", (req, res) => {
  const { name, cwd, prompt } = req.body || {};
  if (!name || !prompt) return res.status(400).json({ error: "name and prompt are required" });
  const { team, session } = teamManager.create({ name, cwd, prompt });
  broadcast({ type: "team-update", teamId: team.id, event: "team-created", team: team.toJSON(), agent: session.toJSON() });
  res.json({ team: team.toJSON(), mainAgent: session.toJSON() });
});

app.get("/api/teams", (req, res) => {
  res.json(teamManager.list());
});

app.get("/api/teams/:teamId", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });
  res.json(team.toJSON());
});

app.delete("/api/teams/:teamId", (req, res) => {
  const destroyed = teamManager.destroy(req.params.teamId);
  if (!destroyed) return res.status(404).json({ error: "Team not found" });
  broadcast({ type: "team-update", teamId: req.params.teamId, event: "team-deleted" });
  res.json({ ok: true });
});

app.post("/api/teams/:teamId/agents", (req, res) => {
  const { name, prompt } = req.body || {};
  if (!name || !prompt) return res.status(400).json({ error: "name and prompt are required" });
  const session = teamManager.addAgent({ teamId: req.params.teamId, name, prompt });
  if (!session) return res.status(404).json({ error: "Team not found" });
  broadcast({ type: "team-update", teamId: req.params.teamId, event: "agent-added", agent: session.toJSON() });
  res.json(session.toJSON());
});

app.get("/api/teams/:teamId/agents", (req, res) => {
  const agents = teamManager.getAgents(req.params.teamId);
  if (!agents) return res.status(404).json({ error: "Team not found" });
  res.json(agents);
});

app.delete("/api/teams/:teamId/agents/:agentId", (req, res) => {
  const removed = teamManager.removeAgent(req.params.teamId, req.params.agentId);
  if (!removed) return res.status(404).json({ error: "Agent not found" });
  broadcast({ type: "team-update", teamId: req.params.teamId, event: "agent-removed", agentId: req.params.agentId });
  res.json({ ok: true });
});

// WebSocket
wss.on("connection", (ws) => {
  allWsClients.add(ws);
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
        // Send current activity state so the client shows the correct indicator
        ws.send(JSON.stringify({ type: "activity", sessionId: session.id, active: session._active }));
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
    allWsClients.delete(ws);
    if (attachedSession) {
      attachedSession.removeClient(ws);
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`Team Maker running at http://localhost:${PORT}`);
});
