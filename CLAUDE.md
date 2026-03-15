# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Team Maker is a web-based manager for running multiple Claude Code CLI instances from a browser. It spawns PTY-backed Claude Code processes and streams terminal I/O over WebSocket to an xterm.js frontend.

## Commands

- **Start server**: `npm start` (runs on http://localhost:3456)
- No build step, linter, or test suite configured.

## Architecture

```
Browser (xterm.js) <--WebSocket--> Express Server <--PTY--> Claude Code CLI
```

- **server/index.js** — Express HTTP server + WebSocket server. REST endpoints for session CRUD, a `/api/browse-folder` endpoint that opens a native macOS Finder dialog via `osascript`, and WebSocket handling for attaching to sessions and proxying terminal I/O.
- **server/sessionManager.js** — Singleton `SessionManager` with a `Session` class. Each session spawns a `node-pty` process running the Claude CLI, maintains a 100KB scrollback buffer, and tracks connected WebSocket clients. Includes question detection: strips ANSI from PTY output into a rolling plain-text buffer and pattern-matches for permission/dialog prompts, sending `{type: "question"}` over WebSocket.
- **public/** — Vanilla HTML/CSS/JS frontend (no build step, no framework). xterm.js and addons loaded from CDN. `app.js` manages tabs, WebSocket connections, terminal instances, a modal for selecting the working directory before starting a session, and plays a Web Audio alert sound + pulses the tab dot yellow when a session has a question dialog.

## Key Conventions

- **ES Modules** — The project uses `"type": "module"` in package.json. Use `import`/`export`, not `require`.
- **No TypeScript** — Pure JavaScript throughout.
- **node-pty pinned to 0.10.x** — v1.x prebuilds are broken on some macOS setups. Do not upgrade.
- **macOS-specific** — The folder browse feature uses `osascript` (AppleScript). The default Claude CLI path is `/Users/tung/.local/bin/claude` (overridable via `CLAUDE_PATH` env var).
- **Catppuccin Mocha theme** — The UI uses Catppuccin Mocha colors consistently across CSS and xterm.js terminal theme.
