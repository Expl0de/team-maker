import { v4 as uuidv4 } from "uuid";
import { writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import sessionManager from "./sessionManager.js";
import stateStore from "./stateStore.js";
import { buildOrchestratorPrompt, BUILTIN_ROLES } from "./promptBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = join(__dirname, "mcpServer.js");

class Team {
  constructor({ id, name, cwd, prompt, roles, sessionId, model, status }) {
    this.id = id;
    this.name = name;
    this.cwd = cwd;
    this.prompt = prompt;
    this.roles = roles;
    this.sessionId = sessionId;
    this.model = model || null; // team-level default model
    this.mainAgentId = null;
    this.agentIds = [];
    this.agentCounter = 0;
    this.createdAt = new Date();
    this.status = status || "running"; // "running" | "stopped"
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      prompt: this.prompt,
      roles: this.roles,
      mainAgentId: this.mainAgentId,
      agentIds: this.agentIds,
      createdAt: this.createdAt.toISOString(),
      status: this.status,
      model: this.model,
      sessionId: this.sessionId,
    };
  }
}

class TeamManager {
  constructor() {
    this.teams = new Map();
  }

  /**
   * Restore persisted teams from StateStore on startup.
   * Teams are restored as "stopped" since PTY processes don't survive restarts.
   */
  restoreFromState() {
    const persisted = stateStore.get("teams") || {};
    let count = 0;
    for (const [id, data] of Object.entries(persisted)) {
      const team = new Team({
        id,
        name: data.name,
        cwd: data.cwd,
        prompt: data.prompt,
        roles: data.roles || [],
        sessionId: data.sessionId,
        model: data.model,
        status: "stopped",
      });
      team.mainAgentId = data.mainAgentId || null;
      team.agentIds = []; // PTY sessions are gone — agents list is empty until re-launched
      team.agentCounter = data.agentCounter || 0;
      team.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
      this.teams.set(id, team);
      count++;
    }
    if (count > 0) {
      console.log(`[TeamManager] Restored ${count} team(s) from state`);
    }
  }

  _persistTeam(team) {
    stateStore.set(`teams.${team.id}`, {
      name: team.name,
      cwd: team.cwd,
      prompt: team.prompt,
      roles: team.roles,
      sessionId: team.sessionId,
      model: team.model,
      mainAgentId: team.mainAgentId,
      agentCounter: team.agentCounter,
      createdAt: team.createdAt.toISOString(),
    });
  }

  _unpersistTeam(teamId) {
    stateStore.delete(`teams.${teamId}`);
  }

  create({ name, cwd, prompt, roles, model }) {
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

    const team = new Team({ id, name, cwd, prompt, roles: teamRoles, sessionId, model });
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

    // Determine model for main agent: first role's model > team default
    const mainModel = (teamRoles[0] && teamRoles[0].model) || model || null;

    // Spawn main agent session first (without prompt) so we know its session ID
    const session = sessionManager.create({
      name,
      cwd,
      autoAccept: true,
      teamId: id,
      role: "main",
      mcpConfigPath,
      model: mainModel,
    });

    // Build orchestrator prompt with the session ID so sub-agents can message back
    const orchestratorPrompt = buildOrchestratorPrompt({
      teamName: name,
      sessionId,
      cwd: cwd || process.env.HOME,
      taskPrompt: prompt,
      roles: teamRoles,
      orchestratorSessionId: session.id,
    });

    // Inject the prompt now that we have the session ID embedded
    session._injectPrompt(orchestratorPrompt);

    team.mainAgentId = session.id;
    team.agentIds.push(session.id);
    team.status = "running";

    // Persist team definition
    this._persistTeam(team);

    return { team, session };
  }

  get(id) {
    return this.teams.get(id) || null;
  }

  list() {
    return Array.from(this.teams.values()).map((t) => t.toJSON());
  }

  addAgent({ teamId, name, prompt, model }) {
    const team = this.teams.get(teamId);
    if (!team) return null;

    // Use provided model, fall back to team-level default
    const agentModel = model || team.model || null;

    team.agentCounter++;
    const session = sessionManager.create({
      name,
      cwd: team.cwd,
      autoAccept: true,
      initialPrompt: prompt,
      teamId,
      role: "agent",
      agentIndex: team.agentCounter,
      model: agentModel,
    });

    team.agentIds.push(session.id);
    this._persistTeam(team);
    return session;
  }

  removeAgent(teamId, agentId) {
    const team = this.teams.get(teamId);
    if (!team) return false;

    const idx = team.agentIds.indexOf(agentId);
    if (idx === -1) return false;

    team.agentIds.splice(idx, 1);
    sessionManager.destroy(agentId);
    this._persistTeam(team);
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

  /**
   * Re-launch a stopped team. Spawns a new orchestrator with the same config.
   * Returns the team and new main agent session.
   */
  relaunch(teamId) {
    const team = this.teams.get(teamId);
    if (!team) return null;
    if (team.status === "running") return null;

    // Write MCP config for this team
    const mcpConfigPath = `/tmp/team-maker-mcp-${teamId}.json`;
    const port = process.env.PORT || 3456;
    const mcpConfig = {
      mcpServers: {
        "team-maker": {
          command: "node",
          args: [MCP_SERVER_PATH],
          env: { TEAM_ID: teamId, TEAM_MAKER_PORT: String(port) },
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    const mainModel = (team.roles[0] && team.roles[0].model) || team.model || null;

    // Spawn session first (without prompt) so we know its session ID
    const session = sessionManager.create({
      name: team.name,
      cwd: team.cwd,
      autoAccept: true,
      teamId,
      role: "main",
      mcpConfigPath,
      model: mainModel,
    });

    // Build orchestrator prompt with session ID so sub-agents can message back
    const orchestratorPrompt = buildOrchestratorPrompt({
      teamName: team.name,
      sessionId: team.sessionId,
      cwd: team.cwd || process.env.HOME,
      taskPrompt: team.prompt,
      roles: team.roles,
      orchestratorSessionId: session.id,
    });

    // Inject the prompt now
    session._injectPrompt(orchestratorPrompt);

    team.mainAgentId = session.id;
    team.agentIds = [session.id];
    team.status = "running";
    this._persistTeam(team);

    return { team, session };
  }

  destroy(teamId) {
    const team = this.teams.get(teamId);
    if (!team) return false;

    // Kill all agent sessions (only if running)
    for (const agentId of team.agentIds) {
      sessionManager.destroy(agentId);
    }

    // Clean up MCP config file
    try {
      unlinkSync(`/tmp/team-maker-mcp-${teamId}.json`);
    } catch {}

    this.teams.delete(teamId);
    this._unpersistTeam(teamId);
    return true;
  }
}

export default new TeamManager();
