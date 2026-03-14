# Team Maker

A web-based manager for running multiple Claude Code CLI instances from your browser.

## What it does

- **Start Claude Code instances** — Click "+ New Instance" to choose a working directory (browse via Finder or type a path) then spawn a session
- **Tab-based interface** — Each instance runs in its own tab, switch between them freely
- **Real-time terminal** — Full terminal rendering with colors, cursor, and interactive prompts via xterm.js
- **Monitor usage** — Status bar shows session duration and I/O stats
- **Session persistence** — Sessions survive page refreshes; the server keeps processes alive with a 100KB scrollback buffer

## Architecture

```
Browser (xterm.js) <--WebSocket--> Node.js Server <--PTY--> Claude Code CLI
```

- **Backend**: Node.js with Express (REST API) + ws (WebSocket for terminal I/O) + node-pty (pseudo-terminal)
- **Frontend**: Vanilla HTML/CSS/JS with xterm.js loaded from CDN (no build step)

## Project structure

```
team-maker/
├── server/
│   ├── index.js             # Express + WebSocket server
│   └── sessionManager.js    # PTY session lifecycle (spawn, resize, kill, scrollback)
├── public/
│   ├── index.html           # Main page
│   ├── css/style.css        # Dark theme styles
│   └── js/app.js            # Tab management, WebSocket connections, usage polling
├── docs/
│   └── summary.md           # This file
└── package.json
```

## API

| Method   | Path                        | Description              |
|----------|-----------------------------|--------------------------|
| `GET`    | `/api/browse-folder`        | Open native Finder dialog to pick a folder |
| `POST`   | `/api/sessions`             | Create a new session (accepts optional `cwd`) |
| `GET`    | `/api/sessions`             | List all sessions        |
| `GET`    | `/api/sessions/:id`         | Get session details      |
| `DELETE` | `/api/sessions/:id`         | Kill and remove session  |
| `POST`   | `/api/sessions/:id/resize`  | Resize terminal          |

WebSocket connects to the same host and uses JSON messages for control (`attach`, `resize`, `input`) and raw data for terminal output.

## Running

```
npm install
npm start
```

Open http://localhost:3456 in your browser.

## Dependencies

- **express** — HTTP server and static file serving
- **ws** — WebSocket server for real-time terminal streaming
- **node-pty@0.10.1** — Pseudo-terminal allocation (v0.10.1 required; v1.x prebuilds are broken on some macOS setups)
- **uuid** — Session ID generation
- **xterm.js** — Terminal rendering in the browser (loaded from CDN)
