# Inline Token Usage — Internal Tab + Sidebar Summary

## Goal

Move token usage from a separate browser tab (`usage.html`) to an **internal tab** inside the app, shown to the left of the main agent tab. Also show a compact token summary in the team sidebar. Remove the "Usage" header button that opens a new browser tab.

## Current State

- `usage.html` is a standalone page opened in a new tab via `window.open`
- Token data comes from `/api/teams/:teamId/usage` (already working)
- Sidebar shows team name + agent count badge only

## Plan

### 1. Add token usage summary to sidebar team items

In `app.js` `renderTeamItem()`:
- Add a `<span class="team-item-tokens">` below the agent badge
- Shows total tokens for the team (e.g. "12.3k tokens")
- Poll `/api/teams/:teamId/usage` every 5s (reuse existing polling interval) and update

In `style.css`:
- Style `.team-item-tokens` — small monospace text in blue (#89b4fa), below the badge

### 2. Create an internal "Usage" tab (left of agent tabs)

The usage tab is **per-team** — when you select a team, a pinned "Usage" tab appears as the first tab in the tab bar. It shows the same data as `usage.html` but only for the active team.

In `index.html`:
- Add a hidden `<div id="usage-panel" class="terminal-wrapper">` inside `#terminal-container` for the usage content

In `app.js`:
- Add a pinned "Usage" tab element that always appears first in tab bar when a team is selected
- When clicked, hide all terminal wrappers, show `#usage-panel` with the rendered usage content
- Fetch `/api/teams/:teamId/usage` and render summary cards + agent table (reuse rendering logic from `usage.html`)
- Auto-refresh every 5s when the usage tab is active
- When switching to an agent tab, hide `#usage-panel` and show the terminal

In `style.css`:
- Style the usage panel content — reuse usage.html styles (summary grid, agent table) adapted for the panel
- Style the pinned usage tab differently (e.g. icon or different color)

### 3. Replace Usage header button

- Change the "Usage" button click handler from `window.open` to switching to the usage tab
- Or remove the button entirely since usage is accessible via the pinned tab

### 4. Files to modify

| File | Changes |
|------|---------|
| `public/index.html` | Add `#usage-panel` div inside terminal container |
| `public/js/app.js` | Add usage tab logic, sidebar token polling, rendering functions |
| `public/css/style.css` | Styles for usage panel, sidebar tokens, pinned tab |

### 5. No server changes needed

The `/api/teams/:teamId/usage` endpoint already returns everything we need.

### 6. Keep usage.html

Keep the standalone page as-is (it still works), but the primary UX is now the internal tab.

## Implementation Order

1. Add sidebar token summary + polling
2. Add usage panel HTML structure
3. Port rendering logic from usage.html into app.js
4. Add usage tab creation/switching logic
5. Wire up the Usage button to switch to internal tab
6. Add CSS styles
