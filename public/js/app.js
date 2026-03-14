const sessions = new Map();
let activeSessionId = null;

const tabBar = document.getElementById("tab-bar");
const terminalContainer = document.getElementById("terminal-container");
const emptyState = document.getElementById("empty-state");
const newTabBtn = document.getElementById("new-tab-btn");
const sessionCount = document.getElementById("session-count");
const statusText = document.getElementById("status-text");
const modalOverlay = document.getElementById("modal-overlay");
const pathInput = document.getElementById("path-input");
const browseBtn = document.getElementById("browse-btn");
const modalCancel = document.getElementById("modal-cancel");
const modalStart = document.getElementById("modal-start");

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

  // Small delay to ensure DOM is ready before fitting
  setTimeout(() => fitAddon.fit(), 50);

  return { terminal, fitAddon };
}

function showNewInstanceModal() {
  pathInput.value = "";
  modalOverlay.classList.remove("hidden");
  pathInput.focus();
}

function hideModal() {
  modalOverlay.classList.add("hidden");
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

async function createNewInstance(cwd) {
  hideModal();
  newTabBtn.disabled = true;
  statusText.textContent = "Starting new instance...";

  try {
    const body = {};
    if (cwd && cwd.trim()) body.cwd = cwd.trim();
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    // Create tab
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset.id = data.id;
    tab.innerHTML = `
      <span class="status-dot"></span>
      <span class="tab-name">${data.name}</span>
      <button class="close-btn" title="Close instance">&times;</button>
    `;
    tab.addEventListener("click", (e) => {
      if (!e.target.classList.contains("close-btn")) {
        switchTab(data.id);
      }
    });
    tab.querySelector(".close-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(data.id);
    });
    tabBar.appendChild(tab);

    // Create terminal container
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
      // Check if it's a control message
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
        } catch {
          // Not JSON, it's terminal data
        }
      }
      terminal.write(event.data);
    };

    ws.onclose = () => {
      if (sessions.has(data.id)) {
        statusText.textContent = `Connection lost for ${data.name}`;
        // Try reconnect after 2s
        setTimeout(() => reconnect(data.id), 2000);
      }
    };

    terminal.onData((input) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: input }));
      }
    });

    sessions.set(data.id, session);
    switchTab(data.id);
    updateSessionCount();
    statusText.textContent = `Started ${data.name}`;
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  } finally {
    newTabBtn.disabled = false;
  }
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

  // Update tab active state
  tabBar.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.id === sessionId);
  });

  // Show/hide terminal wrappers
  terminalContainer.querySelectorAll(".terminal-wrapper").forEach((w) => {
    w.classList.toggle("active", w.dataset.id === sessionId);
  });

  // Hide empty state
  emptyState.style.display = "none";

  // Fit terminal
  const session = sessions.get(sessionId);
  if (session) {
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

  try {
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  } catch {}

  session.ws.close();
  session.terminal.dispose();
  session.tabEl.remove();
  session.wrapperEl.remove();
  sessions.delete(sessionId);

  updateSessionCount();

  if (activeSessionId === sessionId) {
    const remaining = Array.from(sessions.keys());
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
  const count = sessions.size;
  sessionCount.textContent = `${count} instance${count !== 1 ? "s" : ""}`;
}

async function loadExistingSessions() {
  try {
    const res = await fetch("/api/sessions");
    const list = await res.json();
    for (const data of list) {
      // Recreate tab and terminal for existing sessions
      const tab = document.createElement("div");
      tab.className = "tab";
      tab.dataset.id = data.id;
      tab.innerHTML = `
        <span class="status-dot ${data.status === "exited" ? "exited" : ""}"></span>
        <span class="tab-name">${data.name}</span>
        <button class="close-btn" title="Close instance">&times;</button>
      `;
      tab.addEventListener("click", (e) => {
        if (!e.target.classList.contains("close-btn")) switchTab(data.id);
      });
      tab.querySelector(".close-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(data.id);
      });
      tabBar.appendChild(tab);

      const wrapper = document.createElement("div");
      wrapper.className = "terminal-wrapper";
      wrapper.dataset.id = data.id;
      terminalContainer.appendChild(wrapper);

      const { terminal, fitAddon } = createTerminal(wrapper);

      const ws = new WebSocket(getWsUrl());
      const session = {
        id: data.id,
        name: data.name,
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
              return;
            }
            if (msg.type === "attached" || msg.type === "error") return;
          } catch {}
        }
        terminal.write(event.data);
      };

      ws.onclose = () => {
        if (sessions.has(data.id)) {
          setTimeout(() => reconnect(data.id), 2000);
        }
      };

      terminal.onData((input) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: input }));
        }
      });

      sessions.set(data.id, session);
    }

    updateSessionCount();

    if (list.length > 0) {
      switchTab(list[0].id);
    }
  } catch {}
}

// Window resize handling
window.addEventListener("resize", () => {
  if (activeSessionId) {
    const session = sessions.get(activeSessionId);
    if (session) {
      session.fitAddon.fit();
      sendResize(session);
    }
  }
});

// Usage polling
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

// Modal events
browseBtn.addEventListener("click", browseForFolder);
modalCancel.addEventListener("click", hideModal);
modalStart.addEventListener("click", () => createNewInstance(pathInput.value));
pathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createNewInstance(pathInput.value);
  if (e.key === "Escape") hideModal();
});
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) hideModal();
});

// Init
newTabBtn.addEventListener("click", showNewInstanceModal);
loadExistingSessions();
