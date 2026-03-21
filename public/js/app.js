const teams = new Map(); // teamId -> { id, name, agentIds[] }
const sessions = new Map(); // sessionId -> { id, name, teamId, role, terminal, fitAddon, ws, tabEl, wrapperEl, status }
let activeTeamId = null;
let activeSessionId = null;

// Usage tab state
let usageTabActive = false;
let usageRefreshInterval = null;

// Messages tab state
let messagesTabActive = false;
const teamMessages = new Map(); // teamId -> message[]

// Tasks tab state
let tasksTabActive = false;
const teamTasks = new Map(); // teamId -> task[]

// Context tab state (AP5-B: shared context store)
let contextTabActive = false;
const teamContexts = new Map(); // teamId -> entry[]

// Events tab state (AP3: structured JSONL events)
let eventsTabActive = false;
const teamEvents = new Map(); // teamId -> event[]
const agentStates = new Map(); // sessionId -> { state, lastToolCall }

// Role editor state
let currentRoles = [];
let editingRoleIndex = -1;
let savedTemplates = [];
let builtinRoles = [];
let extraRoles = [];

// --- Usage formatting helpers ---

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString();
}

function formatCost(n) {
  return "$" + n.toFixed(4);
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function formatBytes(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

function renderUsageSummaryHTML(totals) {
  const detailedTokens = totals.inputTokens + totals.outputTokens;
  const totalTokens = detailedTokens > 0 ? detailedTokens : (totals.totalTokens || 0);
  return `
    <div class="usage-summary-grid">
      <div class="usage-summary-card">
        <div class="usage-label">Total Cost</div>
        <div class="usage-value cost">${formatCost(totals.cost)}</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-label">Total Tokens</div>
        <div class="usage-value tokens">${formatTokens(totalTokens)}</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-label">Input Tokens</div>
        <div class="usage-value tokens">${formatTokens(totals.inputTokens)}</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-label">Output Tokens</div>
        <div class="usage-value tokens">${formatTokens(totals.outputTokens)}</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-label">Cache Read</div>
        <div class="usage-value tokens">${formatTokens(totals.cacheRead)}</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-label">Cache Create</div>
        <div class="usage-value tokens">${formatTokens(totals.cacheWrite)}</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-label">Duration</div>
        <div class="usage-value duration">${formatDuration(totals.durationMs)}</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-label">Data I/O</div>
        <div class="usage-value">${formatBytes(totals.bytesIn + totals.bytesOut)}</div>
      </div>
    </div>
  `;
}

function renderUsageAgentTableHTML(agents) {
  if (!agents || agents.length === 0) return '<div class="usage-empty">No agents</div>';
  const rows = agents.map(a => {
    const roleLabel = a.role === "main" ? "main" : (a.agentIndex || "?");
    const roleClass = a.role === "main" ? "" : " agent";
    const statusClass = a.status === "running" ? "running" : "exited";
    const detailedTokens = a.tokenUsage.inputTokens + a.tokenUsage.outputTokens;
    const totalTokens = detailedTokens > 0 ? detailedTokens : (a.tokenUsage.totalTokens || 0);
    return `
      <tr>
        <td>
          <span class="usage-status-dot ${statusClass}"></span>
          <span class="usage-agent-name">${a.name}</span>
          <span class="usage-role-badge${roleClass}">${roleLabel}</span>
        </td>
        <td class="usage-cost-cell">${formatCost(a.tokenUsage.cost)}</td>
        <td class="usage-token-cell">${formatTokens(totalTokens)}</td>
        <td class="usage-token-cell">${formatTokens(a.tokenUsage.inputTokens)}</td>
        <td class="usage-token-cell">${formatTokens(a.tokenUsage.outputTokens)}</td>
        <td class="usage-token-cell">${formatTokens(a.tokenUsage.cacheRead)}</td>
        <td class="usage-token-cell">${formatTokens(a.tokenUsage.cacheWrite)}</td>
        <td>${formatBytes(a.usage.bytesIn)}</td>
        <td>${formatBytes(a.usage.bytesOut)}</td>
        <td>${formatDuration(a.usage.durationMs)}</td>
      </tr>
    `;
  }).join("");

  return `
    <h3 class="usage-section-title">Agent Breakdown</h3>
    <table class="usage-agent-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Cost</th>
          <th>Tokens</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache Read</th>
          <th>Cache Write</th>
          <th>Bytes In</th>
          <th>Bytes Out</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function refreshUsagePanel() {
  if (!activeTeamId) return;
  const panel = document.getElementById("usage-panel-content");
  try {
    const res = await fetch(`/api/teams/${activeTeamId}/usage`);
    if (!res.ok) throw new Error("Team not found");
    const data = await res.json();
    panel.innerHTML = renderUsageSummaryHTML(data.totals) + renderUsageAgentTableHTML(data.agents);
  } catch (err) {
    panel.innerHTML = `<div class="usage-empty">Error loading usage: ${err.message}</div>`;
  }
}

async function refreshSidebarTokens() {
  for (const [teamId, team] of teams) {
    try {
      const res = await fetch(`/api/teams/${teamId}/usage`);
      if (!res.ok) continue;
      const data = await res.json();
      const detailedTokens = data.totals.inputTokens + data.totals.outputTokens;
      const totalTokens = detailedTokens > 0 ? detailedTokens : (data.totals.totalTokens || 0);
      const el = teamList.querySelector(`[data-team-id="${teamId}"] .team-item-tokens`);
      if (el) {
        el.textContent = `${formatTokens(totalTokens)} tokens · ${formatCost(data.totals.cost)}`;
      }
    } catch {}
  }
}

// Alert sound using Web Audio API
let audioCtx = null;
function playAlertSound() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, audioCtx.currentTime);
  osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.15);
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.3);
}

function handleQuestionAlert(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  playAlertSound();
  const dot = session.tabEl.querySelector(".status-dot");
  dot.classList.add("question");
  if (sessionId === activeSessionId && document.hasFocus()) {
    setTimeout(() => dot.classList.remove("question"), 3000);
  }
}

function handleActivityUpdate(sessionId, active) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const dot = session.tabEl.querySelector(".status-dot");
  if (active) {
    dot.classList.add("working");
  } else {
    dot.classList.remove("working");
  }
}

// DOM elements
const tabBar = document.getElementById("tab-bar");
const terminalContainer = document.getElementById("terminal-container");
const emptyState = document.getElementById("empty-state");
const newTeamBtn = document.getElementById("new-team-btn");
const newAgentBtn = document.getElementById("new-agent-btn");
const sessionCount = document.getElementById("session-count");
const statusText = document.getElementById("status-text");
const teamList = document.getElementById("team-list");

// Team modal elements
const modalOverlay = document.getElementById("modal-overlay");
const teamNameInput = document.getElementById("team-name-input");
const pathInput = document.getElementById("path-input");
const browseBtn = document.getElementById("browse-btn");
const modalCancel = document.getElementById("modal-cancel");
const modalStart = document.getElementById("modal-start");
const promptInput = document.getElementById("prompt-input");

// Model select elements
const modelSelect = document.getElementById("model-select");
const agentModelSelect = document.getElementById("agent-model-select");

// Agent modal elements
const agentModalOverlay = document.getElementById("agent-modal-overlay");
const agentNameInput = document.getElementById("agent-name-input");
const agentPromptInput = document.getElementById("agent-prompt-input");
const agentModalCancel = document.getElementById("agent-modal-cancel");
const agentModalStart = document.getElementById("agent-modal-start");

// Role editor elements
const templateSelect = document.getElementById("template-select");
const templateSaveBtn = document.getElementById("template-save-btn");
const templateDeleteBtn = document.getElementById("template-delete-btn");
const roleListEl = document.getElementById("role-list");
const addRoleBtn = document.getElementById("add-role-btn");
const quickAddSelect = document.getElementById("quick-add-select");

const MODEL_OPTIONS = [
  { value: "", label: "Default" },
  { value: "claude-opus-4-6", label: "Opus" },
  { value: "claude-sonnet-4-6", label: "Sonnet" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku" },
];

function modelLabel(value) {
  const opt = MODEL_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label : "";
}

function getWsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

function createTerminal(containerEl) {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#cba6f7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#cba6f7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.open(containerEl);
  setTimeout(() => fitAddon.fit(), 50);
  return { terminal, fitAddon };
}

// --- Sidebar ---

function renderTeamItem(team) {
  const el = document.createElement("div");
  const isStopped = team.status === "stopped";
  el.className = "team-item" + (isStopped ? " stopped" : "");
  el.dataset.teamId = team.id;
  el.innerHTML = `
    <div class="team-item-info">
      <span class="team-item-name">${team.name}</span>
      ${isStopped
        ? '<span class="team-item-badge stopped">stopped</span>'
        : `<span class="team-item-badge">${team.agentIds.length} agent${team.agentIds.length !== 1 ? "s" : ""}</span>`
      }
      <span class="team-item-tokens"></span>
    </div>
    <div class="team-item-actions">
      ${isStopped ? '<button class="relaunch-team-btn" title="Re-launch team">&#8635;</button>' : ""}
      <button class="delete-team-btn" title="Delete team">&times;</button>
    </div>
  `;
  el.addEventListener("click", (e) => {
    if (!e.target.classList.contains("delete-team-btn") && !e.target.classList.contains("relaunch-team-btn")) {
      selectTeam(team.id);
    }
  });
  el.querySelector(".delete-team-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTeam(team.id);
  });
  const relaunchBtn = el.querySelector(".relaunch-team-btn");
  if (relaunchBtn) {
    relaunchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      relaunchTeam(team.id);
    });
  }
  return el;
}

function updateTeamBadge(teamId) {
  const team = teams.get(teamId);
  if (!team) return;
  const el = teamList.querySelector(`[data-team-id="${teamId}"]`);
  if (!el) return;
  const badge = el.querySelector(".team-item-badge");
  badge.textContent = `${team.agentIds.length} agent${team.agentIds.length !== 1 ? "s" : ""}`;
}

function selectTeam(teamId) {
  activeTeamId = teamId;

  // Update sidebar active state
  teamList.querySelectorAll(".team-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.teamId === teamId);
  });

  // Enable/disable new agent button (disabled for stopped teams)
  const selectedTeam = teamId ? teams.get(teamId) : null;
  newAgentBtn.disabled = !teamId || (selectedTeam && selectedTeam.status === "stopped");

  // Show/hide usage tab
  const usageTab = tabBar.querySelector(".tab-usage");
  if (teamId) {
    if (!usageTab) {
      createUsageTab();
    } else {
      usageTab.style.display = "";
    }
  } else if (usageTab) {
    usageTab.style.display = "none";
  }

  // Show/hide messages tab
  const messagesTab = tabBar.querySelector(".tab-messages");
  if (teamId) {
    if (!messagesTab) {
      createMessagesTab();
    } else {
      messagesTab.style.display = "";
    }
  } else if (messagesTab) {
    messagesTab.style.display = "none";
  }

  // Show/hide tasks tab
  const tasksTab = tabBar.querySelector(".tab-tasks");
  if (teamId) {
    if (!tasksTab) {
      createTasksTab();
    } else {
      tasksTab.style.display = "";
    }
  } else if (tasksTab) {
    tasksTab.style.display = "none";
  }

  // Show/hide events tab
  const eventsTab = tabBar.querySelector(".tab-events");
  if (teamId) {
    if (!eventsTab) {
      createEventsTab();
    } else {
      eventsTab.style.display = "";
    }
  } else if (eventsTab) {
    eventsTab.style.display = "none";
  }

  // Show/hide context tab
  const contextTab = tabBar.querySelector(".tab-context");
  if (teamId) {
    if (!contextTab) {
      createContextTab();
    } else {
      contextTab.style.display = "";
    }
  } else if (contextTab) {
    contextTab.style.display = "none";
  }

  // Show only tabs for this team, hide others
  tabBar.querySelectorAll(".tab:not(.tab-usage):not(.tab-messages):not(.tab-tasks):not(.tab-events):not(.tab-context)").forEach((t) => {
    const session = sessions.get(t.dataset.id);
    t.style.display = (session && session.teamId === teamId) ? "" : "none";
  });
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#usage-panel):not(#messages-panel):not(#tasks-panel):not(#context-panel)").forEach((w) => {
    const session = sessions.get(w.dataset.id);
    if (!session || session.teamId !== teamId) {
      w.classList.remove("active");
    }
  });

  // If usage/messages/tasks/context tab was active, keep it; otherwise switch to an agent tab
  if (usageTabActive) {
    switchToUsageTab();
  } else if (tasksTabActive) {
    switchToTasksTab();
  } else if (messagesTabActive) {
    switchToMessagesTab();
  } else if (contextTabActive) {
    switchToContextTab();
  } else {
    // Switch to the first visible tab in this team, or the active one if it belongs
    const team = teams.get(teamId);
    if (team && team.status === "stopped") {
      activeSessionId = null;
      emptyState.innerHTML = `<p>Team "${team.name}" is stopped</p><p>Click the <strong>&#8635;</strong> button in the sidebar to re-launch it</p>`;
      emptyState.style.display = "";
    } else if (team && team.agentIds.length > 0) {
      const currentBelongsToTeam = activeSessionId && sessions.get(activeSessionId)?.teamId === teamId;
      if (!currentBelongsToTeam) {
        switchTab(team.agentIds[0]);
      } else {
        switchTab(activeSessionId);
      }
      emptyState.style.display = "none";
    } else {
      activeSessionId = null;
      emptyState.innerHTML = `<p>No teams yet</p><p>Click <strong>+ New Team</strong> to create a team with an orchestrator agent</p>`;
      emptyState.style.display = "";
    }
  }

  updateSessionCount();
}

// --- Tab / Session Management ---

function attachSession(data) {
  // Create tab
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.id = data.id;
  let roleHtml = "";
  if (data.role === "main") {
    roleHtml = '<span class="role-badge">🤖 main</span>';
  } else if (data.role === "agent") {
    roleHtml = `<span class="role-badge agent">🤖 ${data.agentIndex || "?"}</span>`;
  }
  // Strip redundant "Agent N - " prefix since the badge already shows the number
  const displayName = data.name.replace(/^Agent\s*\d+\s*[-–—]\s*/i, "");
  tab.innerHTML = `
    <span class="status-dot ${data.status === "exited" ? "exited" : ""}"></span>
    ${roleHtml}
    <span class="tab-name">${displayName}</span>
    <button class="close-btn" title="Close agent">&times;</button>
  `;
  tab.addEventListener("click", (e) => {
    if (!e.target.classList.contains("close-btn")) switchTab(data.id);
  });
  tab.querySelector(".close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(data.id);
  });
  tabBar.appendChild(tab);

  // Create terminal wrapper
  const wrapper = document.createElement("div");
  wrapper.className = "terminal-wrapper";
  wrapper.dataset.id = data.id;
  terminalContainer.appendChild(wrapper);

  const { terminal, fitAddon } = createTerminal(wrapper);

  // Connect WebSocket
  const ws = new WebSocket(getWsUrl());

  const session = {
    id: data.id,
    name: data.name,
    teamId: data.teamId,
    role: data.role,
    status: data.status,
    terminal,
    fitAddon,
    ws,
    tabEl: tab,
    wrapperEl: wrapper,
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "attach", sessionId: data.id }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "exit") {
          session.status = "exited";
          tab.querySelector(".status-dot").classList.add("exited");
          statusText.textContent = `${data.name} exited (code ${msg.exitCode})`;
          return;
        }
        if (msg.type === "attached") return;
        if (msg.type === "error") {
          terminal.write(`\r\nError: ${msg.message}\r\n`);
          return;
        }
        if (msg.type === "question") {
          handleQuestionAlert(msg.sessionId);
          return;
        }
        if (msg.type === "activity") {
          handleActivityUpdate(msg.sessionId, msg.active);
          return;
        }
        // Handle team-update broadcasts
        if (msg.type === "team-update") {
          handleTeamUpdate(msg);
          return;
        }
        // Handle team message broadcasts
        if (msg.type === "team-message") {
          handleTeamMessage(msg);
          return;
        }
        // Handle team task broadcasts
        if (msg.type === "team-task") {
          handleTeamTaskEvent(msg);
          return;
        }
        // Handle agent event broadcasts (AP3)
        if (msg.type === "agent-event") {
          handleAgentEvent(msg);
          return;
        }
        // Handle agent state changes (AP3)
        if (msg.type === "agent_state") {
          handleAgentState(msg);
          return;
        }
        // Handle agent idle events (AP5-A)
        if (msg.type === "agent-idle") {
          handleAgentIdleEvent(msg);
          return;
        }
        // Handle context store events (AP5-B)
        if (msg.type === "team-context") {
          handleTeamContextEvent(msg);
          return;
        }
      } catch {
        // Not JSON — terminal data
      }
    }
    terminal.write(event.data);
  };

  ws.onclose = () => {
    if (sessions.has(data.id)) {
      statusText.textContent = `Connection lost for ${data.name}`;
      setTimeout(() => reconnect(data.id), 2000);
    }
  };

  terminal.onData((input) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: input }));
    }
  });

  sessions.set(data.id, session);

  // Hide tab if not in active team
  if (data.teamId !== activeTeamId) {
    tab.style.display = "none";
  }

  return session;
}

function reconnect(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const ws = new WebSocket(getWsUrl());
  session.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "attach", sessionId }));
    statusText.textContent = `Reconnected to ${session.name}`;
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "exit") {
          session.status = "exited";
          session.tabEl.querySelector(".status-dot").classList.add("exited");
          return;
        }
        if (msg.type === "question") {
          handleQuestionAlert(msg.sessionId);
          return;
        }
        if (msg.type === "activity") {
          handleActivityUpdate(msg.sessionId, msg.active);
          return;
        }
        if (msg.type === "team-update") {
          handleTeamUpdate(msg);
          return;
        }
        if (msg.type === "team-message") {
          handleTeamMessage(msg);
          return;
        }
        if (msg.type === "agent-event") {
          handleAgentEvent(msg);
          return;
        }
        if (msg.type === "agent_state") {
          handleAgentState(msg);
          return;
        }
        if (msg.type === "agent-idle") {
          handleAgentIdleEvent(msg);
          return;
        }
        if (msg.type === "team-context") {
          handleTeamContextEvent(msg);
          return;
        }
        if (msg.type === "attached" || msg.type === "error") return;
      } catch {}
    }
    session.terminal.write(event.data);
  };

  ws.onclose = () => {
    if (sessions.has(sessionId)) {
      setTimeout(() => reconnect(sessionId), 2000);
    }
  };

  session.terminal.onData((input) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: input }));
    }
  });
}

function switchTab(sessionId) {
  activeSessionId = sessionId;
  usageTabActive = false;
  messagesTabActive = false;
  tasksTabActive = false;
  eventsTabActive = false;
  contextTabActive = false;

  // Deactivate usage tab and panel
  const usageTab = tabBar.querySelector(".tab-usage");
  if (usageTab) usageTab.classList.remove("active");
  document.getElementById("usage-panel").classList.remove("active");
  stopUsageAutoRefresh();

  // Deactivate messages tab and panel
  const messagesTab = tabBar.querySelector(".tab-messages");
  if (messagesTab) messagesTab.classList.remove("active");
  document.getElementById("messages-panel").classList.remove("active");

  // Deactivate tasks tab and panel
  const tasksTab = tabBar.querySelector(".tab-tasks");
  if (tasksTab) tasksTab.classList.remove("active");
  document.getElementById("tasks-panel").classList.remove("active");

  // Deactivate events tab and panel
  const eventsTab = tabBar.querySelector(".tab-events");
  if (eventsTab) eventsTab.classList.remove("active");
  document.getElementById("events-panel").classList.remove("active");

  // Deactivate context tab and panel
  const contextTab = tabBar.querySelector(".tab-context");
  if (contextTab) contextTab.classList.remove("active");
  document.getElementById("context-panel").classList.remove("active");

  tabBar.querySelectorAll(".tab:not(.tab-usage):not(.tab-messages):not(.tab-tasks):not(.tab-events):not(.tab-context)").forEach((t) => {
    t.classList.toggle("active", t.dataset.id === sessionId);
  });

  terminalContainer.querySelectorAll(".terminal-wrapper:not(#usage-panel):not(#messages-panel):not(#tasks-panel):not(#events-panel):not(#context-panel)").forEach((w) => {
    w.classList.toggle("active", w.dataset.id === sessionId);
  });

  emptyState.style.display = "none";

  const session = sessions.get(sessionId);
  if (session) {
    session.tabEl.querySelector(".status-dot").classList.remove("question");
    setTimeout(() => {
      session.fitAddon.fit();
      sendResize(session);
      session.terminal.focus();
    }, 50);
  }
}

// --- Usage tab ---

function createUsageTab() {
  // Remove existing usage tab if any
  const existing = tabBar.querySelector(".tab-usage");
  if (existing) existing.remove();

  const tab = document.createElement("div");
  tab.className = "tab tab-usage";
  tab.innerHTML = `<span class="usage-tab-icon">📊</span><span class="tab-name">Usage</span>`;
  tab.addEventListener("click", () => switchToUsageTab());

  // Insert as first tab
  tabBar.prepend(tab);
  return tab;
}

function switchToUsageTab() {
  usageTabActive = true;
  messagesTabActive = false;
  tasksTabActive = false;
  eventsTabActive = false;
  activeSessionId = null;

  // Deactivate all agent tabs, messages tab, tasks tab, events tab, and wrappers
  tabBar.querySelectorAll(".tab:not(.tab-usage)").forEach((t) => t.classList.remove("active"));
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#usage-panel)").forEach((w) => w.classList.remove("active"));

  // Activate usage tab and panel
  const usageTab = tabBar.querySelector(".tab-usage");
  if (usageTab) usageTab.classList.add("active");
  document.getElementById("usage-panel").classList.add("active");
  emptyState.style.display = "none";

  // Fetch and render usage data
  refreshUsagePanel();
  startUsageAutoRefresh();
}

// --- Messages tab ---

function createMessagesTab() {
  const existing = tabBar.querySelector(".tab-messages");
  if (existing) existing.remove();

  const tab = document.createElement("div");
  tab.className = "tab tab-messages";
  tab.innerHTML = `<span class="messages-tab-icon">💬</span><span class="tab-name">Messages</span>`;
  tab.addEventListener("click", () => switchToMessagesTab());

  // Insert after usage tab
  const usageTab = tabBar.querySelector(".tab-usage");
  if (usageTab) {
    usageTab.after(tab);
  } else {
    tabBar.prepend(tab);
  }
  return tab;
}

function switchToMessagesTab() {
  messagesTabActive = true;
  usageTabActive = false;
  tasksTabActive = false;
  eventsTabActive = false;
  activeSessionId = null;

  // Deactivate all other tabs and wrappers
  tabBar.querySelectorAll(".tab:not(.tab-messages)").forEach((t) => t.classList.remove("active"));
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#messages-panel)").forEach((w) => w.classList.remove("active"));
  stopUsageAutoRefresh();

  // Activate messages tab and panel
  const messagesTab = tabBar.querySelector(".tab-messages");
  if (messagesTab) messagesTab.classList.add("active");
  document.getElementById("messages-panel").classList.add("active");
  emptyState.style.display = "none";

  // Clear unread badge
  updateMessagesUnreadBadge(0);

  // Load messages if not already loaded
  if (activeTeamId) {
    loadTeamMessages(activeTeamId);
  }
}

async function loadTeamMessages(teamId) {
  try {
    const res = await fetch(`/api/teams/${teamId}/messages`);
    const messages = await res.json();
    teamMessages.set(teamId, messages);
    renderMessagesPanel(messages);
  } catch {
    renderMessagesPanel([]);
  }
}

function renderMessagesPanel(messages) {
  const panel = document.getElementById("messages-panel-content");
  if (!messages || messages.length === 0) {
    panel.innerHTML = '<div class="messages-empty">No messages yet</div>';
    return;
  }

  panel.innerHTML = messages.map((m) => renderMessageItem(m)).join("");
  // Auto-scroll to bottom
  const messagesPanel = document.getElementById("messages-panel");
  messagesPanel.scrollTop = messagesPanel.scrollHeight;
}

function renderMessageItem(msg, isNew) {
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const contentEscaped = msg.content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const truncated = contentEscaped.length > 500 ? contentEscaped.slice(0, 500) + "..." : contentEscaped;

  return `<div class="msg-item${isNew ? " msg-new" : ""}">
    <div class="msg-arrow">
      <span class="msg-agent-name">${escapeHtml(msg.fromName || msg.from)}</span>
      <span class="msg-direction">→</span>
      <span class="msg-agent-name msg-to">${escapeHtml(msg.toName || msg.to)}</span>
    </div>
    <div class="msg-body">
      <div class="msg-content">${truncated}</div>
      <div class="msg-time">${time}</div>
    </div>
  </div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function handleTeamMessage(msg) {
  const teamId = msg.teamId;

  // Store message
  if (!teamMessages.has(teamId)) {
    teamMessages.set(teamId, []);
  }
  teamMessages.get(teamId).push(msg.message);

  // If messages panel is active and showing this team, append it
  if (messagesTabActive && activeTeamId === teamId) {
    const panel = document.getElementById("messages-panel-content");
    const isEmpty = panel.querySelector(".messages-empty");
    if (isEmpty) panel.innerHTML = "";
    panel.insertAdjacentHTML("beforeend", renderMessageItem(msg.message, true));
    // Auto-scroll
    const messagesPanel = document.getElementById("messages-panel");
    messagesPanel.scrollTop = messagesPanel.scrollHeight;
  } else if (activeTeamId === teamId && !messagesTabActive) {
    // Show unread count on tab
    const tab = tabBar.querySelector(".tab-messages");
    if (tab) {
      let badge = tab.querySelector(".unread-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "unread-badge";
        tab.appendChild(badge);
      }
      // Count messages since last view (simple: just increment)
      const current = parseInt(badge.textContent || "0", 10);
      badge.textContent = current + 1;
    }
  }
}

function updateMessagesUnreadBadge(count) {
  const tab = tabBar.querySelector(".tab-messages");
  if (!tab) return;
  const badge = tab.querySelector(".unread-badge");
  if (count <= 0) {
    if (badge) badge.remove();
  } else {
    if (badge) {
      badge.textContent = count;
    } else {
      const b = document.createElement("span");
      b.className = "unread-badge";
      b.textContent = count;
      tab.appendChild(b);
    }
  }
}

// --- Tasks tab ---

function createTasksTab() {
  const existing = tabBar.querySelector(".tab-tasks");
  if (existing) existing.remove();

  const tab = document.createElement("div");
  tab.className = "tab tab-tasks";
  tab.innerHTML = `<span class="tasks-tab-icon">📋</span><span class="tab-name">Tasks</span>`;
  tab.addEventListener("click", () => switchToTasksTab());

  // Insert after messages tab
  const messagesTab = tabBar.querySelector(".tab-messages");
  if (messagesTab) {
    messagesTab.after(tab);
  } else {
    const usageTab = tabBar.querySelector(".tab-usage");
    if (usageTab) usageTab.after(tab);
    else tabBar.prepend(tab);
  }
  return tab;
}

function switchToTasksTab() {
  tasksTabActive = true;
  usageTabActive = false;
  messagesTabActive = false;
  eventsTabActive = false;
  activeSessionId = null;

  // Deactivate all other tabs and wrappers
  tabBar.querySelectorAll(".tab:not(.tab-tasks)").forEach((t) => t.classList.remove("active"));
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#tasks-panel)").forEach((w) => w.classList.remove("active"));
  stopUsageAutoRefresh();

  // Activate tasks tab and panel
  const tasksTab = tabBar.querySelector(".tab-tasks");
  if (tasksTab) tasksTab.classList.add("active");
  document.getElementById("tasks-panel").classList.add("active");
  emptyState.style.display = "none";

  // Load tasks
  if (activeTeamId) {
    loadTeamTasks(activeTeamId);
  }
}

async function loadTeamTasks(teamId) {
  try {
    const res = await fetch(`/api/teams/${teamId}/tasks`);
    const data = await res.json();
    teamTasks.set(teamId, data.tasks);
    renderTasksPanel(data.tasks, data.summary);
  } catch {
    renderTasksPanel([], null);
  }
}

function renderTasksPanel(tasks, summary) {
  const panel = document.getElementById("tasks-panel-content");
  if (!tasks || tasks.length === 0) {
    panel.innerHTML = '<div class="tasks-empty">No tasks yet</div>';
    return;
  }

  const summaryHtml = summary ? renderTaskSummaryHTML(summary) : "";

  // Group tasks by status into kanban columns
  const columns = {
    pending: tasks.filter((t) => t.status === "pending"),
    active: tasks.filter((t) => t.status === "assigned" || t.status === "in_progress"),
    completed: tasks.filter((t) => t.status === "completed"),
    failed: tasks.filter((t) => t.status === "failed"),
  };

  panel.innerHTML = summaryHtml + `
    <div class="tasks-board">
      <div class="tasks-column">
        <div class="tasks-column-header pending">Pending <span class="tasks-count">${columns.pending.length}</span></div>
        <div class="tasks-column-body">${columns.pending.map((t) => renderTaskCard(t)).join("")}</div>
      </div>
      <div class="tasks-column">
        <div class="tasks-column-header active">In Progress <span class="tasks-count">${columns.active.length}</span></div>
        <div class="tasks-column-body">${columns.active.map((t) => renderTaskCard(t)).join("")}</div>
      </div>
      <div class="tasks-column">
        <div class="tasks-column-header completed">Completed <span class="tasks-count">${columns.completed.length}</span></div>
        <div class="tasks-column-body">${columns.completed.map((t) => renderTaskCard(t)).join("")}</div>
      </div>
      <div class="tasks-column">
        <div class="tasks-column-header failed">Failed <span class="tasks-count">${columns.failed.length}</span></div>
        <div class="tasks-column-body">${columns.failed.map((t) => renderTaskCard(t)).join("")}</div>
      </div>
    </div>
  `;

  // Attach retry button handlers
  panel.querySelectorAll(".task-retry-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const taskId = e.target.dataset.taskId;
      const teamId = e.target.dataset.teamId;
      try {
        await fetch(`/api/teams/${teamId}/tasks/${taskId}/retry`, { method: "POST" });
        loadTeamTasks(teamId);
      } catch {}
    });
  });
}

function renderTaskSummaryHTML(summary) {
  return `
    <div class="tasks-summary">
      <span class="tasks-summary-item pending">${summary.pending} pending</span>
      <span class="tasks-summary-item active">${(summary.assigned || 0) + (summary.in_progress || 0)} active</span>
      <span class="tasks-summary-item completed">${summary.completed} done</span>
      <span class="tasks-summary-item failed">${summary.failed} failed</span>
      <span class="tasks-summary-total">${summary.total} total</span>
    </div>
  `;
}

function renderTaskCard(task) {
  const time = new Date(task.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const assignee = task.assignedToName ? `<span class="task-assignee">${escapeHtml(task.assignedToName)}</span>` : "";
  const desc = task.description
    ? `<div class="task-desc">${escapeHtml(task.description).slice(0, 200)}</div>`
    : "";
  const result = task.result
    ? `<div class="task-result">${escapeHtml(task.result).slice(0, 200)}</div>`
    : "";
  const failReason = task.failReason
    ? `<div class="task-fail-reason">${escapeHtml(task.failReason).slice(0, 200)}</div>`
    : "";
  const retryBtn = task.status === "failed"
    ? `<button class="task-retry-btn" data-task-id="${task.id}" data-team-id="${task.teamId}">↻ Retry</button>`
    : "";
  const deps = task.dependsOn && task.dependsOn.length > 0
    ? `<div class="task-deps">depends on ${task.dependsOn.length} task(s)</div>`
    : "";

  return `<div class="task-card task-${task.status}">
    <div class="task-card-header">
      <span class="task-title">${escapeHtml(task.title)}</span>
      <span class="task-time">${time}</span>
    </div>
    ${desc}${assignee}${deps}${result}${failReason}${retryBtn}
  </div>`;
}

function handleTeamTaskEvent(msg) {
  const teamId = msg.teamId;

  // Update local cache
  if (teamTasks.has(teamId)) {
    const tasks = teamTasks.get(teamId);
    const idx = tasks.findIndex((t) => t.id === msg.task.id);
    if (idx >= 0) {
      tasks[idx] = msg.task;
    } else {
      tasks.push(msg.task);
    }
  }

  // If tasks panel is active, reload
  if (tasksTabActive && activeTeamId === teamId) {
    loadTeamTasks(teamId);
  }
}

// --- Events tab (AP3: structured JSONL events) ---

function createEventsTab() {
  const existing = tabBar.querySelector(".tab-events");
  if (existing) existing.remove();

  const tab = document.createElement("div");
  tab.className = "tab tab-events";
  tab.innerHTML = `<span class="events-tab-icon">⚡</span><span class="tab-name">Events</span>`;
  tab.addEventListener("click", () => switchToEventsTab());

  // Insert after tasks tab
  const tasksTab = tabBar.querySelector(".tab-tasks");
  if (tasksTab) {
    tasksTab.after(tab);
  } else {
    const messagesTab = tabBar.querySelector(".tab-messages");
    if (messagesTab) messagesTab.after(tab);
    else tabBar.prepend(tab);
  }
  return tab;
}

function switchToEventsTab() {
  eventsTabActive = true;
  usageTabActive = false;
  messagesTabActive = false;
  tasksTabActive = false;
  activeSessionId = null;

  // Deactivate all other tabs and wrappers
  tabBar.querySelectorAll(".tab:not(.tab-events)").forEach((t) => t.classList.remove("active"));
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#events-panel)").forEach((w) => w.classList.remove("active"));
  stopUsageAutoRefresh();

  // Activate events tab and panel
  const eventsTab = tabBar.querySelector(".tab-events");
  if (eventsTab) eventsTab.classList.add("active");
  document.getElementById("events-panel").classList.add("active");
  emptyState.style.display = "none";

  // Load events
  if (activeTeamId) {
    loadTeamEvents(activeTeamId);
  }
}

async function loadTeamEvents(teamId) {
  try {
    const res = await fetch(`/api/teams/${teamId}/events`);
    const data = await res.json();
    teamEvents.set(teamId, data.events);
    renderEventsPanel(data.events);
    populateEventsAgentFilter(teamId);
  } catch {
    renderEventsPanel([]);
  }
}

function populateEventsAgentFilter(teamId) {
  const select = document.getElementById("events-filter-agent");
  const currentVal = select.value;
  // Keep "All agents" option, rebuild the rest
  select.innerHTML = '<option value="">All agents</option>';
  const team = teams.get(teamId);
  if (!team) return;
  for (const agentId of team.agentIds) {
    const session = sessions.get(agentId);
    if (session) {
      const opt = document.createElement("option");
      opt.value = agentId;
      opt.textContent = session.name;
      select.appendChild(opt);
    }
  }
  select.value = currentVal;
}

function getFilteredEvents(events) {
  const typeFilter = document.getElementById("events-filter-type").value;
  const agentFilter = document.getElementById("events-filter-agent").value;
  let filtered = events;
  if (typeFilter) filtered = filtered.filter((e) => e.type === typeFilter);
  if (agentFilter) filtered = filtered.filter((e) => e.sessionId === agentFilter);
  return filtered;
}

function renderEventsPanel(events) {
  const panel = document.getElementById("events-panel-content");
  const filtered = getFilteredEvents(events);

  if (!filtered || filtered.length === 0) {
    panel.innerHTML = '<div class="events-empty">No events yet</div>';
    return;
  }

  panel.innerHTML = filtered.map((e) => renderEventItem(e)).join("");
  // Auto-scroll to bottom
  const eventsPanel = document.getElementById("events-panel");
  eventsPanel.scrollTop = eventsPanel.scrollHeight;
}

function renderEventItem(event, isNew) {
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const agent = event.sessionName || "agent";
  const icon = getEventIcon(event.type);
  const body = getEventBody(event);
  const errorClass = (event.type === "tool_result" && event.isError) ? " event-error" : "";

  return `<div class="event-item event-${event.type}${errorClass}${isNew ? " event-new" : ""}">
    <span class="event-time">${time}</span>
    <span class="event-agent" title="${escapeHtml(agent)}">${escapeHtml(agent)}</span>
    <span class="event-icon">${icon}</span>
    <div class="event-body">${body}</div>
  </div>`;
}

function getEventIcon(type) {
  switch (type) {
    case "tool_call": return "🔧";
    case "tool_result": return "✓";
    case "assistant_message": return "💬";
    case "turn_complete": return "✅";
    case "thinking": return "🧠";
    default: return "·";
  }
}

function getEventBody(event) {
  switch (event.type) {
    case "tool_call": {
      const name = escapeHtml(event.toolName || "?");
      let detail = "";
      if (event.input) {
        if (event.input.file_path) detail = event.input.file_path;
        else if (event.input.command) detail = event.input.command;
        else if (event.input.pattern) detail = `pattern: ${event.input.pattern}`;
        else if (event.input.description) detail = event.input.description;
      }
      const detailHtml = detail ? `<div class="event-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : "";
      return `<span class="event-tool-name">${name}</span>${detailHtml}`;
    }
    case "tool_result": {
      const status = event.isError ? "❌ Error" : "OK";
      const preview = event.contentPreview ? escapeHtml(event.contentPreview).slice(0, 100) : "";
      const detailHtml = preview ? `<div class="event-detail" title="${escapeHtml(event.contentPreview || "")}">${preview}</div>` : "";
      return `${status}${detailHtml}`;
    }
    case "assistant_message": {
      const text = escapeHtml(event.text || "").slice(0, 200);
      return text;
    }
    case "turn_complete":
      return `Turn complete${event.model ? ` (${event.model})` : ""}`;
    case "thinking":
      return `Thinking... (${event.length} chars)`;
    default:
      return event.type;
  }
}

function handleAgentEvent(msg) {
  const teamId = msg.teamId;
  const event = msg.event;

  // Store event
  if (!teamEvents.has(teamId)) {
    teamEvents.set(teamId, []);
  }
  teamEvents.get(teamId).push(event);

  // If events panel is active and showing this team, append it
  if (eventsTabActive && activeTeamId === teamId) {
    const filtered = getFilteredEvents([event]);
    if (filtered.length > 0) {
      const panel = document.getElementById("events-panel-content");
      const isEmpty = panel.querySelector(".events-empty");
      if (isEmpty) panel.innerHTML = "";
      panel.insertAdjacentHTML("beforeend", renderEventItem(event, true));
      // Auto-scroll
      const eventsPanel = document.getElementById("events-panel");
      eventsPanel.scrollTop = eventsPanel.scrollHeight;
    }
  }
}

function handleAgentState(msg) {
  const { sessionId, state, lastToolCall } = msg;
  agentStates.set(sessionId, { state, lastToolCall });

  // Update tab badge if session exists
  const session = sessions.get(sessionId);
  if (session && session.tabEl) {
    let badge = session.tabEl.querySelector(".agent-state-badge");
    if (state === "starting" || state === "idle") {
      // Remove badge for non-interesting states
      if (badge) badge.remove();
    } else {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "agent-state-badge";
        session.tabEl.querySelector(".tab-name").after(badge);
      }
      // Clear all state classes
      badge.className = "agent-state-badge state-" + state;
      badge.textContent = state === "tool_calling" ? (lastToolCall?.name || "tool") : state;
    }
  }
}

// --- Context tab (AP5-B: shared context store) ---

function createContextTab() {
  const existing = tabBar.querySelector(".tab-context");
  if (existing) existing.remove();

  const tab = document.createElement("div");
  tab.className = "tab tab-context";
  tab.innerHTML = `<span class="context-tab-icon">🧠</span><span class="tab-name">Context</span>`;
  tab.addEventListener("click", () => switchToContextTab());

  // Insert after events tab
  const eventsTab = tabBar.querySelector(".tab-events");
  if (eventsTab) {
    eventsTab.after(tab);
  } else {
    const tasksTab = tabBar.querySelector(".tab-tasks");
    if (tasksTab) tasksTab.after(tab);
    else tabBar.prepend(tab);
  }
  return tab;
}

function switchToContextTab() {
  contextTabActive = true;
  usageTabActive = false;
  messagesTabActive = false;
  tasksTabActive = false;
  eventsTabActive = false;
  activeSessionId = null;

  // Deactivate all other tabs and wrappers
  tabBar.querySelectorAll(".tab:not(.tab-context)").forEach((t) => t.classList.remove("active"));
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#context-panel)").forEach((w) => w.classList.remove("active"));
  stopUsageAutoRefresh();

  // Activate context tab and panel
  const contextTab = tabBar.querySelector(".tab-context");
  if (contextTab) contextTab.classList.add("active");
  document.getElementById("context-panel").classList.add("active");
  emptyState.style.display = "none";

  // Load context
  if (activeTeamId) {
    loadTeamContext(activeTeamId);
  }
}

async function loadTeamContext(teamId) {
  try {
    const res = await fetch(`/api/teams/${teamId}/context`);
    const data = await res.json();
    teamContexts.set(teamId, data.entries);
    renderContextPanel(data.entries, data.stats);
  } catch {
    renderContextPanel([], null);
  }
}

function renderContextPanel(entries, stats) {
  const panel = document.getElementById("context-panel-content");
  if (!entries || entries.length === 0) {
    panel.innerHTML = '<div class="context-empty">No shared context yet. Agents will store context here as they analyze the codebase.</div>';
    return;
  }

  const statsHtml = stats ? `
    <div class="context-stats">
      <span class="context-stat">${stats.totalEntries} entries</span>
      <span class="context-stat">${formatBytes(stats.totalBytes)} / ${formatBytes(stats.maxBytes)}</span>
      <span class="context-stat">${stats.usagePercent}% used</span>
    </div>
  ` : "";

  const entriesHtml = entries.map((e) => renderContextEntry(e)).join("");
  panel.innerHTML = statsHtml + `<div class="context-entries">${entriesHtml}</div>`;
}

function renderContextEntry(entry) {
  const time = new Date(entry.lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const storedBy = entry.storedByName ? escapeHtml(entry.storedByName) : "unknown";
  const summary = entry.summary ? escapeHtml(entry.summary) : "(no summary)";

  return `<div class="context-entry">
    <div class="context-entry-header">
      <span class="context-entry-key">${escapeHtml(entry.key)}</span>
      <span class="context-entry-tokens">~${entry.tokens} tokens</span>
    </div>
    <div class="context-entry-summary">${summary}</div>
    <div class="context-entry-meta">
      <span class="context-entry-author">by ${storedBy}</span>
      <span class="context-entry-access">${entry.accessCount}x accessed</span>
      <span class="context-entry-time">${time}</span>
    </div>
  </div>`;
}

function handleTeamContextEvent(msg) {
  const teamId = msg.teamId;

  // Refresh the panel if it's active
  if (contextTabActive && activeTeamId === teamId) {
    loadTeamContext(teamId);
  }
}

// --- Agent idle events (AP5-A) ---

function handleAgentIdleEvent(msg) {
  const event = msg.event;
  const name = event.sessionName || "Agent";

  if (event.type === "agent_idle_warning") {
    // Dim the tab and show idle badge
    const session = sessions.get(event.sessionId);
    if (session && session.tabEl) {
      session.tabEl.classList.add("tab-idle");
      let badge = session.tabEl.querySelector(".agent-state-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "agent-state-badge";
        session.tabEl.querySelector(".tab-name").after(badge);
      }
      badge.className = "agent-state-badge state-idle";
      badge.textContent = "idle";
    }
    showToast(`${name} has been idle for 5+ minutes. Will auto-stop in 5 minutes.`, "warning");
  }

  if (event.type === "agent_idle_killed") {
    // Mark session as exited in local state
    const session = sessions.get(event.sessionId);
    if (session && session.tabEl) {
      session.tabEl.classList.add("tab-idle");
    }
    showToast(`${name} was auto-stopped after 10 minutes idle.`, "error");
  }
}

function showToast(message, level = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add("toast-show"));

  // Auto-dismiss after 6 seconds
  setTimeout(() => {
    toast.classList.remove("toast-show");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    // Fallback removal if transitionend doesn't fire
    setTimeout(() => toast.remove(), 500);
  }, 6000);
}

function startUsageAutoRefresh() {
  stopUsageAutoRefresh();
  usageRefreshInterval = setInterval(() => {
    if (usageTabActive && activeTeamId) refreshUsagePanel();
  }, 5000);
}

function stopUsageAutoRefresh() {
  if (usageRefreshInterval) {
    clearInterval(usageRefreshInterval);
    usageRefreshInterval = null;
  }
}

function sendResize(session) {
  const { cols, rows } = session.terminal;
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

async function closeTab(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // If part of a team, remove from team's agentIds
  if (session.teamId) {
    const team = teams.get(session.teamId);
    if (team) {
      try {
        await fetch(`/api/teams/${session.teamId}/agents/${sessionId}`, { method: "DELETE" });
      } catch {}
      const idx = team.agentIds.indexOf(sessionId);
      if (idx !== -1) team.agentIds.splice(idx, 1);
      updateTeamBadge(session.teamId);
    }
  } else {
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    } catch {}
  }

  session.ws.close();
  session.terminal.dispose();
  session.tabEl.remove();
  session.wrapperEl.remove();
  sessions.delete(sessionId);

  updateSessionCount();

  if (activeSessionId === sessionId) {
    // Find next tab in same team
    const team = activeTeamId ? teams.get(activeTeamId) : null;
    const remaining = team ? team.agentIds.filter((id) => sessions.has(id)) : [];
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    } else {
      activeSessionId = null;
      emptyState.style.display = "";
      statusText.textContent = "Ready";
    }
  }
}

function updateSessionCount() {
  let count = 0;
  if (activeTeamId) {
    const team = teams.get(activeTeamId);
    if (team) count = team.agentIds.length;
  }
  sessionCount.textContent = `${count} agent${count !== 1 ? "s" : ""}`;
}

// --- Team-update WebSocket handler ---

function handleTeamUpdate(msg) {
  switch (msg.event) {
    case "agent-added": {
      const team = teams.get(msg.teamId);
      if (!team) break;
      // Avoid duplicates
      if (!team.agentIds.includes(msg.agent.id)) {
        team.agentIds.push(msg.agent.id);
      }
      // Only attach if we don't already have it
      if (!sessions.has(msg.agent.id)) {
        attachSession(msg.agent);
        // If this team is active, show the tab
        if (msg.teamId === activeTeamId) {
          const s = sessions.get(msg.agent.id);
          if (s) s.tabEl.style.display = "";
        }
      }
      updateTeamBadge(msg.teamId);
      updateSessionCount();
      statusText.textContent = `Agent "${msg.agent.name}" spawned in team`;
      break;
    }
    case "agent-removed": {
      const team = teams.get(msg.teamId);
      if (team) {
        const idx = team.agentIds.indexOf(msg.agentId);
        if (idx !== -1) team.agentIds.splice(idx, 1);
        updateTeamBadge(msg.teamId);
      }
      // Session cleanup handled by closeTab if initiated locally
      break;
    }
    case "team-relaunched": {
      const team = teams.get(msg.teamId);
      if (team) {
        team.agentIds = msg.team.agentIds;
        team.status = "running";
      }
      // Re-render sidebar item
      const sideEl = teamList.querySelector(`[data-team-id="${msg.teamId}"]`);
      if (sideEl) {
        sideEl.replaceWith(renderTeamItem({ id: msg.teamId, name: msg.team.name, agentIds: msg.team.agentIds, status: "running" }));
      }
      // Attach main agent
      if (msg.agent && !sessions.has(msg.agent.id)) {
        attachSession(msg.agent);
      }
      if (msg.teamId === activeTeamId) {
        selectTeam(msg.teamId);
      }
      updateSessionCount();
      statusText.textContent = `Team "${msg.team.name}" re-launched`;
      break;
    }
    case "team-deleted": {
      const team = teams.get(msg.teamId);
      if (team) {
        // Clean up all sessions in this team
        for (const agentId of [...team.agentIds]) {
          const s = sessions.get(agentId);
          if (s) {
            s.ws.close();
            s.terminal.dispose();
            s.tabEl.remove();
            s.wrapperEl.remove();
            sessions.delete(agentId);
          }
        }
        teams.delete(msg.teamId);
        teamMessages.delete(msg.teamId);
        teamTasks.delete(msg.teamId);
        teamEvents.delete(msg.teamId);
        teamContexts.delete(msg.teamId);
        const el = teamList.querySelector(`[data-team-id="${msg.teamId}"]`);
        if (el) el.remove();

        if (activeTeamId === msg.teamId) {
          const remaining = Array.from(teams.keys());
          if (remaining.length > 0) {
            selectTeam(remaining[0]);
          } else {
            activeTeamId = null;
            activeSessionId = null;
            newAgentBtn.disabled = true;
            tabBar.innerHTML = "";
            emptyState.style.display = "";
            updateSessionCount();
          }
        }
      }
      break;
    }
  }
}

// --- Role Editor ---

function renderRoleList() {
  if (currentRoles.length === 0) {
    roleListEl.innerHTML = '<div class="role-list-empty">No roles defined. Add roles below.</div>';
    return;
  }
  roleListEl.innerHTML = "";
  currentRoles.forEach((role, i) => {
    if (i === editingRoleIndex) {
      roleListEl.appendChild(renderRoleEditForm(role, i));
    } else {
      roleListEl.appendChild(renderRoleItem(role, i));
    }
  });
}

function renderRoleItem(role, index) {
  const el = document.createElement("div");
  el.className = "role-item";
  const modelBadge = role.model ? `<span class="role-model-badge">${modelLabel(role.model)}</span>` : "";
  el.innerHTML = `
    <span class="role-item-number">${index + 1}</span>
    <div class="role-item-info">
      <span class="role-item-title">${role.title}${modelBadge}</span>
      <span class="role-item-responsibility">${role.responsibility}</span>
    </div>
    <div class="role-item-actions">
      <button class="edit-role" title="Edit">Edit</button>
      <button class="remove-role" title="Remove">&times;</button>
    </div>
  `;
  el.querySelector(".edit-role").addEventListener("click", () => {
    editingRoleIndex = index;
    renderRoleList();
  });
  el.querySelector(".remove-role").addEventListener("click", () => {
    currentRoles.splice(index, 1);
    if (editingRoleIndex === index) editingRoleIndex = -1;
    else if (editingRoleIndex > index) editingRoleIndex--;
    templateSelect.value = "";
    renderRoleList();
  });
  return el;
}

function renderRoleEditForm(role, index) {
  const el = document.createElement("div");
  el.className = "role-edit-form";
  const modelOptionsHtml = MODEL_OPTIONS.map(
    (o) => `<option value="${o.value}"${o.value === (role.model || "") ? " selected" : ""}>${o.label}</option>`
  ).join("");
  el.innerHTML = `
    <div class="role-edit-fields">
      <input type="text" class="edit-title" value="${role.title}" placeholder="Title (e.g. Architect)" />
      <input type="text" class="edit-responsibility" value="${role.responsibility}" placeholder="Responsibility (e.g. Research & Planning)" />
      <textarea class="edit-description" rows="2" placeholder="Description...">${role.description}</textarea>
      <div class="role-edit-model-row">
        <label>Model</label>
        <select class="edit-model">${modelOptionsHtml}</select>
      </div>
    </div>
    <div class="role-edit-actions">
      <button class="modal-btn secondary small cancel-edit">Cancel</button>
      <button class="modal-btn primary small save-edit">Save</button>
    </div>
  `;
  el.querySelector(".save-edit").addEventListener("click", () => {
    const title = el.querySelector(".edit-title").value.trim();
    const responsibility = el.querySelector(".edit-responsibility").value.trim();
    const description = el.querySelector(".edit-description").value.trim();
    const model = el.querySelector(".edit-model").value || undefined;
    if (title && responsibility) {
      currentRoles[index] = { id: role.id || title.toLowerCase().replace(/\s+/g, "-"), title, responsibility, description, model };
      editingRoleIndex = -1;
      templateSelect.value = "";
      renderRoleList();
    }
  });
  el.querySelector(".cancel-edit").addEventListener("click", () => {
    editingRoleIndex = -1;
    renderRoleList();
  });
  return el;
}

function addRole(role) {
  currentRoles.push({ ...role });
  templateSelect.value = "";
  renderRoleList();
}

async function loadTemplates() {
  try {
    const res = await fetch("/api/templates");
    savedTemplates = await res.json();
  } catch {
    savedTemplates = [];
  }
  populateTemplateDropdown();
}

async function loadBuiltinRoles() {
  try {
    const res = await fetch("/api/builtin-roles");
    const data = await res.json();
    builtinRoles = data.builtin;
    extraRoles = data.extra;
  } catch {
    builtinRoles = [];
    extraRoles = [];
  }
  populateQuickAdd();
}

function populateTemplateDropdown() {
  // Keep first two options (Custom + Standard 4-Agent), remove the rest
  while (templateSelect.options.length > 2) {
    templateSelect.remove(2);
  }
  for (const t of savedTemplates) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    templateSelect.appendChild(opt);
  }
}

function populateQuickAdd() {
  quickAddSelect.innerHTML = '<option value="">Quick-add...</option>';
  const allRoles = [...builtinRoles, ...extraRoles];
  for (const role of allRoles) {
    const opt = document.createElement("option");
    opt.value = role.id;
    opt.textContent = role.title;
    quickAddSelect.appendChild(opt);
  }
}

function applyTemplate(templateId) {
  if (templateId === "__default__") {
    currentRoles = builtinRoles.map((r) => ({ ...r }));
  } else {
    const template = savedTemplates.find((t) => t.id === templateId);
    if (template) {
      currentRoles = template.roles.map((r) => ({ ...r }));
    }
  }
  editingRoleIndex = -1;
  renderRoleList();
}

async function saveTemplate() {
  if (currentRoles.length === 0) return;
  const name = prompt("Template name:");
  if (!name) return;
  try {
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, roles: currentRoles }),
    });
    const template = await res.json();
    savedTemplates.push(template);
    populateTemplateDropdown();
    templateSelect.value = template.id;
  } catch {}
}

async function deleteTemplate() {
  const id = templateSelect.value;
  if (!id || id === "__default__") return;
  try {
    await fetch(`/api/templates/${id}`, { method: "DELETE" });
    savedTemplates = savedTemplates.filter((t) => t.id !== id);
    populateTemplateDropdown();
    templateSelect.value = "";
  } catch {}
}

// --- Modal logic ---

function showNewTeamModal() {
  teamNameInput.value = "";
  pathInput.value = "";
  promptInput.value = "";
  modelSelect.value = "";
  // Init with default 4 roles
  currentRoles = builtinRoles.map((r) => ({ ...r }));
  editingRoleIndex = -1;
  templateSelect.value = "__default__";
  renderRoleList();
  modalOverlay.classList.remove("hidden");
  teamNameInput.focus();
}

function hideModal() {
  modalOverlay.classList.add("hidden");
}

function showNewAgentModal() {
  agentNameInput.value = "";
  agentPromptInput.value = "";
  agentModelSelect.value = "";
  agentModalOverlay.classList.remove("hidden");
  agentNameInput.focus();
}

function hideAgentModal() {
  agentModalOverlay.classList.add("hidden");
}

async function browseForFolder() {
  browseBtn.disabled = true;
  browseBtn.textContent = "Opening...";
  try {
    const res = await fetch("/api/browse-folder");
    const data = await res.json();
    if (!data.cancelled && data.path) {
      pathInput.value = data.path;
    }
  } catch (err) {
    statusText.textContent = `Browse error: ${err.message}`;
  } finally {
    browseBtn.disabled = false;
    browseBtn.textContent = "Browse";
  }
}

async function createNewTeam() {
  const name = teamNameInput.value.trim();
  const cwd = pathInput.value.trim() || undefined;
  const prompt = promptInput.value.trim();
  const roles = currentRoles.length > 0 ? currentRoles : undefined;
  const model = modelSelect.value || undefined;

  if (!name) { teamNameInput.focus(); return; }
  if (!prompt) { promptInput.focus(); return; }

  hideModal();
  newTeamBtn.disabled = true;
  statusText.textContent = "Creating team...";

  try {
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cwd, prompt, roles, model }),
    });
    const data = await res.json();

    // Add team to state
    const team = {
      id: data.team.id,
      name: data.team.name,
      agentIds: data.team.agentIds,
    };
    teams.set(team.id, team);

    // Add to sidebar
    teamList.appendChild(renderTeamItem(team));

    // Attach main agent session
    attachSession(data.mainAgent);

    // Select this team
    selectTeam(team.id);

    statusText.textContent = `Team "${name}" created`;
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  } finally {
    newTeamBtn.disabled = false;
  }
}

async function spawnNewAgent() {
  if (!activeTeamId) return;

  const name = agentNameInput.value.trim();
  const prompt = agentPromptInput.value.trim();
  const model = agentModelSelect.value || undefined;

  if (!name) { agentNameInput.focus(); return; }
  if (!prompt) { agentPromptInput.focus(); return; }

  hideAgentModal();
  statusText.textContent = "Spawning agent...";

  try {
    const res = await fetch(`/api/teams/${activeTeamId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt, model }),
    });
    const data = await res.json();

    // The team-update broadcast will handle adding the tab,
    // but we also attach here in case broadcast arrives late
    const team = teams.get(activeTeamId);
    if (team && !team.agentIds.includes(data.id)) {
      team.agentIds.push(data.id);
    }
    if (!sessions.has(data.id)) {
      attachSession(data);
    }
    updateTeamBadge(activeTeamId);
    updateSessionCount();

    // Show and switch to the new agent
    const s = sessions.get(data.id);
    if (s) s.tabEl.style.display = "";
    switchTab(data.id);

    statusText.textContent = `Agent "${name}" spawned`;
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  }
}

async function relaunchTeam(teamId) {
  statusText.textContent = "Re-launching team...";
  try {
    const res = await fetch(`/api/teams/${teamId}/relaunch`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      statusText.textContent = `Error: ${err.error}`;
      return;
    }
    const data = await res.json();

    // Update local team state
    const team = teams.get(teamId);
    if (team) {
      team.agentIds = data.team.agentIds;
      team.status = "running";
    }

    // Re-render sidebar item
    const el = teamList.querySelector(`[data-team-id="${teamId}"]`);
    if (el) {
      el.replaceWith(renderTeamItem({ id: teamId, name: data.team.name, agentIds: data.team.agentIds, status: "running" }));
    }

    // Attach main agent session
    attachSession(data.mainAgent);

    // Select this team
    selectTeam(teamId);

    statusText.textContent = `Team "${data.team.name}" re-launched`;
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  }
}

async function deleteTeam(teamId) {
  statusText.textContent = "Deleting team...";
  try {
    await fetch(`/api/teams/${teamId}`, { method: "DELETE" });
  } catch {}

  // handleTeamUpdate will be called by broadcast, but also do local cleanup
  const team = teams.get(teamId);
  if (team) {
    for (const agentId of [...team.agentIds]) {
      const s = sessions.get(agentId);
      if (s) {
        s.ws.close();
        s.terminal.dispose();
        s.tabEl.remove();
        s.wrapperEl.remove();
        sessions.delete(agentId);
      }
    }
    teams.delete(teamId);
    const el = teamList.querySelector(`[data-team-id="${teamId}"]`);
    if (el) el.remove();
  }

  if (activeTeamId === teamId) {
    const remaining = Array.from(teams.keys());
    if (remaining.length > 0) {
      selectTeam(remaining[0]);
    } else {
      activeTeamId = null;
      activeSessionId = null;
      newAgentBtn.disabled = true;
      tabBar.innerHTML = "";
      emptyState.style.display = "";
      updateSessionCount();
      statusText.textContent = "Ready";
    }
  }
}

// --- Load existing teams on page load ---

async function loadExistingTeams() {
  try {
    const res = await fetch("/api/teams");
    const teamsList = await res.json();

    for (const teamData of teamsList) {
      const team = {
        id: teamData.id,
        name: teamData.name,
        agentIds: teamData.agentIds,
        status: teamData.status || "running",
      };
      teams.set(team.id, team);
      teamList.appendChild(renderTeamItem(team));

      // Only load agents for running teams (stopped teams have no PTY sessions)
      if (team.status !== "stopped" && team.agentIds.length > 0) {
        const agentsRes = await fetch(`/api/teams/${team.id}/agents`);
        const agents = await agentsRes.json();
        for (const agent of agents) {
          attachSession(agent);
        }
      }
    }

    if (teamsList.length > 0) {
      selectTeam(teamsList[0].id);
    }
  } catch {}
}

// --- Window resize ---
window.addEventListener("resize", () => {
  if (activeSessionId) {
    const session = sessions.get(activeSessionId);
    if (session) {
      session.fitAddon.fit();
      sendResize(session);
    }
  }
});

// --- Usage polling ---
setInterval(async () => {
  // Status bar update for active session
  if (sessions.size > 0) {
    try {
      const res = await fetch("/api/sessions");
      const list = await res.json();
      for (const data of list) {
        const session = sessions.get(data.id);
        if (session && data.id === activeSessionId) {
          const dur = Math.floor(data.usage.durationMs / 1000);
          const mins = Math.floor(dur / 60);
          const secs = dur % 60;
          const inKB = (data.usage.bytesIn / 1024).toFixed(1);
          const outKB = (data.usage.bytesOut / 1024).toFixed(1);
          statusText.textContent = `${data.name} | ${data.status} | ${mins}m ${secs}s | In: ${inKB}KB | Out: ${outKB}KB`;
        }
      }
    } catch {}
  }

  // Sidebar token summary update
  if (teams.size > 0) {
    refreshSidebarTokens();
  }
}, 5000);

// --- Event listeners ---

// Usage tab
document.getElementById("usage-btn").addEventListener("click", () => {
  if (!activeTeamId) return;
  switchToUsageTab();
});

// Team modal
newTeamBtn.addEventListener("click", showNewTeamModal);
browseBtn.addEventListener("click", browseForFolder);
modalCancel.addEventListener("click", hideModal);
modalStart.addEventListener("click", createNewTeam);
teamNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pathInput.focus();
  if (e.key === "Escape") hideModal();
});
pathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") promptInput.focus();
  if (e.key === "Escape") hideModal();
});
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) createNewTeam();
  if (e.key === "Escape") hideModal();
});
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) hideModal();
});

// Agent modal
newAgentBtn.addEventListener("click", showNewAgentModal);
agentModalCancel.addEventListener("click", hideAgentModal);
agentModalStart.addEventListener("click", spawnNewAgent);
agentNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") agentPromptInput.focus();
  if (e.key === "Escape") hideAgentModal();
});
agentPromptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) spawnNewAgent();
  if (e.key === "Escape") hideAgentModal();
});
agentModalOverlay.addEventListener("click", (e) => {
  if (e.target === agentModalOverlay) hideAgentModal();
});

// Role editor events
templateSelect.addEventListener("change", () => {
  const val = templateSelect.value;
  if (val) applyTemplate(val);
});
templateSaveBtn.addEventListener("click", saveTemplate);
templateDeleteBtn.addEventListener("click", deleteTemplate);
addRoleBtn.addEventListener("click", () => {
  const newRole = { id: `role-${Date.now()}`, title: "", responsibility: "", description: "" };
  currentRoles.push(newRole);
  editingRoleIndex = currentRoles.length - 1;
  templateSelect.value = "";
  renderRoleList();
});
quickAddSelect.addEventListener("change", () => {
  const id = quickAddSelect.value;
  if (!id) return;
  const allRoles = [...builtinRoles, ...extraRoles];
  const role = allRoles.find((r) => r.id === id);
  if (role) addRole(role);
  quickAddSelect.value = "";
});

// Events panel filter listeners
document.getElementById("events-filter-type").addEventListener("change", () => {
  if (eventsTabActive && activeTeamId && teamEvents.has(activeTeamId)) {
    renderEventsPanel(teamEvents.get(activeTeamId));
  }
});
document.getElementById("events-filter-agent").addEventListener("change", () => {
  if (eventsTabActive && activeTeamId && teamEvents.has(activeTeamId)) {
    renderEventsPanel(teamEvents.get(activeTeamId));
  }
});

// Init
loadBuiltinRoles();
loadTemplates();
loadExistingTeams();
