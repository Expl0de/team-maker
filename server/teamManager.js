import { v4 as uuidv4 } from "uuid";
import { writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import sessionManager from "./sessionManager.js";
import { buildOrchestratorPrompt, BUILTIN_ROLES } from "./promptBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = join(__dirname, "mcpServer.js");

class Team {
  constructor({ id, name, cwd, prompt, roles, wakeInterval, sessionId }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.prompt = prompt;
    this.roles = roles;
    this.wakeInterval = wakeInterval;
    this.sessionId = sessionId;
    this.mainAgentId = null;
    this.agentIds = [];
    this.agentCounter = 0;
    this.createdAt = new Date();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      prompt: this.prompt,
      roles: this.roles,
      wakeInterval: this.wakeInterval,
      mainAgentId: this.mainAgentId,
      agentIds: this.agentIds,
      createdAt: this.createdAt.toISOString(),
    };
  }
}

class TeamManager {
  constructor() {
    this.teams = new Map();
  }

  create({ name, cwd, prompt, roles, wakeInterval = 60 }) {
    const id = uuidv4();

    // Use provided roles or default built-in roles
    const teamRoles = roles && roles.length > 0 ? roles : [...BUILTIN_ROLES];

    // Generate a timestamp-based session ID for directory naming
    const now = new Date();
    const sessionId = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");

    const team = new Team({ id, name, cwd, prompt, roles: teamRoles, wakeInterval, sessionId });
    this.teams.set(id, team);

    // Write MCP config for this team
    const mcpConfigPath = `/tmp/team-maker-mcp-${id}.json`;
    const port = process.env.PORT || 3456;
    const mcpConfig = {
      mcpServers: {
        "team-maker": {
          command: "node",
          args: [MCP_SERVER_PATH],
          env: { TEAM_ID: id, TEAM_MAKER_PORT: String(port) },
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Build comprehensive orchestrator prompt
    const orchestratorPrompt = buildOrchestratorPrompt({
      teamName: name,
      sessionId,
      cwd: cwd || process.env.HOME,
      taskPrompt: prompt,
      roles: teamRoles,
      wakeInterval,
    });

    // Spawn main agent session
    const session = sessionManager.create({
      name,
      cwd,
      autoAccept: true,
      initialPrompt: orchestratorPrompt,
      teamId: id,
      role: "main",
      mcpConfigPath,
      wakeInterval,
    });

    team.mainAgentId = session.id;
    team.agentIds.push(session.id);

    return { team, session };
  }

  get(id) {
    return this.teams.get(id) || null;
  }

  list() {
    return Array.from(this.teams.values()).map((t) => t.toJSON());
  }

  addAgent({ teamId, name, prompt }) {
    const team = this.teams.get(teamId);
    if (!team) return null;

    team.agentCounter++;
    const session = sessionManager.create({
      name,
      cwd: team.cwd,
      autoAccept: true,
      initialPrompt: prompt,
      teamId,
      role: "agent",
      agentIndex: team.agentCounter,
    });

    team.agentIds.push(session.id);
    return session;
  }

  removeAgent(teamId, agentId) {
    const team = this.teams.get(teamId);
    if (!team) return false;

    const idx = team.agentIds.indexOf(agentId);
    if (idx === -1) return false;

    team.agentIds.splice(idx, 1);
    sessionManager.destroy(agentId);
    return true;
  }

  getAgents(teamId) {
    const team = this.teams.get(teamId);
    if (!team) return null;

    return team.agentIds.map((id) => {
      const session = sessionManager.get(id);
      return session ? session.toJSON() : { id, status: "unknown" };
    });
  }

  destroy(teamId) {
    const team = this.teams.get(teamId);
    if (!team) return false;

    // Kill all agent sessions
    for (const agentId of team.agentIds) {
      sessionManager.destroy(agentId);
    }

    // Clean up MCP config file
    try {
      unlinkSync(`/tmp/team-maker-mcp-${teamId}.json`);
    } catch {}

    this.teams.delete(teamId);
    return true;
  }
}

export default new TeamManager();
