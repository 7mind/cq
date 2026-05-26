# M4 — Persistence + History tab — archive

Closed: 2026-05-26.
Active span: 9 PRs (PR-39 … PR-47). All [x]. No new defects.
Acceptance at close: `bun x tsc -b` 0; `bun x eslint .` 0; `bun test` → 383/383 pass across 58 files (0 fail).

## PR-by-PR (one line each)

- **PR-39** — Persistence layer: DDL + migrations + open; `Persistence.ts` interface; FTS5 triggers. `persist-open.test.ts`.
- **PR-40** — `SqlitePersistence` + `InMemoryPersistence` (dual-tests); CRUD + paginate + filter + FTS; JSONL event-log writer; FTS-update assertion (F-13). `persist-crud.test.ts`.
- **PR-41** — Bridge writes to persistence (live): `chat.start` → insert session+invocation; events → JSONL; `task_started` → child invocation; `history.update` live. `bridge-persist.test.ts`.
- **PR-42** — Web `HistoryTab` list view (sortable, filterable, FTS search). `history-list.test.ts`.
- **PR-43** — Resume-from-history (`resumeFromInvocationId` → SDK `resume:`; transcript replayed via `history.get?replay=true`). `resume.test.ts`.
- **PR-44** — Web `Detail` view (reuses Chat renderer; `Stream` gains `mode='live'|'replay'`). `history-detail.test.ts`.
- **PR-45** — Web `Timing` strip (SVG horizontal time axis with tool-call rectangles). `timing.test.ts`.
- **PR-46** — Export: copy-as-markdown + download-as-json. `export.test.ts`.
- **PR-47** — `history.delete` end-to-end: `sessions.delete` + `invocations.delete` unlink JSONL files before DB cascade; `history.delete` frame handler in `ws/session.ts` emits `history.update{patch:{deleted:true}}`; Detail header gains Delete button + confirm dialog. `history-delete.test.ts` (2 cases, 17 assertions).

## Cross-cutting changes during M4

- `SqlitePersistence.ts`, `sessions.ts`, `invocations.ts` — JSONL cleanup on delete.
- `ws/session.ts` — `history.list`, `history.get` + replay, `history.delete` handlers.
- `web/src/history/` — `HistoryTab`, `List`, `Detail`, `Timing`, `Export` components.
- `packages/shared/src/protocol.ts` — `HistoryDelete`, `HistoryUpdate`, `HistoryRow`, `HistoryRowFull`, replay frames.
