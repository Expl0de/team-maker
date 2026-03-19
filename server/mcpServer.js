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
  "Send a message to another agent. The message is queued server-side and also delivered instantly via PTY injection. The recipient can retrieve it later with check_inbox.",
  {
    agentId: z.string().describe("The session ID of the agent to message"),
    message: z.string().describe("The text to send to the agent"),
    fromAgentId: z.string().optional().describe("Your own session ID (for message tracking). Use list_agents to find it if needed."),
  },
  async ({ agentId, message, fromAgentId }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromAgentId || "unknown", to: agentId, message, teamId: TEAM_ID }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Message sent to ${data.toName || agentId} (queued as ${data.messageId})` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "check_inbox",
  "Check your inbox for unread messages from other agents. Returns only unread messages with their IDs. Use mark_read to acknowledge messages after processing them.",
  {
    agentId: z.string().describe("Your own session ID. Use list_agents to find it if needed."),
  },
  async ({ agentId }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/messages/inbox?agentId=${encodeURIComponent(agentId)}`);
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      if (data.messages.length === 0) {
        return { content: [{ type: "text", text: "No unread messages." }] };
      }
      const formatted = data.messages.map((m) =>
        `[${m.id}] From ${m.fromName} (${m.timestamp}):\n${m.content}`
      ).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `${data.messages.length} unread message(s):\n\n${formatted}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "mark_read",
  "Mark one or more messages as read after processing them. Pass a single message ID or 'all' to mark all unread messages as read.",
  {
    messageId: z.string().describe("The message ID to mark as read, or 'all' to mark all unread messages"),
    agentId: z.string().optional().describe("Your own session ID (required when using 'all')"),
  },
  async ({ messageId, agentId }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/messages/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, agentId, teamId: TEAM_ID }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: data.message }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
