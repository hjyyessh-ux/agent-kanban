<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# web/src/ — React SPA Shell

## OVERVIEW

React/Vite UI for board, scheduler, scripts, capabilities, wiki, and settings management, with a global pending-question overlay. `App.tsx` owns tab switching, modal orchestration, and wiring between domain hooks and presentational components.

## STRUCTURE

```text
web/src/
├── App.tsx                 # Board / Scheduler / Scripts / Settings shell + question banner
├── main.tsx                # React root; imports global styles + bootstraps auth
├── components/
│   ├── Board/
│   ├── Card/
│   ├── Scheduler/
│   ├── Scripts/
│   ├── Settings/
│   ├── Capabilities/
│   ├── Wiki/
│   └── Question/
├── hooks/AGENTS.md         # API wrappers, reducers, polling, accessibility utilities
├── api/AGENTS.md           # Same-origin auth-token bootstrap wrapping window.fetch
├── constants/AGENTS.md     # Agent/command display metadata derived from src/core/
├── styles/AGENTS.md        # Global CSS tokens + .neo-* (v1) / .kv2-* (v2 board) systems
├── utils/AGENTS.md         # Pure formatting/label/stale-state helper functions
└── assets/                 # Static assets (images/icons)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Change app shell / tabs / modal wiring | `App.tsx` | Owns top-level composition |
| Change board UI | `components/Board/`, `components/Card/` | Kanban columns, detail modal, create modal |
| Change scheduler UI | `components/Scheduler/` | Entries, modal, run history |
| Change scripts UI | `components/Scripts/` | Script CRUD, sync, history |
| Change settings UI | `components/Settings/` | Secrets, network toggle, model visibility |
| Change capabilities UI | `components/Capabilities/` | Skills, MCP, scope inventory/targets, diagnostics |
| Change wiki UI | `components/Wiki/` | Wiki view + graph, lazy-loaded from `App.tsx` |
| Change pending-question UI | `components/Question/QuestionBanner.tsx` | Overlay for question reply/reject |
| Change fetch/state/polling logic | `hooks/AGENTS.md` | Domain hook guide |
| Change same-origin auth bootstrap | `api/AGENTS.md` | Wraps `window.fetch` with the install token |
| Change agent/command display metadata | `constants/AGENTS.md` | Labels, colors, emoji sourced from `src/core/` |
| Change global styling tokens | `styles/AGENTS.md` | `.neo-*` (v1, global) and `.kv2-*` (v2, board-only) |
| Change shared formatting/label helpers | `utils/AGENTS.md` | Pure functions, no fetch/state |

## CONVENTIONS

- Shared backend types are imported by relative path from `src/core/types.ts`.
- Components stay mostly prop-driven; network/state logic belongs in hooks.
- Board and questions poll every 3 seconds; scheduler, scripts, and settings poll every 10 seconds when their tab is active.
- Styling stays in plain CSS; `.neo-*` primitives and local component CSS files are the norm.
- No router: tab state in `App.tsx` drives all navigation.

## ANTI-PATTERNS

- Direct `fetch()` calls inside components
- Duplicating reducer/state logic already handled by hooks
- Hardcoded mock data or absolute API hosts
- Tailwind, CSS modules, styled-components, React Router, React Query/SWR

## NOTES

- `QuestionBanner` is always mounted at the app root so pending questions can interrupt any tab.
- Scripts and settings are first-class tabs now; do not let docs or UI assumptions drift back to board-only behavior.
- Capabilities and Wiki are also first-class tabs (Wiki is lazy-loaded); keep this list in sync as new top-level tabs are added.
