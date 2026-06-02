---
ledger: goals
counters:
  milestone: 0
  item: 6
archives: []
---

# goals

## M1

### G1 — done

- createdAt: 2026-06-01T19:24:30.427Z
- updatedAt: 2026-06-02T08:13:31.116Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- title: "Implement the /implement:* command family"
- description: |
    We have the plan:* command family (plan:start, plan:advance) that clarifies goals and prepares an actionable roadmap. Now build the /implement:* command family that executes that roadmap.
    
    Desired flow:
    - /implement:start accepts a list of milestones to complete; if none specified, assume ALL milestones need completion.
    - It then enters a loop: take unblocked tasks honoring DAG order (not blocked, not in a terminal condition).
    - For every independent pending task, create a git worktree and dispatch an implementation subagent using the task's suggested-model field, defaulting to the orchestrator's own model class. Show a WARNING if the suggested model is not set.
    - After the implementor completes, run a review subagent using the most capable model available.
    - The reviewer either approves or disapproves. On disapproval it returns criticism and questions for the user. Criticism can be handled autonomously in a loop; questions are registered in the ledger and must be answered by the user.
    - When the user answers, they run /implement:advance to continue.
    
    Goal: design and implement this command family with all details worked out (concurrency, DAG traversal, worktree lifecycle, model selection, review gating, autonomous-fix loop bounds, question registration/resumption, merge-back, failure handling).
    
    ## Follow-up (2026-06-02) — UI/schema improvements
    1) Our UIs do not allow to see archived items
    2) We should add per-milestone filter controls to the web UI - currently we only have filter by status
    3) I think it would be a good idea to use milestone table subsections in the ledgers views where items include milestone field
    4) In the TUI the items list is misaligned because of different task id length ("T1 name" vs "T14 name") - can we use a table with columns, not just a flat list?
    5) Web UI -> reviews ledger, summary column displays "criticism" field content. That field is too long so "go-ahead" badge wraps ugly. I've checked raw ledger content, there is no "summary" field in reviews. So, we need to fix both wrapping, the schema and modify prompts to fill summaries
    
    ## Follow-up (2026-06-02, #2) — defects/tasks separation + investigate:* flow
    theree is one omission in our plan:* and implement:* commands: they only operate on tasks ledger, but they should separate defects from tasks - and operate BOTH ledgers. Essentially they are very similar, just the ledger names/metadata is different. So, we need to modify the prompts. So, when user reports a defect, it should get into defects ledger. One defect may require one or more tasks to be fixed. When reviewer finds a defect - the same, it should be filed as a defect, not task. We need to introduce separate investigate:* flow specifically designed to figure out best ways to research defects (similar to our research-loop skill) and plan up fixes. This flow should be integrated into plan:* and implement:* flows. Key idea is the same as in research loop: multiple hypothesis with parallel validation, once root cause is found - planning cycle to produce tasks
- grounding: |
    Key facts shaping the plan and questions:
    
    - The existing plan-flow family is the template: thin commands at `llm/commands/plan/{start,advance}.md`, subagents at `llm/agents/{plan-advance,plan-reviewer}.md`. Assets live once under `llm/{commands,agents}` and are symlinked into `.claude/` and `.codex/` by `scripts/link-prompts.ts` (the `LINKS` array must gain the new `/implement:*` entries).
    - Platform constraint (decisive): subagents cannot spawn subagents (Agent-SDK). So, as plan-flow already does, the implementor↔reviewer loop and concurrent worktree dispatch MUST live in the `/implement:advance` orchestrator command, not in a subagent.
    - The Agent tool `model` field accepts a fixed set: sonnet | opus | haiku | inherit | full-model-ID. The 'suggested-model' must resolve onto these.
    - The repo `tasks` schema has `headline`, `description`, `acceptance`, `dependsOn`, `ledgerRefs`. NOTE: the `questions` ledger already has an optional `suggestedModel` field; whether `tasks` does must be confirmed (Q3).
    - Claude Code offers native per-subagent worktree isolation (`isolation: worktree`; auto-removed if unchanged, NOT auto-merged), plus /batch and dynamic Workflow as parallelization surfaces. Manual worktree lifecycle vs native isolation is a real fork.
    - Repo gate is `bun run check` (tsc + eslint + bun test).
    
    ## Follow-up grounding (2026-06-02, UI/schema scope) — verified against source
    - reviews schema: `REVIEWS_SCHEMA` in `packages/ledger/src/constants.ts` (L271-286) has new_questions[], criticism[], ledgerRefs[], tags[], sourceRefs[] — NO `summary` field (confirms Q16). `CANONICAL_LEDGERS` (same file) is asserted by `packages/ledger/test/canonical-ledgers.test.ts`; live registry is `docs/ledgers.yaml`; `examples/sample-ledger` has its own copy.
    - summarize() in BOTH UIs picks headline ?? title ?? question ?? summary ?? Object.values(f)[0]; reviews therefore fall through to criticism (the long string[]). Adding optional `summary` makes it the natural pick (Q16/Q17).
    - Store-layer archive plumbing already exists: `LedgerSearchIndex` has separate active/archived buckets + `includeArchived`; `FsLedgerStore` has archiveDir, `collectArchivedItems`, `refreshLedgerIndexArchived`; MCP exposes `fetch_ledger_archive` + `archivePointers[]` on `fetch_ledger`. Web `mcpClient` does NOT yet implement `fetchLedgerArchive`; no cross-ledger enumerate tool exists (Q11). New MCP tools permitted if agents benefit.
    - Web `ItemTable` is a flat <table> with a milestone column + single status <select>; status badge `.lw-status` wraps because the summary cell is unclamped. TUI list renders each row as one ink <Text> 'id [status] summary' in ScrollList — misaligned by variable id width (Q15).
    - Reviewer write paths: plan-reviewer.md writes its reviews item directly via create_item; implement-reviewer.md returns a JSON block that /implement:advance records as the terminal reviews item (Q18 — summary must be threaded through all three).
    
    ## Follow-up grounding (2026-06-02, #2 — defects/tasks + investigate:*) — verified against source
    - Schemas (docs/ledgers.yaml, the live registry): `defects` (idPrefix D) has headline(req)/description/rootCause/suggestedFix/fix/severity(REQUIRED)/sourceRefs[]/blockedBy[]/dependsOn[]/ledgerRefs[]/tags[]/suggestedModel; statusValues open|wip|blocked|resolved|abandoned, terminal resolved|abandoned. `hypothesis` (idPrefix H) has headline(req)/description/rationale/parentHypothesis(id)/evidence[]/sourceRefs[]/dependsOn[]/ledgerRefs[]/tags[]/suggestedModel; statusValues open|uncertain|confirmed|wrong, terminal confirmed|wrong. `tasks` ALSO already carries an optional `severity` field plus dependsOn[]/ledgerRefs[].
    - DECISIVE on Q28 schema-tweak: the bidirectional defect↔task link chosen in Q20 (tasks.ledgerRefs += defects:<D>; defects.dependsOn = fix-task ids) needs NO new schema field — dependsOn[] and ledgerRefs[] exist on BOTH schemas (and on hypothesis). So 'Full' scope (Q28) means prompt edits + UI work; NO @cq/ledger schema change is required for the link. (A schema change would only arise if UI work surfaces a need; none identified.)
    - Prompt files that gain defect-awareness: llm/commands/plan/{start,advance,follow-up}.md, llm/agents/{plan-advance,plan-reviewer}.md, llm/commands/implement/{start,advance}.md, llm/agents/{implement-worker,implement-reviewer,implement-conflict-resolver}.md. /implement:advance.md already references 'defect D2' inline — confirms defect vocabulary is welcome there.
    - NEW investigate:* assets (Q23): llm/commands/investigate/{start,advance}.md + llm/agents/investigate-explorer.md, all added to the LINKS array in scripts/link-prompts.ts (which currently lists plan/* + implement/* only).
    - Reviewer defect bucket (Q22): plan-reviewer writes its review item directly (add a `defects[]` consideration -> orchestrator/command files defects); implement-reviewer returns JSON the /implement:advance orchestrator records (add `defects[]` to its JSON contract; advance.md files each as open defect + routes per Q26 file-and-defer).
    - Model tiers (decision K4) already established: frontier/standard/fast -> opus/sonnet/haiku (Claude) or host top/mid/fast (Codex); investigate-explorer is READ-ONLY (no worktree, Agent/Write/Edit disallowed, like plan-reviewer's disallowedTools).
    - UI surfaces for the 'Full' scope: the defects + hypothesis ledgers already render via the generic ItemTable/ScrollList (they are canonical ledgers); the #1 follow-up (M6) already adds milestone subsections + archive views generically. The #2 UI add is defect-centric: surface a defect's linked fix-tasks (dependsOn/ledgerRefs) and a hypothesis tree (parentHypothesis ancestry) as a relationship view in BOTH UIs.
    
    Sources: docs/ledgers.yaml; llm/commands+agents prompt files; scripts/link-prompts.ts; research-loop skill; Claude Code subagents/worktrees docs; answered questions Q19-Q28.
- milestones: ["M3","M6","M7","M8","M9"]

## M10

### G2 — done

- createdAt: 2026-06-02T08:27:10.593Z
- updatedAt: 2026-06-02T22:18:12.711Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- title: Ledger-suite UI/schema enhancements (columns, batch-answer, colors, titles)
- description: |
    UI/schema enhancements for the ledger-suite frontends (TUI @cq/ledger-tui and web @cq/ledger-web), a follow-on to the now-completed goal G1. Greenfield features + small UI-correctness fixes.
    
    Scope:
    1) Arbitrary column display in the ledger views: a triple-dot button on the right of the filters row that opens a column selector, letting the user choose which (non-"long") fields show as columns. Default: show `suggestedModel` as a column in the tasks view.
    3) Questions view field order should be exactly: milestone, status, by, question, suggestions, context, recommendation, answer.
    4) Turn the questions `suggestions` field into a proper list type (string[]) and render it as a list. Models currently write semicolon-separated lists into it. NO backward-compat constraint — this repo is the only user (dogfood only), so migrate/normalize freely.
    5) Batch answer mode in BOTH UIs: iterate through all unanswered questions in a focused, nicely-formatted view with a larger font than the normal ledger view. Web: activate via a button at the bottom of the left sidebar (then a large popup/modal); design an equivalent affordance for the TUI.
    6) Fix: the `revise` review status renders green — the same as `go-ahead` — which is wrong. `revise` should have its own distinct (warning/negative) color in the status-badge color map. Folded in here as a small UI-correctness fix (the cause is the badge color map; it pairs naturally with item 8).
    7) Show the project directory name in the page/app title, e.g. "[cq1] LLM ledgers".
    8) Graph view: apply the same status-based colorization to items/nodes as the status badges use (a single shared status→color source).
    
    NOT in scope here (handled separately): original item #2 — "MCP connection fails when an agent starts in a directory without an initialized ledger; should auto-init instead" — is a genuine defect routed to /investigate:start, not part of this goal.
    
    Context: continues the work tracked under goal G1 (the /implement:* command family + its UI/schema follow-ups M6–M9, now done). The frontends are pure MCP clients (never read docs/ directly). A status→color mapping likely already exists for badges and should become the single shared source for items #6 and #8. Item numbering preserves the user's original request (item #2 intentionally absent here). Tests: ink-testing-library (TUI), happy-dom (web). Repo gate: `bun run check`.
    
    ## Follow-up (2026-06-02, #1) — milestone-section rendering + column-width fixes (UI defects)
    Three UI-correctness reports against the ledger views (the milestone-subsection rendering shipped in G1/M6 + the column table). Treat as fix tasks (no investigation needed — causes are plainly in the rendering code):
    9) ARCHIVED MILESTONES render differently from non-archived: they look like BUTTONS and only ONE of the archived milestones is actually visible in the items list. Archived milestones should render the SAME as regular milestone sections; the ONLY difference should be a badge in the section head marking them archived.
    10) Milestone STATUS in the section head is shown as plain text `[open]` — it should be a BADGE (same status-badge styling as item rows / the shared status→color source from #6/#8).
    11) Columns in the items list can be TOO WIDE / mis-proportioned: e.g. id takes ~1/5 of the width, status ~2/5, summary ~2/5. Fix the column proportions so id/status are sized to their content and summary takes the remaining width (consistent with the column work in #1).
    
    ## Follow-up (2026-06-02, #2) — goals-view milestones, TUI nav performance, suggestion pick-as-answer
    12) DEFECT: the GOALS view should NOT show a single `milestone` column/field — a goal may be linked to MANY milestones (`goals.fields.milestones` is an id[]; the generic per-item `milestoneId` shown for other ledgers is misleading for goals). Render a goal's milestones appropriately (e.g. list them) or omit the single-milestone column/section in the goals view specifically.
    13) DEFECT (performance): TUI navigation over a ledger is very slow — the pauses when moving one item up/down GROW with the number of items in the ledger. Diagnose and fix the per-keystroke cost (suspected: full-list re-render and/or recomputing column widths / layout / the ListEntry build over ALL items on every cursor move — needs memoization or windowing/virtualization). If the root cause is not plainly in the render path, it may warrant a quick /investigate pass; otherwise treat as a fix task.
    14) FEATURE: when suggestions render as a list (item #4), show a small 'pick as answer' button after EACH suggestion — analogous to the existing 'as recommended' button — that sets that individual suggestion as the answer.
    
    ## Follow-up (2026-06-02, #3) — disable answer-fill buttons once the user is typing
    15) FEATURE: when the user has entered ANY text into the question answer field, DISABLE both the 'as recommended' button and the per-suggestion 'pick as answer' buttons (item #14). Rationale: those buttons overwrite/auto-fill the answer; once the user is composing their own answer they should not clobber it. Web: disabled state on the buttons gated on non-empty answer input. TUI: the analogous keybindings (the `r` as-recommended key and the #14 pick-suggestion key) become inert/no-op once the answer buffer is non-empty. Depends on #14 (pick-as-answer) and the existing 'as recommended' affordance.
    
    ## Follow-up (2026-06-02, #4) — milestones-ledger archived rendering + routing-question shape + batch-modal sizing
    Four reports against the just-shipped M18/M19 + M14 work. Items 16 and 17 are UI-correctness DEFECTS (causes plainly in the rendering code shipped by T79/T83/T80 — treat as fix tasks, no investigation needed). Item 18 is a process/schema concern about orchestrator-generated routing questions. Item 19 is a batch-modal sizing refinement.
    16) DEFECT: in the MILESTONES ledger list, do NOT add per-milestone subsections for ARCHIVED milestones — it makes no sense and the SAME milestone is shown TWICE (once as the milestone item/row, again as an archived section). The T79 unification (render archived groups through the same collapsible subsection renderer) is correct for NON-milestones ledgers (tasks/defects/etc. grouped by their coordination milestone), but for the MILESTONES ledger itself a milestone is its own row — it must NOT also get an archived 'section'. Scope the archived-subsection rendering so it does NOT apply to the milestones ledger (no duplicate).
    17) DEFECT: archived milestone SECTION TITLES display the milestone's `description` field instead of its `title` field. The section head should show the `title` (like active milestone sections do), not the long description.
    18) PROCESS/SCHEMA: the orchestrator-generated file-and-defer ROUTING questions (e.g. Q52, Q53) carry only `question`+`context`+`ledgerRefs` — no `suggestions`/`recommendation` — so they 'don't look like questions'. These are created by the implement/plan flows (file-and-defer per K8/Q26) to point the user at `/investigate:start <D>` for out-of-scope defects. Reconsider this: either (a) such routing pointers should NOT be created as `questions` items at all (they pollute the questions ledger; the open defect + its ledgerRefs already make it discoverable), or (b) if they remain questions, give them proper shape (suggestions like ['run /investigate:start D3', 'defer', 'wontfix'] + a recommendation) and/or a visual marker distinguishing routing-questions from clarifying-questions. Decide the right model and apply it in the relevant flow prompts and/or the questions schema/rendering.
    19) FEATURE/POLISH: the batch answer-questions popup/modal (item #5, web T63) should be WIDER and TALLER; the font can be reduced a bit (it is currently sized larger than necessary). Tune the modal dimensions + font so more of each question is visible at once.
- grounding: |
    Repo grounding for G2 (verified by reading source):
    
    STATUS/COLOR (items #6, #8): both frontends carry a duplicated status.ts with statusBucket(status, schema): terminal → DROPPED.has(s)?'dropped':'done'; else blocked/progress/start. StatusBucket = start|progress|blocked|done|dropped — NO 'warning' bucket, so `revise` (terminal, not in DROPPED) buckets to 'done'→green. TUI BUCKET_COLOR map: start=cyan, progress=yellow, blocked=red, done=green, dropped=gray (status.ts L44-50; statusColor()). Web has NO JS palette — bucket→color lives only in CSS classes lw-status-<bucket> (styles consumed by App.tsx spans). Adding a 'warning' bucket means: edit BOTH status.ts files (add bucket + special-case revise/needs-changes terminal-negative), add TUI BUCKET_COLOR['warning']='magenta', add web CSS .lw-status-warning (amber) — and to make ONE shared source for #8, introduce a canonical bucket→hex palette (CSS custom properties) consumed by both badges and the SVG.
    
    GRAPH (item #8, web-only — TUI has no DAG): DagView.tsx has its OWN hardcoded STATUS_COLORS keyed on RAW status (only milestone statuses open/done/postponed/blocked) with amber fallback '#e0b341' (L13-21); loadDagData graphs ANY ledger so task/defect/review statuses all fall to amber. DagData/DagNode (dagData.ts L22-34) carry id/title/status/sublabel but NOT the schema, and statusBucket needs schema.terminalStatuses to bucket terminal statuses. loadDagData HAS view.schema (L48) but doesn't forward it. Fix: add schema to DagData, thread into DagView, color nodes via statusBucket→shared hex palette (incl. warning).
    
    QUESTIONS FIELD ORDER (item #3): QUESTION_FIELD_ORDER = [question, context, recommendation, answer] in BOTH status.ts (no suggestions). Web renderQuestionFields() (App.tsx L1750) emits metadata (short-first via orderItemFields) THEN question→context→recommendation→answer; 'milestone' renders in a trailing <dl> block (L1839), 'by'/provenance also trailing (L1841). TUI ContentPane renders id/status header lines, a milestone/created/updated line, a 'by' line, then QUESTION_FIELD_ORDER. So milestone/status/by are NOT contiguous leading rows today. ANSWERED order per Q31: milestone, status, by, question, CONTEXT, suggestions, recommendation, answer (context BEFORE suggestions — deviates from the planner's recommendation). Requires restructuring leading metadata in BOTH UIs, and adding suggestions to the narrative sequence.
    
    SUGGESTIONS AS LIST (item #4): QUESTIONS_SCHEMA.suggestions is ALREADY type 'string[]' (constants.ts L193). Gaps: (a) parseFieldValue() splits string[]/id[] on COMMAS (web App.tsx L144-149, TUI app.tsx L90-95) but models write 'a; b; c' as ONE element; (b) rendering does Array.isArray(v)?v.join(', ') everywhere — never a list. Q32 answer: split on SEMICOLONS (trim/drop empties) for a one-shot update_item normalization pass over existing question items; switch the array editor delimiter off comma (to semicolon/newline); render suggestions as a bulleted list in both UIs. NO back-compat (dogfood only).
    
    COLUMN SELECTOR (item #1): both frontends hardcode table columns to id/status/summary (web ItemTable App.tsx L1228-1355: flat for milestones, per-milestone subsections otherwise; TUI list rows). isShortField(value) is per-VALUE (single-line, <=48 chars) — data-dependent, NOT a stable field-level rule. suggestedModel is a real tasks field (COMMON_REF_FIELDS, type string). Q29/Q30: per-ledger client-local persistence (web localStorage like PANEL_KEY/VIEW_KEY; TUI in-memory); eligible = all schema fields minus a small long/narrative denylist (description, rationale, criticism, context, etc.); id+status+summary always shown; column defaults (incl. suggestedModel for tasks) in a per-ledger code constant. NO schema change, NO new MCP surface.
    
    BATCH ANSWER (item #5): canAnswer(schema, status) (status.ts L96) already generalizes 'answerable' by shape (answer field + answered transition). Web has overlay patterns (HelpOverlay L1107, settings popup) + answerBox with 'save & mark answered'/'as recommended' (App.tsx L1718). Sidebar lw-sidebar (L838) lists ledgers only — no bottom action button. TUI uses centered Overlay union (app.tsx L170-179: search/status/answer/pickField/editField/editTitle/createMilestone/createItem/filter) owning input; batch = NEW Overlay variant with step state. Q33: web sidebar-bottom button → large modal stepping OPEN questions, larger font, same save/as-recommended actions, PLUS left/right buttons + keyboard nav (ctrl/cmd+[ and ]); TUI new full-screen overlay variant on a keybinding stepping with the existing answer prompt; scope to ANY answerable ledger (canAnswer), default questions.
    
    PROJECT TITLE (item #7): index.html hardcodes <title>ledger-web</title>; web header span 'ledger-web' (App.tsx L758); TUI header 'ledger-tui'. LedgerClient (types.ts L59-70) has NO serverInfo/cwd method — both McpLedgerClient (HTTP) and the in-memory test fake implement this interface. --cwd for ledger-mcp is absolute (CLAUDE.md), so basename(cwd) = project dir. MCP server already advertises baseline `instructions`/serverInfo on connect. Q35: server reports displayName (basename --cwd) via serverInfo/instructions; add a serverInfo()/displayName accessor to LedgerClient (+ both impls + fake); both frontends render '[<dir>] LLM ledgers' as document.title + in-app header.
    
    TEST HARNESS: ink-testing-library (TUI), happy-dom (web); controlled text inputs don't fire onChange under happy-dom → uncontrolled inputs via refs (selects fine controlled). Frontends are PURE MCP clients (never read docs/). Repo gate: bun run check (bun test + tsc -b + eslint).
    
    === FOLLOW-UP GROUNDING (#9-#15; M15/M16; verified via Q38-Q41, Q48-Q51 source contexts) ===
    #9 ARCHIVED-SECTIONS (Q38, WEB-ONLY; Q39 leaves TUI as-is): web active items render per-milestone collapsible <section> via ItemTable (App.tsx L1283-1353); archived render via SEPARATE ArchiveSection (App.tsx L1404-1484) as a flat row of lw-archive-pointer <button>s where ONE click fetches just that group (= 'buttons / only one visible'). FIX: render each archived milestone-group through the SAME subsection renderer as active ones, each its own collapsible <section>, with an 'archived' badge (.lw-archived-badge already exists, styles.css L644) in the head; default COLLAPSED + lazy-fetch (fetch_ledger_archive) items on first expand (per Q38 recommendation). Remove the pointer-button path. TUI archive view (flat '── archived ──' header, app.tsx L678-689) stays as-is per Q39.
    #10 MILESTONE-STATUS-BADGE (Q40, BOTH UIs; DEPENDS ON M12 T50/T52/T53): milestone status currently plain text in header label — web headerLabel '<id>: <title> [<status>]' in single span.lw-ms-label (App.tsx L1293-1295); TUI header plain string (app.tsx L141). FIX: render as a status BADGE from the shared M12 bucket→palette; thread the MILESTONES schema so statusBucket classifies terminal (open/done/postponed/blocked). Web: wrap status in span.lw-status.lw-status-<bucket>. TUI: change header ListEntry to carry a rendered element; color status token via statusColor (ink has no bordered badge).
    #11 COLUMN-PROPORTIONS (Q41, WEB-ONLY; relates to M14 T60-T62): web .lw-table is width:100% with NO table-layout/colgroup → auto-layout over-allocates id/status. FIX (CSS): id/status hug content via <colgroup> width:1% + white-space:nowrap; summary takes remainder; apply to ALL web tables (active subsections, flat milestones table, archive table). Define as reusable 'scalar cols hug content, long/summary col flexes' rule that T60-T62's dynamic column set will inherit. TUI already content-sizes via padEnd (app.tsx L672-673,L697) — untouched.
    #12 GOALS-MILESTONES (Q48, BOTH UIs; USER DEVIATED from recommendation): user answer = 'Do not show milestones in Goals ledger items view - it should be a FLAT LIST without subsections - as milestones list.' So for the GOALS ledger specifically: do NOT group goals under their coordination-milestone subsection (web ItemTable L1284-1297 keyed on g.id; TUI buildItemEntries headers app.tsx L137-145) — render goals as a FLAT list; and replace the single coordination-milestone display (web DetailPanel trailing milestone row App.tsx L1839-1840; TUI ContentPane 'milestone <id>' app.tsx L1082) with a list of fields.milestones (the work-milestone id[]). goals.fields.milestones (e.g. G2→[M12,M13,M14,...]) is never displayed today. Goals-specific override must coexist with the column work (T60) and the milestone-subsection/badge work (#9/#10).
    #13 TUI-NAV-PERF (Q49, FIX task — no investigate; touches render path shared with T31/T62 and T53/T51): every cursor move = patchTop({cursor})→setStack→FULL App re-render; the items-frame body (app.tsx L644-714) is NOT memoized so per-keystroke it (i) re-filters via visibleRows (L644), (ii) recomputes maxIdW reducing over ALL rows (L672) + maxStatusW (L673), (iii) rebuilds the ENTIRE ListEntry array via buildItemEntries (L125-147, L676). Draw is already windowed (ScrollList maps only `win`, L941-971), so cost is the O(N) per-keystroke recompute. FIX: useMemo the three derivations keyed on (view, filter, showArchive, archiveRows) — keys MUST include whatever T62 (columns) / T59 (header element) add to the render path. Reproduction-first: documented keystroke-latency repro at large N (≈500/1000) + acceptance asserting the heavy builders run once per data-change, not per keystroke. Defer React.memo list-extraction unless memoization proves insufficient.
    #14 PICK-AS-ANSWER (Q50, BOTH UIs; DEPENDS ON M13 T56/T57; questions ledger only): once suggestions render as a list, add a per-suggestion 'pick as answer' control that sets THAT suggestion's text as the answer, parity with existing 'as recommended'. WEB: small button after each <li> in renderQuestionFields() (where `answerable`/answerWith are in scope), shown ONLY when answerable, calling answerWith(suggestionText) → immediate save + mark answered (answerWith pattern at App.tsx L1733-1741). TUI: bind number keys 1-9 to pick the Nth suggestion, gated on canAnswer + presence of suggestions, calling applyAnswer(cur, suggestionText) immediately, mirroring the `r` as-recommended key (app.tsx L548-557,L572-581). Sequence after T56 (web list) / T57 (TUI list).
    #15 DISABLE-WHEN-TYPING (Q51, BOTH UIs; DEPENDS ON #14 + 'as recommended'; ALSO applies inside batch modal T63/T64): once the user has entered ANY non-whitespace text into the answer field, DISABLE both 'as recommended' and the #14 per-suggestion 'pick' controls (they auto-fill/clobber the answer). WEB: answer textarea is UNCONTROLLED (ref answerRef + defaultValue, App.tsx L1720-1728) so there is no reactive value today — add a minimal onInput-driven 'answer non-empty (NON-WHITESPACE)' signal (onInput fires on uncontrolled textarea under happy-dom; onChange on controlled text does NOT — CLAUDE.md) and gate the buttons' `disabled` on it. TUI: the `r` key + #14 pick keys fire in LIST/CONTENT focus OUTSIDE the answer overlay, reading the PERSISTED cur.item.fields.answer — make them inert/no-op when fieldToString(fields[ANSWER_FIELD]).trim().length>0 (symmetric with web). Apply the rule WHEREVER these auto-fill controls render, INCLUDING the batch-answer modal (#5: web T63 / TUI T64). Sequence after T56/T57 and after #14.
- milestones: ["M12","M13","M14","M18","M19","M21"]

## M15

### G3 — done

- createdAt: 2026-06-02T09:12:10.677Z
- updatedAt: 2026-06-02T22:18:14.143Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- title: "Plan/implement flow-behavior changes: auto-investigate + never auto-close goals"
- description: |
    Prompt-suite behavior changes to the plan:*/implement:*/investigate:* command flows (markdown edits under llm/commands + llm/agents). Follow-on to completed G1 (which built these flows). Two distinct changes:
    
    A) AUTO-INVESTIGATE: plan:* should investigate defects AUTOMATICALLY rather than requiring the user to manually run /investigate:start. CURRENT STATE (deliberate, locked as decision K8, chosen over inline by review R5 #1): the plan↔investigate integration is FILE-AND-DEFER — when plan-flow encounters/needs a defect investigation it files a defect + an open question pointing the user to /investigate:start, and investigate→plan hands back via another user-run /plan:advance. The user wants this AUTOMATIC. This REVERSES/REFINES K8 and must be reconciled with the hard constraint that subagents cannot spawn subagents (the loops live in the main-session command, so the MAIN session can chain investigate→plan, but a subagent cannot). Candidate interpretations to resolve in clarifying: (a) main-session orchestrator auto-chains — when /plan:advance (or /plan:start) detects the goal describes a defect, or the plan-reviewer flags an out-of-scope defect, it AUTOMATICALLY runs the /investigate:advance pass inline instead of filing a question; (b) keep file-and-defer but auto-LAUNCH /investigate:start (no manual step) and auto-resume planning once a root cause is confirmed; (c) hybrid — auto-investigate only reviewer-found in-plan defects, user-reported defects still via /investigate:start. Must stay consistent with the investigate hypothesis-tree/citation-validation machinery and UPDATE the K8 decision record.
    
    B) NEVER AUTO-CLOSE GOALS: agents must NEVER transition a GOAL to a terminal/done status automatically — only when the user explicitly asks. CURRENT STATE: the implement-flow orchestrator advanced goal G1 planned→building→done on its own after the work milestones completed; llm/commands/implement/advance.md's milestone-completion section says the goal 'can then advance per the plan-flow', which invited the auto-close. DESIRED: when all of a goal's work milestones are done, the orchestrator archives the milestones and REPORTS the goal is ready to close, but leaves the goal's terminal transition to the user. Scope the exact prompt edits: implement/advance.md milestone-completion language (do NOT auto-advance the goal) + any plan-flow text implying auto-closing. Marking individual tasks/defects terminal as work completes stays fine; the prohibition is specifically closing the GOAL.
    
    Scope: prompt/markdown edits to llm/commands/plan/{advance,start,follow-up}.md, llm/commands/implement/{start,advance}.md, llm/agents/{plan-advance,plan-reviewer}.md, llm/commands/investigate/{start,advance}.md as needed, and the K8 decision record. No new ledgers; no new product code expected (prompt-suite behavior), though A may touch how the main-session orchestrator chains commands. Constraints: subagents-cannot-spawn-subagents; the file-and-defer vs inline-chain distinction; dogfood-only (this repo is the sole user). Repo gate: bun run check. References G1 (M7/M8 investigate + defect-awareness) and decision K8; and the user rule 'never auto-close goals'. Item A pairs with / may revisit K8; item B is a smaller well-understood correction.
- grounding: |
    Prompt-suite (markdown only) change; no product code. Grounded against the live files:
    
    CHANGE A (auto-investigate) — answers (Q42b-extended/Q43/Q44/Q45):
    - Q42: file ALL defects (user-reported AND auto-found); the plan ORCHESTRATOR auto-launches /investigate:* itself AFTER finishing its primary work, always when possible. (Not the narrow hybrid (c) recommendation.)
    - Q43: trigger lives in the COMMAND orchestrators plan/advance.md, plan/start.md, plan/follow-up.md (a command can run /investigate:advance inline; a subagent cannot). The plan-advance/plan-reviewer SUBAGENTS only file/flag defects (subagent disallowedTools include Bash; they never spawn subagents).
    - Q44: NO hard caps. Replace the existing hard caps with MODEL-JUDGED ill-loop detection that, when the chain loops meaninglessly, STOPS and surfaces a question to the user. Hard caps to remove: plan/advance.md '4-iteration cap' (lines 27,33,56) and implement/advance.md '8-round safety ceiling' (line 128). implement/advance.md already has model-judged ill-loop signals (lines 119-130) to mirror.
    - Q45: SUPERSEDE K8 with a NEW locked decisions item under M (the M15 coordination milestone) that cites K8 point 3 and records the new auto-investigate direction + the model-judged-stop bound; leave K8 immutable.
    
    Current file-and-defer trigger sites that become auto-launch:
      (i) plan-advance subagent 'Consuming the reviewer's defects[] bucket' (llm/agents/plan-advance.md lines 213-242) files defect + routes to /investigate:start.
      (ii) implement/advance.md step 3 (lines 96-111) files reviewer defects[] + routes to /investigate:start.
      (iii) investigate/advance.md step 5 (lines 115-150) file-and-defer hands BACK to a user-run /plan:advance.
    The symmetric reversal: a /plan:* command, after its primary planning work, auto-runs /investigate:advance on filed defects; and on a confirmed root cause the goal is defect-seeded so the SAME /plan:* session can auto-resume planning. K8 point-3 prohibition was on /investigate:advance running the PLAN loop inline; that stays (investigate hands back). The new behavior is /plan:* running the INVESTIGATE loop inline after its own work.
    
    CHANGE B (never auto-close goals) — answers (Q46/Q47):
    - Q46: forbid ONLY automatic goal building->done; planned->building MAY remain automatic (records work started).
    - Q47: when all work milestones done -> archive them + PRINT explicit 'goal G ready to close; close it in the TUI/web (set G to done)' + make NO goal-status change. Auto-marking tasks/defects terminal stays fine.
    - Offending text: implement/advance.md 'Milestone completion' (lines 192-204), specifically line 203 'The goal G ... can advance per the plan-flow once the milestone is archived'. plan-advance.md rule 7 (lines 175-176) returns 'completed' for planned/building/done but does not itself close — keep, but ensure no plan-flow text implies auto-closing the goal. No /plan:close command exists (only start/advance/follow-up); close mechanism = TUI/web.
    
    Gate: bun run check (markdown-only edits should be no-op for it, but run it). Files in scope: llm/commands/plan/{advance,start,follow-up}.md, llm/commands/implement/advance.md (and possibly start.md), llm/commands/investigate/advance.md (the handback Report wording, optional), llm/agents/{plan-advance,plan-reviewer}.md, + the K8-superseding decision record.
- milestones: ["M16","M17"]

## M20

### G4 — done

- createdAt: 2026-06-02T11:27:09.012Z
- updatedAt: 2026-06-02T22:18:16.042Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- title: "Fix D2: graceful backup-and-reinit on ledger schema divergence (no fatal BootstrapViolationError)"
- description: |
    DEFECT-SEEDED goal (linked defects:D2) — the root cause is ALREADY CONFIRMED (hypothesis H4), so this goal enters `planning` directly and SKIPS the clarifying round (per decision K8 point 4 / K12 defect-seeded clarify-skip). plan-advance should produce reviewed FIX TASKS directly.
    
    CONFIRMED ROOT CAUSE (from D2/H4, user-reported error verbatim): `ledger-mcp: fatal: Bootstrap invariant violated: existing goals ledger has a different schema than its canonical bootstrap schema`. FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:283-289) THROWS BootstrapViolationError when an EXISTING on-disk ledger's schema diverges from its CANONICAL_LEDGERS bootstrap schema; main() (packages/ledger-mcp/src/main.ts:337-344) awaits store.init() before serving, so the throw crashes the process before the MCP handshake → 'connection failed'. This is a version-skew artifact (stale built/global binary vs evolved docs/ledgers.yaml). The empty-dir auto-init path already works — only the divergence path is fatal.
    
    CONFIRMED FIX (suggestedFix, user-directed): replace the fatal throw with graceful BACKUP-AND-REINIT. When init() detects a schema divergence for an existing ledger (the `!schemasEqual` branch at FsLedgerStore.ts:283-289), instead of throwing: (a) move/copy the divergent on-disk ledger file(s) AND docs/ledgers.yaml into a timestamped backup dir (e.g. docs/.backup/<ISO-timestamp>/); (b) write fresh canonical ledger(s) + registry from CANONICAL_LEDGERS; (c) continue startup. Emit a loud WARNING to stderr naming the backup path so nothing is silently lost. (Optional: a flag to opt back into the hard abort, but default to backup-and-reinit per the user.)
    
    SCOPE: code fix in @cq/ledger (FsLedgerStore.init + a backup helper) + tests. Tests (dual-tests style): seed a divergent on-disk ledger schema → init() backs up the prior files into docs/.backup/<ts>/ + reinitializes canonical + serves (NO throw); assert the backup dir contains the prior file(s) and the live ledger is fresh-canonical; the empty-dir and the no-divergence (normal) paths are unchanged. Repo gate: `bun run check`. The BootstrapViolationError type may stay defined (for the opt-out path) but is no longer thrown by default on divergence.
    
    NOTE: implementing this in source does NOT retroactively fix an already-running stale GLOBAL binary — that needs a rebuild; and an immediate manual unblock is to back up/remove the divergent docs/ before launch. This goal is the durable code fix.
- grounding: "Confirmed root cause + fix verified against source during the D2 investigation (hypotheses H1/H2 refuted; H4 confirmed via the user's verbatim runtime error). Key sites: packages/ledger/src/store/FsLedgerStore.ts:254-340 (init: mkdir/ENOENT-swallow/bootstrap; the throw at 283-289), packages/ledger-mcp/src/main.ts:337-344 (main awaits init before serve), BootstrapViolationError type in packages/ledger/src/types.ts. CANONICAL_LEDGERS + serializeRegistry/writeRegistry/freshLedger already exist in the store for the reinit path; archiveDir/backup-style dir creation patterns exist (the store already mkdir's docs/archive). Tests use the dual-tests pattern (FsLedgerStore over a seeded tmpdir)."
- tags: ["defect-seeded","defect:D2","ledger-bootstrap","backup-and-reinit"]
- milestones: ["M22"]

## M23

### G5 — done

- createdAt: 2026-06-02T17:25:47.978Z
- updatedAt: 2026-06-02T22:18:16.868Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- title: Fix out-of-scope defects D3-D6 (@cq/ledger packaging + column eligibility + archived-head badge)
- description: |
    DEFECT-SEEDED goal (linked defects:D3, D4, D5, D6) — all four root causes are ALREADY CONFIRMED via the investigate-flow (hypotheses H5-H8, evidence validated against source), so this goal enters `planning` directly and SKIPS clarifying (K8 pt4 / K12). plan-advance should produce reviewed FIX TASKS directly, grouped by the natural fix units below.
    
    These are out-of-scope defects surfaced during G2 implement-flow reviews (file-and-defer), now investigated on the user's broadest-scope /investigate:start.
    
    === FIX UNIT A — @cq/ledger packaging (D3 major + D6 low; SAME package.json edit) ===
    D3 (CONFIRMED H5): packages/ledger/package.json main + exports['.']=./dist/index.js and ['./relationships']=./dist/relationships.js point at files that DON'T exist — tsc (outDir ./dist, include [src,test], NO rootDir) emits under ./dist/src/. Validated on disk. ['./columns'] already correctly uses ./dist/src/columns.js (internal inconsistency). Masked in-repo by tsconfig paths→source; breaks a published / nix clean-checkout consumer.
    D6 (CONFIRMED H8): no browser-safe ./constants subpath export; the '.' barrel (index.ts:50) re-exports FsLedgerStore which imports node:fs/node:path, so importing MILESTONES_SCHEMA via '@cq/ledger' drags Node builtins into the browser bundle — forcing T80's hand-duplicated MILESTONE_STATUS_SCHEMA (App.tsx:69-82).
    FIX A: (1) realign main + every exports entry to a CONSISTENT real layout — prefer setting the ledger tsconfig rootDir:'src' so dist emits flat ./dist/*.js matching the declared paths (then ./columns drops its src/ prefix), OR realign all entries to ./dist/src/* (matching ./columns). (2) ADD a browser-safe `./constants` subpath export (constants.ts is Node-free: only a type-only import) + a `@cq/ledger/constants` paths→source entry in ledger-web/tsconfig.json (mirroring ./relationships, ./columns); import MILESTONES_SCHEMA from @cq/ledger/constants in App.tsx and DELETE the duplicated MILESTONE_STATUS_SCHEMA. (3) Add a test asserting every declared export/main target file exists after `tsc -b`, and (optionally) that the web bundle pulls no Node builtins.
    
    === FIX UNIT B — column eligibility (D4 low) ===
    D4 (CONFIRMED H6): packages/ledger/src/columns.ts eligibleColumnFields (L55-72) excludes only LONG_FIELD_DENYLIST + {id,status,summary}; headline/title/question pass → the column picker offers them, and since summarize() picks headline??title??question??summary first, selecting that column duplicates the summary cell.
    FIX B: exclude the summary-source fields {headline,title,question} from eligibleColumnFields (add a SUMMARY_SOURCE_FIELDS exclusion set, or drop the field summarize() would pick). Add a unit test (none exists) asserting eligibleColumnFields omits headline.
    
    === FIX UNIT C — archived-head status badge (D5 low; DEPENDS ON T91) ===
    D5 (CONFIRMED H7): ArchivePointer/archive-group Milestone carry no status (only ResolvedMilestone does), so archived web heads can't render the T80 status badge. Planned task T91 (M21, under G2) already extends ArchivePointer with title+status at the @cq/ledger types + server-build boundary — supplying the DATA. D5 reduces to: (1) ensure that extension ALSO carries `status` across the MCP fetch_ledger WIRE boundary (the @cq/shared Zod mirror of archivePointers[]) — H7 found this wire half is NOT yet covered by T91's stated scope; (2) a RENDER task passing the archived pointer's status as milestoneStatus to the archived MilestoneSubsection (App.tsx:2002-2008) + a happy-dom assertion. FIX C is BLOCKED-BY / sequenced-after T91 (M21); coordinate so the types+wire extension lands once.
    
    Scope: code fixes in @cq/ledger (package.json, tsconfig, columns.ts), @cq/ledger-web (App.tsx, tsconfig), and the @cq/shared wire schema (for D5); + tests. Repo gate: `bun run check`. Pure-MCP-client invariant for the web changes. No new ledgers.
- grounding: |
    All four root causes confirmed during this investigate pass and validated against source by the orchestrator:
    - D3/H5: package.json:6-20 (main + exports targets); on-disk dist/index.js + dist/relationships.js MISSING, dist/src/* EXIST; tsconfig.json outDir ./dist + include [src,test] + no rootDir; ledger-web/tsconfig.json:11-16 paths mask it. ./columns already uses ./dist/src/columns.js.
    - D4/H6: columns.ts:35-47 (LONG_FIELD_DENYLIST), :55-72 (eligibleColumnFields); summarize() tui app.tsx:82-86 / web App.tsx:181-185; tui app.tsx:1200-1210 row render duplicates; picker mount app.tsx:1809. No columns.test.ts exists.
    - D5/H7: types.ts:155-162 (ArchivePointer {id,path,summary}), :97-104 (Milestone statusless), :116-121 (ResolvedMilestone has status); store/LedgerStore.ts:42-44 + core.ts:497; web App.tsx:1853 (active passes status) vs :2002-2008 (archived passes none), badge gated App.tsx:1659, comment App.tsx:1640. T91 (M21) is the data-extension dependency; the @cq/shared fetch_ledger wire Zod mirror of archivePointers[] is the un-covered half.
    - D6/H8: package.json:8-21 (no ./constants); index.ts:50 re-exports FsLedgerStore; FsLedgerStore.ts:29-30 node:fs/node:path; constants.ts:25-27 type-only import (browser-safe), :47 MILESTONES_SCHEMA; web App.tsx:69-82 duplicate; App.tsx:25/29 already use @cq/ledger/relationships + /columns leaf subpaths; serve.ts:55-59 Bun.build target browser.
    Fix A (D3+D6) share the package.json exports edit. Fix C (D5) sequences after T91 (M21). Tests: bun:test (ledger), happy-dom (web). Repo gate bun run check.
- tags: ["defect-seeded","defect:D3","defect:D4","defect:D5","defect:D6","packaging","out-of-scope-cleanup"]
- milestones: ["M24","M25","M26"]

## M27

### G6 — planned

- createdAt: 2026-06-02T19:51:45.748Z
- updatedAt: 2026-06-02T20:53:40.882Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- title: "Low-severity cleanup: D9 test flake, D10 store parity, D11 sticky filter bar"
- description: |
    DEFECT-SEEDED goal (linked defects:D9, D10, D11) — all three are small, well-understood fixes with confirmed/grounded root causes + suggestedFixes, so this goal enters `planning` directly and SKIPS clarifying (K8 pt4 / K12). plan-advance should produce reviewed FIX TASKS directly. The three are file-DISJOINT and parallel-safe.
    
    === FIX UNIT A — D9: ledger-tui HTTP-client test flake (low) ===
    GROUNDED: packages/ledger-tui/test/{mcpClient,displayName}.test.ts McpLedgerClient-over-HTTP tests intermittently fail with 'Unable to connect' under full-suite concurrency — a port-binding / connection-setup race (the client connects before the server confirms listening). NOT a product defect; test-harness flakiness. FIX: in the HTTP McpLedgerClient test harness, allocate an ephemeral port and WAIT for the server to confirm listening (readiness probe) before the client connects (or serialize those HTTP tests). Acceptance: the affected tests are deterministic under repeated full-suite runs (no connection-race); `bun run check` green across multiple runs.
    
    === FIX UNIT B — D10: InMemoryLedgerStore partial-mutation parity (low; test-hardening) ===
    GROUNDED: T91 already added the Phase-1b terminal guard to InMemoryLedgerStore.performArchive (behavior is FIXED — a non-terminal milestone-item now rejects BEFORE any Phase-2 mutation, matching FsLedgerStore). D10 is the remaining TEST-HARDENING + tracking item. FIX: add a dual-store abstract assertion (packages/ledger/test/store-abstract.ts) that after a non-terminal archiveMilestone REJECTION, the non-milestones ledger groups remain ATTACHED (no partial archive) — asserted in BOTH FsLedgerStore and InMemoryLedgerStore. Acceptance: the new abstract-suite assertion exists, runs against both adapters, and would FAIL against the pre-T91 InMemory behavior (reproduction); `bun run check` green.
    
    === FIX UNIT C — D11: sticky web filter/toolbar bar (low) ===
    GROUNDED: .lw-main (styles.css:274) is the scroll container (overflow:auto, padding 8px 12px); .lw-toolbar (styles.css:305) is normal-flow inside it, so it scrolls away. FIX: .lw-toolbar `position: sticky; top: 0;` + opaque background + z-index BELOW the column-selector popup (z-index:10); handle the .lw-main padding so items don't peek above the bar and the bar background spans the horizontal gutters. happy-dom assertion that the rule carries position:sticky (scroll behavior isn't observable under happy-dom). TUI unaffected.
    
    Scope: D9 = ledger-tui test harness; D10 = ledger store-abstract test (behavior already fixed by T91); D11 = ledger-web styles.css + a happy-dom test. All file-disjoint → parallel-safe. Repo gate: `bun run check`. No new ledgers; pure-MCP-client invariant for the web change.
    
    ## Follow-up (2026-06-02, #1) — D12: archived milestones missing from the milestones view
    === FIX UNIT D — D12: web milestones ledger shows NO archived milestones (medium; user-reported issues 1+2) ===
    GROUNDED + CONFIRMED (already-filed defect D12; no investigation needed): D7/T90 added `&& !isMilestones` to the ArchiveSubsections render gate (App.tsx ~L1193) to stop the milestones ledger showing an archived milestone TWICE (row + duplicate section). That correctly killed the duplication but OVER-CORRECTED: the milestones ledger now shows archived milestones NOT AT ALL (issue 2), so their titles never appear (issue 1). Archived milestones exist only as view.archivePointers for the milestones ledger (not live items); ArchiveSubsections was their only surfacing and it is now suppressed there. FIX (per D12.suggestedFix): when showArchive is on, the web milestones ledger lists each archived milestone ONCE as a ROW in the flat ItemTable (one per view.archivePointers entry), using the ArchivePointer `title` + `status` that T91 landed, marked with an archived badge (reuse .lw-archived-badge); ideally clicking the row opens the archived detail (lazy fetch_ledger_archive). Do NOT reintroduce the duplicate per-milestone SECTION (keep D7's !isMilestones gate on ArchiveSubsections) — the rows ARE the milestones-ledger representation of archived milestones. happy-dom test: milestones ledger + showArchive renders an archived milestone as a single row with its title + archived badge (no duplicate section). File: packages/ledger-web/src/App.tsx (+ test) — DISJOINT from D11 (styles.css) and the D9/D10 ledger fixes; parallel-safe. Depends on T91 (ArchivePointer title/status) which is already merged. (NOTE: issue 3 — TUI nav still ~500ms — is filed separately as D13 and routed to /investigate:start D13, NOT folded here, because its root cause is unknown and needs profiling.)
- grounding: |
    D9: packages/ledger-tui/test/mcpClient.test.ts + displayName.test.ts (HTTP McpLedgerClient); the server-bind vs client-connect race under bun's concurrent test execution. Fix in the test harness (ephemeral port + readiness wait), not product code.
    D10: T91 added InMemoryLedgerStore.performArchive Phase-1b guard (parity with FsLedgerStore); the dual-store abstract suite (packages/ledger/test/store-abstract.ts) asserts only the throw, not the no-partial-mutation post-state — add that assertion for both adapters.
    D11: styles.css .lw-main:274 (scroll container) / .lw-toolbar:305 (normal-flow, no sticky); .lw-column-popup:316 z-index:10 (sticky toolbar z-index must stay below it). Web only; TUI has no scroll-detached toolbar.
    D12 (REVISED per R95 — grounded against LIVE data): ArchivePointer (packages/ledger/src/types.ts:155-166) carries title+status, but those were added by T91 and are only populated AT ARCHIVE TIME going forward. CONFIRMED: docs/milestones.md `archives:` entries persist ONLY id/path/summary (no title/status) — verified for M2 (docs/milestones.md:10-12) — so all 23 pre-T91 pointers (M2..M26) reconstruct with title:"" status:"" via fetch_ledger. The titles+status ARE recoverable from the archive .md: docs/archive/milestones/M2.md:5 `title: TUI + web UI improvements`, header line 1 `### M2 — done` (status). Therefore D12 is NOT App.tsx-only: the read-side ArchivePointer materialisation (FsLedgerStore archive-pointer read / materialiseFetchedLedger) must backfill title+status for legacy pointers from the archive .md, AND App.tsx ItemTable (App.tsx:1687-1816) must be extended to render archived rows (it currently takes neither view.archivePointers nor showArchive nor a fetch handler; isMilestones branch is a flat <table> of Items at App.tsx:1747-1815 that does not map onto an ArchivePointer). The ledger-package fix shares packages/ledger with T106 (store-abstract.ts) — NO LONGER fully parallel-safe; sequence T108 after the ledger backfill task.
    Tests: bun:test (ledger), ink-testing-library (TUI), happy-dom (web). Gate bun run check.
- tags: ["defect-seeded","defect:D9","defect:D10","defect:D11","defect:D12","low-severity-cleanup"]
- milestones: ["M28"]
