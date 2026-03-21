import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join, resolve, relative } from "path";
import { readFile } from "fs/promises";
import { execFile } from "child_process";
import sessionManager from "./sessionManager.js";
import teamManager from "./teamManager.js";
import stateStore from "./stateStore.js";
import * as templateStore from "./templateStore.js";
import messageQueue from "./messageQueue.js";
import taskBoard from "./taskBoard.js";
import contextStore from "./contextStore.js";
import { BUILTIN_ROLES, EXTRA_ROLES } from "./promptBuilder.js";

// Initialize persistence layer
stateStore.load();
templateStore.migrateFromLegacy();
teamManager.restoreFromState();
messageQueue.restoreFromState();
taskBoard.restoreFromState();
contextStore.restoreFromState();

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
  const { name, cwd, autoAccept, initialPrompt, model } = req.body || {};
  const session = sessionManager.create({ name, cwd, autoAccept, initialPrompt, model });
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

// Template API
app.get("/api/templates", (req, res) => {
  res.json(templateStore.loadAll());
});

app.post("/api/templates", (req, res) => {
  const { name, roles } = req.body || {};
  if (!name || !roles) return res.status(400).json({ error: "name and roles are required" });
  const template = templateStore.save({ name, roles });
  res.json(template);
});

app.delete("/api/templates/:id", (req, res) => {
  const removed = templateStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: "Template not found" });
  res.json({ ok: true });
});

// Built-in roles for quick-add
app.get("/api/builtin-roles", (req, res) => {
  res.json({ builtin: BUILTIN_ROLES, extra: EXTRA_ROLES });
});

// Team API
app.post("/api/teams", (req, res) => {
  const { name, cwd, prompt, roles, model, modelRouting } = req.body || {};
  if (!name || !prompt) return res.status(400).json({ error: "name and prompt are required" });
  const { team, session } = teamManager.create({ name, cwd, prompt, roles, model, modelRouting });
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
  messageQueue.clearTeam(req.params.teamId);
  taskBoard.clearTeam(req.params.teamId);
  contextStore.clearTeam(req.params.teamId);
  stateStore.delete(`files.${req.params.teamId}`);
  broadcast({ type: "team-update", teamId: req.params.teamId, event: "team-deleted" });
  res.json({ ok: true });
});

app.post("/api/teams/:teamId/relaunch", (req, res) => {
  const result = teamManager.relaunch(req.params.teamId);
  if (!result) return res.status(404).json({ error: "Team not found or already running" });
  const { team, session } = result;
  broadcast({ type: "team-update", teamId: team.id, event: "team-relaunched", team: team.toJSON(), agent: session.toJSON() });
  res.json({ team: team.toJSON(), mainAgent: session.toJSON() });
});

// Model routing configuration
app.get("/api/teams/:teamId/model-routing", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });
  res.json({
    modelRouting: team.modelRouting,
    defaults: { low: "claude-haiku-4-5-20251001", medium: "claude-sonnet-4-6", high: "claude-opus-4-6" },
  });
});

app.put("/api/teams/:teamId/model-routing", (req, res) => {
  const { modelRouting } = req.body || {};
  if (!modelRouting) return res.status(400).json({ error: "modelRouting is required" });
  const team = teamManager.updateModelRouting(req.params.teamId, modelRouting);
  if (!team) return res.status(404).json({ error: "Team not found" });
  broadcast({ type: "team-update", teamId: req.params.teamId, event: "model-routing-updated", modelRouting: team.modelRouting });
  res.json({ ok: true, modelRouting: team.modelRouting });
});

app.post("/api/teams/:teamId/agents", (req, res) => {
  const { name, prompt, model, taskComplexity } = req.body || {};
  if (!name || !prompt) return res.status(400).json({ error: "name and prompt are required" });
  const session = teamManager.addAgent({ teamId: req.params.teamId, name, prompt, model, taskComplexity });
  if (!session) return res.status(404).json({ error: "Team not found" });
  broadcast({ type: "team-update", teamId: req.params.teamId, event: "agent-added", agent: session.toJSON() });
  res.json(session.toJSON());
});

app.get("/api/teams/:teamId/usage", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });
  const agents = teamManager.getAgents(req.params.teamId);
  const agentUsage = agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    agentIndex: a.agentIndex,
    status: a.status,
    usage: a.usage,
    tokenUsage: a.tokenUsage,
  }));
  // Compute team totals
  const totals = {
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    totalTokens: 0, bytesIn: 0, bytesOut: 0, durationMs: 0,
  };
  for (const a of agentUsage) {
    totals.inputTokens += a.tokenUsage.inputTokens;
    totals.outputTokens += a.tokenUsage.outputTokens;
    totals.cacheRead += a.tokenUsage.cacheRead;
    totals.cacheWrite += a.tokenUsage.cacheWrite;
    totals.cost += a.tokenUsage.cost;
    totals.totalTokens += a.tokenUsage.totalTokens || 0;
    totals.bytesIn += a.usage.bytesIn;
    totals.bytesOut += a.usage.bytesOut;
    if (a.usage.durationMs > totals.durationMs) totals.durationMs = a.usage.durationMs;
  }
  res.json({ team: team.toJSON(), agents: agentUsage, totals });
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

// Message Queue API (used by MCP tools)

// Send a message: enqueue + PTY inject for instant delivery
app.post("/api/messages/send", (req, res) => {
  const { from, to, message, teamId } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: "to and message are required" });

  const toSession = sessionManager.get(to);
  if (!toSession) return res.status(404).json({ error: "Recipient agent not found" });

  const fromName = from ? (sessionManager.get(from)?.name || from) : "unknown";
  const toName = toSession.name || to;

  const msg = messageQueue.enqueue(from || "unknown", to, message, { fromName, toName, teamId });

  // Also inject into PTY for instant delivery (the original send_message behavior)
  // Write text first, then send Enter after a delay so the CLI TUI can process the paste
  const prefix = `\n📨 Message from ${fromName}:\n`;
  toSession.injectInput(prefix + message);
  setTimeout(() => {
    toSession.injectInput("\r");
  }, 300);

  res.json({ ok: true, messageId: msg.id, toName });
});

// Check inbox: get unread messages for the calling agent
app.get("/api/messages/inbox", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.json({ messages: [] });

  const messages = messageQueue.getUnread(agentId);
  res.json({
    messages: messages.map((m) => ({
      id: m.id,
      from: m.from,
      fromName: m.fromName,
      content: m.content,
      timestamp: m.timestamp,
    })),
  });
});

// Mark messages as read
app.post("/api/messages/read", (req, res) => {
  const { messageId, agentId } = req.body || {};
  if (!messageId) return res.status(400).json({ error: "messageId is required" });

  if (messageId === "all") {
    if (!agentId) return res.status(400).json({ error: "agentId is required for mark-all" });
    const count = messageQueue.markAllRead(agentId);
    return res.json({ ok: true, message: `Marked ${count} message(s) as read` });
  }

  const success = messageQueue.markRead(messageId);
  if (!success) return res.status(404).json({ error: "Message not found" });
  res.json({ ok: true, message: `Message ${messageId} marked as read` });
});

// Get message history for a team (used by frontend)
app.get("/api/teams/:teamId/messages", (req, res) => {
  const messages = messageQueue.getTeamMessages(req.params.teamId);
  res.json(messages);
});

// --- Agent Events API (AP3: structured JSONL events) ---

// Get structured agent events for a team
app.get("/api/teams/:teamId/events", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const agents = teamManager.getAgents(req.params.teamId);
  if (!agents) return res.json({ events: [] });

  // Collect events from all agent sessions in this team
  const allEvents = [];
  for (const agentData of agents) {
    const session = sessionManager.get(agentData.id);
    if (session && session.getEvents) {
      allEvents.push(...session.getEvents());
    }
  }

  // Sort by timestamp and apply optional filters
  allEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const { type, sessionId, limit } = req.query;
  let filtered = allEvents;
  if (type) filtered = filtered.filter((e) => e.type === type);
  if (sessionId) filtered = filtered.filter((e) => e.sessionId === sessionId);
  if (limit) filtered = filtered.slice(-parseInt(limit, 10));

  res.json({ events: filtered });
});

// --- Files API (file browser panel) ---

// Get files touched by agents (Write/Edit tool calls from JSONL events)
app.get("/api/teams/:teamId/files", (req, res) => {
  const teamId = req.params.teamId;
  const team = teamManager.get(teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const agents = teamManager.getAgents(teamId);

  // Collect Write/Edit tool_call events from all live agents
  const fileMap = new Map(); // file_path -> { path, agent, operation, timestamp }
  if (agents) {
    for (const agentData of agents) {
      const session = sessionManager.get(agentData.id);
      if (!session || !session.getEvents) continue;
      for (const event of session.getEvents()) {
        if (event.type !== "tool_call") continue;
        if (event.toolName !== "Write" && event.toolName !== "Edit") continue;
        const filePath = event.input?.file_path;
        if (!filePath) continue;

        const existing = fileMap.get(filePath);
        const operation = event.toolName === "Write" ? "created" : "edited";
        if (!existing || new Date(event.timestamp) > new Date(existing.timestamp)) {
          fileMap.set(filePath, {
            path: filePath,
            relativePath: filePath.startsWith(team.cwd)
              ? relative(team.cwd, filePath) || filePath
              : filePath,
            agentName: event.sessionName || agentData.name,
            sessionId: event.sessionId,
            operation: existing ? "edited" : operation,
            timestamp: event.timestamp,
          });
        }
      }
    }
  }

  // Merge with persisted files (persisted data fills gaps for agents no longer running)
  const persisted = stateStore.get(`files.${teamId}`) || {};
  for (const [path, entry] of Object.entries(persisted)) {
    if (!fileMap.has(path)) {
      fileMap.set(path, entry);
    }
  }

  const files = Array.from(fileMap.values()).sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  // Persist current file entries to stateStore for restore after restart
  if (files.length > 0) {
    const toStore = {};
    for (const f of files) {
      toStore[f.path] = f;
    }
    stateStore.set(`files.${teamId}`, toStore);
  }

  res.json({ files });
});

// Read a file's content (with path traversal protection)
app.get("/api/teams/:teamId/files/read", async (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "path parameter required" });

  // Validate the path is within the team's working directory
  const resolved = resolve(filePath);
  const teamCwd = resolve(team.cwd);
  if (!resolved.startsWith(teamCwd)) {
    return res.status(403).json({ error: "Access denied: path outside team directory" });
  }

  try {
    const content = await readFile(resolved, "utf-8");
    res.json({ path: filePath, content });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "File not found" });
    }
    res.status(500).json({ error: "Failed to read file" });
  }
});

// --- Task Board API ---

// Create a task
app.post("/api/teams/:teamId/tasks", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const { title, description, complexity, dependsOn, createdBy } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });

  const createdByName = createdBy ? (sessionManager.get(createdBy)?.name || createdBy) : null;
  const task = taskBoard.createTask({
    title,
    description,
    complexity,
    dependsOn,
    createdBy,
    createdByName,
    teamId: req.params.teamId,
  });
  res.json({ task });
});

// Get tasks for a team (with optional filters)
app.get("/api/teams/:teamId/tasks", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;

  const tasks = taskBoard.getTeamTasks(req.params.teamId, Object.keys(filter).length > 0 ? filter : null);
  const summary = taskBoard.getBoardSummary(req.params.teamId);
  res.json({ tasks, summary });
});

// Claim a task
app.post("/api/teams/:teamId/tasks/:taskId/claim", (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId) return res.status(400).json({ error: "agentId is required" });

  const agentName = sessionManager.get(agentId)?.name || agentId;
  const result = taskBoard.claimTask(req.params.taskId, agentId, agentName);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ task: result.task });
});

// Complete a task
app.post("/api/teams/:teamId/tasks/:taskId/complete", (req, res) => {
  const { agentId, result } = req.body || {};
  if (!agentId) return res.status(400).json({ error: "agentId is required" });

  const out = taskBoard.completeTask(req.params.taskId, agentId, result);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ task: out.task });
});

// Fail a task
app.post("/api/teams/:teamId/tasks/:taskId/fail", (req, res) => {
  const { agentId, reason } = req.body || {};
  if (!agentId) return res.status(400).json({ error: "agentId is required" });

  const out = taskBoard.failTask(req.params.taskId, agentId, reason);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ task: out.task });
});

// Retry a failed task (reset to pending)
app.post("/api/teams/:teamId/tasks/:taskId/retry", (req, res) => {
  const out = taskBoard.retryTask(req.params.taskId);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ task: out.task });
});

// --- Shared Context Store API ---

// Store a context entry
app.post("/api/teams/:teamId/context", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const { key, content, summary, storedBy } = req.body || {};
  if (!key || !content) return res.status(400).json({ error: "key and content are required" });

  const storedByName = storedBy ? (sessionManager.get(storedBy)?.name || storedBy) : null;
  const entry = contextStore.store(key, content, summary, {
    storedBy,
    storedByName,
    teamId: req.params.teamId,
  });
  res.json({ entry });
});

// List all context entries (keys + summaries, no full content)
app.get("/api/teams/:teamId/context", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const entries = contextStore.list({ teamId: req.params.teamId });
  const stats = contextStore.getStats(req.params.teamId);
  res.json({ entries, stats });
});

// Query context by keywords (returns full content)
app.get("/api/teams/:teamId/context/query", (req, res) => {
  const team = teamManager.get(req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q parameter is required" });

  const results = contextStore.query(q, { teamId: req.params.teamId });
  res.json({ results });
});

// Get a single context entry by key
app.get("/api/teams/:teamId/context/:key", (req, res) => {
  const entry = contextStore.get(req.params.key);
  if (!entry || entry.teamId !== req.params.teamId) {
    return res.status(404).json({ error: "Context entry not found" });
  }
  res.json({ entry });
});

// Delete a context entry
app.delete("/api/teams/:teamId/context/:key", (req, res) => {
  const deleted = contextStore.invalidate(req.params.key);
  if (!deleted) return res.status(404).json({ error: "Context entry not found" });
  res.json({ ok: true });
});

// Broadcast agent events (JSONL-sourced) over WebSocket for real-time UI updates
sessionManager.onAgentEvent((event) => {
  // Only broadcast events for team agents (not standalone sessions)
  if (!event.teamId) return;
  broadcast({
    type: "agent-event",
    teamId: event.teamId,
    event,
  });
});

// Broadcast idle events (warning/kill) over WebSocket for real-time UI updates
sessionManager.onIdleEvent((event) => {
  if (!event.teamId) return;
  broadcast({
    type: "agent-idle",
    teamId: event.teamId,
    event,
  });

  // If agent was killed, remove it from the team's agent list
  if (event.type === "agent_idle_killed") {
    const team = teamManager.get(event.teamId);
    if (team) {
      const idx = team.agentIds.indexOf(event.sessionId);
      if (idx !== -1) {
        team.agentIds.splice(idx, 1);
        teamManager._persistTeam(team);
      }
    }
  }
});

// Broadcast task events over WebSocket for real-time UI updates
taskBoard.onTaskEvent((event, task) => {
  broadcast({
    type: "team-task",
    teamId: task.teamId,
    event,
    task,
  });
});

// Broadcast context store events over WebSocket for real-time UI updates
contextStore.onContextEvent((event, data) => {
  if (data && data.teamId) {
    broadcast({
      type: "team-context",
      teamId: data.teamId,
      event,
      entry: {
        key: data.key,
        summary: data.summary,
        storedByName: data.storedByName,
        tokens: data.tokens,
        accessCount: data.accessCount,
        lastUpdated: data.lastUpdated,
      },
    });
  }
});

// Broadcast new messages over WebSocket for real-time UI updates
messageQueue.onMessage((msg) => {
  broadcast({
    type: "team-message",
    teamId: msg.teamId,
    message: {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      fromName: msg.fromName,
      toName: msg.toName,
      content: msg.content,
      timestamp: msg.timestamp,
    },
  });
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

// Flush state to disk on shutdown so debounced writes aren't lost
function onShutdown() {
  console.log("[Server] Shutting down, flushing state...");
  // Mark all running teams as stopped
  for (const team of teamManager.list()) {
    if (team.status === "running") {
      const t = teamManager.get(team.id);
      if (t) t.status = "stopped";
      stateStore.set(`teams.${team.id}`, {
        name: team.name,
        cwd: team.cwd,
        prompt: team.prompt,
        roles: team.roles,
        sessionId: team.sessionId,
        model: team.model,
        modelRouting: team.modelRouting,
        mainAgentId: team.mainAgentId,
        agentCounter: t?.agentCounter || 0,
        createdAt: team.createdAt,
      });
    }
  }
  stateStore.saveNow();
  process.exit(0);
}
process.on("SIGINT", onShutdown);
process.on("SIGTERM", onShutdown);
