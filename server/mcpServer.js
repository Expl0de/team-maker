import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TEAM_ID = process.env.TEAM_ID;
const PORT = process.env.TEAM_MAKER_PORT || "3456";
const BASE_URL = `http://localhost:${PORT}`;

if (!TEAM_ID) {
  console.error("TEAM_ID environment variable is required");
  process.exit(1);
}

const server = new McpServer({
  name: "team-maker",
  version: "1.0.0",
});

server.tool(
  "spawn_agent",
  "Spawn a new agent in your team",
  {
    name: z.string().describe("Name for the new agent"),
    prompt: z.string().describe("Task/prompt for the new agent"),
  },
  async ({ name, prompt }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Agent "${data.name}" spawned with ID: ${data.id}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_agents",
  "List all agents in your team",
  {},
  async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/agents`);
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      const summary = data.map((a) => `- ${a.name} (${a.id}) [${a.status}] role=${a.role || "agent"}`).join("\n");
      return {
        content: [{ type: "text", text: summary || "No agents in team." }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "send_message",
  "Send a message directly to another agent (delivered instantly via PTY injection — primary communication channel)",
  {
    agentId: z.string().describe("The session ID of the agent to message"),
    message: z.string().describe("The text to send to the agent"),
  },
  async ({ agentId, message }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/sessions/${agentId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Message sent to agent ${agentId}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
