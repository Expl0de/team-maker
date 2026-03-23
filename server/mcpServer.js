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
  "Spawn a new agent in your team. If smart model routing is enabled, pass taskComplexity to auto-select the model based on the team's routing table (low=Haiku, medium=Sonnet, high=Opus by default).",
  {
    name: z.string().describe("Name for the new agent"),
    prompt: z.string().describe("Task/prompt for the new agent"),
    model: z.string().optional().describe("Override model for this agent (e.g. 'claude-sonnet-4-6'). If omitted and taskComplexity is set, the model is auto-selected from the team's routing table."),
    taskComplexity: z.enum(["low", "medium", "high"]).optional().describe("Task complexity level for smart model routing. low=coordination/simple tasks, medium=standard coding, high=architecture/complex debugging."),
  },
  async ({ name, prompt, model, taskComplexity }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, model, taskComplexity }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      const modelInfo = data.model ? ` (model: ${data.model})` : "";
      return {
        content: [{ type: "text", text: `Agent "${data.name}" spawned with ID: ${data.id}${modelInfo}` }],
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
  "Create a new task on the team's task board. Use this to break down work into trackable units. Tasks can have dependencies on other tasks. Set complexity for smart model routing: low=coordination/status checks, medium=standard coding, high=architecture/complex debugging.",
  {
    title: z.string().describe("Short title for the task"),
    description: z.string().optional().describe("Detailed description of what needs to be done"),
    complexity: z.enum(["low", "medium", "high"]).optional().describe("Task complexity for smart model routing. low=coordination/simple reads, medium=standard coding/reviews, high=architecture/complex debugging/multi-file refactors. Defaults to medium."),
    dependsOn: z.array(z.string()).optional().describe("Array of task IDs that must be completed before this task can be claimed"),
    fromAgentId: z.string().optional().describe("Your own session ID (for tracking who created the task)"),
  },
  async ({ title, description, complexity, dependsOn, fromAgentId }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, complexity, dependsOn, createdBy: fromAgentId }),
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
        const complexity = t.complexity ? ` [${t.complexity}]` : "";
        const result = t.result ? `\n  Result: ${t.result}` : "";
        const fail = t.failReason ? `\n  Reason: ${t.failReason}` : "";
        return `[${t.status.toUpperCase()}]${complexity} ${t.title} (${t.id})${assignee}${deps}${result}${fail}\n  ${t.description || "(no description)"}`;
      }).join("\n\n");
      return {
        content: [{ type: "text", text: `${data.tasks.length} task(s):\n\n${formatted}\n\nSummary: ${JSON.stringify(data.summary)}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Shared Context Store MCP Tools ---

server.tool(
  "store_context",
  "Store a piece of knowledge in the team's shared context store. Use this after reading or analyzing project files so other agents don't have to repeat the work. The key should be descriptive (e.g., 'package.json-deps', 'src-architecture', 'auth-flow').",
  {
    key: z.string().describe("A descriptive key for this context entry (e.g., 'package.json-deps', 'api-routes')"),
    content: z.string().describe("The content to store — file summaries, analysis results, architecture notes, etc."),
    summary: z.string().optional().describe("A one-line summary of what this context contains (for discovery via list_context)"),
    fromAgentId: z.string().optional().describe("Your own session ID (for tracking who stored the context)"),
  },
  async ({ key, content, summary, fromAgentId }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, content, summary, storedBy: fromAgentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Context stored: "${key}" (~${data.entry.tokens} tokens). Other agents can find it with list_context() or query_context("${key}").` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "query_context",
  "Search the team's shared context store by keywords. Returns matching entries with full content. Use this BEFORE reading project files to check if another agent already analyzed them.",
  {
    query: z.string().describe("Keywords to search for in context keys and summaries"),
  },
  async ({ query }) => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/context/query?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      if (data.results.length === 0) {
        return { content: [{ type: "text", text: `No context found matching "${query}". You may need to read the files yourself.` }] };
      }
      const formatted = data.results.map((r) =>
        `### ${r.key} (score: ${r.score}, by ${r.storedByName || "unknown"})\n${r.content}`
      ).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `Found ${data.results.length} result(s):\n\n${formatted}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_context",
  "List all entries in the team's shared context store. Shows keys, summaries, and who stored each entry. Use this to discover what knowledge is already available before doing redundant work.",
  {},
  async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/teams/${TEAM_ID}/context`);
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      if (data.entries.length === 0) {
        return { content: [{ type: "text", text: "No shared context stored yet. Use store_context() to share knowledge with the team." }] };
      }
      const formatted = data.entries.map((e) =>
        `- **${e.key}** (~${e.tokens} tokens, by ${e.storedByName || "unknown"}, accessed ${e.accessCount}x)\n  ${e.summary || "(no summary)"}`
      ).join("\n");
      return {
        content: [{ type: "text", text: `${data.entries.length} shared context entries:\n\n${formatted}\n\nUse query_context("keyword") to retrieve full content.` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
