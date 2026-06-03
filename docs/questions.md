---
ledger: questions
counters:
  milestone: 0
  item: 87
archives:
  - id: M2
    path: ./archive/questions/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: TUI + web UI improvements
    status: done
  - id: M14
    path: ./archive/questions/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/questions/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M15
    path: ./archive/questions/M15.md
    summary: "G3 coordination — COMPLETE (auto-archived by the new milestone-sweep rule, T129). Goal G3 (plan/implement flow-behavior changes: auto-investigate + never-auto-close-goals) done; work milestones M16/M17 archived; decisions K10/K12 (K12 supersedes K8 pt3); questions Q42-Q47 answered; reviews R31/R32."
    title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
    status: done
  - id: M1
    path: ./archive/questions/M1.md
    summary: G1 coordination — COMPLETE. Goal G1 (build the /implement:* command family) done; work milestones M3/M6/M7/M8/M9 archived; clarifying questions answered, reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: /implement:* command family"
    status: done
  - id: M10
    path: ./archive/questions/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/questions/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M33
    path: ./archive/questions/M33.md
    summary: "G6 #4A work milestone — COMPLETE. Formal defect-lifecycle states (open/wip/root-caused/inconclusive/resolved/wontfix) landed in @cq/ledger CANONICAL_LEDGERS + investigate/plan/implement flow prompts; live open-defect migration done; tasks + reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #4A — formal defect-lifecycle states (root-caused/inconclusive) across schema + flow prompts"
    status: done
---

# questions

## M11

### Q37 — answered

- createdAt: 2026-06-02T08:42:37.390Z
- updatedAt: 2026-06-02T11:26:11.572Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- question: "D2 does NOT reproduce from source — the requested auto-init already exists and works. To find the real root cause, what did you actually observe? Please provide: (a) the exact client error / how 'MCP connection fails' surfaced; (b) HOW the ledger MCP server was launched in that directory — from source (`bun … main.ts`), the Nix-built product (`nix build .#ledger-mcp`), or the globally plugin-registered (home-manager) binary [version skew is the prime suspect — see H3 / cf. D1]; (c) whether that directory even had a `.mcp.json` / plugin wiring the ledger server (no wiring = 'not configured', not a connection failure); (d) was it THIS repo or a different/empty project, and was the dir writable?"
- context: "Round 1 of investigation. H1 (server-startup registry-load throws) and H2 (FsLedgerStore construction/index-build throws) both adjudicated WRONG by orchestrator-verified citations + a live reproduction: FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:254-340), called by main() (packages/ledger-mcp/src/main.ts:337-344) BEFORE serving, mkdir's docs/ recursively, swallows ENOENT on the registry and each ledger file, writes EMPTY_REGISTRY, and bootstraps CANONICAL_LEDGERS. Reproduction: `bun packages/ledger-mcp/src/main.ts --cwd <fresh empty tmpdir>` printed 'serving stdio MCP', exited 0, and auto-created docs/ledgers.yaml + all canonical ledger files. So the source already does exactly what D2 requests. Remaining live hypothesis H3 (environmental: stale globally-registered/Nix binary version-skew like D1, or --cwd/.mcp.json wiring) needs your environment data to adjudicate. After answering, re-run /investigate:advance D2."
- suggestions: ["Most likely: the globally plugin-registered (home-manager/Nix) ledger-mcp binary is older than the source that has the auto-init — rebuild/refresh it (version skew, cf. D1) and retest","The directory had no .mcp.json wiring the ledger server (so it was never configured, not a 'connection failure')","A --cwd resolved to a non-existent or unwritable path","Something else — paste the actual error"]
- recommendation: Capture the exact failure + launch method; if it's the globally-registered binary, rebuild it and retest before we plan any code fix (source already auto-inits, so a code change may be unnecessary).
- ledgerRefs: ["defects:D2","hypothesis:H3"]
- answer: "User-provided actual error: `ledger-mcp: fatal: Bootstrap invariant violated: existing goals ledger has a different schema than its canonical bootstrap schema`. So the failure is NOT missing-init (the empty-dir auto-init works) — it is the BootstrapViolationError thrown by FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:283-289) when an EXISTING on-disk ledger's schema diverges from its CANONICAL_LEDGERS bootstrap schema (e.g. a stale/version-skewed binary vs an evolved docs/ledgers.yaml). Confirms the H3 environmental direction. Desired fix (user): on such a divergence, automatically BACK UP the old/divergent ledger files and set up fresh canonical ledgers, instead of aborting with a fatal error."

## M40

### Q74 — answered

- createdAt: 2026-06-03T11:36:57.788Z
- updatedAt: 2026-06-03T14:59:41.371Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: Which convenience surface(s) do you want built? (a) a single state-overview/snapshot MCP tool returning the actionable set in one call; (b) a generic compact/projection + pagination mode on fetch_ledger; (c) better tool/field/query-language descriptions only (docs); or some combination?
- context: These are the four candidate directions in the goal, and they are not mutually exclusive but they have very different cost/blast-radius. The repo today has 14 read tools but no cross-ledger snapshot, no projection, and the fts query help is already embedded in the tool description + server instructions. A snapshot tool (a) directly kills evidence #1/#4 (the ~13 bootstrap calls); a projection mode (b) directly kills evidence #2 (token overflow) and is reusable beyond /advance; docs (c) address evidence #3 and are nearly free. I can scope any subset.
- suggestions: ["All of a+b+c (snapshot tool + fetch_ledger projection/pagination + doc improvements) — covers every piece of evidence","a+c only (snapshot tool + docs) — the snapshot is /advance-shaped and can itself be compact, deferring a generic projection","b+c only (projection/pagination + docs) — generic, reusable building blocks; let agents compose predicates from compact reads","c only — documentation/recipes, no new endpoints"]
- recommendation: All of a+b+c. The snapshot tool removes the bootstrap round-trips, the projection mode is a small reusable fix for the token-overflow that also benefits the snapshot, and the doc improvements are cheap. The grounding shows columns.ts already provides LONG_FIELD_DENYLIST as the projection building block, so (b) is low-cost.
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q75 — answered

- createdAt: 2026-06-03T11:37:09.586Z
- updatedAt: 2026-06-03T15:00:05.091Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: If we build a state-overview/snapshot tool, what exactly should it return — and should it be generic or /advance-predicate-shaped? E.g. counts + item ids grouped by ledger×status; or a curated 'actionable set' (open/wip defects, movable-phase goals, DAG-ready tasks, open questions) shaped to the three /advance detection predicates?
- context: "Evidence #1/#4: deriving the three /advance predicates (P-investigate=actionable defects, P-plan=movable-phase goals, P-implement=DAG-ready tasks, + open-questions gate) took ~13 calls. A generic ledger×status grouping (with ids) is reusable by any agent/UI and stays decoupled from flow semantics; a predicate-shaped summary is maximally convenient for /advance but bakes flow knowledge (phase movability, DAG-readiness) into the ledger library, which currently has none. enumerate_ledgers already returns per-ledger counts but no status breakdown and no ids."
- suggestions: ["Generic: { ledger: { status: { count, ids[] } } } across all active ledgers — one call gives every predicate its raw inputs; agent composes the predicates","Generic + compact item stubs: same grouping but each entry is {id, status, summary} (headline/title/question) so the agent rarely needs a follow-up fetch","Predicate-shaped: an /advance-tailored payload (actionableDefects[], movableGoals[], readyTasks[], openQuestions[]) computing phase-movability and DAG-readiness server-side","Both: a generic grouping tool now, leave predicate logic in the flow prompts"]
- recommendation: "Generic + compact item stubs ({id,status,summary} grouped by ledger×status). It collapses the bootstrap to ~1 call, stays flow-agnostic (no DAG/phase semantics leaking into @cq/ledger), is reusable by the TUI/web and any future flow, and the {id,status,summary} stub avoids most follow-up fetches. DAG-readiness/phase-movability stay in the flow prompts where the flow vocabulary already lives."
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q76 — answered

- createdAt: 2026-06-03T11:37:19.433Z
- updatedAt: 2026-06-03T15:00:56.204Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: For the fetch_ledger token-overflow (evidence #2), do you prefer a compact PROJECTION mode (omit long narrative fields, return id+status+summary+short fields), PAGINATION (offset/limit chunks of full items), or BOTH? And should projection be a new parameter on fetch_ledger or a separate tool?
- context: "Evidence #2: goals=51.8KB and questions=142.7KB overflowed the tool-output token limit because fetch_ledger returns every item's full long fields. columns.ts already defines LONG_FIELD_DENYLIST (description/rationale/criticism/context/alternatives/evidence/completion/answer/rootCause/suggestedFix/fix) that the frontends use to render compact tables — a projection mode could reuse it directly. Projection fixes the common case (you rarely need every long field at once); pagination guarantees you can always page through full content; they compose. A new parameter keeps the tool count at 14; a separate tool keeps fetch_ledger's contract unchanged."
- suggestions: ["Projection only, as a `summary: true` (or `fields: 'compact'`) param on fetch_ledger reusing LONG_FIELD_DENYLIST — smallest change, kills the overflow for reads","Projection + pagination, both as params on fetch_ledger — compact by default-ish, page through full items when needed","Pagination only (offset/limit of full items) — no field model, but large items can still individually overflow","A separate compact-read tool, leaving fetch_ledger untouched"]
- recommendation: Projection as a param on fetch_ledger (reusing LONG_FIELD_DENYLIST), plus optional pagination on the same tool. Projection alone resolves the observed overflow with a single small reusable change; adding offset/limit makes the full-content path safe for any future growth. Keeping both as params on fetch_ledger avoids inflating the tool surface.
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q77 — answered

- createdAt: 2026-06-03T11:37:33.274Z
- updatedAt: 2026-06-03T15:01:28.635Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "For the fts status-filter confusion (evidence #3): before any documentation work, should we treat the observed-empty `(status:open OR status:wip)` result as a SUSPECTED DEFECT to reproduce-and-fix, or assume it was a usage/stale-index artifact and fix only the documentation?"
- context: "Grounding: the query evaluator should match an OR-of-qualifiers per item (an empty query node returns false, but a qualifier node is evaluated against each item). So `(status:open OR status:wip)` returning empty over a populated ledger is unexpected and may be a real defect in OR-of-qualifier evaluation or in how the inline `status:` qualifier interacts with the dedicated `status:` param (two distinct code paths). Per repo policy (reproduce-before-fix), if it is a defect we must write a failing test first. This determines whether G11 carries a fix task + a defects record, or is purely docs for evidence #3."
- suggestions: ["Reproduce first: add a failing test for `(status:open OR status:wip)`; if it confirms a defect, G11 includes a fix task + defects record; then document the corrected behaviour","Docs only: assume usage/stale-index artifact, just clarify the query language (status param vs inline qualifier, active-vs-archived, terminal semantics) at point of use","Out of scope: file any confirmed defect separately and keep G11 to convenience surfaces + docs"]
- recommendation: "Reproduce first. The behaviour is unexpected per the evaluator's design, and repo policy forbids shipping a doc 'explanation' for what may be a real OR-of-qualifier defect. A 10-line test settles it: if green, it was usage and we document; if red, we have a reproduced defect to fix within G11 (or file-and-defer)."
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q78 — answered

- createdAt: 2026-06-03T11:37:44.107Z
- updatedAt: 2026-06-03T15:02:21.795Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "For the archive/terminal footgun (evidence #5): which remedy do you want — (a) a reopen-terminal capability (move a terminal item back to a non-terminal status), (b) an un-archive capability (pull an archived item/group back out of ./archive), (c) a GUARD on the auto-archive sweep (e.g. don't sweep an item whose terminal status was set within N seconds, or require an explicit confirm), or (d) leave it out of G11 and track as a separate defect?"
- context: "Evidence #5: D22 was accidentally set `resolved`, the auto-archive sweep moved it to ./archive, and recovery required re-filing as D24. Grounding: terminal statuses have [] outgoing transitions in each schema's `transitions` map (so reopen needs either a new transition edge or a guard-bypassing store op), and archiveMilestone has NO inverse (un-archive needs a new store method to restore from ./archive/<ledger>/<id>.md). A sweep-guard prevents the accident; reopen/un-archive enable recovery after it. These address different points in the failure chain and can combine."
- suggestions: ["Reopen-terminal only: a store op (+ MCP tool) to move a terminal item back to a chosen non-terminal status; simplest recovery, no archive surgery","Un-archive only: restore an archived item/group back to active; recovers the already-archived case (the actual D22 situation)","Sweep-guard only: prevent the auto-archive sweep from acting on a freshly-set or erroneous terminal status (prevention, not recovery)","Reopen + un-archive (full recovery path), defer the sweep-guard","Out of scope for G11: file as a separate defect/improvement"]
- recommendation: Reopen-terminal + un-archive (the full recovery path), and defer the sweep-guard to a follow-up. Recovery primitives are general-purpose and directly undo the D22-class accident regardless of how it occurred; a sweep-guard is a heuristic that is easy to get wrong and only addresses one trigger. If you want minimum scope, pick un-archive only, since that matches the exact D22 situation (already archived).
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q79 — answered

- createdAt: 2026-06-03T11:37:58.135Z
- updatedAt: 2026-06-03T15:02:35.074Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "Where should the improved query-language / state-derivation documentation live, and who is the audience? Options: the MCP server `instructions` string (seen by every connecting agent), the per-tool descriptions (seen when the tool is invoked), the flow-command prompt files under llm/commands/** (seen by /advance et al.), the repo CLAUDE.md, or several of these?"
- context: "Evidence #3 is partly a docs problem. Grounding: QUERY_LANGUAGE_HELP is ALREADY embedded in both the fts_search tool description and the server instructions — so the gap is not 'undocumented' but 'the existing doc didn't make the status-param-vs-inline distinction and terminal/active semantics obvious at point of use'. The /advance bootstrap recipe (how to derive the predicates in few calls) is flow-specific and arguably belongs in the flow prompts, not the generic server instructions. Audience matters: server instructions reach ALL agents/projects using this MCP; flow prompts reach only this repo's flows."
- suggestions: ["Server instructions + per-tool descriptions only — fix the generic query-language doc (status param vs inline, active-vs-archived, terminal semantics) at point of use; keep it project-agnostic","Server/tool docs for the query language, PLUS a /advance bootstrap recipe in the flow-command prompts (llm/commands/**) referencing the new snapshot tool","All of the above plus a short note in repo CLAUDE.md","Flow prompts only — treat it as a /advance usage issue, leave the MCP docs as-is"]
- recommendation: Server instructions + per-tool descriptions for the GENERIC query-language clarifications (project-agnostic, reaches every agent), PLUS a short /advance bootstrap recipe in the flow-command prompts that points at whatever snapshot/projection surface we build. This puts each piece of documentation where its audience actually reads it and avoids leaking flow specifics into the generic MCP server.
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q80 — answered

- createdAt: 2026-06-03T11:38:06.197Z
- updatedAt: 2026-06-03T15:02:54.443Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "Any scope boundaries or constraints for G11 beyond 'pass bun run check'? Specifically: is it acceptable to GROW the MCP tool count beyond 14 (the surface is described as '14 tools' in code comments and tests), and must every new capability be exposed over MCP (so the TUI/web pure-MCP clients can use it), or are server-side-only store helpers acceptable for some pieces?"
- context: "Grounding: ledgerTools.ts and main.ts both hardcode/comment '14 tools', and LEDGER_TOOL_NAMES is a fixed list that tests assert against — adding a snapshot tool and/or un-archive/reopen tools bumps that count and touches those assertions. Project convention: frontends are pure MCP clients and never read docs/ directly, so any capability they need must be an MCP tool; but a pure store helper that only the snapshot tool consumes need not be its own tool. Knowing the tolerance for new tools vs. new params on existing tools shapes the whole plan (new tools vs. overloaded params)."
- suggestions: ["Growing the tool count is fine — add as many well-named tools as the design needs; update the '14 tools' comments/tests accordingly","Prefer minimal new tools — add params to existing tools (fetch_ledger projection, etc.) and only add a tool where no existing one fits (e.g. the snapshot, un-archive)","Keep the surface as small as possible — favour documentation + params over any new tool","No constraint beyond bun run check — use engineering judgment"]
- recommendation: "Prefer minimal new tools: add params to existing tools where they fit (fetch_ledger projection/pagination) and add a new tool only where no existing one fits (the cross-ledger snapshot; reopen/un-archive operations). Update the '14 tools' comments and LEDGER_TOOL_NAMES + their tests as part of the change. Every agent-facing capability must be an MCP tool (pure-client frontends); internal store helpers need not be."
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q81 — answered

- createdAt: 2026-06-03T13:59:10.291Z
- updatedAt: 2026-06-03T15:03:28.211Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "F1 (click-protection): which set of buttons gets the click-and-hold gate — (a) ALL state-mutating action buttons (every status-transition save PLUS the answer buttons: per-suggestion 'pick', 'as recommended', 'save & mark answered' in both the detail panel AND the BatchAnswerModal); (b) DESTRUCTIVE/irreversible-only (e.g. transitions INTO a terminal status, abandon/wontfix, and overwriting a stored answer) while ordinary saves stay single-click; or (c) a configurable subset?"
- context: "Grounding (packages/ledger-web/src/App.tsx): there are exactly these state-mutating action buttons today — (1) the DetailPanel 'save' button (status transition + field edits, driven by the controlled status <select>), (2) the BatchAnswerModal buttons data-testid 'batch-answer-submit' ('save & mark answered'), 'batch-answer-as-recommended' ('as recommended'), and per-suggestion 'batch-pick-suggestion-N' ('pick'), and (3) the analogous detail-panel answerBox buttons. The user's verbatim list ('transition buttons plus pick answer/as recommended/save answer') reads as ALL of them, but confirming scope (a vs b) sets how many call sites get the hold wrapper and whether the +item/+milestone create-save also counts. The 'show archived', filter selects, column toggles, and navigation are NOT state-mutating and are out of scope either way."
- suggestions: ["(a) ALL state-mutating action buttons — uniform: every save + every answer button (detail panel and batch modal) gets the hold gate; simplest mental model, no per-button policy","(b) Destructive/irreversible-only — gate transitions into terminal statuses, abandon/wontfix/withdraw, and answer-overwrite; leave forward/non-destructive saves single-click","(c) ALL state-transition + answer buttons EXCEPT pure field edits with no status change","Make it a per-button 'requireHold' prop so the policy is decided at each call site and trivially adjustable later"]
- recommendation: (a) ALL state-mutating action buttons. The user enumerated transition + pick + as-recommended + save-answer explicitly, which is the full action set; a uniform hold gate on every mutating button is the least surprising and avoids a brittle destructive/non-destructive classification that the schema does not currently express. Implement it as a single reusable HoldButton wrapping each call site (so a future policy split is a one-line change), defaulting every current mutating button to require-hold.
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q82 — answered

- createdAt: 2026-06-03T13:59:25.101Z
- updatedAt: 2026-06-03T15:03:58.177Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "F1 (hold UX details): confirm the interaction contract — (i) hold duration (~1s as proposed?); (ii) RELEASE-before-complete = cancel (action does NOT fire) and the progress bar resets; (iii) the keyboard/non-mouse accessible path (since hold-to-confirm is pointer-centric) — e.g. Enter/Space starts the hold while held down, or a focused button shows a separate confirm affordance; (iv) does the TUI (@cq/ledger-tui) need a PARALLEL confirm affordance for its analogous keybindings, or is click-protection WEB-ONLY this round?"
- context: "Grounding: ledger-web inputs are uncontrolled-via-ref and selects controlled specifically because happy-dom does not fire onChange for synthetic events on controlled text inputs (CLAUDE.md + App.tsx header comment) — a hold interaction driven by pointerdown/pointerup + a timer + a progress element must be DRIVABLE under happy-dom (the test harness), which can dispatch pointerdown/pointerup/keydown but advancing a real ~1s timer needs fake timers. The TUI (packages/ledger-tui) uses ink keybindings for the same transitions/answers (the user said 'web ui' specifically), so a TUI parallel is plausibly out of scope but should be confirmed rather than assumed. Keyboard accessibility matters because a pure pointer-hold strands keyboard-only users."
- suggestions: ["1000ms hold; release-before-complete cancels and resets the bar; keyboard path = press-and-hold Enter or Space on the focused button (keydown starts, keyup before threshold cancels); WEB-ONLY (no TUI change this round)","Same timing/cancel, but keyboard uses a two-step confirm (first activation arms, second within N s confirms) instead of held-key, since key-repeat semantics vary","Configurable duration (default 1000ms) exposed as a constant; cancel-on-release; web-only","Include a TUI parallel (a hold/confirm keybinding) so both clients are hardened symmetrically"]
- recommendation: 1000ms; release-before-complete cancels and resets; keyboard path = hold Enter/Space on the focused button (keydown arms + starts the progress, keyup before the threshold cancels), so the affordance is identical across input modalities; WEB-ONLY this round (the user said 'web ui'; a TUI confirm can be a separate follow-up goal if wanted). Drive it in tests with fake timers + dispatched pointer/key events. Expose the duration as a named constant (HOLD_MS) rather than a magic literal.
- ledgerRefs: ["goals:G11"]
- answer: as recommended, no need for this in tui.

### Q83 — answered

- createdAt: 2026-06-03T13:59:50.140Z
- updatedAt: 2026-06-03T15:05:56.199Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "F2 (handoffs ledger — status enum + idPrefix): confirm the full ALL-TERMINAL status set. Proposed: drained | answers-required | illness-detected. The /advance end-of-run categories are DRAINED / BLOCKED-ON-QUESTIONS / MIXED — do you want a status per category (so BLOCKED-ON-QUESTIONS→answers-required and MIXED→a 'mixed'/'progress-with-blocks' status), plus 'illness-detected' for an aborted/errored run? And which idPrefix (M/D/T/H/Q/K/G/R are taken — 'HO' or 'X' are free)?"
- context: "Grounding: every CANONICAL_LEDGERS schema (packages/ledger/src/constants.ts) is {statusValues, terminalStatuses, idPrefix, transitions, fields}; an all-terminal ledger has every status in terminalStatuses with empty transition arrays (REVIEWS_SCHEMA is the existing precedent — go-ahead|revise, both terminal, transitions {go-ahead:[], revise:[]}). idPrefixes M,D,T,H,Q,K,G,R are all in use, so handoffs needs a new one. The /advance report (llm/commands/advance.md) classifies a run as exactly one of DRAINED / BLOCKED-ON-QUESTIONS / MIXED — if a handoff item is written per stop, the status should encode that classification, and 'illness-detected' covers a stop that is neither (an error/abort the user flagged). The user said 'maybe smth else', so the enum is genuinely open."
- suggestions: ["drained | answers-required | illness-detected (3, verbatim) — map BLOCKED-ON-QUESTIONS→answers-required; fold MIXED into drained-or-answers-required by dominant reason; idPrefix 'HO'","drained | answers-required | mixed | illness-detected (4) — one status per /advance category PLUS illness; idPrefix 'HO'","drained | answers-required | illness-detected | aborted | failed (5) — separate a user-aborted run from an internal error; idPrefix 'X'","Keep status to the 3 proposed and carry the finer category (mixed/aborted/error) in an explanatory field, not the enum"]
- recommendation: "drained | answers-required | mixed | illness-detected (4 statuses, all terminal), idPrefix 'HO'. This maps 1:1 onto the /advance report categories (DRAINED→drained, BLOCKED-ON-QUESTIONS→answers-required, MIXED→mixed) so a handoff record IS the persisted run classification, plus 'illness-detected' for the user's explicit error/abort case. All-terminal mirrors REVIEWS_SCHEMA exactly. Avoid over-splitting (aborted/failed) until a flow actually needs to distinguish them — the explanation field carries the detail."
- ledgerRefs: ["goals:G11"]
- answer: "Mixed is annoying. I think \"drained | answers-required | mixed | illness-detected \" is okay, but we need a separate field explaining what exactly is mixed (e.g. handoff-reasons: [drained, answers-required]"

### Q84 — answered

- createdAt: 2026-06-03T14:00:04.747Z
- updatedAt: 2026-06-03T15:06:09.736Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "F2 (handoffs ledger — item shape + fields): besides the intrinsic status(=reason), what fields should a handoff item carry? Proposed: a required 'summary'/'explanation' (the human-readable why), the COMMON_REF_FIELDS (ledgerRefs to the goals/defects/questions/tasks that caused the stop, plus tags/sourceRefs), and — since handoffs are run records — possibly an explicit 'flow' field (which command stopped: advance/plan/implement/investigate) and a 'blockingQuestions' id[] (the open questions enumerated in a BLOCKED-ON-QUESTIONS report). Append-only history (no edits after creation)?"
- context: "Grounding: COMMON_REF_FIELDS (sourceRefs/blockedBy/dependsOn/ledgerRefs/tags/suggestedModel) is spread into defects/tasks/hypothesis/questions/decisions; REVIEWS_SCHEMA instead carries a bespoke subset (summary/new_questions/criticism/ledgerRefs/tags/sourceRefs) — so there is precedent for a tailored field set on a record-style ledger. The /advance BLOCKED-ON-QUESTIONS report already enumerates each blocking question by id with its owning item (defects:<D>/goals:<G>/tasks:<id>) — that maps directly to ledgerRefs + an optional blockingQuestions id[]. The intrinsic author/session fields already record WHO wrote the item and the session, so a separate 'session' schema field may be redundant. Each item also has intrinsic createdAt, giving append-only history for free if items are never updated."
- suggestions: ["summary (required) + ledgerRefs + tags + sourceRefs (reuse the REVIEWS-style subset); rely on intrinsic author/session/createdAt for provenance + ordering; append-only","Above PLUS a 'flow' string (advance|plan|implement|investigate) and a 'blockingQuestions' id[] mirroring the BLOCKED-ON-QUESTIONS enumeration","Full COMMON_REF_FIELDS + summary + flow + blockingQuestions — maximally linkable","summary + ledgerRefs only — minimal; everything else lives in the prose summary"]
- recommendation: "summary (required) + flow (string: advance|plan|implement|investigate) + ledgerRefs (id[], the stop-causing items) + blockingQuestions (id[], for answers-required/mixed stops) + tags + sourceRefs; rely on intrinsic author/session/createdAt (no redundant schema 'session' field); treat handoffs as APPEND-ONLY (write once at each stop, never update). 'flow' makes the record queryable by which command stopped, and 'blockingQuestions' makes a BLOCKED-ON-QUESTIONS handoff directly actionable (the user can navigate to the exact open questions). This stays close to the REVIEWS precedent rather than inventing a wholly new field vocabulary."
- ledgerRefs: ["goals:G11"]
- answer: ""

### Q85 — answered

- createdAt: 2026-06-03T14:00:24.016Z
- updatedAt: 2026-06-03T15:06:37.079Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "F2 (who writes handoffs, and at which stop points): WHICH flows record a handoff, and does writing one VIOLATE the current read-only invariant of /advance? Today llm/commands/advance.md explicitly makes NO ledger writes of its own ('every write is performed by a chained sub-command'). A handoff record at the /advance stop would be a NEW write by the top-level sequencer. Do you want: (a) ONLY /advance writes a handoff at its end-of-run classification (accepting that /advance gains one write, narrowly scoped to the handoffs ledger); (b) EACH flow (plan/implement/investigate) also writes a handoff when ITS own loop stops; or (c) only /advance, and the per-flow commands stay silent?"
- context: "Grounding: advance.md §Provenance: 'This command makes NO ledger writes of its own (read-only detection only).' Adding a handoff write changes that invariant for exactly one ledger. The per-flow advance commands (plan/implement/investigate) DO write (they own all mutations), so they could each emit a handoff at their stop without breaking any invariant — but that risks duplicate/overlapping handoffs when /advance chains them (each sub-flow stop PLUS the /advance stop). The natural single-writer is /advance (it owns the DRAINED/BLOCKED/MIXED classification); the natural multi-writer story is 'every flow logs why it stopped' (richer audit, but needs a rule to avoid double-recording within a chained run)."
- suggestions: ["(a) ONLY /advance writes one handoff at end-of-run (its DRAINED/BLOCKED-ON-QUESTIONS/MIXED classification); update advance.md §Provenance to permit this single handoffs write; per-flow commands stay silent","(b) EACH flow writes a handoff when run STANDALONE; when chained under /advance, the SUB-flow suppresses its handoff and only /advance writes the run-level one (avoids duplicates)","(c) Every flow ALWAYS writes its own handoff at every stop (full per-stop audit trail), accepting multiple handoffs per /advance run","(d) Defer: build the handoffs ledger + schema now, wire the WRITERS in a follow-up once the schema is agreed"]
- recommendation: "(b): each per-flow command writes a handoff when invoked STANDALONE, but when chained under /advance the sub-flow suppresses its own handoff and /advance writes the single run-level record carrying its DRAINED/BLOCKED/MIXED classification. This gives one authoritative handoff per top-level run (no duplicates) while still recording a stop when a flow is run on its own. It does require amending advance.md's read-only §Provenance note to allow exactly the handoffs write — call that out explicitly in the plan. If you prefer to keep /advance strictly read-only, pick (a)-with-no-/advance-write is not possible (then nothing records the run-level stop), so (a) as written (allow the one write) is the fallback."
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q86 — answered

- createdAt: 2026-06-03T14:00:39.972Z
- updatedAt: 2026-06-03T15:07:03.286Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "F3 (session-log link field — which ledgers + field name/type): the field links an item to its docs/logs/<timestamp>-<agent-id>.md session log(s). WHICH ledgers get it? Candidates: tasks (the implement worker writes a log per task), reviews (the reviewer logs its round), defects/hypothesis (investigate explorers log per round), goals (the planner logs per planning round), and the NEW handoffs ledger. Field NAME + TYPE: 'sessionLogs' as string[] of repo-relative log PATHS, or 'logRefs' as string[] of agent-ids, or fold into the existing 'sourceRefs' string[] that several schemas already carry?"
- context: "Grounding: each flow already writes per-subagent logs to docs/logs/<timestamp>-<agent-id>.md (advance.md §Session logs: 'Each chained sub-command logs ITS subagents to docs/logs/ per that command's own §Session logs rule'). COMMON_REF_FIELDS already includes 'sourceRefs: string[]' on defects/tasks/hypothesis/questions/decisions — a path-typed log link could either reuse sourceRefs (no schema change, but mixes provenance kinds) or be a dedicated field added to COMMON_REF_FIELDS (one edit propagates to all ledgers that spread it) plus REVIEWS_SCHEMA and the new handoffs schema (which carry bespoke field sets). The user said 'everywhere where it makes sense' — the work-producing ledgers (tasks/reviews/defects/hypothesis/goals/handoffs) are where a session log exists; questions/decisions are user/record artifacts that may not have one."
- suggestions: ["Add 'sessionLogs: string[]' (repo-relative paths) to COMMON_REF_FIELDS (propagates to defects/tasks/hypothesis/questions/decisions) PLUS REVIEWS_SCHEMA + handoffs + GOALS_SCHEMA — every ledger gets it uniformly","Add 'sessionLogs: string[]' only to the WORK-producing ledgers (tasks, reviews, defects, hypothesis, goals, handoffs); leave questions/decisions without it","Reuse the existing 'sourceRefs: string[]' for log paths (no schema change) with a path convention, documented in the field description","Add 'logRefs: string[]' carrying agent-IDs (not paths), resolved to files by convention <timestamp>-<agent-id>.md"]
- recommendation: "Add a dedicated 'sessionLogs: string[]' of repo-relative log PATHS (e.g. docs/logs/2026-...-<agent-id>.md) to the WORK-producing ledgers only: tasks, reviews, defects, hypothesis, goals, and the new handoffs schema; leave questions and decisions without it (they are user/record artifacts with no owning session log). Paths over agent-ids so the link resolves without re-deriving the filename. A dedicated field over reusing sourceRefs keeps log-provenance distinct from other source references and lets the TUI/web render it as a distinct 'logs' relationship. Adding it to COMMON_REF_FIELDS would also hit questions/decisions — acceptable if you prefer uniformity, but the work-producing subset matches 'where it makes sense'."
- ledgerRefs: ["goals:G11"]
- answer: as recommended

### Q87 — answered

- createdAt: 2026-06-03T14:00:59.356Z
- updatedAt: 2026-06-03T15:07:56.667Z
- author: user
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- question: "F3 (who populates sessionLogs, and should the TUI/web RENDER it): WHO writes the link and WHEN — the orchestrator/command that writes the docs/logs/<ts>-<agent-id>.md file (it already knows the agent-id↔item mapping), populating sessionLogs as part of the same update that sets the item terminal? And must the frontends render it — as a clickable link / relationship panel (like the existing fix-tasks and hypothesis-tree panels), or is it a plain display field this round?"
- context: "Grounding: the flow commands write the session log AND own the item mutations (e.g. implement worker marks its task done; planner advances the goal), so they are the natural populators — the link would be set in the same update_item that records the work outcome. Frontends are PURE MCP clients (CLAUDE.md): App.tsx already renders cross-ledger relationship panels for defects↔fix-tasks and hypothesis trees (defectFixTaskIds/hypothesisRelationships from @cq/ledger/relationships) and shows ordered short/long fields; a sessionLogs field would render as a plain list unless given dedicated treatment. Logs live on the FILESYSTEM under docs/logs/, not in the ledger, so a web 'open log' action would need a way to read the file — which the pure-MCP-client web app has no tool for today (it never reads docs/ directly). That constrains whether 'clickable' is even feasible this round."
- suggestions: ["Populated by the writing command in the same update_item that records the outcome; frontends render sessionLogs as a PLAIN display field (list of paths) — no file-opening, respecting the pure-MCP-client boundary","Same population; TUI/web render it as a labeled 'logs' section but paths are non-clickable text (no MCP tool reads files)","Populated by the writing command; ADD an MCP tool to fetch a log file's contents so the web can open it in-app — larger scope, crosses the 'frontends never read docs/ directly' line via a proper MCP read tool","Populate now, defer ALL frontend rendering to a follow-up"]
- recommendation: "Populated by the command that writes the log, in the SAME update_item that records the work outcome (it holds the agent-id↔item mapping); frontends render sessionLogs as a PLAIN display field (a labeled list of paths) this round, NON-clickable. Opening a log in-app would require a new MCP read-file tool (the web app cannot read docs/ directly per the pure-client rule) — that is worth a separate decision and should NOT be bundled into F3. So: link + display now; in-app log viewer deferred unless you want it scoped in."
- ledgerRefs: ["goals:G11"]
- answer: "as recommended but: let's make them clickable and show popups rendering the content of the logs"
