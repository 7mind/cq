---
ledger: tasks
counters:
  milestone: 0
  item: 89
archives:
  - id: M5
    path: ./archive/tasks/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
  - id: M2
    path: ./archive/tasks/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
  - id: M3
    path: ./archive/tasks/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
  - id: M4
    path: ./archive/tasks/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
  - id: M6
    path: ./archive/tasks/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
  - id: M7
    path: ./archive/tasks/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
  - id: M8
    path: ./archive/tasks/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
  - id: M9
    path: ./archive/tasks/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
---

# tasks

## M12

### T50 — done

- createdAt: 2026-06-02T08:46:21.175Z
- updatedAt: 2026-06-02T10:52:16.434Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Add 'warning' status bucket; map `revise` to it (both status.ts)
- description: "Item #6 (root). In BOTH packages/ledger-tui/src/status.ts and packages/ledger-web/src/status.ts, extend `StatusBucket` with a new `warning` member and change `statusBucket()` so terminal-negative review verdicts route to it instead of greening. Concretely: introduce a `WARNING` set containing `revise` (and any sibling 'needs-changes' terminal verdict) and, in the terminal branch of `statusBucket`, return `warning` when the lowercased status is in WARNING (checked before the DROPPED test). `revise` is terminal (REVIEWS_SCHEMA.terminalStatuses includes both `go-ahead` and `revise`), so it MUST remain bucketed as terminal — do not move it to a non-terminal branch. Keep the two status.ts files mirror-identical in the bucket logic (they are intentional duplicates). Do not yet wire colors — that is the next two tasks."
- acceptance: "Unit test in each package: statusBucket('revise', REVIEWS_SCHEMA) === 'warning' and statusBucket('go-ahead', REVIEWS_SCHEMA) === 'done'; existing bucket tests (planned/wip/blocked/abandoned) unchanged. `bun run typecheck` passes (StatusBucket union updated everywhere it is switched on)."
- suggestedModel: standard
- ledgerRefs: ["goals:G2"]
- resultCommit: 492b38f
- completion: "Added 'warning' StatusBucket + WARNING={revise} checked before DROPPED in both status.ts (mirror-identical); revise stays terminal→warning, go-ahead→done; BUCKET_COLOR['warning']='yellow' placeholder (T51 sets magenta). Reviewer approve 0/0. Merged 492b38f; integration 505 pass."

### T51 — done

- createdAt: 2026-06-02T08:46:30.482Z
- updatedAt: 2026-06-02T11:14:45.564Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: give the `warning` bucket a distinct ink color (magenta)"
- description: "Item #6 (TUI). In packages/ledger-tui/src/status.ts add `warning: \"magenta\"` to the BUCKET_COLOR map so statusColor('revise', REVIEWS_SCHEMA) returns 'magenta' rather than 'green'. Do not reuse 'yellow' (already the `progress` bucket) per Q34. This is the full TUI side of item #6 (the TUI has no graph, so #8 does not apply here). Verify badge rendering in the list/detail panes picks up the new color automatically (they already call statusColor)."
- acceptance: "Unit test: statusColor('revise', REVIEWS_SCHEMA) === 'magenta'; statusColor('go-ahead', REVIEWS_SCHEMA) === 'green' unchanged. An ink-testing-library render of a reviews item with status 'revise' shows the badge in magenta (assert via the Text color prop / frame). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T50"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 1214c9d
- completion: "TUI BUCKET_COLOR['warning']='magenta' (was T50 'yellow' placeholder); progress keeps yellow (no Q34 collision); statusColor('revise')='magenta', ('go-ahead')='green'; unit + ink-render ([35m) tests. Reviewer approve 0/0. Merged 1214c9d."

### T52 — done

- createdAt: 2026-06-02T08:46:39.837Z
- updatedAt: 2026-06-02T11:01:54.007Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: canonical bucket→color palette as the single shared source (CSS vars + JS map) incl. `warning`"
- description: "Items #6 + #8 (web foundation). Establish ONE canonical StatusBucket→color source in the web package, consumed by both the CSS status badges and (next task) the SVG graph. Concretely: (a) define a bucket→hex palette ONCE — e.g. CSS custom properties `--lw-status-<bucket>` on :root in the stylesheet, with a small exported TS record (e.g. `BUCKET_HEX: Record<StatusBucket, string>` in status.ts or a new palette.ts) holding the SAME hex values, so SVG fills (which can't read a CSS class) and CSS badges agree; (b) add the new `warning` bucket to both — amber/orange (e.g. #e0a341) per Q34 — and the existing `.lw-status-warning` badge class deriving from `--lw-status-warning`; (c) refactor existing `.lw-status-*` badge rules to reference the custom properties so there is no second copy of the palette. No behavioral change to start/progress/blocked/done/dropped colors beyond sourcing them from the shared definition. The web badges already emit class `lw-status-${statusBucket(...)}` so `revise` will pick up the warning class automatically once the bucket exists (from T50)."
- acceptance: "happy-dom test: a reviews item with status 'revise' renders a badge whose className includes `lw-status-warning` (not `lw-status-done`). The exported BUCKET_HEX has a `warning` entry and one entry per bucket; a test asserts BUCKET_HEX keys === the StatusBucket union members. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T50"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 7609b8a
- completion: "Web: canonical BUCKET_HEX:Record<StatusBucket,string> (single source) mirrored as --lw-status-* CSS vars on :root; .lw-status-warning=#e0a341 (Q34 amber, distinct from progress); badge rules re-sourced from vars (no palette dup); revise→lw-status-warning; tests assert keys===union. Reviewer approve 0/0. Merged 7609b8a."

### T53 — done

- createdAt: 2026-06-02T08:46:50.633Z
- updatedAt: 2026-06-02T11:14:48.893Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web graph: color DAG nodes via statusBucket + shared palette (thread schema)"
- description: "Item #8 (web-only). Replace DagView.tsx's local STATUS_COLORS map (keyed on raw status, milestone-only, amber fallback at L13-21) with the shared bucket→hex palette from T52. Because statusBucket(status, schema) needs schema.terminalStatuses, thread the ledger schema into the graph path: add `schema: LedgerSchema` (or just `terminalStatuses`) to DagData in dagData.ts and populate it in loadDagData (it already has `view.schema` at L48); pass it through DagView so each node computes `BUCKET_HEX[statusBucket(node.status, schema)]` for its rect/stroke/status-text fill. This makes task/defect/review/hypothesis statuses (planned, wip, go-ahead, revise, confirmed, …) color correctly instead of all falling to amber, and uses the SAME palette as the badges (single source). Keep the selected-node highlight (active stroke '#e6e9ef') behavior. Per Q36 this is web-scoped (TUI has no DAG)."
- acceptance: "happy-dom test rendering DagView for a non-milestones ledger: a node with status 'revise' uses the warning hex; a 'done'/terminal node uses the done hex; a non-terminal 'planned' node uses the start hex — i.e. no node falls back to the old amber default for a known status. DagData carries the schema/terminalStatuses. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T52"]
- ledgerRefs: ["goals:G2"]
- resultCommit: d5137ce
- completion: "DagView nodes colored via shared BUCKET_HEX[statusBucket(status,schema)] (replaced milestone-only amber-fallback STATUS_COLORS); schema threaded into DagData from view.schema (no extra MCP call); selected-highlight preserved; happy-dom test revise→warning/done→done/planned→start. Reviewer approve 0/0. Merged d5137ce. M12 COMPLETE."

## M13

### T54 — done

- createdAt: 2026-06-02T08:47:03.877Z
- updatedAt: 2026-06-02T10:52:19.206Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Array-field editor delimiter: split on semicolons/newlines (both UIs)"
- description: |
    Item #4 (editor side). Today parseFieldValue(raw, type) splits string[]/id[] inputs on COMMAS in both web (App.tsx L144-149) and TUI (app.tsx L90-95), and the web edit input placeholder says 'comma,separated' (L1675). Models write suggestion lists as 'a; b; c' in a single element, so commas are the wrong delimiter for prose-bearing suggestions.
    
    DELIMITER RULE (decided here, NOT deferred to the implementer):
    - `string[]` (e.g. suggestions): split on SEMICOLONS and NEWLINES, trim each element, drop empties.
    - `id[]` (dependsOn/blockedBy — COMMON_REF_FIELDS): KEEP the existing COMMA split unchanged. Rationale (lowest-risk): ids contain no semicolons or prose, existing multi-id entry and tests rely on comma-splitting, and changing it would be an unnecessary regression surface. Do NOT change id[] parsing.
    
    Apply this split-by-type rule identically in both parseFieldValue implementations (web App.tsx + TUI app.tsx) — keep the two mirror-identical. Update the web edit-input placeholder for string[] fields to reflect semicolon/newline separation (e.g. 'semicolon; or newline separated'); leave the id[] placeholder/comma guidance as-is.
- acceptance: "Unit test (each package): parseFieldValue('a; b; c', 'string[]') === ['a','b','c']; parseFieldValue('a\\nb', 'string[]') === ['a','b']; whitespace trimmed and empties dropped. parseFieldValue('T1, T2', 'id[]') === ['T1','T2'] (comma split for id[] UNCHANGED, no regression). The two parseFieldValue implementations are byte-for-byte equivalent in their split logic. `bun run check` green."
- suggestedModel: standard
- ledgerRefs: ["goals:G2"]
- resultCommit: dd918a7
- completion: "parseFieldValue splits string[] on /[;\\n]/ (trim, drop empties) in both UIs; id[] keeps comma-split (T1,T2 invariant preserved); web string[] placeholder updated; parseFieldValue exported + 18 unit tests. Reviewer approve 0/0. Merged dd918a7."

### T55 — done

- createdAt: 2026-06-02T08:47:11.876Z
- updatedAt: 2026-06-02T11:51:50.029Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: One-shot normalize existing question `suggestions` (split semicolon-joined elements)
- description: |
    Item #4 (data normalization). Existing on-disk question items have suggestions stored either already as a proper array, or as one array element containing 'a; b; c' (semicolon-joined legacy data). Per Q32, normalize freely (dogfood-only, no back-compat): write a small one-shot maintenance script (e.g. under packages/ledger or a scripts/ dir) that, via the ledger library/MCP tools (NOT by hand-editing docs/*.md — CLAUDE.md forbids that), iterates every item in the questions ledger and rewrites `suggestions`.
    
    NORMALIZATION MUST OPERATE ON THE STORED ARRAY ELEMENTS DIRECTLY — do NOT route through T54's editor parseFieldValue path. Concretely: read the current `suggestions` value, coerce to an array (an already-array value stays an array; a bare string becomes a single-element array), then for EACH element split it on semicolons AND newlines, trim, drop empties, and flatten into the result array. This makes the pass independent of T54's editor-delimiter change (so it neither depends on nor is affected by it) and idempotent by construction: already-split elements contain no semicolons/newlines, so a second run is a no-op. (This is why T55 no longer dependsOn T54 — the split logic is inlined in the script, not borrowed from the parser.)
    
    Run it once against this repo's ledger and confirm the questions ledger's suggestions are now proper multi-element arrays.
- acceptance: After running, fetch a question that previously had a semicolon-joined suggestions value (e.g. one of Q29–Q36 which carry multi-option suggestions) and confirm `suggestions` is an array with one trimmed entry per option, no semicolons/newlines embedded in any element. The script splits stored array elements directly (does NOT call parseFieldValue). Re-running the script produces no further changes (idempotent — verified by a second run diffing to empty). Script is committed; `bun run check` green.
- suggestedModel: standard
- dependsOn: []
- ledgerRefs: ["goals:G2"]
- resultCommit: f1102ab
- completion: "Delivered: packages/ledger/src/normalizeSuggestions.ts (pure split-on-;/newline helper, no parseFieldValue) + scripts/normalize-suggestions.ts (FsLedgerStore one-shot) + idempotent unit test (16 cases). Reviewer approve 0/0. Merged f1102ab. NOTE: the one-shot DATA run against the live repo ledger is DEFERRED — running it mid-session would be clobbered by this session's MCP server rewriting docs/questions.md from stale in-memory state; run `bun scripts/normalize-suggestions.ts` with the ledger server quiesced, then restart it. M13 COMPLETE."

### T56 — done

- createdAt: 2026-06-02T08:47:22.715Z
- updatedAt: 2026-06-02T11:01:50.135Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: render `suggestions` (string[]) as a bulleted list"
- description: "Item #4 (web render). In packages/ledger-web/src/App.tsx the detail panel renders array values as `v.join(', ')` (renderQuestionFields renderVal L1761-1762, and the generic field render L1835). Add a list renderer for the questions `suggestions` field specifically (and ideally any string[] field) so it shows as a real bulleted list (<ul><li>…) rather than a comma-joined string. Keep markdown handling for string scalars. A shared small helper (e.g. renderListField) keeps it DRY. This is the rendering half of item #4; the field-order task (T58) will then place this list in the correct sequence."
- acceptance: "happy-dom test: a question with suggestions ['opt a','opt b','opt c'] renders three <li> entries under the suggestions field (not a single 'opt a, opt b, opt c' string). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T54"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 17aabe5
- completion: "Web: renderListField emits <ul><li> for string[] fields (both detail render paths); scalar Markdown preserved; happy-dom test asserts 3 <li>. Reviewer approve 0/0. Merged 17aabe5."

### T57 — done

- createdAt: 2026-06-02T08:47:27.144Z
- updatedAt: 2026-06-02T11:32:36.826Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: render `suggestions` (string[]) as a bulleted list"
- description: Item #4 (TUI render). The TUI ContentPane joins array values with ', ' (fieldToString / array render). Render the questions `suggestions` field as a bulleted list — one ink <Text> line per element prefixed with a bullet (e.g. '• ') — rather than a comma-joined line. Keep the existing markdown rendering for scalar string fields. This is the TUI rendering half of item #4; the field-order task (T59) places the list in the correct sequence.
- acceptance: "ink-testing-library test: a question with suggestions ['opt a','opt b'] renders two bulleted lines in the content pane (assert the frame contains both options on separate lines with the bullet glyph). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T54"]
- ledgerRefs: ["goals:G2"]
- resultCommit: c3899b0
- completion: "TUI ContentPane renders questions.suggestions (string[]) as a '• '-prefixed bulleted list, intercepted before the isShortField comma-join; scalar markdown preserved; ink test (repro-verified). Reviewer approve 0/0. Merged c3899b0."

### T58 — done

- createdAt: 2026-06-02T08:47:39.484Z
- updatedAt: 2026-06-02T11:51:39.667Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: question detail literal field order milestone,status,by,question,context,suggestions,recommendation,answer"
- description: "Item #3 (web). Per Q31's ANSWER (note: deviates from the planner's recommendation — context comes BEFORE suggestions): restructure the questions DetailPanel so the rendered sequence is LITERALLY: milestone, status, by, question, context, suggestions, recommendation, answer. Today (App.tsx) status renders first, generic short-first metadata next, then question/context/recommendation/answer, with 'milestone' and 'by' in a trailing block (L1839-1849). Rework renderQuestionFields() + the surrounding <dl> for question items so the three leading metadata rows (milestone, status, by) appear first in that exact order, then the narrative in the exact order question → context → suggestions (the bulleted list from T56) → recommendation (keep the highlighted lw-recommendation styling) → answer (editable answerBox when answerable, else stored value). Apply ONLY to question items (isQuestion(schema)); leave non-question detail rendering unchanged. Add a QUESTION_FIELD_ORDER-style constant if helpful, but the metadata trio is structural so it may live in the component."
- acceptance: "happy-dom test on a question item asserts the detail's field labels appear in DOM order exactly: milestone, status, by, question, context, suggestions, recommendation, answer. Recommendation retains its highlighted container; suggestions renders as the T56 bulleted list. Non-question items' detail order is unchanged (existing tests pass). `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T56"]
- ledgerRefs: ["goals:G2"]
- resultCommit: af8e825
- completion: Web question DetailPanel renders exact order milestone,status,by,question,context,suggestions,recommendation,answer (renderQuestionFields owns the <dl>); recommendation highlight + bulleted suggestions; non-question unchanged; SUGGESTIONS_FIELD added to web QUESTION_FIELD_ORDER. Reviewer approve 0/0. Merged af8e825; integration 549 pass.

### T59 — done

- createdAt: 2026-06-02T08:47:46.131Z
- updatedAt: 2026-06-02T11:51:42.935Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: question detail literal field order milestone,status,by,question,context,suggestions,recommendation,answer"
- description: "Item #3 (TUI). Mirror of T58 for the TUI ContentPane. Today it renders id/status header lines, a 'milestone … created … updated' line, a 'by' line, then QUESTION_FIELD_ORDER (= question, context, recommendation, answer). Per Q31's answer, for question items render the leading metadata as exactly milestone, status, by (in that order) followed by the narrative question → context → suggestions (bulleted list from T57) → recommendation → answer. Extend the shared QUESTION_FIELD_ORDER (packages/ledger-tui/src/status.ts; mirror in web/status.ts to keep them identical) to [question, context, suggestions, recommendation, answer], and restructure ContentPane's leading lines so milestone/status/by lead in that literal order (drop created/updated from the leading trio, or relocate them out of the required sequence). Apply only to question items; non-question rendering unchanged."
- acceptance: "ink-testing-library test on a question item: the content-pane frame shows the labels milestone, status, by, question, context, suggestions, recommendation, answer in that vertical order. QUESTION_FIELD_ORDER in both status.ts files is identical and includes suggestions between context and recommendation. Non-question items unchanged. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T57"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 5710c72
- completion: "TUI ContentPane question order milestone→status→by→question→context→suggestions→recommendation→answer; QUESTION_FIELD_ORDER=[question,context,suggestions,recommendation,answer] byte-identical in both status.ts (orchestrator resolved a dup-add conflict on web status.ts comment); non-question unchanged; ink test. Reviewer approve 0/0. Merged 5710c72."

## M14

### T60 — done

- createdAt: 2026-06-02T08:47:57.646Z
- updatedAt: 2026-06-02T11:01:59.159Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Column model: eligible-fields rule + per-ledger default columns constant"
- description: "Item #1 (foundation, both UIs). Per Q29/Q30: define a FIELD-LEVEL eligibility rule (NOT the per-value isShortField) for which schema fields can be shown as columns. Rule: eligible = every schema field name EXCEPT a small denylist of known long/narrative fields (description, rationale, criticism, context, alternatives, evidence, completion, and similar) AND excluding id/status/summary which are ALWAYS shown. Add a per-ledger DEFAULT columns constant: tasks defaults to showing `suggestedModel`; other ledgers default to none-extra. Place these as exported pure helpers (e.g. eligibleColumnFields(schema): string[] and defaultColumns(ledgerName): string[]) so both frontends and their tests share one definition — a sensible home is @cq/ledger (constants) or a small shared module; if cross-package import is awkward, mirror the same pure helper in both frontends (matching the status.ts duplication convention). No schema change."
- acceptance: "Unit test: eligibleColumnFields(TASKS_SCHEMA) includes 'suggestedModel' and excludes 'description'/'id'/'status'; defaultColumns('tasks') === ['suggestedModel']; defaultColumns('goals') === []. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]
- resultCommit: 48fa2c6
- completion: "@cq/ledger columns.ts: pure eligibleColumnFields(schema) (field-level, minus long/narrative denylist + always-shown id/status/summary) + defaultColumns(ledgerName) (tasks→['suggestedModel']); index-exported, no Node deps (browser-safe for T61); 6 unit tests. Reviewer approve 0/0 (noted acceptance/planDoc/grounding eligible — T61/T62 may refine). Merged 48fa2c6."

### T61 — done

- createdAt: 2026-06-02T08:48:07.769Z
- updatedAt: 2026-06-02T12:31:07.554Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: column selector (triple-dot menu) + extra columns, per-ledger localStorage"
- description: Item #1 (web). Add a triple-dot (⋮) button at the right end of the filters/toolbar row (the lw-toolbar at App.tsx L886) that opens a column-selector popup listing eligibleColumnFields(schema) (from T60) as checkboxes; checked fields render as extra <td>/<th> columns in ItemTable (both the flat milestones table and the per-milestone subsection tables), in addition to the always-shown id/status/summary. Persist the chosen set PER LEDGER in localStorage (new key namespace, mirroring PANEL_KEY/VIEW_KEY style at L57/L84); on first open of a ledger with no saved set, seed from defaultColumns(ledgerName) so the tasks view shows suggestedModel by default. Extra-column cell values render via the existing fieldToString (arrays joined) — a column is a compact scalar by the eligibility rule. No new MCP surface.
- acceptance: "happy-dom tests: (1) opening tasks shows a 'suggestedModel' column by default; (2) the ⋮ menu lists eligible fields; toggling one on adds its column header + cells, toggling off removes them; (3) the selection persists across a remount (localStorage) and is independent per ledger. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T60"]
- ledgerRefs: ["goals:G2"]
- resultCommit: "5786674"
- completion: "Web ⋮ column-selector (eligibleColumnFields checkboxes), extra columns in flat + subsection tables, per-ledger localStorage seeded from defaultColumns (tasks→suggestedModel). Round-0 criticism fixed in round 1: added @cq/ledger/columns→../ledger/src/columns.ts to ledger-web/tsconfig.json paths (mirroring relationships) so the dist-less browser bundle resolves it from source (verified via Bun.build repro); ./columns export points at real dist/src/columns.js. Reviewer approve (round 1). Merged 5786674; integration 555 pass."

### T62 — done

- createdAt: 2026-06-02T08:48:14.367Z
- updatedAt: 2026-06-02T12:18:11.304Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: column selector overlay + extra columns, per-ledger in-memory"
- description: "Item #1 (TUI). Add a column-selector affordance to the TUI: a new Overlay variant (extend the Overlay union at app.tsx L170-179, e.g. { t: 'pickColumns'; ledger }) opened by a keybinding (document it in the key hints), listing eligibleColumnFields(schema) (from T60) as a toggle list (reuse SelectList-style multi-select or a checkbox list). Selected fields render as extra columns in the item list rows alongside id/status/summary. Persist the per-ledger selection IN MEMORY for the session (per Q29 — no server/config persistence for the TUI); seed from defaultColumns(ledgerName) so the tasks view shows suggestedModel by default. Keep row layout readable within the pane width."
- acceptance: "ink-testing-library tests: (1) opening the tasks ledger shows a suggestedModel column by default; (2) the column overlay toggles a field on/off and the list rows gain/lose that column; (3) selection persists while navigating away and back within the session. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T60"]
- ledgerRefs: ["goals:G2"]
- resultCommit: a7d66b3
- completion: TUI column-selector Overlay (pickColumns, key 'c', documented) over eligibleColumnFields; extra columns render after id|status before summary (T31 alignment preserved); per-ledger in-memory (Q29), seeded from defaultColumns (tasks→suggestedModel); 3 ink tests. Reviewer approve 0/0. Merged a7d66b3 (recovered onto main after a stray verify-worker left the checkout on implement/T78); integration 552 pass.

### T63 — done

- createdAt: 2026-06-02T08:48:27.429Z
- updatedAt: 2026-06-02T12:48:15.974Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: batch-answer modal stepping open questions (sidebar button, larger font, prev/next + kbd nav)"
- description: "Item #5 (web). Per Q33: add a button at the BOTTOM of the left sidebar (lw-sidebar, App.tsx L838) that opens a large modal/popup (reuse the HelpOverlay backdrop pattern) which steps through all UNANSWERED (open) answerable items one at a time in a focused, LARGER-FONT layout. Each step shows the question fields (question, context, suggestions list, highlighted recommendation) and the same actions as the existing answerBox: 'save & mark answered' and 'as recommended' (canned AS_RECOMMENDED_ANSWER), advancing to the next open question after a save. Add explicit LEFT/RIGHT navigation buttons in the popup AND keyboard navigation via ctrl/cmd+[ (prev) and ctrl/cmd+] (next) (Q33 addendum). Scope: ANY answerable ledger via canAnswer (status.ts), DEFAULTING to the questions ledger. The set of 'open questions' = items where canAnswer(schema,status) is true and the item is not yet answered; fetch the questions ledger (default) for its open items. Esc closes. Uncontrolled answer textarea (refs) for happy-dom."
- acceptance: "happy-dom tests: (1) the sidebar-bottom button opens the batch modal; (2) it shows the first open question with a larger-font class and the suggestions as a list; (3) prev/next buttons and ctrl+]/ctrl+[ move between open questions; (4) 'save & mark answered' writes the answer + answered status and advances; 'as recommended' writes AS_RECOMMENDED_ANSWER; (5) Esc closes. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T56"]
- ledgerRefs: ["goals:G2"]
- resultCommit: e677b77
- completion: "Web batch-answer modal: sidebar-bottom button opens a larger-font HelpOverlay-style modal stepping all open answerable questions (canAnswer + not-answered, from questions ledger); save&mark-answered + as-recommended over client.updateItem; prev/next buttons + ctrl/cmd+[ /] kbd nav; Esc closes. 5 happy-dom tests. Reviewer approve 0/0."

### T64 — done

- createdAt: 2026-06-02T08:48:33.730Z
- updatedAt: 2026-06-02T12:48:18.835Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: batch-answer full-screen overlay stepping open questions (keybinding, prev/next nav)"
- description: "Item #5 (TUI). Per Q33: add a dedicated full-screen Overlay variant (extend the Overlay union at app.tsx L170-179, e.g. { t: 'batchAnswer'; rows; idx }) entered by a keybinding (document it in the key hints), that steps through all UNANSWERED (open) answerable items one at a time using the existing answer prompt (TextPrompt) plus the 'as recommended' shortcut (AS_RECOMMENDED_ANSWER when the item hasRecommendation). After each save (mark answered), auto-advance to the next open item. Provide prev/next navigation within the overlay (e.g. left/right arrows or a documented key pair). Scope to ANY answerable ledger via canAnswer, defaulting to the questions ledger (fetch it for open items if not already on it). Esc exits the overlay. Reuse the existing answer overlay's write path (status→answered + answer field)."
- acceptance: "ink-testing-library tests: (1) the keybinding opens the batch overlay showing the first open question; (2) submitting an answer marks it answered and advances to the next open question; (3) the 'as recommended' shortcut writes AS_RECOMMENDED_ANSWER; (4) prev/next moves between open questions; (5) Esc exits. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T57"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 8bfd320
- completion: "TUI batch-answer full-screen Overlay ('b'): steps open answerable items (canAnswer + not-answered, default questions ledger); Enter saves+advances, Ctrl+R as-recommended (gated on hasRecommendation), Left/Right prev-next (clamped), Esc exits; write path at parity with single-item applyAnswer. 5 ink tests. Reviewer approve 0/0."

### T65 — done

- createdAt: 2026-06-02T08:48:43.847Z
- updatedAt: 2026-06-02T11:14:42.891Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "MCP server: expose project displayName (basename of --cwd) via serverInfo/instructions"
- description: |
    Item #7 (server side). Per Q35: the frontends are pure MCP clients and never read the cwd, so the project directory name must come from the server. GROUNDED against packages/ledger-mcp/src/main.ts (the planner's referenced `server.ts` does NOT exist — main.ts is the wiring):
    
    - The MCP server is constructed in `buildServer(store)` (main.ts L183-190) as `new McpServer(SERVER_INFO, { capabilities, instructions: SERVER_INSTRUCTIONS })`, where `SERVER_INFO = { name: 'ledger-mcp', version: '0.0.1' }` is a module constant (L49). `buildServer` today takes ONLY `store`, NOT cwd — so the cwd basename must be threaded through.
    - The resolved `--cwd` (absolute per CLAUDE.md) already flows to `createEmbeddedStore(cwd)` (L198-202). Compute `displayName = path.basename(cwd)`.
    
    THREADING (required): change `buildServer` to accept the display name (or the cwd) in addition to `store` — e.g. `buildServer(store, displayName)`. Update ALL call sites: the standalone stdio/HTTP binary path, `attachMcpHttp`/the co-hosted HTTP host, the embedded TUI in-memory-transport host, and the embedded web co-hosted `/mcp` host — every site that calls `buildServer` must pass the basename derived from the same resolved cwd used for the store.
    
    NAMED CARRIER (decide here, do NOT defer): the MCP `Implementation`/serverInfo type carries `{ name, version, title }`. Convey the project display name on `serverInfo.title` (set `SERVER_INFO`'s per-instance `title` to the basename, keeping `name`/`version` stable) — the spec-blessed human-readable carrier the SDK exposes via the client's `getServerVersion()` Implementation object. (If a runtime SDK version omits `title` on Implementation, fall back to embedding it on `instructions` as a stable leading line the client parses — but title is the primary carrier.) Keep it absolute-cwd safe and stable across reconnects (the per-session McpServer must report the same title every time).
- acceptance: A test (against the in-process/embedded server or the McpServer init result) asserts that when `buildServer` is given a cwd whose basename is e.g. 'cq1', the server's connect-time `serverInfo.title` (the named carrier — title primary, instructions fallback) equals 'cq1', and that `name`/`version` are unchanged. All `buildServer` call sites (standalone, HTTP, embedded TUI, embedded web) compile with the threaded cwd/displayName. `bun run check` green.
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]
- resultCommit: 8b553a8
- completion: "buildServer(store, displayName) threads basename(--cwd) to serverInfo.title (per-instance; name/version stable) + instructions fallback line; all call sites updated (standalone stdio/HTTP, attachMcpHttp/serveHttp, embedded TUI, embedded web). Test: getServerVersion().title==='cq1'. Reviewer approve 0/0. Merged 8b553a8; integration 522 pass."

### T66 — done

- createdAt: 2026-06-02T08:48:51.917Z
- updatedAt: 2026-06-02T11:32:40.171Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "LedgerClient: expose serverInfo()/displayName accessor (both impls + test fakes)"
- description: |
    Item #7 (client interface). Add a method to the LedgerClient interface (packages/ledger-web/src/types.ts L59-70; and the TUI's equivalent types) to read the server's project display name surfaced in T65 — e.g. `displayName(): string` (or `serverInfo(): { displayName: string }`), captured at connect.
    
    Real client (McpLedgerClient): read the display name from the SAME named carrier T65 writes — the MCP `Implementation.title` returned by the SDK client's `getServerVersion()` (the serverInfo captured at initialize). If T65 used the `instructions` fallback, read it via the client's `getInstructions()` and parse the agreed leading line; the carrier read here MUST match the carrier T65 wrote (title primary). Capture/cache it at connect time so the accessor is synchronous for the title-rendering tasks.
    
    Fakes: implement the same accessor in BOTH in-memory test fakes (web + TUI), returning a configurable display name (default e.g. 'cq1').
- acceptance: Typecheck passes with the new interface method implemented by McpLedgerClient and the in-memory fakes (web + TUI). A unit test drives the fake and reads back the configured displayName. A test asserts McpLedgerClient surfaces the basename from the REAL carrier T65 wrote (serverInfo.title via getServerVersion(), or instructions via getInstructions() if that fallback was used) — not merely the fake. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T65"]
- ledgerRefs: ["goals:G2"]
- resultCommit: d30a148
- completion: "displayName() added to LedgerClient interface (web+TUI) + all impls/fakes; McpLedgerClient reads T65's serverInfo.title (getServerVersion) primary + 'Project:' instructions fallback, cached at connect; fake+real-carrier tests. Reviewer approve 0/0. Merged d30a148 (auto-merged cleanly with T57's TUI test edits); integration 530 pass."

### T67 — done

- createdAt: 2026-06-02T08:48:59.249Z
- updatedAt: 2026-06-02T12:56:55.865Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: render '[<dir>] LLM ledgers' as document.title + header"
- description: "Item #7 (web render). Using the displayName from T66, set the browser document.title to '[<dir>] LLM ledgers' (e.g. '[cq1] LLM ledgers') once connected (replacing the hardcoded <title>ledger-web</title> in index.html — set it dynamically on connect), and replace the in-app header span text 'ledger-web' (App.tsx L758) with the same '[<dir>] LLM ledgers' string. Fall back gracefully (e.g. just 'LLM ledgers' or the prior text) if displayName is unavailable before connect."
- acceptance: "happy-dom test: after connecting with a fake whose displayName is 'cq1', document.title === '[cq1] LLM ledgers' and the header shows the same text. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T66"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 66dddd4
- completion: "Web: appTitle = '[<dir>] LLM ledgers' from client.displayName() (fallback 'LLM ledgers' pre-connect); useEffect sets document.title; header span renders it; index.html default updated. happy-dom test asserts both document.title + header. Reviewer approve 0/0."

### T68 — done

- createdAt: 2026-06-02T08:49:03.471Z
- updatedAt: 2026-06-02T12:56:58.657Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: render '[<dir>] LLM ledgers' as the header"
- description: "Item #7 (TUI render). Using the displayName from T66, replace the TUI header text 'ledger-tui' with '[<dir>] LLM ledgers' (e.g. '[cq1] LLM ledgers'). Fetch/read the displayName at connect time and store it in app state; fall back to a neutral label if unavailable. Keep the header layout (conn status, live indicator, hints) intact."
- acceptance: "ink-testing-library test: with a fake whose displayName is 'cq1', the rendered header frame contains '[cq1] LLM ledgers'. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T66"]
- ledgerRefs: ["goals:G2"]
- resultCommit: be4287b
- completion: "TUI: header renders '[<dir>] LLM ledgers' from client.displayName() (fallback 'ledger-tui'); header layout (conn status, LiveBadge, hints) intact. ink test asserts frame contains '[cq1] LLM ledgers'. Reviewer approve 0/0."

## M16

### T69 — done

- createdAt: 2026-06-02T10:13:43.585Z
- updatedAt: 2026-06-02T10:52:22.079Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "implement/advance.md: never auto-close the goal at milestone completion"
- description: |
    Edit llm/commands/implement/advance.md 'Milestone completion' section (currently lines ~192-204) and the 'Report to the user' section (lines ~206-213).
    
    Required behavior (per Q46/Q47):
    1. Keep auto-archiving completed work milestones (archive_milestone once all items terminal) and keep auto-marking individual tasks/defects terminal as work lands.
    2. ADD an explicit hard rule: the orchestrator MUST NEVER transition a GOAL to a terminal status (building->done) automatically. Only the user closes a goal.
    3. REPLACE the offending sentence (line ~203: 'The goal G ... can advance per the plan-flow once the milestone is archived') with: when ALL of a goal's work milestones are archived, the orchestrator REPORTS that goal G is ready to close and instructs the user to close it themselves in the TUI/web (set G's status to done) when satisfied. Make NO goal-status change.
    4. planned->building MAY remain automatic (it records that work started; non-terminal). If the orchestrator sets a goal planned->building at work-start, that stays allowed; only ->done is forbidden automatically. (Note: implement/advance.md does not currently set goal status at all, so this is a clarifying guardrail, not a new transition.)
    5. Add a 'goal ready to close' line to the end-of-pass Report bullets (Report section) covering the case where all work milestones are archived.
    
    Do NOT add a /plan:close command (none exists; out of scope). The close mechanism the report points at is the TUI/web. Surgical markdown edits only.
- acceptance: llm/commands/implement/advance.md no longer contains the 'can advance per the plan-flow once the milestone is archived' phrasing; it contains an explicit 'never auto-transition a goal to done' rule and a 'report goal G ready to close (close via TUI/web)' instruction; the Report section lists the ready-to-close case. `bun run check` passes (markdown-only edit is a no-op for it).
- suggestedModel: standard
- ledgerRefs: ["goals:G3"]
- resultCommit: d18cd8a
- completion: "implement/advance.md: removed 'can advance per the plan-flow' phrasing; added hard rule 'MUST NEVER auto-transition a goal to done' (user-only close via TUI/web); milestone auto-archive + auto-mark-terminal preserved; ready-to-close Report bullet added. Reviewer approve 0/0. Merged d18cd8a."

### T70 — done

- createdAt: 2026-06-02T10:13:54.840Z
- updatedAt: 2026-06-02T11:14:52.195Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Audit + scrub residual auto-close-goal language across plan/implement prompts
- description: |
    Grep the prompt suite for any text that implies an agent may auto-close (terminal-transition) a GOAL, and correct it to match the Q46/Q47 rule (only the user closes a goal; planned->building auto is fine, building->done auto is forbidden). Files to audit at minimum:
    - llm/commands/plan/advance.md: the 'Report to the user' section (lines ~76-90) describes phases incl. 'completed' for a planned goal; ensure no wording implies the orchestrator itself closes a goal. plan-advance subagent rule 7 returns 'completed' for planned/building/done WITHOUT closing — keep that, but if any orchestrator text implies closing on completion, fix it.
    - llm/agents/plan-advance.md: rule 7 (lines ~175-176) and the transitions list (lines ~67-70). The transitions list documents building->done as a legal transition — ADD a note that the plan-flow planner/orchestrator never PERFORMS building->done automatically; that edge is user-driven only. Do not remove the edge from the documented state machine (it remains legal for the user).
    - llm/commands/implement/start.md: confirm it states no goal-status auto-close (it currently doesn't touch goal status — add a one-line reaffirmation only if it clarifies, else leave).
    
    Add a single crisp shared rule statement (the 'never auto-close a goal; only the user closes it' invariant) where it most belongs (plan/advance.md or plan-advance.md). Keep edits surgical; do not duplicate the rule across every file — state it once authoritatively and reference it.
- acceptance: A grep for auto-close-implying phrasing (e.g. 'advance ... to done', 'close the goal', 'goal ... done automatically') across llm/commands/plan/*.md, llm/commands/implement/*.md, llm/agents/plan-*.md returns only intentional, corrected statements. The 'never auto-close a goal; only the user closes it' invariant appears stated once authoritatively. building->done remains documented as a legal (user-driven) transition. `bun run check` passes.
- suggestedModel: standard
- ledgerRefs: ["goals:G3"]
- resultCommit: bbd01ef
- completion: Authoritative 'never auto-close a goal' invariant stated once in plan-advance.md (building→done user-driven only; edge stays legal in the documented state machine); rule-7 + plan/advance.md 'completed' wording de-imply auto-close; cross-refs T69's implement/advance.md; implement/start.md untouched. Reviewer approve 0/0. Merged bbd01ef.

### T71 — done

- createdAt: 2026-06-02T10:14:03.471Z
- updatedAt: 2026-06-02T12:18:14.584Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Verify Change B: gate + no residual auto-close language"
- description: |
    Final verification for milestone M16 (Change B). After T69 and T70 land:
    1. Run `bun run check` from the repo root; it must pass (markdown-only edits should be a no-op for typecheck/lint/test, but confirm nothing regressed).
    2. Grep the touched files for residual auto-close-implying phrasing and confirm only the corrected, intentional statements remain: `rg -n 'can advance per the plan-flow|advance.*to.*done|close the goal|goal.*done automatically' llm/commands/plan llm/commands/implement llm/agents/plan-advance.md`.
    3. Confirm the authoritative 'never auto-close a goal; only the user closes it' invariant is present and the 'report goal ready to close (TUI/web)' instruction exists in implement/advance.md.
    Report the grep output and check result.
- acceptance: "`bun run check` exits 0. The grep shows no un-corrected auto-close phrasing (only the intentional invariant statement + the user-driven building->done documentation). The ready-to-close report instruction is present in implement/advance.md."
- suggestedModel: fast
- dependsOn: ["T69","T70"]
- ledgerRefs: ["goals:G3"]
- completion: "M16 (never-auto-close) verify gate: bun run check green; grep confirms only intentional auto-close refs remain (plan-advance.md invariant L75-83 + implement/advance.md user-driven close instruction); ready-to-close instruction present. Verification-only — no source merge (worker's spurious docs/tasks.md commit not merged). M16 COMPLETE."

## M17

### T72 — done

- createdAt: 2026-06-02T10:14:29.203Z
- updatedAt: 2026-06-02T10:44:40.852Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Supersede K8 point 3 only: new locked decision for auto-investigate from plan:* (K8 pts 1,2,4,5 stay in force)"
- description: |
    Create a NEW locked `decisions` item (per Q45: supersede, do NOT amend K8 in place; K8 stays immutable history). Place it under the M15 coordination milestone (where G3's goal/questions/reviews/decision live). Use the ledger tools (this is a ledger write, not a markdown edit).
    
    The decision must record:
    1. CITATION + SCOPE OF SUPERSESSION: cites K8 point 3 (file-and-defer handoff, status: locked, milestone M1) and states it REFINES/REVERSES ONLY the symmetric DIRECTION of point 3. State EXPLICITLY: 'K8 points 1, 2, 4, and 5 remain in force unchanged; this decision refines ONLY point 3's handoff-direction asymmetry.' K8 point 3 forbade /investigate:advance running the PLAN loop inline (that prohibition STILL STANDS — investigate still hands back via file-and-defer; it is NOT reversed). The NEW direction is the OTHER (symmetric) way: a /plan:* COMMAND, after completing its own primary planning work, MAY run /investigate:advance inline in the same main session (legal because a COMMAND does the chaining; only a SUBAGENT cannot — subagents-cannot-spawn-subagents is preserved). In particular, K8 POINT 4 (defect-seeded clarify-skip) must remain in force because T74/T75's auto-resume path ('skips clarification per K8 pt4') depends on it.
    2. RULE (Q42): all defects (user-reported AND auto-found by the plan-reviewer) are FILED; the plan:* orchestrator then auto-launches /investigate:advance itself after its primary work, always when possible — replacing the prior 'file an open question telling the user to run /investigate:start' manual step.
    3. TRIGGER SITES (Q43): the trigger lives in the plan:* COMMAND orchestrators (plan/advance.md, plan/start.md, plan/follow-up.md). The plan-advance/plan-reviewer SUBAGENTS only file/flag defects — they never spawn subagents and cannot run /investigate:advance.
    4. STOP BOUNDARY (Q44): NO hard iteration caps. The orchestrator uses MODEL-JUDGED ill-loop detection with CONCRETE termination predicates for the cross-command auto-investigate<->replan chain (enumerated in T74) — when the chain loops meaninglessly (no progress, repeating without convergence, same failure recurring), it STOPS and surfaces a `questions` item to the user rather than spinning. This removes the prior plan/advance.md 4-iteration cap and the implement/advance.md 8-round safety ceiling.
    
    Use create_item('decisions', M15, status: 'locked', fields: { headline, rationale, alternatives?, ledgerRefs: ['goals:G3','decisions:K8'] }). Provenance: author=opus-4.8[1m] (or executing model's class), session=$CLAUDE_CODE_SESSION_ID. Capture the new decision id; later tasks reference it.
- acceptance: "A new `decisions` item exists under M15 with status `locked`, ledgerRefs including both goals:G3 and decisions:K8, whose rationale records: (1) cites K8 pt3 + an EXPLICIT one-line statement that 'K8 points 1,2,4,5 remain in force; only point 3's handoff-direction asymmetry is refined' AND that K8 pt3's prohibition on investigate running the plan loop inline still stands (the new direction is the symmetric plan-runs-investigate, legal because a command chains); (2) file-all-defects + orchestrator auto-launch; (3) command-only trigger sites; (4) model-judged-no-hard-cap stop. K8 itself is unchanged (still locked, original fields)."
- suggestedModel: frontier
- ledgerRefs: ["goals:G3"]
- completion: "Orchestrator-handled (ledger write; workers can't mutate the ledger). Created locked decision K12 under M15, supersedes:[K8], ledgerRefs goals:G3+decisions:K8 — pins K8 pts 1/2/4/5 in force, refines only pt3's handoff DIRECTION (plan:* commands may auto-launch /investigate:advance inline; investigate-runs-plan still forbidden), file-all-defects + command-only triggers, no hard caps (model-judged stop predicates per T74). T73-T78 cite K12."

### T73 — done

- createdAt: 2026-06-02T10:14:45.473Z
- updatedAt: 2026-06-02T10:52:25.344Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan-advance subagent: file defects (drop manual /investigate:start routing); orchestrator re-derives worklist by ledger query, not summary-parsing"
- description: |
    Edit llm/agents/plan-advance.md so the subagent's defect handling FILES the defect (as today) but DROPS the manual 'run /investigate:start' user-question routing. The subagent still cannot run /investigate:advance (no Bash, never spawns subagents) — it only files; the orchestrator (T74) re-derives the auto-investigate worklist by QUERYING THE LEDGER, not by parsing the subagent's prose summary.
    
    DATA-PASSING (criticism #3 fix — ROBUST, not parse-dependent): the subagent's machine-readable output is fixed to a SINGLE status token on its last line (plan-advance.md L257-263); the Session summary is free prose. So the AUTHORITATIVE source of the auto-investigate worklist is a LEDGER QUERY by the orchestrator (T74): `open` defects newly linked goals:<G> with no terminal status. The subagent therefore does NOT need to emit a machine-readable defect-id flag for correctness; if it mentions filed defect ids in its human-readable Session summary at all, that is at most an ADVISORY hint, NEVER the contract the orchestrator depends on. Do not introduce any requirement that the orchestrator parse the summary text.
    
    Specific edits:
    1. 'Consuming the reviewer's defects[] bucket' section (lines ~213-242): step 2 currently files an `open` question saying 'run /investigate:start <D>'. CHANGE it so the subagent: (a) still files the `open` defect linked goals:G3-style (this is what makes it discoverable by the orchestrator's ledger query); (b) DOES NOT file a 'run /investigate:start' user-question for them. Keep the file-and-defer note that these defects do not block/revise THIS plan. Optionally note the filed ids in the prose summary as an advisory aid only.
    2. 'Defect-aware planning' section (lines ~180-211): when the GOAL itself is defect-seeded or describes a fault, the defect record + fix tasks stay as-is; ensure the wording reflects that user-reported faults are also auto-investigated by the orchestrator when applicable (per Q42 + orchestrator auto-launches). Do not change the fix-task/bidirectional-link mechanics.
    3. Reference the new superseding decision (from T72) in place of, or alongside, the K8/Q26 citations where the file-and-defer-to-user behavior is described, so the subagent prompt is consistent with the new direction.
    
    Keep the subagent's contract intact: it performs EXACTLY ONE state-driven step, makes no Bash calls, returns one status token. The orchestrator does the investigate launch and re-derives the worklist from the ledger.
- acceptance: "llm/agents/plan-advance.md no longer instructs the subagent to file a 'run /investigate:start <D>' user-question for reviewer-bucket defects; instead it files the `open` defect (linked goals:<G>) so the orchestrator's ledger query can discover it. The prompt does NOT mandate any orchestrator parse of the prose Session summary (any filed-id mention is advisory only; the authoritative worklist is the orchestrator's ledger query in T74). The new superseding decision is cited. The one-step/no-Bash/single-token contract is unchanged. `bun run check` passes."
- suggestedModel: frontier
- dependsOn: ["T72"]
- ledgerRefs: ["goals:G3"]
- resultCommit: 7256dc6
- completion: "plan-advance.md reviewer-defect path now file-only (open defect linked goals:<G>, discoverable by orchestrator ledger query); dropped 'run /investigate:start' user-question; prose summary demoted to advisory; cites K12; subagent one-step/no-Bash/single-token contract intact. Reviewer approve 0/0. Merged 7256dc6."

### T74 — done

- createdAt: 2026-06-02T10:15:09.269Z
- updatedAt: 2026-06-02T11:01:47.327Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan/advance.md orchestrator: auto-launch /investigate:advance after planning + CONCRETE cross-chain stop predicates (drop 4-iteration cap)"
- description: |
    Edit llm/commands/plan/advance.md (the main-session orchestrator). This is the core of Change A.
    
    1. ADD an 'allowed-tools' update if needed: the orchestrator must be able to run the /investigate:advance loop inline. /investigate:advance dispatches investigate-explorer subagents via Agent and uses mcp__ledger__*, Bash, Read/Grep/Glob — the plan/advance.md frontmatter currently lists only fetch/list ledger reads + Agent + Write + Bash. Broaden allowed-tools so the orchestrator can run the investigate pass inline (mirror investigate/advance.md's allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob).
    
    2. ADD an 'Auto-investigate filed defects' phase AFTER the per-goal planner<->reviewer round completes (after the loop, before/within the final report). WORKLIST DERIVATION (criticism #3 — robust, ledger-query authoritative): the orchestrator derives the worklist by QUERYING THE LEDGER — `open` defects newly linked goals:<G> with no terminal status — NOT by parsing the plan-advance subagent's prose Session summary (any summary mention is advisory only; do not depend on it; the subagent's machine output is a single status token per plan-advance.md L257-263). For EACH such defect D, the orchestrator runs the /investigate:advance pass inline (per llm/commands/investigate/advance.md — do not duplicate that logic, run it) in the SAME main session. On a confirmed root cause, investigate seeds/extends a defect-seeded goal; the orchestrator MAY then auto-resume planning on that defect-seeded goal in the same session (it skips clarification per K8 pt4). Per Q42: 'always when possible'.
    
    3. AWAITING-ANSWERS INTERACTION (criticism #2 — explicit): specify what happens when the primary planner<->reviewer round ends on `awaiting-answers` (rule 4: reviewer new_questions sent the goal BACK to `clarifying`) WHILE the same review's defects[] bucket was ALSO filed (a go-ahead OR revise review may carry defects[], per plan-reviewer.md L92-95). RULE: the filed defects are ORTHOGONAL to the goal's clarification (per plan-advance.md L237-242), so the orchestrator STILL auto-investigates the filed (non-blocked) defects even though the GOAL is parked on user questions — auto-investigate operates on the defect records, not on the user-blocked goal; it just must NOT auto-resume PLANNING on a goal that is parked in `clarifying` (planning resumes only after the user answers). State this explicitly so the executor does not have to guess. (If a clearer alternative — defer all auto-investigate while the round is user-blocked — is chosen instead during implementation, it must be stated just as explicitly; the orthogonal-still-runs reading is the recommended default.)
    
    4. STOP BOUNDARY (Q44, criticism #1 — CONCRETE termination predicates): REMOVE the hard 4-iteration cap (lines ~27, ~33, ~56 'Repeat at most 4 iterations'/'4-iteration cap'/'If you hit the 4-iteration cap'). Replace with MODEL-JUDGED ill-loop detection that has CONCRETE, OPERATIONALLY-PINNED stop predicates for the NEW cross-command auto-investigate<->replan axis (NOT merely the generic single-worktree signals from implement/advance.md L119-130, which are about one worktree's criticism rounds and do NOT translate to the cross-command chain). Enumerate at minimum these stop predicates for the auto-investigate<->replan chain; when ANY holds the orchestrator STOPS auto-relaunching and files an `open` `questions` item to the user:
       (a) each filed defect D is auto-investigated AT MOST ONCE per plan:advance round (no re-launch on the same defect within the same round);
       (b) no re-launch of investigate on a defect D if D's hypothesis tree gained NO new confirmed/[correct] evidence since the previous round (no-new-evidence => stop, do not relaunch);
       (c) when a confirmed root cause has SEEDED or EXTENDED its goal, STOP and report — do NOT auto-relaunch investigate on that defect (planning resumes on the seeded goal instead; that is the convergence, not a new investigate round);
       (d) a defect D that cycles open->investigated->replanned->open WITHOUT convergence (e.g. re-confirmed across rounds with no NEW fix tasks emitted, or the goal re-planned with an identical task set) => STOP and park to the user;
       (e) investigate returns no adjudicable evidence on two consecutive rounds for the same defect => STOP and park;
       (f) a per-pass budget on auto-launched investigate rounds is governed by (a)-(e) (no fixed numeric cap, but each defect is bounded by once-per-round + no-progress stop, so the pass provably converges).
       State the no-hard-cap rule explicitly, that these are the concrete stop predicates that replace the numeric cap, and cite the new superseding decision (T72).
    
    5. Ensure subagents-cannot-spawn-subagents is respected: only the orchestrator (a command) runs /investigate:advance; the plan-advance/plan-reviewer subagents only file (T73).
    
    6. Update the 'Report to the user' section to cover auto-investigate outcomes (defect investigated -> confirmed/seeded goal G' / parked-on-question / no-new-evidence-stopped / ill-loop-stopped) and the next action.
    
    Surgical markdown edits; keep the existing planner<->reviewer loop structure, just remove the numeric cap and add the auto-investigate phase + concrete cross-chain stop predicates.
- acceptance: "llm/commands/plan/advance.md: (a) frontmatter allowed-tools permits running the investigate pass inline (Agent + Read/Grep/Glob + Bash + mcp__ledger__*); (b) contains an 'auto-investigate filed defects' phase whose worklist is derived by LEDGER QUERY (`open` defects newly linked goals:<G>, no terminal status) — NOT by parsing the subagent's prose summary — that runs /investigate:advance inline after the planning round and may auto-resume planning on a defect-seeded goal; (c) explicitly specifies the awaiting-answers + defects-filed interaction (filed defects are orthogonal and still auto-investigated, but planning does NOT auto-resume on a goal parked in `clarifying`); (d) the '4 iterations'/'4-iteration cap' hard limit is GONE, replaced by ENUMERATED concrete cross-chain stop predicates (at minimum: once-per-defect-per-round; no-relaunch-without-new-confirmed-evidence; stop+report once a confirmed root cause seeded/extended its goal; stop+park on a non-converging open->investigated->replanned->open cycle; stop+park on two consecutive no-adjudicable-evidence rounds) that file an `open` user question when the loop is ill — generic single-worktree signals alone do NOT satisfy this; (e) cites the T72 superseding decision; (f) Report covers auto-investigate outcomes including the stop reasons. `bun run check` passes."
- suggestedModel: frontier
- dependsOn: ["T72","T73"]
- ledgerRefs: ["goals:G3"]
- resultCommit: 22169f2
- completion: "plan/advance.md: broadened allowed-tools for inline investigate; added auto-investigate phase (ledger-query worklist, runs /investigate:advance inline + auto-resume on defect-seeded goal); explicit awaiting-answers+defects orthogonality; removed 4-iteration cap, replaced with enumerated convergent stop predicates (a)-(f); cites K12; Report covers outcomes. Reviewer approve 0/0. Merged 22169f2; integration 516 pass."

### T75 — done

- createdAt: 2026-06-02T10:15:21.142Z
- updatedAt: 2026-06-02T11:32:43.496Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan/start.md + plan/follow-up.md: auto-launch /investigate:advance after bootstrap+handoff"
- description: |
    Edit llm/commands/plan/start.md and llm/commands/plan/follow-up.md so both COMMANDS also auto-investigate filed defects after their primary work (Q43: 'plan:advance, plan:follow-up and plan:start could trigger investigations').
    
    For each file:
    1. After the existing bootstrap + single plan-advance handoff (start.md step 3; follow-up.md step 5) and BEFORE the final Report: add an 'auto-investigate filed defects' step that mirrors plan/advance.md's new phase (T-A3) — if the plan-advance subagent flagged filed defects, the COMMAND runs /investigate:advance inline (per llm/commands/investigate/advance.md; do not duplicate, run it). DO NOT restate the investigate logic; reference plan/advance.md's auto-investigate phase / the investigate command, exactly as start.md already references advance.md's loop spec by pointer.
    2. Confirm allowed-tools already permit it: both use `mcp__ledger__*, Agent, Write, Bash`; ADD Read, Grep, Glob if running /investigate:advance inline requires them (match investigate/advance.md's allowed-tools).
    3. Special case for start.md/follow-up.md: a freshly bootstrapped goal usually goes to `clarifying` with open questions (awaiting-answers) — there are typically no filed defects yet on the first round. Make the auto-investigate step CONDITIONAL on defects actually having been filed/flagged, so it is a no-op when none exist. The defect-seeded-goal path (investigate->plan) is the main case where these commands chain.
    4. Update each Report to mention auto-investigate outcomes when triggered.
    5. Cite the new superseding decision (T72) where the auto-investigate behavior is introduced.
    
    Keep these commands 'bootstrap only + handoff' in spirit — they still own NO planner/question logic; the auto-investigate is the same orchestrator-level chaining plan/advance.md gained.
- acceptance: "Both llm/commands/plan/start.md and llm/commands/plan/follow-up.md contain a conditional 'auto-investigate filed defects' step (a no-op when none filed) that runs /investigate:advance inline by pointer to the investigate command / plan-advance.md phase, with allowed-tools sufficient to run it, the T72 decision cited, and Reports updated. `bun run check` passes."
- suggestedModel: standard
- dependsOn: ["T72","T74"]
- ledgerRefs: ["goals:G3"]
- resultCommit: fd302c5
- completion: "plan/start.md + plan/follow-up.md gain a conditional auto-investigate step (ledger-query worklist, no-op when empty) running /investigate:advance inline by pointer (stop predicates inherited from plan/advance.md); allowed-tools +Read/Grep/Glob; K12 cited; Reports updated. Reviewer approve 0/0. Merged fd302c5."

### T76 — done

- createdAt: 2026-06-02T10:15:34.082Z
- updatedAt: 2026-06-02T11:32:46.287Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "implement/advance.md: remove the 8-round hard safety ceiling; keep model-judged ill-loop signals"
- description: |
    Per Q44 ('We MUST remove any hard-caps and do the same - detect ill loops with model, not hard caps'), edit llm/commands/implement/advance.md section 4 'Autonomous criticism loop (NO fixed cap)' (lines ~113-131).
    
    1. REMOVE the 4th ill-loop bullet: 'a hard safety ceiling of 8 rounds is hit (defense-in-depth only ...)' (line ~128). Hard caps are forbidden.
    2. KEEP the first three MODEL-JUDGED ill-loop signals (no file changes; criticism repeats without shrinking; same bun run check failure recurs) — these are exactly the model-judged detection Q44 wants, and they already mirror the pattern the plan/advance.md edit (T-A3) adopts.
    3. Ensure the surrounding prose still reads as 'no fixed cap; iterate while converging; stop via model judgement when ill' with NO numeric round limit anywhere in the section.
    4. Cite the new superseding decision (T72) for the no-hard-cap principle if a citation fits naturally; otherwise leave the existing references.
    
    Surgical edit — only the hard-ceiling bullet is removed; the model-judged signals and bailout-to-questions (section 5) stay.
- acceptance: llm/commands/implement/advance.md section 4 no longer mentions an '8 rounds' hard ceiling (or any numeric round cap); the three model-judged ill-loop signals remain; the bailout to a questions item (section 5) is unchanged. `bun run check` passes.
- suggestedModel: standard
- dependsOn: ["T72"]
- ledgerRefs: ["goals:G3"]
- resultCommit: 26fe8e1
- completion: "implement/advance.md §4: removed the 8-round hard ceiling bullet; three model-judged ill-loop signals + §5 questions bailout intact; no numeric cap survives. Reviewer approve 0/0. Merged 26fe8e1."

### T77 — done

- createdAt: 2026-06-02T10:15:50.974Z
- updatedAt: 2026-06-02T11:51:45.778Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Reconcile cross-flow defect-routing wording with auto-investigate (investigate handback, plan-reviewer, implement defect-routing)
- description: |
    Make the defect-routing wording across the suite consistent with the new auto-investigate direction (T72), so no prompt still tells the user to manually run /investigate:start when an orchestrator now auto-launches it. Surgical wording edits only.
    
    1. llm/commands/investigate/advance.md step 5(c) (lines ~144-150) + the K8 'Conventions' block (lines ~18-35) + Report (lines ~164-174): the handback currently files an `open` question telling the user to run `/plan:advance <G>` and STOPS. Per Q42 the symmetric automation is plan:* launching investigate; investigate->plan handback MAY stay file-and-defer (K8 pt3 prohibition on investigate running the plan loop STANDS). BUT: since /plan:advance now auto-investigates, clarify that when investigate is itself running INSIDE a /plan:* session (auto-launched), the seeded goal is auto-resumed by that same plan session rather than requiring a fresh user-run /plan:advance. Add a short note distinguishing standalone /investigate:start (hands back to user-run /plan:advance, unchanged) from auto-launched-inside-plan (the plan orchestrator resumes). Cite T72.
    2. llm/agents/plan-reviewer.md 'defects' bucket description (lines ~62-79): it says the orchestrator files each defect 'then routes it to /investigate:start ... for later triage'. Update to: the orchestrator files each defect and AUTO-LAUNCHES the investigate pass (per T72), rather than routing the user to a manual /investigate:start. Keep the reviewer's contract (it only REPORTS defects in the review; it writes nothing to the defects ledger).
    3. llm/commands/implement/advance.md step 3 (lines ~96-111): the implement-reviewer defects[] bucket is filed + routed to '/investigate:start <D>' via an open question. DECIDE per Q42 ('If defect was found automatically, it should be filed. The orchestrator should launch investigate:* itself once it finishes its primary work'): the IMPLEMENT orchestrator's primary work is execution, not planning — confirm whether it should also auto-launch investigate. Given Q43 names only plan:* commands as triggers, KEEP implement's file-and-defer-to-user routing AS-IS, but update the wording to note these defects are picked up by the next /plan:* auto-investigate (or a user /investigate:start) — do NOT make implement:* run investigate inline (that is plan:*'s job per Q43). State this scoping decision explicitly in the edit.
    
    This task only reconciles WORDING/cross-references; the orchestrator mechanics live in T74/T75/T76.
- acceptance: "investigate/advance.md distinguishes standalone-handback (user-run /plan:advance, unchanged) from auto-launched-inside-plan (plan session auto-resumes), citing T72; plan-reviewer.md says the orchestrator auto-launches investigate rather than routing to manual /investigate:start; implement/advance.md step 3 explicitly states implement:* does NOT run investigate inline (per Q43) and its filed defects are picked up by the next plan:* auto-investigate or a user /investigate:start. `bun run check` passes."
- suggestedModel: standard
- dependsOn: ["T72","T73","T74"]
- ledgerRefs: ["goals:G3"]
- resultCommit: f697144
- completion: "Cross-flow wording reconciled to K12: investigate/advance.md distinguishes standalone vs auto-launched-inside-plan handback (K8 pt3 prohibition intact); plan-reviewer.md defects bucket says orchestrator auto-launches investigate (write-nothing contract kept); implement/advance.md step 3 scopes implement:* as NOT auto-launching investigate (Q43). Reviewer approve 0/0. Merged f697144."

### T78 — done

- createdAt: 2026-06-02T10:16:04.064Z
- updatedAt: 2026-06-02T12:18:18.350Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Verify Change A: gate + no residual manual-investigate routing + caps GONE + concrete stop predicates ADDED"
- description: |
    Final verification for milestone M17 (Change A). After T72-T77 land:
    1. Run `bun run check` from the repo root; must pass.
    2. Confirm the superseding decision exists and is locked: fetch it from the decisions ledger under M15, verify ledgerRefs include goals:G3 and decisions:K8, that its rationale explicitly pins 'K8 points 1,2,4,5 remain in force; only point 3's direction refined', and that K8 is unchanged.
    3. Grep for residual HARD CAPS that should be gone: `rg -n '4-iteration|4 iterations|8 rounds|safety ceiling' llm/commands/plan/advance.md llm/commands/implement/advance.md` — expect no surviving numeric loop cap (model-judged ill-loop wording only).
    4. POSITIVE STOP-PREDICATE CHECK (criticism #5 — caps-removed must not ship without convergence-guaranteed): assert plan/advance.md now CONTAINS enumerated concrete auto-investigate<->replan stop predicates, not merely the ABSENCE of a numeric cap. Grep/enumerate for the presence of the cross-chain termination criteria, e.g. `rg -n -i 'once per (round|defect)|no new (confirmed|adjudicable)? ?evidence|stop and (report|park)|no-progress|identical task set|two consecutive' llm/commands/plan/advance.md` — expect the auto-investigate stop predicates from T74 to be present and enumerable. The verification FAILS if the caps are gone but no concrete stop predicate text was added.
    5. Grep for residual manual-investigate routing where auto-launch should now apply: `rg -n 'run .?/investigate:start' llm/commands/plan llm/agents/plan-advance.md llm/agents/plan-reviewer.md` — the plan-flow reviewer-bucket path should no longer tell the user to run /investigate:start (implement/advance.md MAY still reference it per the T77 scoping decision; the standalone /investigate:start intake guidance in plan/start.md/follow-up.md for USER-reported faults is intentional and stays).
    6. Confirm plan/advance.md, plan/start.md, plan/follow-up.md each contain an auto-investigate phase/step and allowed-tools sufficient to run /investigate:advance inline.
    Report grep outputs + check result; flag any inconsistency for a follow-up revision.
- acceptance: "`bun run check` exits 0. The superseding locked decision exists (refs goals:G3 + decisions:K8) and explicitly pins K8 pts 1,2,4,5 in force; K8 unchanged. No '4-iteration'/'8 rounds'/'safety ceiling' numeric cap survives in plan/advance.md or implement/advance.md. POSITIVELY, plan/advance.md contains enumerated concrete auto-investigate<->replan stop predicates (grep-able / enumerable — once-per-round, no-relaunch-without-new-evidence, stop-and-report-on-seeded-goal, non-convergence park, two-consecutive-no-evidence park); 'caps removed' cannot pass without 'convergence guaranteed'. The plan-flow reviewer-bucket path no longer routes the user to manual /investigate:start (auto-launch instead); intentional user-fault-intake references remain. All three plan:* commands have an auto-investigate step with adequate allowed-tools."
- suggestedModel: fast
- dependsOn: ["T72","T73","T74","T75","T76","T77"]
- ledgerRefs: ["goals:G3"]
- completion: "M17 (auto-investigate) verify gate: bun run check green; K12 exists+locked (supersedes K8 pt3, pins pts1,2,4,5; K8 unchanged); no 4-iteration/8-round/safety-ceiling cap survives; concrete stop predicates present in plan/advance.md; reviewer-bucket no longer routes to manual /investigate:start; all 3 plan:* commands have the auto-investigate phase. Verification-only — empty audit commit, not merged. M17 COMPLETE."

## M18

### T79 — planned

- createdAt: 2026-06-02T10:35:48.260Z
- updatedAt: 2026-06-02T10:35:48.260Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "Web #9: unify archived milestone-groups into the active subsection renderer + 'archived' badge"
- description: |
    Item #9 (WEB-ONLY per Q38/Q39). Today active non-milestones items render as per-milestone collapsible <section> subsections via ItemTable (packages/ledger-web/src/App.tsx L1283-1353: header button with id+title+[status], then the id/status/summary table), while ARCHIVED milestones render via a SEPARATE component ArchiveSection (App.tsx L1404-1484) as a flat row of lw-archive-pointer <button>s where clicking ONE pointer fetches and shows only that group's items below — exactly the reported 'they look like buttons / only one is visible'.
    
    FIX (per Q38 chosen recommendation): render each archived milestone-group through the SAME subsection renderer as active groups — each archived group becomes its own collapsible <section> with the same id/title + id/status/summary table — listed AFTER the active sections, ALL present at once (not click-to-reveal). The ONLY visual difference is an 'archived' badge in each section head (reuse the existing .lw-archived-badge class, styles.css L644). Archived sections DEFAULT COLLAPSED and LAZY-FETCH their items (fetch_ledger_archive per pointer) on first expand (parity with the current per-pointer fetch; avoids fetching every archive up front). Remove/retire the lw-archive-pointer button path. Keep the active-section rendering unchanged.
    
    NOTE: this is the same subsection renderer touched by #10 (milestone-status badge) and #12 (goals flat-list); coordinate so the unified renderer still honors the goals-specific flat-list override (T-goals-flat) and the milestone-status badge (T-ms-badge-web).
- acceptance: "happy-dom test: with >=2 archived milestone-groups, ALL of them render as collapsible <section> elements (same structure/class as active subsections), each carrying an 'archived' badge in the head; none renders as an lw-archive-pointer button. An archived section is collapsed by default and fetches its items (via the archive fetch) only on first expand. Active sections are unaffected. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]

### T80 — planned

- createdAt: 2026-06-02T10:35:55.985Z
- updatedAt: 2026-06-02T10:35:55.985Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "Web #10: render milestone-section status as a badge from the shared M12 palette"
- description: |
    Item #10 (web half; DEPENDS ON M12 T50/T52 — the 'warning' bucket + canonical bucket->color palette/CSS vars). Today the milestone status in a web subsection header is plain text inside the label: ItemTable builds headerLabel = '<id>: <title> [<status>]' rendered in a single <span class=lw-ms-label> (packages/ledger-web/src/App.tsx L1293-1295).
    
    FIX: render the milestone status using the SAME status badge as item rows (<span class='lw-status lw-status-<bucket>'>, App.tsx L1337) driven by the shared M12 source. Compute the bucket via statusBucket(milestone.status, MILESTONES_SCHEMA) — the milestones schema must be threaded into the header so terminal classification (open/done/postponed/blocked) is correct. Remove the inline '[<status>]' text from the label and render the badge element instead. Applies to both the active subsection heads and (after #9) the archived subsection heads.
- acceptance: "happy-dom test: a milestone subsection head renders the status as a <span class='lw-status lw-status-<bucket>'> (NOT bare '[status]' text), with the bucket derived via statusBucket against the milestones schema (e.g. an 'open' milestone -> the start/progress bucket class, a 'done' milestone -> the done bucket class). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T52"]
- ledgerRefs: ["goals:G2"]

### T81 — planned

- createdAt: 2026-06-02T10:36:07.803Z
- updatedAt: 2026-06-02T10:36:07.803Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "TUI #10: color milestone-section header status via statusColor (shared bucket source)"
- description: |
    Item #10 (TUI half; DEPENDS ON M12 T50/T51 — the 'warning' bucket + TUI BUCKET_COLOR). Today buildItemEntries builds the milestone subsection header label '<id> <title> [<status>]' as a plain STRING rendered as a non-selectable header line (packages/ledger-tui/src/app.tsx L137-145, L141). Ink has no bordered-badge primitive, so the parity for #10 is a color-coded status token.
    
    FIX (per Q40 recommendation): change the header ListEntry so it carries a RENDERED element (not just a plain string) for milestone subsection heads — render the id/title text plus the status token colored via statusColor(milestone.status, MILESTONES_SCHEMA) from the shared TUI bucket source. Thread the milestones schema into the header build so terminal classification (open/done/postponed/blocked) is correct. Keep non-milestone-header entries unchanged. COORDINATE with #13 (T-tui-navperf): the header build feeds buildItemEntries which #13 memoizes — the memo keys must remain valid after this change.
- acceptance: "ink-testing-library test: a milestone subsection header renders the status token in the statusColor for its bucket (e.g. assert the Text color prop / frame for an 'open' vs 'done' milestone differs and matches statusColor against the milestones schema), rather than uncolored '[status]' text. Non-milestone rows unchanged. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T51"]
- ledgerRefs: ["goals:G2"]

### T82 — planned

- createdAt: 2026-06-02T10:36:15.468Z
- updatedAt: 2026-06-02T10:36:15.468Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "Web #11: CSS column proportions — id/status hug content, summary takes remainder (all web tables)"
- description: |
    Item #11 (WEB-ONLY per Q41; TUI already content-sizes via padEnd and is untouched). The web .lw-table is width:100% with border-collapse:collapse and NO table-layout/colgroup, so the browser's automatic table layout distributes width by content and over-allocates id/status (the reported ~1/5 id, ~2/5 status, ~2/5 summary). .lw-summary-cell already uses max-width:0 + ellipsis (styles.css L306-311).
    
    FIX (CSS-level): size id/status columns to their content via a <colgroup> with width:1% + white-space:nowrap, and let the summary column take the remaining width. Apply to ALL web table variants that share .lw-table: the active per-milestone subsection tables, the flat milestones-ledger table, and the archive table (after #9 unifies it). Define the sizing as a REUSABLE rule — 'narrow scalar columns hug content, the long/summary column flexes' — so the column-selector work (M14 T60-T62) can inherit the same rule for arbitrary dynamic columns. Standalone CSS change on TODAY's fixed id/status/summary tables; does NOT depend on T60-T62 (per Q41 chosen recommendation), but note the relationship.
- acceptance: "happy-dom test (or computed-style assertion) on each web table variant: the id and status columns are sized to content (colgroup width:1% + white-space:nowrap applied) and the summary column receives the remaining width; the over-allocation is gone. The sizing rule is expressed once and reused across the three table variants. `bun run check` green."
- suggestedModel: standard
- ledgerRefs: ["goals:G2"]

### T83 — planned

- createdAt: 2026-06-02T10:36:28.534Z
- updatedAt: 2026-06-02T10:36:28.534Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "Web #12: GOALS ledger as a flat list (no coordination subsections) showing fields.milestones"
- description: |
    Item #12 (web half; USER-DEVIATED answer Q48 — follow the user's literal instruction, NOT the planner's recommendation). User answer: 'Do not show milestones in Goals ledger items view - it should be a FLAT LIST without subsections - as milestones list.'
    
    Today non-milestones ledgers (incl. goals) render as per-milestone collapsible subsections keyed on the coordination group id g.id (packages/ledger-web/src/App.tsx L1284-1297), and DetailPanel appends a trailing single 'milestone: <coordinationId>' row (App.tsx L1839-1840). goals.fields.milestones (the work-milestone id[], e.g. G2->[M12,M13,M14,M18,M19]) is never displayed.
    
    FIX (GOALS ledger ONLY, isGoals(schema)): (a) render the goals LIST as a FLAT table — do NOT group goals into coordination-milestone subsections (suppress the per-milestone <section> grouping for goals); (b) in the goals DETAIL panel, REPLACE the single coordination-milestone row with a `milestones` list rendered from fields.milestones (the work-milestone ids), and suppress any single 'milestone' column for goals. Leave all OTHER ledgers' subsection grouping and detail rendering unchanged. Coordinate with #9/#10 (subsection renderer) and the column work (T60/T61) so the goals override composes cleanly.
- acceptance: "happy-dom test on the GOALS ledger: the list renders as a single flat table with NO per-coordination-milestone <section> subsections; the detail panel for a goal shows a `milestones` list containing the work-milestone ids from fields.milestones (e.g. M12, M13, M14) and does NOT show a single coordination 'milestone' row/column. Non-goal ledgers still render their per-milestone subsections and single milestone row unchanged. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]

### T84 — planned

- createdAt: 2026-06-02T10:36:35.467Z
- updatedAt: 2026-06-02T10:36:35.467Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "TUI #12: GOALS ledger as a flat list (no subsection headers) showing fields.milestones"
- description: |
    Item #12 (TUI half; USER-DEVIATED answer Q48). Mirror of the web fix for the TUI. Today buildItemEntries groups rows under per-coordination-milestone subsection headers (packages/ledger-tui/src/app.tsx L137-145) and ContentPane shows a single 'milestone <coordinationId>' line (app.tsx L1082); goals.fields.milestones is never shown.
    
    FIX (GOALS ledger ONLY): (a) for the goals view, build a FLAT entry list with NO per-milestone subsection headers (skip the coordination-milestone grouping in buildItemEntries when the active ledger is goals); (b) in ContentPane for a goal, REPLACE the single 'milestone <id>' line with a `milestones` list rendered from fields.milestones (the work-milestone ids). Leave other ledgers' subsection grouping and the 'milestone <id>' line unchanged. COORDINATE with #13 (memoized buildItemEntries) and #10 (TUI header element) so the goals branch composes with those changes.
- acceptance: "ink-testing-library test on the GOALS ledger: the list frame shows goals as a flat list with NO milestone subsection header lines; the content pane for a goal shows a `milestones` list of the work-milestone ids from fields.milestones (e.g. M12, M13, M14) and not a single coordination 'milestone <id>' line. Other ledgers' grouping/content unchanged. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]

### T85 — planned

- createdAt: 2026-06-02T10:36:52.987Z
- updatedAt: 2026-06-02T10:36:52.987Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "TUI #13: memoize the per-keystroke O(N) list derivations (nav latency fix)"
- description: |
    Item #13 (TUI; FIX task — cause localized to the render path, NO /investigate needed per Q49). Symptom: TUI navigation latency GROWS with item count — the pause when moving the cursor up/down scales O(N) in the ledger size.
    
    ROOT CAUSE (grounded in packages/ledger-tui/src/app.tsx): every cursor move does patchTop({cursor}) -> setStack -> a FULL re-render of App; the items-frame render body (L644-714) is NOT memoized, so on EVERY keystroke it (i) re-filters all rows via visibleRows (L644; visibleRows is a useCallback but is CALLED fresh each render), (ii) recomputes maxIdW by reducing over ALL rows (L672) and maxStatusW over all status values (L673), and (iii) rebuilds the ENTIRE ListEntry array via buildItemEntries (L125-147, L676). The draw itself is already windowed (ScrollList maps only the visible slice `win`, L941-971), so the O(N) cost is the per-keystroke RECOMPUTE, not the row paint.
    
    FIX (per Q49 chosen recommendation): wrap the three derivations — visibleRows result, maxIdW/maxStatusW, and the buildItemEntries entries — in useMemo keyed on (view, filter, showArchive, archiveRows) so a pure cursor move does NO O(N) work. The memo keys MUST also include whatever the other render-path tasks add: the column selection from T62 (#1 TUI columns) and the rendered-header-element change from T81 (#10 TUI badge) / T84 (#12 goals flat branch). Defer the React.memo list-extraction unless the memoization alone proves insufficient.
    
    REPRODUCTION-FIRST (repo policy): write a documented keystroke-latency repro / a 'heavy builders invoked once per data-change, not per keystroke' assertion at large N (≈500/1000 items) that FAILS before the fix (builders run per keystroke) and PASSES after.
- acceptance: A test asserts the heavy derivations (visibleRows/maxIdW/maxStatusW/buildItemEntries) execute ONCE per data-change (view/filter/showArchive/archiveRows change) and NOT on a pure cursor move — e.g. instrument call counts and move the cursor N times with zero additional builder invocations. The repro demonstrably failed before the memoization (builders ran per keystroke). Navigation behavior (selection, scrolling) is unchanged. `bun run check` green.
- suggestedModel: frontier
- dependsOn: ["T62","T81","T84"]
- ledgerRefs: ["goals:G2"]

## M19

### T86 — planned

- createdAt: 2026-06-02T10:37:05.474Z
- updatedAt: 2026-06-02T10:37:05.474Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "Web #14: per-suggestion 'pick as answer' button after each suggestion <li>"
- description: |
    Item #14 (web half; DEPENDS ON M13 T56 — the web suggestions bulleted list. Questions ledger only per Q50). Once suggestions render as a <ul><li> list (T56) inside renderQuestionFields() (packages/ledger-web/src/App.tsx; `answerable` and `answerWith` are in scope there), add a small 'pick' button AFTER each suggestion <li>, analogous to the existing 'as recommended' button (answerBox L1733-1741, which calls answerWith(AS_RECOMMENDED_ANSWER) -> onSave(ANSWERED_STATUS, {...fields, [ANSWER_FIELD]: answer})).
    
    FIX (per Q50 recommendation): render the per-suggestion 'pick' button ONLY when the item is answerable (open + canAnswer). Clicking it calls answerWith(suggestionText) for THAT suggestion's literal text — immediately saving + marking answered (exact parity with 'as recommended', passing the suggestion text instead of the AS_RECOMMENDED_ANSWER sentinel). Give it a stable data-testid (e.g. answer-pick-suggestion-<index>) for testing. Scope to the questions ledger (the only ledger with a suggestions field).
- acceptance: "happy-dom test: an answerable question with suggestions ['opt a','opt b'] renders a 'pick' button after each <li>; clicking the button for 'opt b' calls the save path with answer === 'opt b' and status === answered. The buttons are NOT rendered when the item is not answerable. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T56"]
- ledgerRefs: ["goals:G2"]

### T87 — planned

- createdAt: 2026-06-02T10:37:12.068Z
- updatedAt: 2026-06-02T10:37:12.068Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "TUI #14: number keys 1-9 pick the Nth suggestion as the answer"
- description: |
    Item #14 (TUI half; DEPENDS ON M13 T57 — the TUI suggestions bulleted list. Questions ledger only per Q50). The TUI has no buttons; the existing 'as recommended' is the `r` keybinding (packages/ledger-tui/src/app.tsx L548-557 content-focus, L572-581 list-focus), gated on canAnswer + hasRecommendation, calling applyAnswer(cur, AS_RECOMMENDED_ANSWER).
    
    FIX (per Q50 recommendation): bind number keys 1-9 so pressing N picks the Nth suggestion and calls applyAnswer(cur, suggestionText) immediately (save + mark answered), mirroring the `r` key. Gate on canAnswer AND the presence of a non-empty suggestions list (and N within range of the suggestions array). Mirror the gating in both focus modes where `r` is handled. Document the new keys in the key hints. Scope to the questions ledger (the only ledger with a suggestions field).
- acceptance: "ink-testing-library test: for an answerable question with suggestions ['opt a','opt b'], pressing '2' calls applyAnswer with 'opt b' and marks answered; pressing a number beyond the suggestion count is a no-op; the keys are inert when the item is not answerable or has no suggestions. The key hints document 1-9. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T57"]
- ledgerRefs: ["goals:G2"]

### T88 — planned

- createdAt: 2026-06-02T10:37:26.066Z
- updatedAt: 2026-06-02T10:37:26.066Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "Web #15: disable 'as recommended' + per-suggestion 'pick' once the answer has non-whitespace text"
- description: |
    Item #15 (web half; DEPENDS ON T86 (#14 web pick buttons) + the existing 'as recommended' affordance; also covers the batch modal T63 per Q51 (C)). Rationale: those buttons auto-fill/clobber the answer, so once the user is composing their own answer they must not overwrite it.
    
    GROUNDED (Q51 A): the answer field is an UNCONTROLLED <textarea> (ref={answerRef} + defaultValue, packages/ledger-web/src/App.tsx L1720-1728) — there is NO reactive value today, so the 'as recommended' button (data-testid answer-as-recommended, L1733-1741) and the #14 per-suggestion 'pick' buttons (T86) cannot reactively flip `disabled`. Under happy-dom, onChange on a controlled text input does NOT fire, but onInput on the uncontrolled textarea DOES (CLAUDE.md) — that is the signal to test against.
    
    FIX (per Q51 recommendation, suggestion 1): add a minimal onInput-driven 'answer is non-empty (NON-WHITESPACE)' signal on the uncontrolled textarea (any non-whitespace character locks; leading/trailing spaces do not), and gate the `disabled` of BOTH the 'as recommended' button and the #14 per-suggestion 'pick' buttons on it. Apply the rule WHEREVER these controls render — the main detail-panel answerBox AND the batch-answer modal (T63). Reset the signal when switching to a different item.
- acceptance: "happy-dom test: typing a non-whitespace character into the answer textarea (fire onInput) sets BOTH 'as recommended' and every per-suggestion 'pick' button to disabled; clearing the field (or whitespace-only) re-enables them. The same gating holds inside the batch-answer modal (T63). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T86","T63"]
- ledgerRefs: ["goals:G2"]

### T89 — planned

- createdAt: 2026-06-02T10:37:33.607Z
- updatedAt: 2026-06-02T10:37:33.607Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-83a1-session
- headline: "TUI #15: make the `r` and #14 pick keys inert when the persisted answer is non-empty"
- description: |
    Item #15 (TUI half; DEPENDS ON T87 (#14 TUI pick keys) + the existing `r` as-recommended key; also covers the batch overlay T64 per Q51 (C)). Rationale: parity with the web disable-when-typing rule.
    
    GROUNDED (Q51 B): the `r` as-recommended key (packages/ledger-tui/src/app.tsx L548-557 content-focus, L572-581 list-focus) and the #14 number pick keys fire in LIST/CONTENT focus modes, OUTSIDE the answer overlay — they read the PERSISTED cur.item.fields.answer, not a live edit buffer (the live buffer only exists transiently inside the { t:'answer' } overlay). So the coherent 'answer non-empty' semantics for these keys is the PERSISTED field.
    
    FIX (per Q51 recommendation, suggestion 1): make both the `r` key and the #14 pick keys inert/no-op when fieldToString(cur.item.fields[ANSWER_FIELD]).trim().length > 0 (persisted answer non-empty, trimmed) — symmetric with the web disabled state and with where the keys actually fire. Apply the same gating wherever these controls act, INCLUDING the batch-answer overlay (T64). Reflect the inert state in the key hints if the hints are status-sensitive.
- acceptance: "ink-testing-library test: for a question whose persisted answer field is non-empty, pressing `r` and pressing a #14 number key are BOTH no-ops (no save/transition); when the persisted answer is empty/whitespace they act as before. The same gating holds inside the batch-answer overlay (T64). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T87","T64"]
- ledgerRefs: ["goals:G2"]
