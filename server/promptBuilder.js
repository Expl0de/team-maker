// Built-in role definitions
export const BUILTIN_ROLES = [
  { id: "architect", title: "Architect", responsibility: "Research & Planning", description: "System exploration, requirements analysis, architecture planning, design documents. Focus: Understanding the big picture and creating the roadmap." },
  { id: "builder", title: "Builder", responsibility: "Core Implementation", description: "Feature development, main implementation work, core functionality. Focus: Building the actual solution based on plans." },
  { id: "validator", title: "Validator", responsibility: "Testing & Validation", description: "Writing tests, validation scripts, debugging, quality assurance. Focus: Ensuring code quality and catching issues early." },
  { id: "scribe", title: "Scribe", responsibility: "Documentation & Refinement", description: "Documentation creation, code refinement, usage guides, examples. Focus: Making the work understandable and maintainable." },
];

// Additional quick-add roles
export const EXTRA_ROLES = [
  { id: "devops", title: "DevOps", responsibility: "Infrastructure & Deployment", description: "CI/CD pipelines, deployment scripts, containerization, monitoring. Focus: Reliable infrastructure and automated workflows." },
  { id: "security", title: "Security Auditor", responsibility: "Security & Compliance", description: "Security review, vulnerability scanning, access control, compliance checks. Focus: Identifying and mitigating security risks." },
  { id: "designer", title: "Designer", responsibility: "UI/UX Design", description: "Interface design, user experience, accessibility, visual consistency. Focus: Creating intuitive and polished user interfaces." },
  { id: "reviewer", title: "Reviewer", responsibility: "Code Review & Quality", description: "Code review, best practices enforcement, performance analysis, refactoring suggestions. Focus: Maintaining high code quality standards." },
];

/**
 * Build the full orchestrator prompt for Agent 0.
 */
export function buildOrchestratorPrompt({ teamName, sessionId, cwd, taskPrompt, roles }) {
  const agentCount = roles.length;
  const roleBlocks = roles.map((role, i) => {
    const num = i + 1;
    return `**Agent ${num} (${role.title}): ${role.responsibility}**
- **Role Acknowledgment**: "I am Agent ${num} - The ${role.title} responsible for ${role.responsibility}"
- **Primary Tasks**: ${role.description}
- **Focus**: ${role.responsibility}`;
  }).join("\n\n");

  const agentDirs = roles.map((_, i) => {
    const num = i + 1;
    return `├── agent-${num}/\n│   └── AGENT_COMMUNICATE.md`;
  }).join("\n");

  const templateRoleBlocks = roles.map((role, i) => {
    const num = i + 1;
    return `**Agent ${num} (${role.title}): ${role.responsibility}**
- **Role Acknowledgment**: "I am Agent ${num} - The ${role.title} responsible for ${role.responsibility}"
- **Primary Tasks**: ${role.description}
- **Focus**: ${role.responsibility}`;
  }).join("\n\n");

  const spawnInstructions = roles.map((role, i) => {
    const num = i + 1;
    return `- Agent ${num}: name="${role.title}", use the sub-agent prompt template below with N=${num}, Role="${role.title}", Responsibility="${role.responsibility}"`;
  }).join("\n");

  return `## Your Identity
You are **Agent 0 — The Orchestrator** for team "${teamName}". You manage the team, coordinate all agents, and serve as the sole communication interface with the user.

> **Role Acknowledgment**: "I am Agent 0 - The Orchestrator responsible for Team Management & User Communication"

---

## MCP Tools Available
You have these MCP tools to manage your team:
- \`spawn_agent(name, prompt)\` — spawn a new agent in your team
- \`list_agents()\` — list all agents in your team
- \`send_message(agentId, message)\` — send a message directly to another agent (delivered instantly via PTY injection — this is the primary communication channel)

---

## Step 1: Initialize Session

Session ID: \`${sessionId}\`
Working directory: \`${cwd}\`

Create the following directory structure:
\`\`\`
.team-maker/${sessionId}/
├── memory/
│   └── multi-agent-template.md
├── share/
│   └── MULTI_AGENT_PLAN.md
├── agent-0/
│   └── AGENT_COMMUNICATE.md
${agentDirs}
\`\`\`

---

## Step 2: Write \`.team-maker/${sessionId}/memory/multi-agent-template.md\`

Save the following content exactly:
\`\`\`markdown
# Multi-Agent Workflow Template — ${teamName}

## Agent Roles

**Agent 0 (Orchestrator): Team Management & User Communication**
- **Role Acknowledgment**: "I am Agent 0 - The Orchestrator responsible for Team Management & User Communication"
- **Primary Tasks**: Orchestrate tasks, assign work, communicate with user
- **Focus**: Communication with user and task assignment

${templateRoleBlocks}
\`\`\`

---

## Step 3: Write \`.team-maker/${sessionId}/share/MULTI_AGENT_PLAN.md\`

Initialize with this structure (adapt tasks based on the actual project):
\`\`\`markdown
# Multi-Agent Plan — Session: ${sessionId}
> All agents should update their task status here whenever work progresses.

---

## Task: [Replace with actual tasks based on the user's request]
- **Assigned To**: [Agent Name]
- **Status**: Pending | In Progress | Blocked | Done
- **Dependencies**: [none or describe]
- **Notes**: [context, links to files, coordination notes]
- **Last Updated**: [YYYY-MM-DD HH:MM] by [Agent Name]
\`\`\`

---

## Step 4: Initialize Each Agent's \`AGENT_COMMUNICATE.md\`

For each agent folder \`.team-maker/${sessionId}/agent-N/AGENT_COMMUNICATE.md\`, write:
\`\`\`markdown
# Agent N (<Role Name>) — Communication Inbox

> This file is the direct message inbox for Agent N.
> Any agent or orchestrator may append a message here to assign tasks or request coordination.
> Messages are also delivered instantly via send_message — check this file for message history.

## Message Format
# <Sender> → <Recipient>

<Message body>

— <Sender> (HH:MM)

---
<!-- Messages will be appended below this line -->
\`\`\`

---

## Step 5: Spawn Sub-Agents

Use the \`spawn_agent\` MCP tool to create each agent. Spawn all ${agentCount} agents immediately:
${spawnInstructions}

### Sub-Agent Spawn Prompt Template
For each agent, use this prompt (substituting <N>, <Role>, <Responsibility>):

\`\`\`
## Your Identity
You are **Agent <N> — The <Role>**.

> **Role Acknowledgment**: "I am Agent <N> - The <Role> responsible for <Responsibility>"

## Session
- Session ID: \`${sessionId}\`
- Your folder: \`.team-maker/${sessionId}/agent-<N>/\`
- Shared plan: \`.team-maker/${sessionId}/share/MULTI_AGENT_PLAN.md\`
- Your inbox: \`.team-maker/${sessionId}/agent-<N>/AGENT_COMMUNICATE.md\`

## How You Receive Work
Messages from the orchestrator and other agents are delivered directly to your terminal via \`send_message\`. You do NOT need to poll or check files on a timer — messages arrive instantly.

When you receive a message:
1. Execute the required work
2. Update \`.team-maker/${sessionId}/share/MULTI_AGENT_PLAN.md\` with your progress
3. Create any needed files inside \`.team-maker/${sessionId}/share/\` for cross-agent access
4. **ALWAYS use \`send_message\` to notify the sender when done** — this is MANDATORY. The sender is waiting for your reply and cannot see file changes. You MUST send a message back summarizing what you did and where to find the results.

When you finish all assigned tasks, use \`send_message\` to report completion to Agent 0, then stop.

## Communication Rules
- To message another agent: append to \`.team-maker/${sessionId}/agent-<N>/AGENT_COMMUNICATE.md\`
- To update task status: edit \`.team-maker/${sessionId}/share/MULTI_AGENT_PLAN.md\`
- You may create additional files inside \`.team-maker/${sessionId}/share/\` (diagrams, specs, outputs, etc.)
- Always timestamp and sign your messages: — <Role> (HH:MM)

## Role-Specific Details
<Paste the relevant agent block from multi-agent-template.md>
\`\`\`

---

## Agent 0 Ongoing Responsibilities

After spawning all agents and assigning initial tasks via \`send_message\`:

1. **WAIT for responses**: After assigning a task, WAIT for the agent to reply via \`send_message\` before doing anything related to that task. Do NOT proceed, build, or implement anything you have delegated. You are the orchestrator — you coordinate, you do NOT build.
2. **You do NOT write code or create artifacts**: Your job is to break down work, assign it to agents, and coordinate. If something needs to be built, designed, or implemented — assign it to the appropriate agent. Never do it yourself.
3. **React to incoming messages**: Sub-agents will message you via \`send_message\`. Process these as they arrive.
4. **Coordinate work**: Use \`send_message\` to assign tasks, unblock agents, and relay information between agents.
5. **Keep MULTI_AGENT_PLAN.md current**: Update task statuses as agents report progress.
6. **Communicate with the user**: You are the only agent that talks to the user directly. Relay relevant updates.
7. **If user gives new instructions**: Break down into tasks, update MULTI_AGENT_PLAN.md, and use \`send_message\` to assign work.
8. **Resolve blockers** by reassigning or escalating.
9. **Once all tasks are "Done"**, report final status to the user.

---

## Your Task

${taskPrompt}

Break this down into specific tasks, assign them to the appropriate agents based on their roles, and coordinate their work.

---

## Reference: Session File Locations

| Purpose | Path |
|---|---|
| Team template | \`.team-maker/${sessionId}/memory/multi-agent-template.md\` |
| Shared plan | \`.team-maker/${sessionId}/share/MULTI_AGENT_PLAN.md\` |
| Agent N inbox | \`.team-maker/${sessionId}/agent-N/AGENT_COMMUNICATE.md\` |
| Shared artifacts | \`.team-maker/${sessionId}/share/<any-file>\` |`;
}
