---
ledger: goals
counters:
  milestone: 0
  item: 8
archives:
  - id: M15
    path: ./archive/goals/M15.md
    summary: "G3 coordination — COMPLETE (auto-archived by the new milestone-sweep rule, T129). Goal G3 (plan/implement flow-behavior changes: auto-investigate + never-auto-close-goals) done; work milestones M16/M17 archived; decisions K10/K12 (K12 supersedes K8 pt3); questions Q42-Q47 answered; reviews R31/R32."
    title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
    status: done
  - id: M20
    path: ./archive/goals/M20.md
    summary: G4 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G4 (D2 backup-and-reinit on schema divergence) done; work milestone M22 archived; decision K15; reviews R75/R76. D2 resolved.
    title: "Plan: fix D2 — graceful backup-and-reinit on ledger schema divergence"
    status: done
  - id: M23
    path: ./archive/goals/M23.md
    summary: G5 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G5 (@cq/ledger packaging + UI-eligibility defects D3-D6) done; work milestones M24/M25/M26 archived; decision K16; reviews R77/R78. D3-D6 resolved.
    title: "Plan: @cq/ledger packaging + UI-eligibility defect cleanup (D3-D6)"
    status: done
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

## M27

### G6 — planned

- createdAt: 2026-06-02T19:51:45.748Z
- updatedAt: 2026-06-03T00:56:21.226Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- title: "Low-severity cleanup: D9 test flake, D10 store parity, D11 sticky filter bar"
- description: |
    DEFECT-SEEDED goal (originally D9/D10/D11/D12, ALL RESOLVED: D9→T105, D10→T106, D11→T107, D12→T108+T109; decisions K17+K18; work milestone M28). This goal has since accumulated greenfield FLOW/TOOLING follow-ups (the original cleanup is done; see git history + resolved defects D9–D12 for the original text).
    
    ## Follow-up (2026-06-02, #2) — universal /advance command + subagent parallelism bump
    2) UNIVERSAL /advance COMMAND combining investigate:advance → plan:advance → implement:advance (check-investigate / check-plan / check-implement; explain when nothing to do). Wire into scripts/link-prompts.ts + .codex/prompts. (Clarifying Q55–Q60, ANSWERED.)
    3) SUBAGENT PARALLELISM: raise the implement-flow concurrent-worker cap N=4→8 (implement/advance.md:36 + any restatement). (Covered by Q60.)
    
    ## Follow-up (2026-06-02, #3) — ledger archive-and-reset command
    Greenfield `ledger-reset` / `ledger-mcp --reset` tooling (archive + reset ledgers; relationship to the G4/T94 backupAndReinit helper). (Clarifying Q61–Q65, pending answers.) Three defects were also filed this round (NOT goal scope): D16 (archived titles in non-milestones views — RESOLVED via T110), D17 (archived badge in id column — RESOLVED via T113), D18 (batch modal pick buttons — RESOLVED via T114). [All of D14–D19 were subsequently fixed under the defect-seeded goal G7 / M30.]
    
    ## Follow-up (2026-06-03, #4) — formal defect-lifecycle states + auto-close/archive completed milestones
    Two greenfield PROCESS/SCHEMA + prompt-suite improvements (folded into G6 per explicit user direction):
    
    A) FORMAL DEFECT-LIFECYCLE STATES (verbatim): 'there is an important defect lifecycle part which is not formal enough: you use rootCause field to add UNKNOWN | CONFIRMED markers. Probably we need to introduce additional states to mark successfully investigated and unclear defects. So, smth like open -> wip -> investigated|unclear -> ... - we will need to carefully review the code and the prompts so these new states would be used everywhere instead of textual markers. I'm not sure if investigated|unclear is the best naming, feel free to propose yours.'
    PROBLEM (self-observed this session): the investigate/plan flows encode root-cause status as FREE TEXT in defects.rootCause ('UNKNOWN' / 'CONFIRMED' / 'GROUNDED'), which is informal, inconsistent, and unqueryable — the worklist/file-and-defer logic should key off a real STATUS, not prose. Formalize as explicit defects-ledger status values. Candidate machine (planner to refine + LOCK final names): open -> wip (under investigation) -> { root-caused (cause confirmed, ready to seed a fix) | inconclusive (investigated, cause not pinned — parked / needs more) } -> resolved | wontfix; inconclusive should be re-openable to wip. (User's working names: investigated|unclear; orchestrator counter-proposal: root-caused|inconclusive — decide in clarifying.) CLARIFY: exact state set + final names + transitions (which are terminal); the mapping from today's textual markers; whether 'root-caused' becomes the PRECONDITION/gate for the investigate file-and-defer seeding (replacing the 'confirmed root cause' prose check) and for the plan auto-investigate worklist/stop-predicates (K12 a–f currently say 'confirmed node'); migration of existing OPEN defects (e.g. D13, D20) to the new states; and the FULL touch-point set so the states are used EVERYWHERE instead of text — (i) the defects ledger schema in @cq/ledger CANONICAL_LEDGERS (statusValues/terminalStatuses/transitions) + any code reading/writing defect status (+ baboon/model-version rules if the defects schema is versioned, + the TUI/web status→bucket color maps); (ii) llm/commands/investigate/advance.md (adjudication writes the new state instead of rootCause text); (iii) llm/commands/plan/advance.md + llm/agents/plan-advance.md (auto-investigate worklist + file-and-defer + stop predicates key off the state); (iv) llm/commands/implement/advance.md (reviewer-filed defects). Repo gate bun run check.
    
    B) AUTO-CLOSE + ARCHIVE COMPLETED MILESTONES (verbatim): 'some of the milestones remained open (e.g. M10, M11, M15) - only M1 is done (I did it manually). Unlike goals, it's fine to close and archive completed milestones automatically! Probably we might need to harden the prompts?'
    OBSERVED GAP: COORDINATION milestones (M10/M11/M15/M20/M23, and the just-finished M27/M29) stay `open` after all their items reach terminal, because the flows only archive WORK milestones at the end of an implement run — nothing sweeps the coordination milestones (which hold the goal + questions + reviews + decisions) once their goal is done / their items terminal. Per the never-auto-close-GOALS invariant (G3-B / M16), milestones are EXEMPT and SHOULD auto-close (set status done) + archive when all their items are terminal. CLARIFY: where the sweep lives (a step in implement/advance milestone-completion that ALSO closes+archives the goal's coordination milestone once the goal is terminal? a dedicated sweep in the new /advance? every flow's completion?); the predicate (ALL items under the milestone terminal → set milestone status done → archive_milestone); make the goal-vs-milestone asymmetry EXPLICIT in the prompts (goals NEVER auto-close; milestones ALWAYS may once their items are terminal); the guard that a coordination milestone whose GOAL is still non-terminal must NOT be archived even if its current items are terminal (new follow-up scope may add items — cf. THIS goal G6, whose M27 must stay open while G6 is active); and a one-shot cleanup of the already-open completed milestones (M10/M11/M15/M20/M23/M27?/M29 ...) once the rule lands. Harden the relevant prompt(s). Repo gate bun run check.
- grounding: |
    Follow-up #2/#3 grounding retained (N=4 cap at implement/advance.md:36; /advance wires into scripts/link-prompts.ts LINKS + .codex/prompts; ledger-reset relates to G4/T94 backupAndReinit).
    
    Follow-up #4 grounding:
    A) defect-status-as-text smell observed directly this session — rootCause carried 'UNKNOWN'/'CONFIRMED'/'GROUNDED' prose; the plan auto-investigate worklist + stop predicates (K12 a-f) and investigate file-and-defer currently reason over that prose / a 'confirmed root cause' check rather than a queryable status. The defects ledger schema lives in @cq/ledger CANONICAL_LEDGERS (statusValues/terminalStatuses/transitions) + investigate/plan/implement prompts; TUI+web status->bucket color maps must extend.
    B) milestone-completion is handled in implement/advance.md (archive_milestone once all items terminal) but ONLY for work milestones at end-of-run; coordination milestones never swept.
    
    VERIFIED THIS SESSION (planner ground pass, 2026-06-03):
    - @cq/ledger DEFECTS_SCHEMA (packages/ledger/src/constants.ts:102-126) CURRENTLY = statusValues [open, wip, blocked, resolved, abandoned], terminalStatuses [resolved, abandoned], transitions open->{wip,blocked,resolved,abandoned} / wip->{blocked,resolved,abandoned} / blocked->{open,wip,resolved,abandoned}. This DIFFERS from Q66's preamble ('open/wip/resolved/wontfix'). The LOCKED target (Q66/Q67) = statusValues [open, wip, root-caused, inconclusive, resolved, wontfix], terminal [resolved, wontfix]. So the schema edit must: ADD root-caused+inconclusive, RENAME/REPLACE abandoned->wontfix, DROP blocked, and install Q67's transition map. Implementer MUST grep live docs/defects.md for any defect currently in status 'blocked' or 'abandoned' and migrate it (no live ones expected; D13/D20 are open). Field rootCause STAYS (free-text narrative, markers removed) per Q68.
    - backupAndReinit is a PRIVATE method on FsLedgerStore (packages/ledger/src/store/FsLedgerStore.ts:694) currently only called from init()'s schema-divergence branch BEFORE the in-memory load. It does (a) timestamped docs/.backup/<sanitized-ISO>/ mkdir, (b) copy registry + each CANONICAL_LEDGERS file, (c) rewrite fresh canonical registry+files, (d) stderr WARNING. The --reset wrapper must EXPOSE it (make public or add a thin public reset()) and call it on a freshly-constructed store before serving, then exit. It reuses CANONICAL_LEDGERS so the new defect-status set lands automatically post-reset.
    - ledger-mcp entrypoint: packages/ledger-mcp/src/main.ts — parseArgs(argv) (line 109) parses --cwd/--http; main(argv) (line 361) constructs FsLedgerStore + init + serve. --reset is a new parseArgs branch + a short-circuit in main() that runs reset then returns (no server). Confirmation: TTY y/N prompt via process.stdin.isTTY + --yes skip (Q64).
    - /advance is a NEW top-level command at llm/commands/advance.md (NO namespace); wire into scripts/link-prompts.ts LINKS (.claude/commands/advance.md) + .codex/prompts mirror (link-prompts.ts only materialises .claude links; .codex/prompts/*.md symlinks are committed separately — implementer must add the committed .codex/prompts/advance.md symlink too). Verified link-prompts.ts LINKS array at scripts/link-prompts.ts:29-43.
    - Only explicit 'N = 4' concurrency cap confirmed at implement/advance.md (Concurrency rule). Implementer must grep implement/start.md + investigate/* + plan/* for any other numeric cap and bump only those that exist (Q60).
- tags: ["defect-seeded","defect:D9","defect:D10","defect:D11","defect:D12","low-severity-cleanup"]
- milestones: ["M28","M33","M31","M32"]

## M29

### G7 — planned

- createdAt: 2026-06-02T22:48:48.534Z
- updatedAt: 2026-06-02T23:00:13.233Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- title: Fix confirmed dogfood UI/store defects (D14-D19)
- description: |
    DEFECT-SEEDED goal (linked defects:D14, D15, D16, D17, D18, D19) — all root causes are already CONFIRMED/grounded against source (no further investigation needed), so this goal enters `planning` directly and SKIPS clarifying (K8 pt4 / K12). Seeded by /advance's investigate phase (file-and-defer convergence on already-confirmed defects). plan-advance should produce reviewed FIX TASKS directly, one per defect (or grouped by file where they collide). NOTE D13 (TUI ~500ms nav perf) is NOT included — its root cause is UNKNOWN and needs runtime profiling (a dedicated /investigate round), not a confirmed fix.
    
    === FIX UNIT A — D16 (medium): non-milestones archived views show no titles ===
    T109's backfillLegacyArchivePointers is gated `if (isMilestones)` (packages/ledger/src/store/FsLedgerStore.ts:402), so only the milestones ledger's archivePointers get titles; tasks/defects/etc. keep empty titles → ArchiveSubsections heads (label = pointer.title, T91/D8) render title-less. FIX: run the backfill for EVERY loaded ledger (drop the isMilestones gate). Reproduction-first test: fetch('tasks').archivePointers carry non-empty titles after init against a legacy (no-inline-title) fixture; fails pre-fix. packages/ledger (+ test). NOTE shares packages/ledger with no other fix here — but is the only ledger-package change.
    
    === FIX UNIT B — D17 (low): archived badge wraps the id column ===
    T108's archived ROW renders <span className="lw-archived-badge"> in the id cell (packages/ledger-web/src/App.tsx:1862) → wraps 'M13' + badge. FIX: remove the archived badge from the id cell of the milestones-ledger archived rows (or relocate/ nowrap). Update milestonesArchivedRows.test.tsx. File: App.tsx (+ test).
    
    === FIX UNIT C — D18 (medium): batch modal missing per-suggestion pick buttons ===
    The detail answer view has per-suggestion pick (App.tsx:2438, lw-pick-suggestion); the BatchAnswerModal (~1392-1475) renders suggestions as a plain <dd> with only 'as recommended'. FIX: add per-suggestion pick buttons to the batch modal (answerWith(item)), gated by the same #15 disable-when-answer-non-empty rule. File: App.tsx (+ test).
    
    === FIX UNIT D — D19 (medium): batch modal doesn't close after the last answer ===
    batchSave (App.tsx:543) advances setBatchIndex(Math.min(batchRows.length-1, i+1)) and never closes; batchRows is an open-time snapshot, so the last index clamps in place. FIX: in batchSave, when the last remaining open question is answered (or recompute the open set post-save and it is empty), call setBatchOpen(false) instead of clamping. happy-dom test: a 1-question batch closes after 'save & mark answered' and after 'as recommended'. File: App.tsx (+ test).
    
    FIX UNITS B/C/D ALL TOUCH packages/ledger-web/src/App.tsx — NOT parallel-safe with each other; serialize or co-assign to ONE worker. Fix Unit A (D16) is packages/ledger (disjoint). 
    
    === FIX UNIT E — D14 (low): freePort bind-then-close TOCTOU ===
    test/portHelpers.ts freePort() binds :0, reads the port, then close()s before returning — a TOCTOU window. FIX: harden (retry-on-EADDRINUSE on server spawn, or keep the listener open and hand off the fd) and update pty.e2e + the HTTP tests. ledger-tui test harness only. Disjoint.
    
    === FIX UNIT F — D15 (medium): ledger-tui live-badge test flake ===
    packages/ledger-tui/test/app.test.tsx ~593-612 ('live badge') races a FakeWS push + await tick(60) against the refetch+render. FIX: replace the fixed tick(60) with a bounded poll/wait-for predicate re-checking r.lastFrame() until it contains 'pushed-tui'. ledger-tui test only. Disjoint. (Pre-existing flake; gates clean `bun run check`.)
    
    Scope: packages/ledger (D16), packages/ledger-web/src/App.tsx (D17/D18/D19 — serialize), packages/ledger-tui/test (D14, D15) + tests. Repo gate: `bun run check`. Pure-MCP-client invariant for the web changes. No new ledgers.
- grounding: "All six root causes confirmed/grounded against live source during G6 dogfooding (see the defect records D14-D19 for full detail + line citations). D16: FsLedgerStore.ts:402 isMilestones gate (probe: fetch('tasks') 19/20 empty titles, fetch('defects') 3/4, fetch('milestones') 0/20). D17: App.tsx:1862 lw-archived-badge in archived-row id cell. D18: App.tsx:2438 (detail pick) vs BatchAnswerModal ~1392-1475 (no per-suggestion pick). D19: App.tsx:543 batchSave advances index, never closes; batchRows snapshot at App.tsx:520. D14: test/portHelpers.ts freePort bind-then-close. D15: app.test.tsx ~593-612 tick(60) race. File-collision: D17/D18/D19 all edit App.tsx (serialize); D16 = packages/ledger; D14/D15 = ledger-tui test. Tests: bun:test (ledger), ink-testing-library (TUI), happy-dom (web). Gate bun run check."
- tags: ["defect-seeded","defect:D14","defect:D15","defect:D16","defect:D17","defect:D18","defect:D19","dogfood-cleanup"]
- milestones: ["M30"]
