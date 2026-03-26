# Spec Directory — Team Maker

This `specs/` directory contains the Specification-Driven Development (SDD) documents for Team Maker. SDD is a workflow where each feature is specified before it is built: a spec file describes the expected behavior, interfaces, and acceptance criteria, and implementation work only begins once the spec is reviewed and approved. After implementation, a Validator confirms behavior matches the spec, and the Scribe marks each item done. This creates a living contract between intent and code, and prevents scope drift.

---

## Spec Files

| File | Title | Description | Spec Status |
|------|-------|-------------|-------------|
| [00-overview.md](00-overview.md) | System Overview | High-level purpose, key concepts, glossary, and top-level feature list | `[x] Done` |
| [01-architecture.md](01-architecture.md) | Architecture | Component map, data flow diagrams, dependency graph, and NPM dependencies | `[x] Done` |
| [02-contracts.md](02-contracts.md) | Contracts & Interfaces | All REST endpoints, WebSocket message types, and MCP tool schemas | `[x] Done` |
| [03-backend.md](03-backend.md) | Backend | All 11 server modules with PTY lifecycle, session management, and supporting infrastructure | `[x] Done` |
| [04-frontend.md](04-frontend.md) | Frontend | Tab management, xterm.js terminals, WebSocket client, modals, panels, and theming | `[x] Done` |
| [05-agents.md](05-agents.md) | Agent Orchestration | MCP server architecture, all 17 MCP tools, agent lifecycle, task state machine, and orchestrator pattern | `[x] Done` |

---

## Status Marker Convention

Every component, feature, endpoint, or behavior block in a spec file carries one of the following status markers:

| Marker | Meaning |
|--------|---------|
| `[ ] Pending` | Exists in the codebase or is planned, but not yet SDD-validated |
| `[~] In Progress` | Currently being built or changed |
| `[x] Done` | Implemented and believed correct |
| `[✓] Validated` | Tested and confirmed to match the spec |
| `[!] Failed` | Validation attempted and failed — needs fix |

Markers appear on both individual component blocks (at the `> Status:` line inside each block) and on individual acceptance criteria checkboxes (`- [ ]` items). A component is only `[✓] Validated` when all its acceptance criteria are checked.

---

## SDD Feature Development Flow

All new features and significant changes follow this flow:

1. **Spec** — Write or update the relevant spec file with Purpose, Responsibilities, Interfaces, Behavior/Rules, and Acceptance Criteria. Set status to `[ ] Pending`.
2. **Approve** — User (or team lead) reviews and approves the spec. Status remains `[ ] Pending` until approved.
3. **Build** — Builder implements the feature against the spec. Status moves to `[~] In Progress`.
4. **Validate** — Validator runs the acceptance criteria against the implementation. If all pass, status moves to `[✓] Validated`. If any fail, status is `[!] Failed` and the cycle returns to Build.
5. **Document** — Scribe updates the spec to mark all criteria done, sets doc-level status to reflect current state, and closes the loop.

> This flow applies to features, not hotfixes. Small bug fixes may skip the spec step if the existing spec already covers the expected behavior.
