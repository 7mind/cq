---
ledger: tasks
counters:
  milestone: 0
  item: 129
archives:
  - id: M5
    path: ./archive/tasks/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
    title: ""
    status: ""
  - id: M2
    path: ./archive/tasks/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: ""
    status: ""
  - id: M3
    path: ./archive/tasks/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
    title: ""
    status: ""
  - id: M4
    path: ./archive/tasks/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
    title: ""
    status: ""
  - id: M6
    path: ./archive/tasks/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
    title: ""
    status: ""
  - id: M7
    path: ./archive/tasks/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
    title: ""
    status: ""
  - id: M8
    path: ./archive/tasks/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
    title: ""
    status: ""
  - id: M9
    path: ./archive/tasks/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
    title: ""
    status: ""
  - id: M12
    path: ./archive/tasks/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
    title: ""
    status: ""
  - id: M13
    path: ./archive/tasks/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
    title: ""
    status: ""
  - id: M16
    path: ./archive/tasks/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
    title: ""
    status: ""
  - id: M17
    path: ./archive/tasks/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
    title: ""
    status: ""
  - id: M19
    path: ./archive/tasks/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
    title: ""
    status: ""
  - id: M14
    path: ./archive/tasks/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: ""
    status: ""
  - id: M18
    path: ./archive/tasks/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: ""
    status: ""
  - id: M22
    path: ./archive/tasks/M22.md
    summary: G4-W D2 backup-and-reinit — COMPLETE. T94 backupAndReinit helper (timestamped docs/.backup/, ENOENT-tolerant, fresh canonical + WARNING); T95 init() !schemasEqual branch → backup-and-reinit by default + onSchemaDivergence:'abort' opt-out; T96 tests (divergence/abort/no-divergence/empty-dir) + abort-suite migration; T97 repo gate. Defect D2 RESOLVED. Reviews R80/R85/R89/R91. Shipped on main; check 661.
    title: ""
    status: ""
  - id: M24
    path: ./archive/tasks/M24.md
    summary: G5 Fix Unit A @cq/ledger packaging — COMPLETE. T98 realigned package.json main+exports → ./dist/src/* (consistent w/ ./columns); T99 browser-safe ./constants subpath export + web tsconfig paths; T100 App.tsx consumes @cq/ledger/constants, deletes MILESTONE_STATUS_SCHEMA dup; T101 package-exports.test.ts (asserts all export targets exist post-build). Defects D3 + D6 RESOLVED. Reviews R81/R86/R87/R88. Shipped on main.
    title: ""
    status: ""
  - id: M25
    path: ./archive/tasks/M25.md
    summary: G5 Fix Unit B column eligibility — COMPLETE. T102 added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields (grounded in summarize() precedence) + first columns.test.ts; suggestedModel still eligible. Defect D4 RESOLVED. Review R82. Shipped on main.
    title: ""
    status: ""
  - id: M26
    path: ./archive/tasks/M26.md
    summary: "G5 Fix Unit C archived-head status badge — COMPLETE. T104 passes archived pointer status as milestoneStatus to the archived MilestoneSubsection (empty-status guarded) → T80 badge renders for archived heads; happy-dom test. T103 withdrawn (R77: no @cq/shared wire mirror — T91's ArchivePointer.status flows over the wire as-is). Defect D5 RESOLVED. Review R92. Shipped on main; check 661."
    title: ""
    status: ""
  - id: M21
    path: ./archive/tasks/M21.md
    summary: "G2 follow-up #4 (items 16-19) — COMPLETE. T90 (!isMilestones gate, D7); T91 (ArchivePointer title+status extension, D8, lands status for D5); T92 (retire /investigate:start routing-questions per K13, item 18); T93 (batch-answer modal wider/taller/smaller-font/scrolls, item 19). Defects D7/D8 resolved; out-of-scope D9/D10 surfaced here, resolved via G6/M28 (T105/T106). Reviews R79/R83/R84/R90. Last G2 work milestone."
    title: "G2 follow-up #4: milestones-ledger archived rendering, routing-question retirement, batch-modal sizing"
    status: done
  - id: M30
    path: ./archive/tasks/M30.md
    summary: "G7 fixes COMPLETE — six confirmed dogfood defects fixed + merged. T110 (D16: backfill non-milestones archive-pointer titles from docs/archive/milestones/<id>.md by id; 48f4e93). T111 (D14: spawnWithFreePort retry-on-EADDRINUSE closes the bind-then-close TOCTOU; 6e223bb). T112 (D15: bounded wait-for de-flakes the live-badge test; 40385f6). T113 (D17: removed archived badge from row id cell; 1dec462). T114 (D18: per-suggestion pick buttons in the batch answer modal; ae0e5f8). T115 (D19: batch modal closes on open-set drain; 051fb27). Reviews R105-R110 (all go-ahead). Decision K19. Defects D14-D19 resolved. Final integration check 696 pass / 0 fail. Seeded + driven by the simulated /advance pipeline."
    title: "G7 fixes: confirmed dogfood UI/store defects (D14-D19)"
    status: done
  - id: M28
    path: ./archive/tasks/M28.md
    summary: G6 work milestone M28 — COMPLETE (auto-archived by the milestone-completion rule). Tasks T105 (D9), T106 (D10), T107 (D11), T108+T109 (D12) done; defects D9/D10/D11/D12 + the out-of-scope D14/D15/D16/D17 all resolved (via G7/M30); reviews R98-R102. Decisions K17/K18. Integration green.
    title: "G6 fixes: D9 test flake, D10 store parity, D11 sticky toolbar"
    status: done
  - id: M31
    path: ./archive/tasks/M31.md
    summary: "G6 #2/#4B — COMPLETE. T125 (authored llm/commands/advance.md universal sequencer), T126 (wired into link-prompts.ts + committed .codex/prompts/advance.md symlink), T127 (implement worker cap N=4→8), T128 (factored milestone auto-close+archive sweep predicate in advance.md + implement/advance.md), T129 (one-shot backlog sweep: archived M15/M20/M23/M28; guard-skipped M10/M11/M29/M27/M32/M33). Reviews R119/R122/R123/R124. Integration green."
    title: "G6 #2/#4B — universal /advance command, parallelism bump (N=4→8), milestone auto-close+archive sweep"
    status: done
---

# tasks

## M33

### T116 — done

- createdAt: 2026-06-03T00:41:04.646Z
- updatedAt: 2026-06-03T01:11:08.634Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Defects schema: install locked lifecycle statusValues/terminalStatuses/transitions in CANONICAL_LEDGERS"
- description: |
    Edit DEFECTS_SCHEMA in packages/ledger/src/constants.ts. The LIVE schema (verified constants.ts:102-126) = statusValues [open, wip, blocked, resolved, abandoned], terminalStatuses [resolved, abandoned], transitions open->{wip,blocked,resolved,abandoned} / wip->{blocked,resolved,abandoned} / blocked->{open,wip,resolved,abandoned}. Replace with the LOCKED target (Q66/Q67):
    
    statusValues = [open, wip, root-caused, inconclusive, resolved, wontfix]
    terminalStatuses = [resolved, wontfix]
    transitions = {
      open:        [wip, resolved, wontfix],        // Q67 VERBATIM: open->{wip, resolved, wontfix}. NO open->root-caused and NO open->inconclusive edge — root-caused/inconclusive are reachable ONLY from wip.
      wip:         [root-caused, inconclusive, resolved, wontfix],
      root-caused: [resolved, wontfix, wip],
      inconclusive:[wip, wontfix],
      resolved:    [],
      wontfix:     []
    }
    
    NET DELTA vs the live schema: ADD root-caused + inconclusive; DROP blocked entirely; RENAME the terminal abandoned->wontfix (abandoned is removed everywhere). Keep the rootCause field (free-text narrative, Q68; markers removed) and severity (required).
    
    Update the doc-comment to describe the lifecycle (open->wip->{root-caused|inconclusive}->resolved|wontfix; root-caused is the queryable file-and-defer gate; inconclusive re-openable to wip). No baboon/model-version step (Q69 — direct edit). FsLedgerStore.init() guards on-disk schema divergence (backup-reinit default); the live-data migration of any defect on a removed status (blocked/abandoned) is handled by T122 — this task is the in-code constant + its unit tests.
- acceptance: "DEFECTS_SCHEMA.statusValues deep-equals [open, wip, root-caused, inconclusive, resolved, wontfix]; terminalStatuses deep-equals [resolved, wontfix]; transitions match Q67 EXACTLY (open->{wip,resolved,wontfix} ONLY — no open->root-caused/inconclusive edge; every terminal status has empty outgoing; every referenced target is a declared status; validateSchema accepts it). Add/extend a unit test in packages/ledger asserting the new statusValues/terminalStatuses and that a wip->root-caused->resolved path and a wip->inconclusive->wip path are ACCEPTED while a removed edge (open->blocked) and an illegal direct open->root-caused are REJECTED. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G6"]
- resultCommit: ef4bc69
- completion: "DEFECTS_SCHEMA → [open,wip,root-caused,inconclusive,resolved,wontfix], terminal [resolved,wontfix], Q67-verbatim transitions; rootCause+severity kept; discriminating transition test. Reviewer-noted wontfix→DROPPED-bucket gap is covered by T117/T118."

### T117 — done

- createdAt: 2026-06-03T00:41:21.413Z
- updatedAt: 2026-06-03T02:39:16.990Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "TUI: extend defect status→color/bucket map for root-caused + inconclusive (drop blocked/abandoned)"
- description: "Update the ledger-tui status→bucket/color mapping so the two new non-terminal defect states (root-caused, inconclusive) render with a sensible bucket/color, and the removed states (blocked, abandoned) no longer appear for defects. Locate the TUI status→color map (cf. the G2 'warning' bucket work referenced in grounding; grep packages/ledger-tui for the existing defect status color/bucket table). Map: open/wip→in-progress bucket; root-caused→a distinct 'ready' colour (cause confirmed, fix pending); inconclusive→a 'warning'/parked colour; resolved→done/success; wontfix→muted/terminal. Keep behaviour for other ledgers unchanged. Depends on the locked status names from the schema task."
- acceptance: TUI renders a defect in each new status (root-caused, inconclusive, wontfix) with a defined, distinct colour/bucket; no reference to defect 'blocked'/'abandoned' remains in the map. ink-testing-library test asserts the bucket/colour for root-caused and inconclusive. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: b7fdcfa
- completion: "TUI status map: root-caused→ready(blueBright), inconclusive→warning(magenta, non-terminal path), wontfix→DROPPED(gray). Tests assert all three."

### T118 — done

- createdAt: 2026-06-03T00:41:33.582Z
- updatedAt: 2026-06-03T02:39:34.239Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Web: extend defect status→color/bucket map for root-caused + inconclusive (drop blocked/abandoned)"
- description: "Mirror the TUI change in ledger-web: update the web status→bucket/colour mapping (grep packages/ledger-web for the defect status colour/bucket table, cf. styles.css buckets + the App status→colour logic) so root-caused and inconclusive render with distinct buckets/colours and the removed defect states (blocked, abandoned) are gone. Use the same bucket semantics as the TUI task for consistency (root-caused→ready, inconclusive→warning/parked, wontfix→muted/terminal). Frontends are pure MCP clients — do not read docs/ directly. Depends on the locked status names."
- acceptance: Web renders a defect in each new status with a defined distinct bucket/colour; no defect 'blocked'/'abandoned' mapping remains. happy-dom test asserts the rendered class/colour for a root-caused and an inconclusive defect. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: d05f3d5
- completion: "Web status map: root-caused→ready(#7c6af5, new bucket + --lw-status-ready), inconclusive→warning(WARNING_ACTIVE non-terminal), wontfix→DROPPED(muted). happy-dom test asserts each."

### T119 — done

- createdAt: 2026-06-03T00:41:52.891Z
- updatedAt: 2026-06-03T02:39:41.513Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "investigate/advance.md: adjudication writes root-caused|inconclusive STATUS instead of rootCause text markers"
- description: |
    Rewrite the investigate-flow adjudication + file-and-defer sections of llm/commands/investigate/advance.md (and llm/commands/investigate/start.md if it restates the marker convention) so defect STATUS — not a rootCause prose marker — carries the lifecycle.
    
    TRANSITION-LEGALITY (BLOCKING, per R111): Q67's locked transition map has NO open->root-caused edge — root-caused is reachable ONLY from wip. Today the investigate flow (step 5a) NEVER sets the defect's STATUS; the lifecycle lives entirely on the HYPOTHESIS tree (open|uncertain|confirmed|wrong) and rootCause is written as narrative + citations. So the flow MUST move the defect open->wip when it BEGINS investigating (the adjudication step / step where an explorer starts work), making the path open->wip->root-caused — both edges legal per Q67. A direct open->root-caused write WOULD throw InvalidTransitionError against the server's strict transition guard. Make the wip transition EXPLICIT in the adjudication task.
    
    Thus, edit the prompt to instruct: (1) when investigation STARTS on an `open` defect, update_item status=wip (explicit); (2) on a CONFIRMED root cause, update_item status=root-caused (legal from wip); (3) on an investigated-but-unpinned cause, update_item status=inconclusive (legal from wip; re-openable to wip). The rootCause FIELD stays as the free-text cause NARRATIVE (Q68) WITHOUT lifecycle tokens. The file-and-defer seeding gate becomes 'status == root-caused' (Q68). Update any prose that says 'confirmed root cause'/'mark rootCause CONFIRMED' to the status-based phrasing. Keep the explorer-dispatch + citation-validation behaviour unchanged.
- acceptance: "grep of llm/commands/investigate/*.md shows NO remaining instruction to stuff UNKNOWN/CONFIRMED/GROUNDED into rootCause; the prompt EXPLICITLY instructs update_item status=wip when investigation begins on an open defect (so no direct open->root-caused write occurs), then status=root-caused (confirmed) / status=inconclusive (unpinned) at adjudication; the file-and-defer precondition is stated as status==root-caused; the documented path is open->wip->{root-caused|inconclusive} (Q67-legal). `bun run check` green (markdown-only; no-op gate)."
- suggestedModel: frontier
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 9456c23
- completion: "investigate/advance.md: open→wip at investigation start, root-caused/inconclusive at adjudication, seed gate status==root-caused; rootCause narrative-only + marker prohibition; hypothesis-tree vocabulary intact."

### T120 — done

- createdAt: 2026-06-03T00:42:07.203Z
- updatedAt: 2026-06-03T02:39:46.009Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "plan prompts: re-key the DEFECT-STATUS auto-investigate worklist/seed-gate to status==root-caused (leave hypothesis-tree predicates intact)"
- description: |
    Update llm/commands/plan/advance.md AND llm/agents/plan-advance.md so the DEFECT-STATUS worklist + file-and-defer SEED GATE key off the queryable defect STATUS — NOT a prose marker.
    
    SCOPE (BLOCKING DISTINCTION, per R111 — be SURGICAL about which 'confirmed' is which):
    - CHANGE (defect lifecycle): the auto-investigate WORKLIST (plan/advance.md:92-98 + plan-advance.md:248-249, currently keyed on status:open) and the file-and-defer SEED GATE. New semantics: the worklist treats `open`/`wip`/`inconclusive` defects as still-ACTIONABLE, `root-caused` as READY-TO-SEED (the seed gate becomes status==root-caused, replacing any 'confirmed root cause' prose check), and `resolved`/`wontfix` as terminal/EXCLUDED. Replace any prose marker checks (rootCause CONFIRMED/UNKNOWN) here with status queries.
    - PRESERVE (hypothesis tree — DO NOT TOUCH): the K12 stop-predicates (b)/(c)/(d) at plan/advance.md:150-164 reason over the HYPOTHESIS TREE (hypothesis status `confirmed` + `[correct]` evidence — the investigate adjudication + ill-loop/convergence detector), which is a SEPARATE concept from the defect lifecycle. A blanket 're-key every confirmed node/confirmed root cause to status==root-caused' would CORRUPT these. Leave the hypothesis-tree `confirmed`-node vocabulary and the stop predicates' hypothesis reasoning INTACT. Only the defect-STATUS seed gate / worklist references change.
    
    Keep the auto-investigate ledger-query mechanism (re-derive worklist from the ledger) intact; only the defect-status predicate vocabulary changes. NOTE: these two files are ALSO edited by the M31 /advance + sweep tasks — this task lands FIRST (M33 precedes M31); the M31 tasks declare dependsOn this task to serialize the shared files.
- acceptance: "grep of llm/commands/plan/advance.md + llm/agents/plan-advance.md shows the auto-investigate WORKLIST + file-and-defer SEED GATE keyed off defect STATUS (open/wip/inconclusive actionable, root-caused ready-to-seed, resolved/wontfix excluded), with no remaining 'confirmed root cause' prose-marker gate on the DEFECT path. The K12 stop-predicates (b)/(c)/(d) at plan/advance.md:150-164 STILL reference the HYPOTHESIS-TREE `confirmed` node + `[correct]` evidence UNCHANGED (verify via diff that those lines' hypothesis vocabulary is preserved, not re-keyed to defect status). `bun run check` green (markdown-only)."
- suggestedModel: frontier
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 6818f7a
- completion: "plan/advance.md + plan-advance.md: auto-investigate worklist keyed to open/wip/inconclusive actionable, seed gate status==root-caused, resolved/wontfix excluded; K12 hypothesis-tree predicates (b)/(c)/(d) untouched."

### T121 — done

- createdAt: 2026-06-03T00:42:18.563Z
- updatedAt: 2026-06-03T04:40:06.423Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "implement/advance.md: align defect-terminal vocabulary with the locked set (abandoned->wontfix at :198; reviewer-filed defects already status:open)"
- description: |
    Two SURGICAL edits to llm/commands/implement/advance.md, both grounded against the live file (R111 corrected the original premise):
    
    (a) MILESTONE-COMPLETION terminal vocabulary (the MISSED touch-point, BLOCKING-adjacent): line 198 states the defect terminal set as `resolved`/`abandoned`. The locked schema (T116) RENAMES abandoned->wontfix and DROPS blocked, so this line references a REMOVED status. Edit :198 (and grep the whole file for any OTHER `abandoned` defect-terminal reference) to read `resolved`/`wontfix`. This is the primary content of this task.
    
    (b) REVIEWER-FILED defects section (lines 96-117): the original T121 premise was WRONG — this section ALREADY files reviewer defects with status:open and fields {headline, description, severity, suggestedFix?}; it writes NO rootCause marker and NO CONFIRMED/UNKNOWN token. So there is NOTHING to remove here. The ONLY action for this section is to CONFIRM it stays status=open (untriaged; a defect reaches root-caused only via an investigate pass, never directly from the implement reviewer) and that it sets NO removed status (blocked/abandoned). Do NOT instruct the implementer to hunt for a nonexistent rootCause marker.
    
    NOTE: implement/advance.md is ALSO edited by the M31 N=4->8 bump (T127) and the milestone-sweep predicate task (T128) — this task lands first (M33 precedes M31); those M31 tasks declare dependsOn this task to serialize the shared file.
- acceptance: "grep of llm/commands/implement/advance.md shows (a) the milestone-completion defect-terminal reference at ~:198 reads `resolved`/`wontfix` with NO remaining `abandoned` (nor `blocked`) defect-status reference anywhere in the file; (b) the reviewer-filed-defects section still creates defects with status=open and {headline,description,severity,suggestedFix?} (unchanged), with rootCause used as narrative only and no removed status written. `bun run check` green (markdown-only)."
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: f546fe2
- completion: "implement/advance.md:198 defect-terminal ref abandoned→wontfix (per T116 schema); task-status `abandoned` (:199) + blocked/blockedBy dependency refs correctly untouched; reviewer-filed-defects section unchanged (status:open)."

### T122 — blocked

- createdAt: 2026-06-03T00:42:35.400Z
- updatedAt: 2026-06-03T04:51:41.924Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: Migrate live open defects to the new status vocabulary (one-shot, data-only; no on-load coercion)
- description: "After the schema lands (T116), perform a one-shot update_item migration of every live NON-terminal defect to the new vocabulary (Q69): for each, read its current status + rootCause marker and set the new status — a defect whose rootCause carried CONFIRMED/GROUNDED → root-caused; UNKNOWN-still-investigating → stays open (or wip if under active investigation); strip the marker token from rootCause leaving only the narrative. Also migrate any defect currently in a REMOVED status: status 'blocked' → open or wip (per its situation); status 'abandoned' (now removed; the terminal rename is abandoned→wontfix) → wontfix. The known live open defects are D13 (TUI nav latency, rootCause 'UNKNOWN' → stays open, marker stripped) and D20 (inspect its current marker). D13/D20 are MIGRATED ONLY, not fixed (explicitly out of scope). Re-query the defects ledger at execution time for the authoritative live set — do not trust this list. Use update_item via the ledger MCP (author/session set); do NOT hand-edit docs/defects.md. No permanent on-load coercion in the store (Q69)."
- acceptance: "Every live non-terminal defect carries a status from the new set [open, wip, root-caused, inconclusive] (or terminal resolved/wontfix); no live defect remains in a removed status (blocked/abandoned); no rootCause field contains a UNKNOWN/CONFIRMED/GROUNDED lifecycle token (narrative text only). Confirm via fts_search/fetch over the defects ledger. D13/D20 unchanged except status/rootCause-marker migration. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]

## M32

### T123 — done

- createdAt: 2026-06-03T00:42:54.427Z
- updatedAt: 2026-06-03T04:26:01.511Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "@cq/ledger: expose a public reset() on FsLedgerStore wrapping backupAndReinit (+ per-ledger summary return)"
- description: "backupAndReinit is currently a PRIVATE method (packages/ledger/src/store/FsLedgerStore.ts:694) invoked only from init()'s schema-divergence branch. Add a public async reset() method (or make backupAndReinit public) that the --reset CLI wrapper can call on a freshly-constructed (NOT-yet-serving) store: it must perform the same timestamped docs/.backup/<ts>/ snapshot + fresh canonical reinit, and RETURN a small summary the CLI can print (Q64) — e.g. { backupDir: absolute path, ledgers: Array<{ name, itemCount }> } counting items in each active ledger BEFORE the wipe. Reuse backupAndReinit verbatim for the snapshot/reinit (Q65); the reset() wrapper adds only the pre-count + the returned summary. FS-only (InMemory store needs no parallel — Q65). Keep init()'s existing private call-site working (if backupAndReinit stays private, reset() pre-counts then calls it; if made public, init still calls it). Export any new public type from @cq/ledger index.ts as needed."
- acceptance: "FsLedgerStore exposes a public reset() returning { backupDir, ledgers: [{name,itemCount}] }; a unit test creates a store with seeded items, calls reset(), and asserts (a) a docs/.backup/<ts>/ dir exists containing the prior ledgers.yaml + ledger files, (b) the live ledgers are back to the canonical empty set, (c) the summary item counts match what was seeded, (d) the post-reset defects ledger carries the NEW status set (proves CANONICAL_LEDGERS reuse). `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G6"]
- resultCommit: af0d882
- completion: "Public FsLedgerStore.reset() → ResetSummary{backupDir,ledgers:[{name,itemCount}]}: pre-counts, reuses backupAndReinit (now returns backup dir), reloads canonical via init(). Test asserts backup contents + canonical empty + counts + new defect status set."

### T124 — done

- createdAt: 2026-06-03T00:43:10.514Z
- updatedAt: 2026-06-03T04:40:12.621Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "ledger-mcp: add --reset flag (TTY y/N confirm + --yes skip), short-circuit main() to reset then exit"
- description: "Extend packages/ledger-mcp/src/main.ts: (1) parseArgs (line 109) recognises `--reset` (boolean) and `--yes`/`-y` (boolean), threading them into ParsedArgs; `--reset` honours the existing --cwd/$LEDGER_ROOT root resolution. (2) main() short-circuits when reset is set: construct the FsLedgerStore for the resolved cwd, print a per-ledger summary of what will be backed up (counts — obtain by init()+count or via the reset() summary), then CONFIRM per Q64 — if process.stdin.isTTY and NOT --yes, prompt 'Reset ledgers at <cwd>? Backup will be written to docs/.backup/. [y/N] ' and proceed only on y/Y; if --yes, skip the prompt (unattended); if NOT a TTY and NOT --yes, REFUSE with a non-zero exit + a message instructing --yes (a non-interactive run must not wipe silently). On confirm, call store.reset() (T123), print the returned backupDir + summary, and return (NO server started; process exits 0). Do NOT start the watcher/HTTP/stdio server on the reset path. Keep the existing serve paths unchanged when --reset is absent."
- acceptance: parseArgs recognises --reset/--yes (unit test). `ledger-mcp --cwd <tmp> --reset --yes` backs up + reinits the tmp ledger tree and exits 0 without serving (integration-style test invoking main() with --yes on a seeded tmp dir asserts docs/.backup/<ts>/ created, live tree reset, no server bound). A non-TTY invocation WITHOUT --yes exits non-zero and does NOT modify the tree. `bun run check` green.
- suggestedModel: frontier
- dependsOn: ["T123"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 8ac6c29
- completion: "ledger-mcp --reset/--yes: parseArgs + main() short-circuit to exported runReset(cwd,yes,ResetIo) — Q64 confirm (--yes unattended, TTY y/N, non-TTY-no-yes refuses exit2 no-mutation), calls store.reset(), prints backupDir+summary, exits without serving. 23/0 targeted tests."
