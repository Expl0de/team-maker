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

// Track handled idle events to avoid duplicate toasts from multiple WebSocket connections
const handledIdleEvents = new Set();

// P1-21: Persistent tab selection helpers
function getActiveTabName() {
  if (teamTabActive) return "team";
  if (usageTabActive) return "usage";
  if (messagesTabActive) return "messages";
  if (tasksTabActive) return "tasks";
  if (eventsTabActive) return "events";
  if (contextTabActive) return "context";
  if (filesTabActive) return "files";
  if (activeSessionId) return `session:${activeSessionId}`;
  return "team";
}

function saveTabState() {
  try {
    localStorage.setItem("tm_activeTeamId", activeTeamId || "");
    localStorage.setItem("tm_activeTab", getActiveTabName());
  } catch (_) { /* localStorage unavailable */ }
}

function getSavedTabState() {
  try {
    return {
      teamId: localStorage.getItem("tm_activeTeamId") || null,
      tab: localStorage.getItem("tm_activeTab") || "team",
    };
  } catch (_) {
    return { teamId: null, tab: "team" };
  }
}

// Team tab state
let teamTabActive = false;
let selectedFlowAgentId = null; // which agent is selected in the flow graph

// Files tab state
let filesTabActive = false;
const teamFiles = new Map(); // teamId -> file[]

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

// --- P1-12: Fetch with timeout wrapper ---

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

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
          <span class="usage-agent-name">${escapeHtml(a.name)}</span>
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
    const res = await fetchWithTimeout(`/api/teams/${activeTeamId}/usage`);
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
      const res = await fetchWithTimeout(`/api/teams/${teamId}/usage`);
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
  // Update tab dot
  const dot = session.tabEl.querySelector(".status-dot");
  dot.classList.add("question");
  if (sessionId === activeSessionId && document.hasFocus()) {
    setTimeout(() => dot.classList.remove("question"), 3000);
  }
  // Update flow graph node dot
  const nodeDot = document.querySelector(`.agent-node[data-session-id="${sessionId}"] .node-status-dot`);
  if (nodeDot) {
    nodeDot.classList.add("question");
    if (sessionId === selectedFlowAgentId && document.hasFocus()) {
      setTimeout(() => nodeDot.classList.remove("question"), 3000);
    }
  }
}

function handleActivityUpdate(sessionId, active) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const dot = session.tabEl.querySelector(".status-dot");
  if (active) {
    dot.classList.add("working");
    // Clear idle dedup keys so future idle events can trigger toasts again
    handledIdleEvents.delete(`${sessionId}:agent_idle_warning`);
    handledIdleEvents.delete(`${sessionId}:agent_idle_killed`);
  } else {
    dot.classList.remove("working");
  }
  // Update flow graph node dot
  const nodeDot = document.querySelector(`.agent-node[data-session-id="${sessionId}"] .node-status-dot`);
  if (nodeDot) {
    if (active) {
      nodeDot.classList.add("working");
    } else {
      nodeDot.classList.remove("working");
    }
  }
}

// DOM elements
const tabBar = document.getElementById("tab-bar");
const terminalContainer = document.getElementById("terminal-container");
const emptyState = document.getElementById("empty-state");
const newTeamBtn = document.getElementById("new-team-btn");
const newAgentBtn = document.getElementById("new-agent-btn");
const importTeamBtn = document.getElementById("import-team-btn");
importTeamBtn.addEventListener("click", () => importTeam());
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
      <button class="export-team-btn" title="Export team config">&#8615;</button>
      ${isStopped ? '<button class="relaunch-team-btn" title="Re-launch team">&#8635;</button>' : ""}
      <button class="delete-team-btn" title="Delete team">&times;</button>
    </div>
  `;
  el.addEventListener("click", (e) => {
    if (!e.target.classList.contains("delete-team-btn") && !e.target.classList.contains("relaunch-team-btn") && !e.target.classList.contains("export-team-btn")) {
      selectTeam(team.id);
    }
  });
  el.querySelector(".delete-team-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTeam(team.id);
  });
  el.querySelector(".export-team-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    exportTeam(team.id);
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
  selectedFlowAgentId = null;
  saveTabState(); // P1-21

  // Update sidebar active state
  teamList.querySelectorAll(".team-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.teamId === teamId);
  });

  // Enable/disable new agent button (disabled for stopped teams)
  const selectedTeam = teamId ? teams.get(teamId) : null;
  newAgentBtn.disabled = !teamId || (selectedTeam && selectedTeam.status === "stopped");

  // Create meta-tabs if needed
  const tabConfigs = [
    { cls: ".tab-team", create: createTeamTab },
    { cls: ".tab-usage", create: createUsageTab },
    { cls: ".tab-messages", create: createMessagesTab },
    { cls: ".tab-tasks", create: createTasksTab },
    { cls: ".tab-events", create: createEventsTab },
    { cls: ".tab-context", create: createContextTab },
    { cls: ".tab-files", create: createFilesTab },
  ];
  for (const { cls, create } of tabConfigs) {
    const existing = tabBar.querySelector(cls);
    if (teamId) {
      if (!existing) create();
      else existing.style.display = "";
    } else if (existing) {
      existing.style.display = "none";
    }
  }

  // Hide all individual agent tabs (Team tab replaces them)
  tabBar.querySelectorAll(".tab:not(.tab-team):not(.tab-usage):not(.tab-messages):not(.tab-tasks):not(.tab-events):not(.tab-context):not(.tab-files)").forEach((t) => {
    t.style.display = "none";
  });
  // Deactivate non-team terminal wrappers
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#usage-panel):not(#messages-panel):not(#tasks-panel):not(#context-panel):not(#files-panel):not(#events-panel):not(#team-panel)").forEach((w) => {
    w.classList.remove("active");
  });

  // Clear embedded terminals from previous team's console area
  const consoleArea = document.getElementById("team-console-area");
  consoleArea.querySelectorAll(".terminal-wrapper-embedded").forEach((el) => {
    // Move xterm DOM back to original wrapper before removing
    const sid = el.dataset.sessionId;
    const session = sessions.get(sid);
    if (session) {
      const xtermEl = el.querySelector(".xterm");
      if (xtermEl) session.wrapperEl.appendChild(xtermEl);
    }
    el.remove();
  });
  const placeholder = document.getElementById("team-console-placeholder");
  if (placeholder) placeholder.style.display = "";

  // Decide which tab to show
  if (usageTabActive) {
    switchToUsageTab();
  } else if (tasksTabActive) {
    switchToTasksTab();
  } else if (messagesTabActive) {
    switchToMessagesTab();
  } else if (eventsTabActive) {
    switchToEventsTab();
  } else if (contextTabActive) {
    switchToContextTab();
  } else if (filesTabActive) {
    switchToFilesTab();
  } else {
    // Default to Team tab
    const team = teams.get(teamId);
    if (team && team.status === "stopped") {
      activeSessionId = null;
      emptyState.innerHTML = `<p>Team "${team.name}" is stopped</p><p>Click the <strong>&#8635;</strong> button in the sidebar to re-launch it</p>`;
      emptyState.style.display = "";
    } else if (team && team.agentIds.length > 0) {
      switchToTeamTab();
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
    <div class="tab-kebab" title="Actions">
      <button class="kebab-btn">⋮</button>
      <div class="kebab-menu">
        <button class="kebab-item clear-context-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Clear context</button>
        <button class="kebab-item close-agent-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Close agent</button>
      </div>
    </div>
  `;
  tab.addEventListener("click", (e) => {
    if (e.target.closest(".tab-kebab")) return;
    switchTab(data.id);
  });
  // Kebab menu toggle
  tab.querySelector(".kebab-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = tab.querySelector(".kebab-menu");
    // Close all other open kebab menus first
    document.querySelectorAll(".kebab-menu.open").forEach((m) => {
      if (m !== menu) m.classList.remove("open");
    });
    menu.classList.toggle("open");
  });
  tab.querySelector(".clear-context-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    tab.querySelector(".kebab-menu").classList.remove("open");
    clearSessionContext(data.id);
  });
  tab.querySelector(".close-agent-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    tab.querySelector(".kebab-menu").classList.remove("open");
    closeTab(data.id);
  });
  tabBar.appendChild(tab);

  // Create terminal wrapper
  const wrapper = document.createElement("div");
  wrapper.className = "terminal-wrapper";
  wrapper.dataset.id = data.id;
  terminalContainer.appendChild(wrapper);

  const { terminal, fitAddon } = createTerminal(wrapper);

  // Add starting overlay if agent is still initializing (blocks input)
  const isStarting = !data.agentState || data.agentState === "starting";
  if (isStarting) {
    const overlay = document.createElement("div");
    overlay.className = "starting-overlay";
    overlay.innerHTML = `
      <div class="starting-spinner"></div>
      <div class="starting-text">Agent is starting…</div>
    `;
    wrapper.appendChild(overlay);

    // After 15s, add a close button so the user can dismiss a stuck overlay
    const closeTimer = setTimeout(() => {
      if (!overlay.isConnected) return;
      const btn = document.createElement("button");
      btn.className = "starting-close-btn";
      btn.textContent = "Close";
      btn.addEventListener("click", () => {
        overlay.remove();
        // Also remove from embedded wrapper in team console
        const embedded = document.querySelector(
          `#team-console-area .terminal-wrapper-embedded[data-session-id="${data.id}"] .starting-overlay`
        );
        if (embedded) embedded.remove();
      });
      overlay.appendChild(btn);
    }, 15000);

    // Cancel the timer if the overlay is removed before 15s (normal start)
    new MutationObserver((_, obs) => {
      if (!overlay.isConnected) {
        clearTimeout(closeTimer);
        obs.disconnect();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Connect WebSocket
  const ws = new WebSocket(getWsUrl());

  const session = {
    id: data.id,
    name: data.name,
    teamId: data.teamId,
    role: data.role,
    agentIndex: data.agentIndex,
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
          // Update flow graph node
          const exitNodeDot = document.querySelector(`.agent-node[data-session-id="${data.id}"] .node-status-dot`);
          if (exitNodeDot) {
            exitNodeDot.classList.add("exited");
            exitNodeDot.classList.remove("working", "question");
          }
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
      } catch (e) {
        // P1-5: Log parse/handler errors; if not a JSON parse error, it's a real bug
        if (!(e instanceof SyntaxError)) {
          console.warn("[WS] Error handling message:", e);
        }
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
    // Block input while starting overlay is visible
    if (wrapper.querySelector(".starting-overlay")) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: input }));
    }
  });

  sessions.set(data.id, session);

  // Always hide individual agent tabs — Team tab flow graph replaces them
  tab.style.display = "none";

  // Update flow graph if this agent belongs to the active team
  if (data.teamId === activeTeamId && teamTabActive) {
    renderTeamFlowGraph();
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

    // P1-1: Refresh state after reconnect to avoid stale data
    if (session.teamId) {
      refreshSidebarTokens();
      if (usageTabActive && activeTeamId === session.teamId) refreshUsagePanel();
      if (eventsTabActive && activeTeamId === session.teamId) loadTeamEvents(session.teamId);
      if (contextTabActive && activeTeamId === session.teamId) loadTeamContext(session.teamId);
      if (filesTabActive && activeTeamId === session.teamId) loadTeamFiles(session.teamId);
      if (messagesTabActive && activeTeamId === session.teamId) loadTeamMessages(session.teamId);
      if (tasksTabActive && activeTeamId === session.teamId) loadTeamTasks(session.teamId);
    }
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "exit") {
          session.status = "exited";
          session.tabEl.querySelector(".status-dot").classList.add("exited");
          const exitNodeDot = document.querySelector(`.agent-node[data-session-id="${sessionId}"] .node-status-dot`);
          if (exitNodeDot) {
            exitNodeDot.classList.add("exited");
            exitNodeDot.classList.remove("working", "question");
          }
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
      } catch (e) {
        // P1-5: Log parse/handler errors instead of swallowing silently
        console.warn("[WS reconnect] Error handling message:", e);
      }
    }
    session.terminal.write(event.data);
  };

  ws.onclose = () => {
    if (sessions.has(sessionId)) {
      setTimeout(() => reconnect(sessionId), 2000);
    }
  };

  session.terminal.onData((input) => {
    // Block input while starting overlay is visible
    if (session.wrapperEl.querySelector(".starting-overlay")) return;
    const embeddedEl = document.querySelector(`#team-console-area .terminal-wrapper-embedded[data-session-id="${sessionId}"] .starting-overlay`);
    if (embeddedEl) return;
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
  filesTabActive = false;
  teamTabActive = false;

  // Deactivate all meta-tabs
  const metaTabs = [".tab-usage", ".tab-messages", ".tab-tasks", ".tab-events", ".tab-context", ".tab-files", ".tab-team"];
  metaTabs.forEach((sel) => {
    const t = tabBar.querySelector(sel);
    if (t) t.classList.remove("active");
  });
  const metaPanels = ["usage-panel", "messages-panel", "tasks-panel", "events-panel", "context-panel", "files-panel", "team-panel"];
  metaPanels.forEach((id) => document.getElementById(id).classList.remove("active"));
  stopUsageAutoRefresh();

  tabBar.querySelectorAll(".tab:not(.tab-usage):not(.tab-messages):not(.tab-tasks):not(.tab-events):not(.tab-context):not(.tab-files):not(.tab-team)").forEach((t) => {
    t.classList.toggle("active", t.dataset.id === sessionId);
  });

  terminalContainer.querySelectorAll(".terminal-wrapper:not(#usage-panel):not(#messages-panel):not(#tasks-panel):not(#events-panel):not(#context-panel):not(#files-panel):not(#team-panel)").forEach((w) => {
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
  saveTabState(); // P1-21
}

// --- Team tab (flow graph) ---

function createTeamTab() {
  const existing = tabBar.querySelector(".tab-team");
  if (existing) existing.remove();

  const tab = document.createElement("div");
  tab.className = "tab tab-team";
  tab.innerHTML = `<span class="team-tab-icon">🌐</span><span class="tab-name">Team</span>`;
  tab.addEventListener("click", () => switchToTeamTab());

  // Insert as first tab
  tabBar.prepend(tab);
  return tab;
}

function switchToTeamTab() {
  teamTabActive = true;
  usageTabActive = false;
  messagesTabActive = false;
  tasksTabActive = false;
  eventsTabActive = false;
  contextTabActive = false;
  filesTabActive = false;
  activeSessionId = null;

  // Deactivate all other tabs and wrappers
  tabBar.querySelectorAll(".tab:not(.tab-team)").forEach((t) => t.classList.remove("active"));
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#team-panel)").forEach((w) => w.classList.remove("active"));
  stopUsageAutoRefresh();

  // Activate team tab and panel
  const teamTab = tabBar.querySelector(".tab-team");
  if (teamTab) teamTab.classList.add("active");
  document.getElementById("team-panel").classList.add("active");
  emptyState.style.display = "none";

  // Render flow graph
  renderTeamFlowGraph();

  // Auto-select main agent if nothing selected
  if (!selectedFlowAgentId || !sessions.has(selectedFlowAgentId)) {
    const team = activeTeamId ? teams.get(activeTeamId) : null;
    if (team && team.agentIds.length > 0) {
      selectAgentInFlow(team.agentIds[0]);
    }
  } else {
    selectAgentInFlow(selectedFlowAgentId);
  }
  saveTabState(); // P1-21
}

function renderTeamFlowGraph() {
  const nodesContainer = document.getElementById("team-flow-nodes");
  nodesContainer.innerHTML = "";

  if (!activeTeamId) return;
  const team = teams.get(activeTeamId);
  if (!team) return;

  let mainSession = null;
  const agentSessions = [];

  for (const agentId of team.agentIds) {
    const session = sessions.get(agentId);
    if (!session) continue;
    if (session.role === "main") {
      mainSession = session;
    } else {
      agentSessions.push(session);
    }
  }

  // Render main node
  if (mainSession) {
    nodesContainer.appendChild(createAgentNode(mainSession));
  }

  // Render child agents with connectors
  if (agentSessions.length > 0 && mainSession) {
    // Vertical connector from main
    const connector = document.createElement("div");
    connector.className = "agent-connector";
    nodesContainer.appendChild(connector);

    if (agentSessions.length === 1) {
      // Single child — just stack vertically
      nodesContainer.appendChild(createAgentNode(agentSessions[0]));
    } else {
      // Multiple children — branch row
      const branchRow = document.createElement("div");
      branchRow.className = "agent-branch-row";
      for (const s of agentSessions) {
        const item = document.createElement("div");
        item.className = "agent-branch-item";
        const branchConn = document.createElement("div");
        branchConn.className = "agent-connector";
        item.appendChild(branchConn);
        item.appendChild(createAgentNode(s));
        branchRow.appendChild(item);
      }
      nodesContainer.appendChild(branchRow);
    }
  }
}

function createAgentNode(session) {
  const node = document.createElement("div");
  node.className = "agent-node" + (session.id === selectedFlowAgentId ? " selected" : "");
  node.dataset.sessionId = session.id;

  const isMain = session.role === "main";
  const roleLabel = isMain ? "main" : (session.agentIndex || "?");
  const roleClass = isMain ? "" : " agent";
  const displayName = session.name.replace(/^Agent\s*\d+\s*[-–—]\s*/i, "");

  // Status dot classes
  const dotClasses = ["node-status-dot"];
  if (session.status === "exited") dotClasses.push("exited");
  // Check tab dot for working/question state (mirroring)
  const tabDot = session.tabEl.querySelector(".status-dot");
  if (tabDot) {
    if (tabDot.classList.contains("working")) dotClasses.push("working");
    if (tabDot.classList.contains("question")) dotClasses.push("question");
  }

  // Agent state badge
  const agentState = agentStates.get(session.id);
  let stateBadgeHtml = "";
  if (agentState && agentState.state && agentState.state !== "starting" && agentState.state !== "idle") {
    const stateText = agentState.state === "tool_calling" ? (agentState.lastToolCall?.name || "tool") : agentState.state;
    stateBadgeHtml = `<span class="node-state-badge state-${agentState.state}">${stateText}</span>`;
  }

  node.innerHTML = `
    <div class="agent-node-header">
      <span class="${dotClasses.join(" ")}"></span>
      <span class="node-role-badge${roleClass}">🤖 ${roleLabel}</span>
      <span class="node-name" title="${escapeHtml(session.name)}">${escapeHtml(displayName)}</span>
      <div class="node-kebab" title="Actions">
        <button class="node-kebab-btn">⋮</button>
        <div class="node-kebab-menu">
          <button class="kebab-item node-clear-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Clear context</button>
          <button class="kebab-item node-restart-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Restart agent</button>
          <button class="kebab-item node-close-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Close agent</button>
        </div>
      </div>
    </div>
    <div class="agent-node-footer">
      ${stateBadgeHtml}
    </div>
  `;

  // Kebab menu on agent node
  node.querySelector(".node-kebab-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = node.querySelector(".node-kebab-menu");
    document.querySelectorAll(".node-kebab-menu.open, .kebab-menu.open").forEach((m) => {
      if (m !== menu) m.classList.remove("open");
    });
    menu.classList.toggle("open");
  });
  node.querySelector(".node-clear-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    node.querySelector(".node-kebab-menu").classList.remove("open");
    clearSessionContext(session.id);
  });
  node.querySelector(".node-restart-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    node.querySelector(".node-kebab-menu").classList.remove("open");
    restartAgent(session.id);
  });
  node.querySelector(".node-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    node.querySelector(".node-kebab-menu").classList.remove("open");
    closeTab(session.id);
  });

  node.addEventListener("click", (e) => {
    if (e.target.closest(".node-kebab")) return;
    selectAgentInFlow(session.id);
  });
  return node;
}

function selectAgentInFlow(sessionId) {
  selectedFlowAgentId = sessionId;

  // Update node selection visual
  document.querySelectorAll(".agent-node").forEach((n) => {
    n.classList.toggle("selected", n.dataset.sessionId === sessionId);
  });

  const consoleArea = document.getElementById("team-console-area");
  const placeholder = document.getElementById("team-console-placeholder");

  // Hide all embedded terminals
  consoleArea.querySelectorAll(".terminal-wrapper-embedded").forEach((w) => {
    w.classList.remove("active");
  });

  const session = sessions.get(sessionId);
  if (!session) return;

  // Check if we already moved this terminal into the console area
  let embedded = consoleArea.querySelector(`.terminal-wrapper-embedded[data-session-id="${sessionId}"]`);
  if (!embedded) {
    // Create a new embedded wrapper and move the terminal DOM into it
    embedded = document.createElement("div");
    embedded.className = "terminal-wrapper-embedded";
    embedded.dataset.sessionId = sessionId;

    // Move the xterm DOM element from the original wrapper to here
    const xtermScreen = session.wrapperEl.querySelector(".xterm");
    if (xtermScreen) {
      embedded.appendChild(xtermScreen);
    }
    // Also move starting overlay if present
    const startingOverlay = session.wrapperEl.querySelector(".starting-overlay");
    if (startingOverlay) {
      embedded.appendChild(startingOverlay);
    }
    consoleArea.appendChild(embedded);
  }

  embedded.classList.add("active");
  if (placeholder) placeholder.style.display = "none";

  // Clear question highlight on the selected node
  const nodeDot = document.querySelector(`.agent-node[data-session-id="${sessionId}"] .node-status-dot`);
  if (nodeDot) nodeDot.classList.remove("question");

  // Fit terminal to new container
  setTimeout(() => {
    session.fitAddon.fit();
    sendResize(session);
    session.terminal.focus();
  }, 50);
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

  // Insert after team tab
  const teamTab = tabBar.querySelector(".tab-team");
  if (teamTab) {
    teamTab.after(tab);
  } else {
    tabBar.prepend(tab);
  }
  return tab;
}

function switchToUsageTab() {
  usageTabActive = true;
  messagesTabActive = false;
  tasksTabActive = false;
  eventsTabActive = false;
  filesTabActive = false;
  teamTabActive = false;
  activeSessionId = null;

  // Deactivate all other tabs and wrappers
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
  saveTabState(); // P1-21
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
  filesTabActive = false;
  teamTabActive = false;
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
  saveTabState(); // P1-21
}

async function loadTeamMessages(teamId) {
  try {
    const res = await fetchWithTimeout(`/api/teams/${teamId}/messages`);
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

const seenMessageIds = new Set();

function handleTeamMessage(msg) {
  const teamId = msg.teamId;

  // Deduplicate — broadcast goes to all WS connections, so each message arrives N times
  if (msg.message.id && seenMessageIds.has(msg.message.id)) return;
  if (msg.message.id) seenMessageIds.add(msg.message.id);

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
  filesTabActive = false;
  teamTabActive = false;
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
  saveTabState(); // P1-21
}

async function loadTeamTasks(teamId) {
  try {
    const res = await fetchWithTimeout(`/api/teams/${teamId}/tasks`);
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
        await fetchWithTimeout(`/api/teams/${teamId}/tasks/${taskId}/retry`, { method: "POST" });
        loadTeamTasks(teamId);
      } catch {}
    });
  });
}

function renderTaskSummaryHTML(summary) {
  // Check if the active team has model routing enabled
  let routingHtml = "";
  if (activeTeamId) {
    const teamData = teams.get(activeTeamId);
    if (teamData && teamData.modelRouting) {
      const low = modelLabel(teamData.modelRouting.low) || "?";
      const med = modelLabel(teamData.modelRouting.medium) || "?";
      const high = modelLabel(teamData.modelRouting.high) || "?";
      routingHtml = `<span class="tasks-summary-routing" title="Smart model routing active: Low→${low}, Medium→${med}, High→${high}">🧠 ${low} / ${med} / ${high}</span>`;
    }
  }
  return `
    <div class="tasks-summary">
      <span class="tasks-summary-item pending">${summary.pending} pending</span>
      <span class="tasks-summary-item active">${(summary.assigned || 0) + (summary.in_progress || 0)} active</span>
      <span class="tasks-summary-item completed">${summary.completed} done</span>
      <span class="tasks-summary-item failed">${summary.failed} failed</span>
      <span class="tasks-summary-total">${summary.total} total</span>
      ${routingHtml}
    </div>
  `;
}

function renderTaskCard(task) {
  const time = new Date(task.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const assignee = task.assignedToName ? `<span class="task-assignee">${escapeHtml(task.assignedToName)}</span>` : "";
  const complexity = task.complexity
    ? `<span class="task-complexity complexity-${task.complexity}">${task.complexity}</span>`
    : "";
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
    ${desc}${complexity}${assignee}${deps}${result}${failReason}${retryBtn}
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
  filesTabActive = false;
  teamTabActive = false;
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
  saveTabState(); // P1-21
}

async function loadTeamEvents(teamId) {
  try {
    const res = await fetchWithTimeout(`/api/teams/${teamId}/events`);
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
  const searchFilter = (document.getElementById("events-filter-search").value || "").toLowerCase().trim();
  let filtered = events;
  if (typeFilter) filtered = filtered.filter((e) => e.type === typeFilter);
  if (agentFilter) filtered = filtered.filter((e) => e.sessionId === agentFilter);
  if (searchFilter) {
    filtered = filtered.filter((e) => {
      const haystack = [
        e.toolName || "",
        e.sessionName || "",
        e.text || "",
        e.contentPreview || "",
        e.input?.file_path || "",
        e.input?.command || "",
        e.input?.pattern || "",
        e.input?.description || "",
        e.model || "",
      ].join(" ").toLowerCase();
      return haystack.includes(searchFilter);
    });
  }
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

  // If a Write/Edit tool call, refresh files panel if active
  if (event.type === "tool_call" && (event.toolName === "Write" || event.toolName === "Edit") && event.input?.file_path) {
    if (filesTabActive && activeTeamId === teamId) {
      loadTeamFiles(teamId);
    }
  }
}

function handleAgentState(msg) {
  const { sessionId, state, lastToolCall } = msg;
  agentStates.set(sessionId, { state, lastToolCall });

  // Remove starting overlay when agent is no longer starting
  if (state !== "starting") {
    const session = sessions.get(sessionId);
    if (session) {
      // Remove overlay from original wrapper
      const overlay = session.wrapperEl.querySelector(".starting-overlay");
      if (overlay) overlay.remove();
      // Also remove from embedded wrapper in team console
      const embedded = document.querySelector(`#team-console-area .terminal-wrapper-embedded[data-session-id="${sessionId}"] .starting-overlay`);
      if (embedded) embedded.remove();
    }
  }

  // Update tab badge if session exists
  const session = sessions.get(sessionId);
  if (session && session.tabEl) {
    let badge = session.tabEl.querySelector(".agent-state-badge");
    if (state === "starting" || state === "idle") {
      if (badge) badge.remove();
    } else {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "agent-state-badge";
        session.tabEl.querySelector(".tab-name").after(badge);
      }
      badge.className = "agent-state-badge state-" + state;
      badge.textContent = state === "tool_calling" ? (lastToolCall?.name || "tool") : state;
    }
  }

  // Update flow graph node state badge
  const node = document.querySelector(`.agent-node[data-session-id="${sessionId}"]`);
  if (node) {
    const footer = node.querySelector(".agent-node-footer");
    if (footer) {
      let nodeBadge = footer.querySelector(".node-state-badge");
      if (state === "starting" || state === "idle") {
        if (nodeBadge) nodeBadge.remove();
      } else {
        if (!nodeBadge) {
          nodeBadge = document.createElement("span");
          nodeBadge.className = "node-state-badge";
          footer.appendChild(nodeBadge);
        }
        nodeBadge.className = "node-state-badge state-" + state;
        nodeBadge.textContent = state === "tool_calling" ? (lastToolCall?.name || "tool") : state;
      }
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
  filesTabActive = false;
  teamTabActive = false;
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
    refreshTeamProjectMemory();
  }
  saveTabState(); // P1-21
}

async function loadTeamContext(teamId) {
  try {
    const res = await fetchWithTimeout(`/api/teams/${teamId}/context`);
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

  const container = panel.querySelector(".context-entries");
  if (container) {
    container.addEventListener("click", handleContextEntryClick);
  }
}

function renderContextEntry(entry) {
  const time = new Date(entry.lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const storedBy = entry.storedByName ? escapeHtml(entry.storedByName) : "unknown";
  const summary = entry.summary ? escapeHtml(entry.summary) : "(no summary)";
  const key = escapeHtml(entry.key);

  return `<div class="context-entry" data-key="${key}">
    <div class="context-entry-header">
      <div class="context-entry-header-left">
        <span class="context-entry-toggle">▶</span>
        <span class="context-entry-key">${key}</span>
      </div>
      <div class="context-entry-header-right">
        <span class="context-entry-tokens">~${entry.tokens} tokens</span>
        <button class="context-entry-copy-btn" title="Copy reference to paste to agent">Copy Key</button>
      </div>
    </div>
    <div class="context-entry-summary">${summary}</div>
    <div class="context-entry-meta">
      <span class="context-entry-author">by ${storedBy}</span>
      <span class="context-entry-access">${entry.accessCount}x accessed</span>
      <span class="context-entry-time">${time}</span>
    </div>
    <div class="context-entry-content"></div>
  </div>`;
}

async function handleContextEntryClick(e) {
  const entryEl = e.target.closest(".context-entry");
  if (!entryEl) return;

  const key = entryEl.dataset.key;

  // Copy button
  if (e.target.closest(".context-entry-copy-btn")) {
    const btn = e.target.closest(".context-entry-copy-btn");
    const copyText = `[Team Context: "${key}"]`;
    navigator.clipboard.writeText(copyText).then(() => {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 1500);
    });
    return;
  }

  // Toggle expand on header click
  if (!e.target.closest(".context-entry-header")) return;

  const content = entryEl.querySelector(".context-entry-content");
  const toggle = entryEl.querySelector(".context-entry-toggle");
  const isExpanded = entryEl.classList.contains("expanded");

  if (isExpanded) {
    entryEl.classList.remove("expanded");
    content.style.display = "none";
    toggle.textContent = "▶";
    return;
  }

  entryEl.classList.add("expanded");
  toggle.textContent = "▼";

  if (!content.dataset.loaded) {
    content.innerHTML = '<div class="context-content-loading">Loading…</div>';
    content.style.display = "block";
    try {
      const res = await fetchWithTimeout(`/api/teams/${activeTeamId}/context/${encodeURIComponent(key)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      content.innerHTML = `<pre class="context-entry-full-content">${escapeHtml(data.entry.content)}</pre>`;
      content.dataset.loaded = "1";
    } catch {
      content.innerHTML = '<div class="context-content-error">Failed to load content.</div>';
    }
  } else {
    content.style.display = "block";
  }
}

function handleTeamContextEvent(msg) {
  const teamId = msg.teamId;

  // Refresh the panel if it's active
  if (contextTabActive && activeTeamId === teamId) {
    loadTeamContext(teamId);
  }
}

// --- Files tab ---

function createFilesTab() {
  const existing = tabBar.querySelector(".tab-files");
  if (existing) existing.remove();

  const tab = document.createElement("div");
  tab.className = "tab tab-files";
  tab.innerHTML = `<span class="files-tab-icon">📁</span><span class="tab-name">Files</span>`;
  tab.addEventListener("click", () => switchToFilesTab());

  // Insert after context tab
  const contextTab = tabBar.querySelector(".tab-context");
  if (contextTab) {
    contextTab.after(tab);
  } else {
    const eventsTab = tabBar.querySelector(".tab-events");
    if (eventsTab) eventsTab.after(tab);
    else tabBar.prepend(tab);
  }
  return tab;
}

function switchToFilesTab() {
  filesTabActive = true;
  usageTabActive = false;
  messagesTabActive = false;
  tasksTabActive = false;
  eventsTabActive = false;
  contextTabActive = false;
  teamTabActive = false;
  activeSessionId = null;

  // Deactivate all other tabs and wrappers
  tabBar.querySelectorAll(".tab:not(.tab-files)").forEach((t) => t.classList.remove("active"));
  terminalContainer.querySelectorAll(".terminal-wrapper:not(#files-panel)").forEach((w) => w.classList.remove("active"));
  stopUsageAutoRefresh();

  // Activate files tab and panel
  const filesTab = tabBar.querySelector(".tab-files");
  if (filesTab) filesTab.classList.add("active");
  document.getElementById("files-panel").classList.add("active");
  emptyState.style.display = "none";

  // Load files
  if (activeTeamId) {
    loadTeamFiles(activeTeamId);
  }
  saveTabState(); // P1-21
}

async function loadTeamFiles(teamId) {
  try {
    const res = await fetchWithTimeout(`/api/teams/${teamId}/files`);
    const data = await res.json();
    teamFiles.set(teamId, data.files || []);
    renderFilesPanel(data.files || []);
  } catch {
    renderFilesPanel([]);
  }
}

function renderFilesPanel(files) {
  const panel = document.getElementById("files-panel-content");
  if (!files || files.length === 0) {
    panel.innerHTML = '<div class="files-empty">No files changed yet</div>';
    return;
  }

  const items = files.map((f) => {
    const time = new Date(f.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const opClass = f.operation === "edited" ? "edited" : "";
    const icon = f.operation === "created" ? "📄" : "✏️";
    return `<div class="file-item" data-path="${escapeHtml(f.path)}" onclick="viewFile('${escapeHtml(f.path).replace(/'/g, "\\'")}')">
      <span class="file-item-icon">${icon}</span>
      <div class="file-item-info">
        <div class="file-item-path" title="${escapeHtml(f.path)}">${escapeHtml(f.relativePath)}</div>
        <div class="file-item-meta">
          <span class="file-item-agent">${escapeHtml(f.agentName)}</span>
          <span class="file-item-op ${opClass}">${f.operation}</span>
          <span class="file-item-time">${time}</span>
        </div>
      </div>
    </div>`;
  }).join("");

  panel.innerHTML = `<div class="files-list">${items}</div>`;
}

async function viewFile(filePath) {
  if (!activeTeamId) return;
  const panel = document.getElementById("files-panel-content");
  panel.innerHTML = '<div class="files-empty">Loading file...</div>';

  try {
    const res = await fetchWithTimeout(`/api/teams/${activeTeamId}/files/read?path=${encodeURIComponent(filePath)}`);
    if (!res.ok) {
      const err = await res.json();
      panel.innerHTML = `<div class="files-empty">${escapeHtml(err.error || "Failed to read file")}</div>`;
      return;
    }
    const data = await res.json();
    const filename = filePath.split("/").pop();
    const isMarkdown = /\.md$/i.test(filename);

    let contentHtml;
    if (isMarkdown) {
      const rendered = DOMPurify.sanitize(marked.parse(data.content));
      contentHtml = `<div class="file-viewer-markdown">${rendered}</div>`;
    } else {
      const lines = data.content.split("\n");
      const lineHtml = lines.map((line, i) => {
        const num = i + 1;
        const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<div class="file-line"><span class="file-line-number">${num}</span><span class="file-line-content">${escaped}</span></div>`;
      }).join("");
      contentHtml = `<pre>${lineHtml}</pre>`;
    }

    panel.innerHTML = `<div class="file-viewer">
      <div class="file-viewer-header">
        <button class="file-viewer-back" onclick="loadTeamFiles('${activeTeamId}')">← Back</button>
        <span class="file-viewer-filename" title="${escapeHtml(filePath)}">${escapeHtml(filename)}</span>
      </div>
      <div class="file-viewer-content">${contentHtml}</div>
    </div>`;
  } catch {
    panel.innerHTML = '<div class="files-empty">Failed to load file</div>';
  }
}

// --- Agent idle events (AP5-A) ---


function handleAgentIdleEvent(msg) {
  const event = msg.event;
  const name = event.sessionName || "Agent";

  // Deduplicate: each idle event should only be handled once across all WS connections
  const dedupeKey = `${event.sessionId}:${event.type}`;
  if (handledIdleEvents.has(dedupeKey)) return;
  handledIdleEvents.add(dedupeKey);

  if (event.type === "agent_idle_warning") {
    // P1-16: Don't show idle toast for already-stopped teams
    const session = sessions.get(event.sessionId);
    if (session && session.teamId) {
      const team = teams.get(session.teamId);
      if (team && team.status === "stopped") return;
    }
    // Dim the tab and show idle badge
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
    // P1-25: Include "Keep alive" button to dismiss idle timer
    const sessionId = event.sessionId;
    const teamId = session?.teamId;
    showToast(`${name} has been idle for 5+ minutes. Will auto-stop in 5 minutes.`, "warning", {
      actionLabel: "Keep alive",
      action: () => {
        if (teamId && sessionId) {
          fetchWithTimeout(`/api/teams/${teamId}/agents/${sessionId}/keep-alive`, { method: "POST" })
            .then(() => {
              // Clear idle UI state
              const s = sessions.get(sessionId);
              if (s && s.tabEl) {
                s.tabEl.classList.remove("tab-idle");
                const badge = s.tabEl.querySelector(".agent-state-badge");
                if (badge) badge.remove();
              }
              handledIdleEvents.delete(`${sessionId}:agent_idle_warning`);
              handledIdleEvents.delete(`${sessionId}:agent_idle_killed`);
              showToast(`${name} kept alive`, "success");
            })
            .catch(() => showToast("Failed to keep alive", "error"));
        }
      },
    });
  }

  if (event.type === "agent_idle_killed") {
    // P1-16: Don't show idle kill toast for already-stopped teams
    const killedSession = sessions.get(event.sessionId);
    if (killedSession && killedSession.teamId) {
      const team = teams.get(killedSession.teamId);
      if (team && team.status === "stopped") return;
    }
    // Mark session as exited in local state
    if (killedSession && killedSession.tabEl) {
      killedSession.tabEl.classList.add("tab-idle");
    }
    showToast(`${name} was auto-stopped after 10 minutes idle.`, "error");
  }
}

function showToast(message, level = "info", { action, actionLabel } = {}) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.textContent = message;

  // P1-25: Optional action button (e.g. "Keep alive")
  if (action && actionLabel) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      action();
      toast.classList.remove("toast-show");
      setTimeout(() => toast.remove(), 300);
    });
    toast.appendChild(btn);
  }

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

// P1-26: Clear agent context via /clear command
async function clearSessionContext(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status !== "running") {
    showToast("Cannot clear context — agent is not running", "warning");
    return;
  }
  try {
    const resp = await fetchWithTimeout(`/api/sessions/${sessionId}/clear`, { method: "POST" });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || "Failed to clear context", "error");
      return;
    }
    // Clear local terminal display
    session.terminal.clear();
    session.terminal.write("\r\n\x1b[38;2;166;227;161m● Context cleared\x1b[0m\r\n\r\n");
    showToast(`Context cleared for ${session.name}`, "success");
  } catch (err) {
    showToast("Failed to clear context: " + err.message, "error");
  }
}

async function restartAgent(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.teamId) {
    showToast("Can only restart team agents", "warning");
    return;
  }
  try {
    const resp = await fetchWithTimeout(`/api/teams/${session.teamId}/agents/${sessionId}/restart`, { method: "POST" });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || "Failed to restart agent", "error");
      return;
    }
    showToast(`Restarting ${session.name}…`, "success");
    // The WebSocket "agent-restarted" event will handle cleanup and reattach
  } catch (err) {
    showToast("Failed to restart agent: " + err.message, "error");
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
        await fetchWithTimeout(`/api/teams/${session.teamId}/agents/${sessionId}`, { method: "DELETE" });
      } catch {}
      const idx = team.agentIds.indexOf(sessionId);
      if (idx !== -1) team.agentIds.splice(idx, 1);
      updateTeamBadge(session.teamId);
    }
  } else {
    try {
      await fetchWithTimeout(`/api/sessions/${sessionId}`, { method: "DELETE" });
    } catch {}
  }

  session.ws.close();
  session.terminal.dispose();
  session.tabEl.remove();
  session.wrapperEl.remove();

  // Clean up embedded terminal in team console area
  const embedded = document.querySelector(`#team-console-area .terminal-wrapper-embedded[data-session-id="${sessionId}"]`);
  if (embedded) embedded.remove();

  sessions.delete(sessionId);

  updateSessionCount();

  // Refresh flow graph if needed
  if (session.teamId === activeTeamId && teamTabActive) {
    renderTeamFlowGraph();
    // If we removed the selected agent, select another
    if (selectedFlowAgentId === sessionId) {
      selectedFlowAgentId = null;
      const team = teams.get(activeTeamId);
      const remaining = team ? team.agentIds.filter((id) => sessions.has(id)) : [];
      if (remaining.length > 0) {
        selectAgentInFlow(remaining[0]);
      } else {
        const placeholder = document.getElementById("team-console-placeholder");
        if (placeholder) placeholder.style.display = "";
      }
    }
  } else if (activeSessionId === sessionId) {
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
      }
      updateTeamBadge(msg.teamId);
      updateSessionCount();
      // Refresh flow graph if this is the active team and team tab is shown
      if (msg.teamId === activeTeamId && teamTabActive) {
        renderTeamFlowGraph();
      }
      statusText.textContent = `Agent "${msg.agent.name}" spawned in team`;
      break;
    }
    case "agent-restarted": {
      const team = teams.get(msg.teamId);
      if (!team) break;
      // Replace old ID with new in team's agentIds
      const ridx = team.agentIds.indexOf(msg.oldAgentId);
      if (ridx !== -1) {
        team.agentIds[ridx] = msg.agent.id;
      }
      // Clean up the old session
      const oldSession = sessions.get(msg.oldAgentId);
      if (oldSession) {
        const wasSelected = selectedFlowAgentId === msg.oldAgentId;
        oldSession.ws.close();
        oldSession.terminal.dispose();
        oldSession.tabEl.remove();
        oldSession.wrapperEl.remove();
        const embedded = document.querySelector(`#team-console-area .terminal-wrapper-embedded[data-session-id="${msg.oldAgentId}"]`);
        if (embedded) embedded.remove();
        sessions.delete(msg.oldAgentId);
        // Attach the new session
        attachSession(msg.agent);
        updateTeamBadge(msg.teamId);
        updateSessionCount();
        if (msg.teamId === activeTeamId && teamTabActive) {
          renderTeamFlowGraph();
          if (wasSelected) {
            selectAgentInFlow(msg.agent.id);
          }
        }
      }
      statusText.textContent = `Agent "${msg.agent.name}" restarted`;
      break;
    }
    case "agent-removed": {
      const team = teams.get(msg.teamId);
      if (team) {
        const idx = team.agentIds.indexOf(msg.agentId);
        if (idx !== -1) team.agentIds.splice(idx, 1);
        updateTeamBadge(msg.teamId);
      }
      // Refresh flow graph
      if (msg.teamId === activeTeamId && teamTabActive) {
        renderTeamFlowGraph();
      }
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
            const embedded = document.querySelector(`#team-console-area .terminal-wrapper-embedded[data-session-id="${agentId}"]`);
            if (embedded) embedded.remove();
            sessions.delete(agentId);
          }
        }
        selectedFlowAgentId = null;
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
    const res = await fetchWithTimeout("/api/templates");
    savedTemplates = await res.json();
  } catch {
    savedTemplates = [];
  }
  populateTemplateDropdown();
}

async function loadBuiltinRoles() {
  try {
    const res = await fetchWithTimeout("/api/builtin-roles");
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
    const res = await fetchWithTimeout("/api/templates", {
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
    await fetchWithTimeout(`/api/templates/${id}`, { method: "DELETE" });
    savedTemplates = savedTemplates.filter((t) => t.id !== id);
    populateTemplateDropdown();
    templateSelect.value = "";
  } catch {}
}

// --- Project Memory Preview ---

async function loadProjectMemoryPreview(cwd) {
  const container = document.getElementById("project-memory-preview");
  if (!cwd) { container.style.display = "none"; return; }
  try {
    const res = await fetchWithTimeout(`/api/project-memory?cwd=${encodeURIComponent(cwd)}`);
    const data = await res.json();
    const entries = (data.entries || []).filter((e) => !e.deprecated);
    if (entries.length === 0) { container.style.display = "none"; return; }
    container.innerHTML = `
      <div class="pm-preview-title">Prior Project Knowledge (${entries.length} entries from previous teams)</div>
      ${entries.map((e) => `
        <div class="pm-preview-entry">
          <span class="pm-preview-key">${escapeHtml(e.key)}</span>
          <span class="pm-preview-summary">— ${escapeHtml(e.summary || "(no summary)")}</span>
        </div>`).join("")}`;
    container.style.display = "";
  } catch {
    container.style.display = "none";
  }
}

function renderTeamProjectMemory(entries) {
  const container = document.getElementById("context-project-memory");
  if (!container) return;
  const active = entries && entries.filter((e) => !e.deprecated);
  if (!active || active.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "block";
  const entriesHtml = active.map((e) => {
    const time = e.lastUpdated ? new Date(e.lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const storedBy = e.storedBy ? escapeHtml(e.storedBy) : "unknown";
    const summary = escapeHtml(e.summary || "(no summary)");
    const key = escapeHtml(e.key);
    return `<div class="pm-context-entry" data-key="${key}">
      <div class="pm-context-entry-header">
        <div class="pm-context-entry-header-left">
          <span class="pm-context-entry-toggle">▶</span>
          <span class="pm-context-entry-key">${key}</span>
        </div>
        <div class="pm-context-entry-header-right">
          <button class="pm-context-copy-btn">Copy Key</button>
        </div>
      </div>
      <div class="pm-context-entry-summary">${summary}</div>
      <div class="pm-context-entry-meta">
        <span class="pm-context-entry-author">by ${storedBy}</span>
        ${time ? `<span class="pm-context-entry-time">${time}</span>` : ""}
      </div>
      <div class="pm-context-entry-content"></div>
    </div>`;
  }).join("");
  container.innerHTML = `
    <div class="pm-context-title">Project Memory (${active.length})</div>
    <div class="pm-context-entries">${entriesHtml}</div>`;
  container.querySelector(".pm-context-entries").addEventListener("click", handleProjectMemoryEntryClick);
}

async function handleProjectMemoryEntryClick(e) {
  const entryEl = e.target.closest(".pm-context-entry");
  if (!entryEl) return;

  const key = entryEl.dataset.key;

  // Copy button
  if (e.target.closest(".pm-context-copy-btn")) {
    const btn = e.target.closest(".pm-context-copy-btn");
    const copyText = `[Project Memory: "${key}"]`;
    navigator.clipboard.writeText(copyText).then(() => {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 1500);
    });
    return;
  }

  // Toggle expand on header click
  if (!e.target.closest(".pm-context-entry-header")) return;

  const content = entryEl.querySelector(".pm-context-entry-content");
  const toggle = entryEl.querySelector(".pm-context-entry-toggle");
  const isExpanded = entryEl.classList.contains("expanded");

  if (isExpanded) {
    entryEl.classList.remove("expanded");
    content.style.display = "none";
    toggle.textContent = "▶";
    return;
  }

  entryEl.classList.add("expanded");
  toggle.textContent = "▼";

  if (!content.dataset.loaded) {
    content.innerHTML = '<div class="context-content-loading">Loading…</div>';
    content.style.display = "block";
    try {
      const res = await fetchWithTimeout(`/api/teams/${activeTeamId}/project-memory/${encodeURIComponent(key)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      content.innerHTML = `<pre class="context-entry-full-content">${escapeHtml(data.entry.content)}</pre>`;
      content.dataset.loaded = "1";
    } catch {
      content.innerHTML = '<div class="context-content-error">Failed to load content.</div>';
    }
  } else {
    content.style.display = "block";
  }
}

async function refreshTeamProjectMemory() {
  if (!activeTeamId) return;
  try {
    const res = await fetchWithTimeout(`/api/teams/${activeTeamId}/project-memory`);
    const data = await res.json();
    renderTeamProjectMemory(data.entries || []);
  } catch { /* non-fatal */ }
}

// --- Modal logic ---

function showNewTeamModal() {
  teamNameInput.value = "";
  pathInput.value = "";
  promptInput.value = "";
  modelSelect.value = "";
  // Reset model routing toggle
  const routingCheckbox = document.getElementById("model-routing-enabled");
  const routingConfig = document.getElementById("model-routing-config");
  routingCheckbox.checked = false;
  routingConfig.style.display = "none";
  document.getElementById("routing-low").value = "claude-haiku-4-5-20251001";
  document.getElementById("routing-medium").value = "claude-sonnet-4-6";
  document.getElementById("routing-high").value = "claude-opus-4-6";
  // Init with default 4 roles
  currentRoles = builtinRoles.map((r) => ({ ...r }));
  editingRoleIndex = -1;
  templateSelect.value = "__default__";
  renderRoleList();
  document.getElementById("project-memory-preview").style.display = "none";
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
    const res = await fetchWithTimeout("/api/browse-folder", {}, 65000);
    const data = await res.json();
    if (!data.cancelled && data.path) {
      pathInput.value = data.path;
      loadProjectMemoryPreview(data.path);
    }
  } catch (err) {
    statusText.textContent = `Browse error: ${err.message}`;
  } finally {
    browseBtn.disabled = false;
    browseBtn.textContent = "Browse";
  }
}

let _creatingTeam = false;
async function createNewTeam() {
  // P1-15: Prevent double-submit
  if (_creatingTeam) return;
  const name = teamNameInput.value.trim();
  const cwd = pathInput.value.trim() || undefined;
  const prompt = promptInput.value.trim();
  const roles = currentRoles.length > 0 ? currentRoles : undefined;
  const model = modelSelect.value || undefined;

  // Collect model routing config if enabled
  const routingEnabled = document.getElementById("model-routing-enabled").checked;
  const modelRouting = routingEnabled ? {
    low: document.getElementById("routing-low").value,
    medium: document.getElementById("routing-medium").value,
    high: document.getElementById("routing-high").value,
  } : undefined;

  if (!name) { teamNameInput.focus(); return; }
  if (!prompt) { promptInput.focus(); return; }
  // P1-14: Limit prompt length to prevent excessive token usage
  if (prompt.length > 5000) {
    showToast("Prompt too long (max 5000 characters). Please shorten it.", "error");
    promptInput.focus();
    return;
  }

  _creatingTeam = true;
  hideModal();
  newTeamBtn.disabled = true;
  statusText.textContent = "Creating team...";

  try {
    const res = await fetchWithTimeout("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cwd, prompt, roles, model, modelRouting }),
    }, 30000);
    const data = await res.json();

    // P1-11: Handle server error responses
    if (!res.ok) {
      const errMsg = data.error || `Server error (${res.status})`;
      showToast(`Failed to create team: ${errMsg}`, "error");
      statusText.textContent = `Error: ${errMsg}`;
      return;
    }

    // Add team to state
    const team = {
      id: data.team.id,
      name: data.team.name,
      agentIds: data.team.agentIds,
      modelRouting: data.team.modelRouting || null,
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
    // P1-11: Show toast on network/fetch errors
    showToast(`Failed to create team: ${err.message}`, "error");
    statusText.textContent = `Error: ${err.message}`;
  } finally {
    newTeamBtn.disabled = false;
    _creatingTeam = false;
  }
}

let _spawningAgent = false;
async function spawnNewAgent() {
  // P1-15: Prevent double-submit
  if (_spawningAgent) return;
  if (!activeTeamId) return;

  const name = agentNameInput.value.trim();
  const prompt = agentPromptInput.value.trim();
  const model = agentModelSelect.value || undefined;

  if (!name) { agentNameInput.focus(); return; }
  if (!prompt) { agentPromptInput.focus(); return; }

  _spawningAgent = true;
  hideAgentModal();
  statusText.textContent = "Spawning agent...";

  try {
    const res = await fetchWithTimeout(`/api/teams/${activeTeamId}/agents`, {
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

    // If team tab is active, refresh flow and select the new agent
    if (teamTabActive) {
      renderTeamFlowGraph();
      selectAgentInFlow(data.id);
    } else {
      switchToTeamTab();
      selectAgentInFlow(data.id);
    }

    statusText.textContent = `Agent "${name}" spawned`;
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  } finally {
    _spawningAgent = false;
  }
}

async function relaunchTeam(teamId) {
  statusText.textContent = "Re-launching team...";
  try {
    const res = await fetchWithTimeout(`/api/teams/${teamId}/relaunch`, { method: "POST" });
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
    await fetchWithTimeout(`/api/teams/${teamId}`, { method: "DELETE" });
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
        // Clean up embedded terminal
        const embedded = document.querySelector(`#team-console-area .terminal-wrapper-embedded[data-session-id="${agentId}"]`);
        if (embedded) embedded.remove();
        sessions.delete(agentId);
      }
    }
    teams.delete(teamId);
    selectedFlowAgentId = null;
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

// P1-24: Export team config as JSON download
async function exportTeam(teamId) {
  try {
    const res = await fetchWithTimeout(`/api/teams/${teamId}/export`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `team-${data.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported "${data.name}"`, "success");
  } catch (err) {
    console.error("[Export] Failed:", err);
    showToast("Failed to export team", "error");
  }
}

// P1-24: Import team config from JSON file
function importTeam() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await fetchWithTimeout("/api/teams/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || "Import failed", "error");
        return;
      }
      const result = await res.json();
      const team = {
        id: result.team.id,
        name: result.team.name,
        agentIds: result.team.agentIds,
        modelRouting: result.team.modelRouting || null,
        status: result.team.status || "running",
      };
      teams.set(team.id, team);
      teamList.appendChild(renderTeamItem(team));
      attachSession(result.mainAgent);
      selectTeam(team.id);
      switchToTeamTab();
      showToast(`Imported "${team.name}"`, "success");
    } catch (err) {
      console.error("[Import] Failed:", err);
      showToast("Failed to import team: invalid file", "error");
    }
  });
  input.click();
}

// --- Load existing teams on page load ---

async function loadExistingTeams() {
  try {
    const res = await fetchWithTimeout("/api/teams");
    const teamsList = await res.json();

    for (const teamData of teamsList) {
      const team = {
        id: teamData.id,
        name: teamData.name,
        agentIds: teamData.agentIds,
        modelRouting: teamData.modelRouting || null,
        status: teamData.status || "running",
      };
      teams.set(team.id, team);
      teamList.appendChild(renderTeamItem(team));

      // Only load agents for running teams (stopped teams have no PTY sessions)
      if (team.status !== "stopped" && team.agentIds.length > 0) {
        const agentsRes = await fetchWithTimeout(`/api/teams/${team.id}/agents`);
        const agents = await agentsRes.json();
        for (const agent of agents) {
          attachSession(agent);
        }
      }
    }

    // P1-21: Restore saved team and tab selection
    if (teamsList.length > 0) {
      const saved = getSavedTabState();
      const savedTeamExists = saved.teamId && teams.has(saved.teamId);
      const targetTeamId = savedTeamExists ? saved.teamId : teamsList[0].id;
      selectTeam(targetTeamId);

      // Restore the previously active tab
      if (savedTeamExists && saved.tab && saved.tab !== "team") {
        const tabSwitchers = {
          usage: switchToUsageTab,
          messages: switchToMessagesTab,
          tasks: switchToTasksTab,
          events: switchToEventsTab,
          context: switchToContextTab,
          files: switchToFilesTab,
        };
        if (tabSwitchers[saved.tab]) {
          tabSwitchers[saved.tab]();
        } else if (saved.tab.startsWith("session:")) {
          const sessionId = saved.tab.slice(8);
          if (sessions.has(sessionId)) switchTab(sessionId);
        }
      }
    }
  } catch (err) {
    // P1-5: Show error instead of blank UI when server is unreachable
    console.error("[Init] Failed to load teams:", err);
    showToast("Failed to connect to server. Is it running?", "error");
  }
}

// P1-7: Clean up intervals on page unload to prevent memory leaks
window.addEventListener("beforeunload", () => {
  stopUsageAutoRefresh();
  clearTimeout(_usagePollTimer);
});

// P1-26: Close kebab menus on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest(".tab-kebab") && !e.target.closest(".node-kebab")) {
    document.querySelectorAll(".kebab-menu.open, .node-kebab-menu.open").forEach((m) => m.classList.remove("open"));
  }
});

// --- Window resize ---
window.addEventListener("resize", () => {
  if (teamTabActive && selectedFlowAgentId) {
    const session = sessions.get(selectedFlowAgentId);
    if (session) {
      session.fitAddon.fit();
      sendResize(session);
    }
  } else if (activeSessionId) {
    const session = sessions.get(activeSessionId);
    if (session) {
      session.fitAddon.fit();
      sendResize(session);
    }
  }
});

// --- Usage polling (P1-6: efficient polling) ---
let _usagePollTimer = null;
let _usagePollMs = 5000;

function _usagePollTick() {
  // Skip polling when no teams/sessions exist or tab is hidden
  if (teams.size === 0 && sessions.size === 0) {
    _scheduleUsagePoll();
    return;
  }
  if (document.hidden) {
    _scheduleUsagePoll();
    return;
  }

  const work = [];

  // Status bar update for active session
  if (sessions.size > 0 && activeSessionId) {
    work.push(
      fetch("/api/sessions").then((r) => r.json()).then((list) => {
        for (const data of list) {
          if (data.id === activeSessionId) {
            const dur = Math.floor(data.usage.durationMs / 1000);
            const mins = Math.floor(dur / 60);
            const secs = dur % 60;
            const inKB = (data.usage.bytesIn / 1024).toFixed(1);
            const outKB = (data.usage.bytesOut / 1024).toFixed(1);
            statusText.textContent = `${data.name} | ${data.status} | ${mins}m ${secs}s | In: ${inKB}KB | Out: ${outKB}KB`;
          }
        }
      }).catch(() => {})
    );
  }

  // Sidebar token summary update
  if (teams.size > 0) {
    refreshSidebarTokens();
  }

  Promise.allSettled(work).then(() => _scheduleUsagePoll());
}

function _scheduleUsagePoll() {
  clearTimeout(_usagePollTimer);
  // Use 15s when tab is hidden, 5s when visible
  const interval = document.hidden ? 15000 : 5000;
  _usagePollTimer = setTimeout(_usagePollTick, interval);
}

// Start polling
_scheduleUsagePoll();

// P1-6: Adjust polling rate on visibility change
document.addEventListener("visibilitychange", () => {
  clearTimeout(_usagePollTimer);
  if (!document.hidden) {
    // Immediately poll on return to foreground
    _usagePollTick();
  } else {
    _scheduleUsagePoll();
  }
});

// --- Event listeners ---

// Model routing toggle
document.getElementById("model-routing-enabled").addEventListener("change", (e) => {
  document.getElementById("model-routing-config").style.display = e.target.checked ? "" : "none";
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
pathInput.addEventListener("blur", () => loadProjectMemoryPreview(pathInput.value.trim()));
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
// P1-22: Debounced text search for events
let _eventsSearchTimer = null;
document.getElementById("events-filter-search").addEventListener("input", () => {
  clearTimeout(_eventsSearchTimer);
  _eventsSearchTimer = setTimeout(() => {
    if (eventsTabActive && activeTeamId && teamEvents.has(activeTeamId)) {
      renderEventsPanel(teamEvents.get(activeTeamId));
    }
  }, 200);
});

// Init
loadBuiltinRoles();
loadTemplates();
loadExistingTeams();
