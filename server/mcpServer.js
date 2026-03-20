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

// --- Task Board MCP Tools ---

server.tool(
  "create_task",
  "Create a new task on the team's task board. Use this to break down work into trackable units. Tasks can have dependencies on other tasks.",
  {
    title: z.string().describe("Short title for the task"),
    description: z.string().optional().describe("Detailed description of what needs to be done"),
    dependsOn: z.array(z.string()).optional().describe("Array of task IDs that must be completed before this task can be claimed"),
    fromAgentId: z.string().optional().describe("Your own session ID (for tracking who created the task)"),
  },
  async ({ title, description, dependsOn, fromAgentId }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, dependsOn, createdBy: fromAgentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Task created: "${data.task.title}" (ID: ${data.task.id})` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "claim_task",
  "Claim a pending task from the task board. The task must be pending and all its dependencies must be completed. After claiming, start working on it immediately.",
  {
    taskId: z.string().describe("The ID of the task to claim"),
    agentId: z.string().describe("Your own session ID"),
  },
  async ({ taskId, agentId }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/tasks/${taskId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Claimed task: "${data.task.title}" — now assigned to you. Start working on it.` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "complete_task",
  "Mark a task as completed with a result summary. Call this when you have finished the work for a task.",
  {
    taskId: z.string().describe("The ID of the task to complete"),
    agentId: z.string().describe("Your own session ID"),
    result: z.string().describe("Summary of what was accomplished"),
  },
  async ({ taskId, agentId, result }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/tasks/${taskId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, result }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Task completed: "${data.task.title}"` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "fail_task",
  "Mark a task as failed with a reason. This allows the orchestrator to reassign it to another agent.",
  {
    taskId: z.string().describe("The ID of the task that failed"),
    agentId: z.string().describe("Your own session ID"),
    reason: z.string().describe("Why the task failed"),
  },
  async ({ taskId, agentId, reason }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/tasks/${taskId}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Task failed: "${data.task.title}" — reason: ${reason}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_tasks",
  "Get the current task board for your team. Shows all tasks with their status, assignee, and dependencies. Optionally filter by status or assignee.",
  {
    status: z.string().optional().describe("Filter by status: pending, assigned, in_progress, completed, failed"),
    assignedTo: z.string().optional().describe("Filter by assigned agent's session ID"),
  },
  async ({ status, assignedTo }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (assignedTo) params.set("assignedTo", assignedTo);
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/tasks?${params}`);
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      if (data.tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks on the board." }] };
      }
      const formatted = data.tasks.map((t) => {
        const deps = t.dependsOn.length > 0 ? ` (depends on: ${t.dependsOn.join(", ")})` : "";
        const assignee = t.assignedToName ? ` → ${t.assignedToName}` : "";
        const result = t.result ? `\n  Result: ${t.result}` : "";
        const fail = t.failReason ? `\n  Reason: ${t.failReason}` : "";
        return `[${t.status.toUpperCase()}] ${t.title} (${t.id})${assignee}${deps}${result}${fail}\n  ${t.description || "(no description)"}`;
      }).join("\n\n");
      return {
        content: [{ type: "text", text: `${data.tasks.length} task(s):\n\n${formatted}\n\nSummary: ${JSON.stringify(data.summary)}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
