const teams = new Map(); // teamId -> { id, name, agentIds[] }
const sessions = new Map(); // sessionId -> { id, name, teamId, role, terminal, fitAddon, ws, tabEl, wrapperEl, status }
let activeTeamId = null;
let activeSessionId = null;

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

// Agent modal elements
const agentModalOverlay = document.getElementById("agent-modal-overlay");
const agentNameInput = document.getElementById("agent-name-input");
const agentPromptInput = document.getElementById("agent-prompt-input");
const agentModalCancel = document.getElementById("agent-modal-cancel");
const agentModalStart = document.getElementById("agent-modal-start");

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
  el.className = "team-item";
  el.dataset.teamId = team.id;
  el.innerHTML = `
    <div class="team-item-info">
      <span class="team-item-name">${team.name}</span>
      <span class="team-item-badge">${team.agentIds.length} agent${team.agentIds.length !== 1 ? "s" : ""}</span>
    </div>
    <button class="delete-team-btn" title="Delete team">&times;</button>
  `;
  el.addEventListener("click", (e) => {
    if (!e.target.classList.contains("delete-team-btn")) {
      selectTeam(team.id);
    }
  });
  el.querySelector(".delete-team-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTeam(team.id);
  });
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

  // Enable/disable new agent button
  newAgentBtn.disabled = !teamId;

  // Show only tabs for this team, hide others
  tabBar.querySelectorAll(".tab").forEach((t) => {
    const session = sessions.get(t.dataset.id);
    t.style.display = (session && session.teamId === teamId) ? "" : "none";
  });
  terminalContainer.querySelectorAll(".terminal-wrapper").forEach((w) => {
    const session = sessions.get(w.dataset.id);
    if (!session || session.teamId !== teamId) {
      w.classList.remove("active");
    }
  });

  // Switch to the first visible tab in this team, or the active one if it belongs
  const team = teams.get(teamId);
  if (team && team.agentIds.length > 0) {
    const currentBelongsToTeam = activeSessionId && sessions.get(activeSessionId)?.teamId === teamId;
    if (!currentBelongsToTeam) {
      switchTab(team.agentIds[0]);
    } else {
      switchTab(activeSessionId);
    }
    emptyState.style.display = "none";
  } else {
    activeSessionId = null;
    emptyState.style.display = "";
  }

  updateSessionCount();
}

// --- Tab / Session Management ---

function attachSession(data) {
  // Create tab
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.id = data.id;
  const roleLabel = data.role === "main" ? '<span class="role-badge">main</span>' : "";
  tab.innerHTML = `
    <span class="status-dot ${data.status === "exited" ? "exited" : ""}"></span>
    ${roleLabel}
    <span class="tab-name">${data.name}</span>
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

  tabBar.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.id === sessionId);
  });

  terminalContainer.querySelectorAll(".terminal-wrapper").forEach((w) => {
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

// --- Modal logic ---

function showNewTeamModal() {
  teamNameInput.value = "";
  pathInput.value = "";
  promptInput.value = "";
  modalOverlay.classList.remove("hidden");
  teamNameInput.focus();
}

function hideModal() {
  modalOverlay.classList.add("hidden");
}

function showNewAgentModal() {
  agentNameInput.value = "";
  agentPromptInput.value = "";
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

  if (!name) { teamNameInput.focus(); return; }
  if (!prompt) { promptInput.focus(); return; }

  hideModal();
  newTeamBtn.disabled = true;
  statusText.textContent = "Creating team...";

  try {
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cwd, prompt }),
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

  if (!name) { agentNameInput.focus(); return; }
  if (!prompt) { agentPromptInput.focus(); return; }

  hideAgentModal();
  statusText.textContent = "Spawning agent...";

  try {
    const res = await fetch(`/api/teams/${activeTeamId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt }),
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
      };
      teams.set(team.id, team);
      teamList.appendChild(renderTeamItem(team));

      // Load agents for this team
      const agentsRes = await fetch(`/api/teams/${team.id}/agents`);
      const agents = await agentsRes.json();
      for (const agent of agents) {
        attachSession(agent);
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
  if (sessions.size === 0) return;
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
}, 5000);

// --- Event listeners ---

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

// Init
loadExistingTeams();
