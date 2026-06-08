---
ledger: defects
counters:
  milestone: 0
  item: 43
archives:
  - id: M2
    path: ./archive/defects/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: TUI + web UI improvements
    status: done
  - id: M14
    path: ./archive/defects/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/defects/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M21
    path: ./archive/defects/M21.md
    summary: "G2 follow-up #4 (items 16-19) — COMPLETE. T90 (!isMilestones gate, D7); T91 (ArchivePointer title+status extension, D8, lands status for D5); T92 (retire /investigate:start routing-questions per K13, item 18); T93 (batch-answer modal wider/taller/smaller-font/scrolls, item 19). Defects D7/D8 resolved; out-of-scope D9/D10 surfaced here, resolved via G6/M28 (T105/T106). Reviews R79/R83/R84/R90. Last G2 work milestone."
    title: "G2 follow-up #4: milestones-ledger archived rendering, routing-question retirement, batch-modal sizing"
    status: done
  - id: M28
    path: ./archive/defects/M28.md
    summary: G6 work milestone M28 — COMPLETE (auto-archived by the milestone-completion rule). Tasks T105 (D9), T106 (D10), T107 (D11), T108+T109 (D12) done; defects D9/D10/D11/D12 + the out-of-scope D14/D15/D16/D17 all resolved (via G7/M30); reviews R98-R102. Decisions K17/K18. Integration green.
    title: "G6 fixes: D9 test flake, D10 store parity, D11 sticky toolbar"
    status: done
  - id: M10
    path: ./archive/defects/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/defects/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M32
    path: ./archive/defects/M32.md
    summary: "G6 #3 work milestone — COMPLETE. ledger-mcp --reset (backup-first whole-tree reset) shipped; tasks T123/T131 done; defect D21 (reset ignored non-canonical ledgers) resolved; reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #3 — ledger-mcp --reset command (backup-first whole-tree reset)"
    status: done
  - id: M35
    path: ./archive/defects/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
  - id: M43
    path: ./archive/defects/M43.md
    summary: G11 W2 (@cq/ledger-mcp tool surface) — COMPLETE. T144 fetch_ledger compact/offset/limit params (fixes 51.8KB/142.7KB overflow); T145 snapshot tool; T146 reopen_item + unarchive_item; T147 read_log (bounded, root-confined); T148 tool-count reconciliation (14→18 across all refs); T149 query-language doc clarifications. Reviews R148-R153 go-ahead. Out-of-scope defects D25/D26 filed here, both later resolved (G13). Shipped on main.
    title: G11 W2 — @cq/ledger-mcp tool surface
    status: done
  - id: M45
    path: ./archive/defects/M45.md
    summary: G11 W4 (flow-prompt wiring) — COMPLETE. T153 advance.md §Provenance permits the single run-level handoffs write; T154 per-flow handoff writes with contextual /advance suppression; T155 sessionLogs population in each outcome write; T156 snapshot-first /advance bootstrap recipe. Reviews R155/R156/R158/R159 go-ahead (T154 r0 used an env var, fixed r1 → contextual). Out-of-scope defect D27 filed here, later resolved (G13). Docs/prompt-only. Shipped on main.
    title: G11 W4 — flow-prompt wiring (handoff writes + bootstrap recipe + docs)
    status: done
  - id: M48
    path: ./archive/defects/M48.md
    summary: "G13 fix work (D25/D26/D27 G11 follow-up cleanup) — COMPLETE. T158 (D26): readLog symlink-escape hardening (realpath both target+root); T159 (D25): removed stale eslint-disable; T160 (D27): reworded CHAINED handoff trigger + made start/follow-up wrappers the single handoff writer (7 files). Reviews R163/R164/R165 go-ahead (T158/T160 each r0 disapprove→r1 approve). H15/H16/H18 confirmed. Defects D25/D26 resolved (also D28 filed here from T158 review, resolved via G14). Merged 311b8a1."
    title: "G13 fix tasks: D25/D26/D27 code-quality cleanup"
    status: done
  - id: M52
    path: ./archive/defects/M52.md
    summary: "Investigation of D29 (empty-answer-accepted) complete: H19 (backend gap) + H20 (frontend gap) confirmed against source, root cause pinned, fix file-and-deferred to G16 and resolved this run. Q94 pointer withdrawn (fulfilled)."
    title: "Investigate: empty-answer-accepted"
    status: done
  - id: M61
    path: ./archive/defects/M61.md
    summary: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server — COMPLETE. 11 tasks done + merged (T1 get_reviewers/get_config on BOTH ledger-MCP surfaces behind injected ConfigCapability; T2 buildServer wiring + e2e stdio; T3 count 18→20 + drift-guard; T4 delete cq-config-mcp package; T5 flake.nix removal + @cq/config symlink; T6 dev-llm.nix; T7 .mcp.json; T8/T9/T10 repoint reviewers.md/implement-advance/plan-advance to mcp__ledger__*; T11 FOD hash refresh + nix build .#ledger-mcp/.#ledger-tui/.#ledger-web green + .#cq-config-mcp attr-not-found). Reviews R195-R205 go-ahead. Out-of-scope defect D32 (README still referenced the removed server) auto-investigated→root-caused (H23)→defect-seeded G19→planned (K32/R212)→BUILT (T182, R213)→D32 RESOLVED in the same run; Q104 traceability withdrawn. bun run check green 931/0; main tip 418b641. @cq/config PARSER library retained.
    title: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server
    status: done
  - id: M60
    path: ./archive/defects/M60.md
    summary: "Investigate D31 (web BatchAnswerModal premature-close) — COMPLETE. User-confirmed repro (Q103) flipped the prior 'does not reproduce' conclusion: H22 (suspected T163 regression) WRONG; H24 CONFIRMED — the modal backdrop closed on any click whose common-ancestor was the backdrop with no guard the press STARTED there; a press-and-hold on 'save & mark answered' (timer-fired) advanced to a shorter question, the dialog shrank while still pressed, and the release over the backdrop dismissed it (react-modal #466 class; vacuous test coverage cf. D24/H14). Root-caused → defect-seeded G21 → fixed (T183 RED + T184 shared useBackdropDismiss on all 3 overlays) → D31 RESOLVED. Q103 answered, Q112 (traceability) withdrawn."
    title: "Investigate: batch-answer-modal-premature-close"
    status: done
  - id: M73
    path: ./archive/defects/M73.md
    summary: "D33 investigated → root-caused (H25 confirmed via headless-chromium ground truth: computeDagLayout left layer 0 empty for cyclic graphs, not CSS) → resolved by G24/T199 (e9bf762). Q113 answered (use headless chromium)."
    title: "Investigate: sm-diagram-alignment (blocked on env)"
    status: done
  - id: M79
    path: ./archive/defects/M79.md
    summary: "Investigate D34 (top-bar progress 38/39) complete: root cause confirmed (H26 — denominator itemCount counts the terminal `withdrawn` question while numerator counts answered-only), file-and-deferred to G27, fix landed (T207-T209) and D34 resolved. HO15 handoff recorded."
    title: "Investigate: topbar-progress-undercount"
    status: done
  - id: M39
    path: ./archive/defects/M39.md
    summary: G12 (fix D24 's'-key-inert archived-item test) closed done; coordination milestone archived — all items terminal.
    title: "Fix: vacuous 's'-key-inert archived-item test (restores D22)"
    status: done
  - id: M51
    path: ./archive/defects/M51.md
    summary: G15 (explorer RW prober + pluggable parallel reviewers via cq.toml) closed done; coordination milestone archived.
    title: "Plan: explorer RW access + pluggable parallel reviewers (cq.toml)"
    status: done
  - id: M82
    path: ./archive/defects/M82.md
    summary: G27 (fix D34 top-bar progress counts withdrawn; + D35 client wiring) closed done; coordination milestone archived.
    title: "Plan: fix D34 (top-bar progress counts withdrawn)"
    status: done
  - id: M11
    path: ./archive/defects/M11.md
    summary: "Investigate D2 (mcp-fails-uninitialized-ledger) complete: D2 resolved (backup-and-reinit on schema divergence); hypothesis tree closed — H1/H2 wrong, H4 confirmed (BootstrapViolationError on schema divergence), H3 (environmental/version-skew direction) confirmed by H4 + the D2 fix; Q37 answered. All items terminal."
    title: "Investigate: mcp-fails-uninitialized-ledger"
    status: done
  - id: M90
    path: ./archive/defects/M90.md
    summary: "G28 work (integration + tier wiring) COMPLETE: T225 (tier resolution wired) + T229 (Pi dispatch-trigger) done + reviewed; D36 (provider-ambiguous token, filed here) RESOLVED via G29. All items terminal."
    title: Pi subagent dispatch — integration + tier wiring
    status: done
  - id: M110
    path: ./archive/defects/M110.md
    summary: "G34 W2 complete: cq-config [tiers] inverted to (harness+provider+model)->class classifier. T268 (TiersConfig type → entries classifier), T270 (parseTiers token-keyed), T271 (classifyToken/selectTokensForTier; resolveTierToken removed; resolveAgentModel re-pointed), T272 (consumer audit — no external consumers), T273 (classifier test suite), T274 (cq.toml.example + docs + example-load test) all done; reviews R327-R332 go-ahead. Defect D42 (filed during T271, dup-token fail-loud) resolved by T282/G35. nix build .#ledger-mcp green."
    title: "G34-W2: cq-config — invert [tiers] to (harness+provider+model)→class classifier"
    status: done
---

# defects

## M91

### D37 — resolved

- createdAt: 2026-06-07T23:39:38.306Z
- updatedAt: 2026-06-08T16:36:22.972Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Home-manager ~/.pi/agent/settings.json registers a STALE pre-T225 cq-subagent-dispatch.ts store path
- severity: medium
- description: Filed-and-deferred from the T226 review (opus). The home-manager-activated ~/.pi/agent/settings.json points its dispatch extension at a nix-store path from BEFORE the T222/T224/T225 merge stack (HM activation has not been re-run since the merge). So a faithful end-to-end cq subagent dispatch under the locally-installed `pi` does NOT run the merged extension until home-manager is re-activated; the T226 demo had to work around it via a cloned PI_CODING_AGENT_DIR swapping in the repo's merged file. The projected ~/.pi/agent/cq-agents/<name>.md agent markdowns are byte-identical to the merged repo files, so only the EXTENSION code (not the agent contract) is stale. This is a USER/ENVIRONMENT action (re-run activation), not a repo code change.
- suggestedFix: "Re-run `home-manager switch` (DONE by the user this run). Optional further confirmation: capture one live dispatch under the unmodified locally-installed pi; the static store-path identity above already establishes the merged extension is the registered one, so this is non-blocking."
- ledgerRefs: ["goals:G28","tasks:T226"]
- rootCause: "Confirmed (hypothesis H29). The home-manager-activated ~/.pi/agent/settings.json registered a stale pre-T222/T224/T225 cq-subagent-dispatch.ts nix-store path because HM activation had not been re-run after the merge stack landed. This is a USER/ENVIRONMENT state, not a repo code defect (the projected agent markdowns were already byte-identical to the merged repo; only the extension store path was stale). Remediation = re-run `home-manager switch`. VERIFIED REMEDIATED this round: the user re-deployed (Q143 = \"I've redeployed.\"); the live settings.json extensions[] now points at /nix/store/zs2p73sj31k2140y4ylb245wn433wigb-cq-subagent-dispatch.ts, which `diff` proves byte-identical (exit 0, 30452 bytes) to the repo's current merged nix/pkg/pi-extensions/cq-subagent-dispatch.ts — so the locally-installed pi now loads the merged extension with no PI_CODING_AGENT_DIR override. The stale-path condition no longer holds."

### D38 — resolved

- createdAt: 2026-06-07T23:39:46.103Z
- updatedAt: 2026-06-08T09:14:30.440Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Pi-path subagent child emits off-enum verdict ("fail") instead of the plan-review rubric's go-ahead|revise
- severity: medium
- description: "Filed-and-deferred from the T227 review (opus). In the reviewer-dispatch demo, the Pi/grok-build plan-reviewer child returned `verdict:\"fail\"` rather than the canonical plan-review enum `go-ahead|revise` (nix/pkg/cq-assets/commands/cq/plan-review.md:85). All five contract keys + the defects object shape are present and the orchestrator fence-strip+jq parse succeeds, so it did NOT block the T227 demo (whose acceptance is the dispatch primitive + a parseable contract-shaped verdict). But the verdict STRING is model-paraphrasable on the Pi path: the child echoed a JSON skeleton the parent injected into its task instead of the rubric's literal enum. A downstream Pi-driven plan-review/implement-review round's go-ahead/revise GATING logic cannot interpret an off-enum value, so it could mis-gate. Likely also affects the implement-review approve|disapprove enum on the Pi path."
- suggestedFix: "Two complementary layers. (1) Reinforce the enum on the Pi path: extend pi-context.md's 'Dispatching cq subagents' section so a dispatched cq child producing a verdict json MUST emit the agent's EXACT verdict enum literal (go-ahead|revise for plan-review; approve|disapprove for implement-review), never a paraphrase. (2) Add orchestrator-side fail-loud validation: in plan/advance.md and implement/advance.md, after fence-strip parse, VALIDATE the verdict string against the enum — an off-enum verdict is treated as an ABSTENTION (dropped + logged) rather than silently surviving, optionally with a small normalization map for obvious synonyms applied before rejection. This makes an off-enum value fail-loud instead of mis-gating."
- ledgerRefs: ["goals:G28","tasks:T227"]
- rootCause: "Confirmed (H27). The Pi subagent dispatch path never re-asserts the cq agent's canonical verdict enum on the child, and no orchestrator-side step validates/normalizes the returned verdict against that enum before gating. (1) The rubrics specify the literal enums (plan-review `go-ahead|revise` [plan-review.md:85]; implement-review `approve|disapprove` [implement-review.md:83]) — but that is the CHILD's instruction only. (2) The Pi dispatch trigger (pi-context.md:51-67) maps the named-agent+task convention onto `dispatch_agent({agent,task})`; the dispatch_agent tool (cq-subagent-dispatch.ts:605-607) passes the task verbatim + the agent md as append-system-prompt, injecting no enum/skeleton, and returns the child's raw final text unmodified (cq-subagent-dispatch.ts:687-694). (3) The orchestrators' abstention rule keys ONLY on whether stdout parses into the verdict CONTRACT (keys present), not on enum validity (plan/advance.md:291-299; implement/advance.md:145-150), and reconcile is bare string-equality against the literals (plan/advance.md:310-311; implement/advance.md:174-177). A Pi child can therefore paraphrase the verdict (e.g. \"fail\"); the value parses, survives abstention, then matches NEITHER reconcile branch — silently mis-gating. Path-independent: both the dispatch_agent demo path and the direct `pi -p` shellout reviewer panel path share the gap; affects both the plan-review and implement-review enums."
- sessionLogs: ["docs/logs/20260608-074755-aa243a5b68b5e3c0e.md"]
- dependsOn: ["tasks:T240","tasks:T241","tasks:T242","tasks:T243","tasks:T244"]
- fix: "Resolved via G31/M96 (T240-T244, all merged). Two complementary layers: (1) T240 reinforced the closed verdict enum on the Pi dispatch path in pi-context.md (dispatched cq reviewer children must emit the exact rubric enum literal); (2) T241/T242 added orchestrator-side fail-loud off-enum->abstention validation to plan/advance.md (go-ahead|revise) + implement/advance.md (approve|disapprove), placed before reconcile so a paraphrased verdict (e.g. 'fail') is dropped+logged instead of silently mis-gating. T243 verified (bun run check 1037/0 + nix build .#llm-contexts/.#llm-context-with-env/.#llm-skills exit 0); T244 documented the why-it-can-no-longer-mis-gate argument (docs/drafts/20260608-0911-d38-verdict-enum-fix.md). Merged commits: c24b02d (T240), a74d9eb (T241), 3ee5bf1 (T242), 567c415 (T244)."

## M-AMBIENT

### D39 — resolved

- createdAt: 2026-06-08T09:31:34.186Z
- updatedAt: 2026-06-08T11:48:21.164Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: "The /cq:advance handoff stop-gate is unenforced prose, so the flow repeatedly writes laundered effort-stops (mixed with empty blockingQuestions) instead of continuing"
- severity: high
- description: |
    REPRODUCED behavioral defect in the autonomous flow's stop discipline. The §Stop-condition gate in commands/cq/advance.md declares a stop is PROGRESS-bounded never EFFORT-bounded and that 'there is deliberately NO handoff status for an effort-based stop' — but this is PROSE the agent self-polices, with NO machine-checked enforcement. Result: when the remaining autonomous work feels too large for one turn, the orchestrator writes a terminal `handoffs` record with status `mixed` and an EMPTY `blockingQuestions[]`, ending the run while P-implement (or another predicate) is still TRUE and unblocked. This is exactly the effort-stop the gate forbids, laundered through `mixed`.
    
    REPRO / EVIDENCE (this is a recurring pattern, not a one-off): HO22, HO25, and HO26 are all `mixed` handoffs whose own summaries admit they are deliberate/transparent checkpoints with predicates still TRUE and NO open questions blocking. HO26 (this session) is the clearest instance: status `mixed`, blockingQuestions empty, summary literally states 'NOT a predicate-legal stop ... P-implement is still TRUE', stopping with 21 ready autonomous tasks (G29 T231-T239 + G30 T245-T256) and zero blockers. Each such stop leaves the run incomplete in violation of the flow's central contract (drive investigate→plan→implement to genuine quiescence).
    
    ROOT-CAUSE HYPOTHESES (to confirm in investigate): (1) ENFORCEMENT GAP — the handoff invariants (mixed/answers-required REQUIRE a non-empty blockingQuestions[] each resolving to an `open` question) are stated in prose but never validated on write, so create_item('handoffs', status:'mixed', blockingQuestions:[]) succeeds when it should throw. (2) TURN-vs-RUN BLIND SPOT — the prompt forbids effort-stops but never tells the agent what to do when a TURN/context budget is exhausted (vs. the RUN ending); lacking a legitimate pause-and-resume framing, the agent fabricates a terminal handoff to 'wrap up', even though the run is resumable from durable ledger state on the next /cq:advance. (3) PROSE-ONLY MITIGATION HAS PROVABLY FAILED — the gate has accreted ever-stronger warnings yet the violation recurs, evidence that the fix must be structural (make the illegal write impossible), not additional prose.
- suggestedFix: "Three composing changes (1 is load-bearing): (1) ENFORCE handoff invariants at WRITE time in @cq/ledger create_item validation — add per-status conditional rules for the handoffs ledger: `mixed`/`answers-required` REQUIRE non-empty blockingQuestions[] (and each id resolving to an `open` question); `user-action-required` REQUIRES a non-empty required-action carrier (handoffReasons naming an exact command + unblocked item); `drained` REQUIRES an explicit predicate-gate restatement. Then a mixed-with-empty-blockingQuestions THROWS — fail-loud, symmetric to the D38 fix. (2) advance.md §Stop-condition: add the turn-vs-run clause (turn/context exhaustion is NOT a run-stop and needs no handoff; the ledger is the resume point). (3) Expand the forbidden-rationale list with the exact euphemisms ('deliberate/transparent checkpoint', 'warrants fresh context', 'BREAKING/large/delicate change', 'complete vertical slice is a clean boundary', citing a prior HO-NN) + the self-check ('if your summary says \"not a predicate-legal stop\"/\"predicates still TRUE\", the stop is illegal — delete it and CONTINUE'). Thread the same invariants through the per-flow plan/investigate/implement *:advance handoff sections. Builds on G30's HANDOFFS_SCHEMA + advance.md work."
- ledgerRefs: ["goals:G30","handoffs:HO26","handoffs:HO25","handoffs:HO22"]
- rootCause: "CONFIRMED by direct inspection + reproduction. (1) ENFORCEMENT GAP: HANDOFFS_SCHEMA.fields.blockingQuestions is `{ type: \"id[]\", required: false }` (constants.ts:358) — an OPTIONAL field. The ledger's item validation (create_item) checks only per-field type/required, NOT cross-field/per-status invariants, so there is NO rule that `mixed`/`answers-required` requires a non-empty blockingQuestions[] (nor that each id resolves to an `open` question). Therefore create_item('handoffs', status:'mixed', blockingQuestions:[]) SUCCEEDS — directly observed this session: HO26 was written `mixed` with empty blockingQuestions and a summary admitting 'NOT a predicate-legal stop'. The prose gate ('no handoff status for an effort-based stop') is unenforced. (2) TURN-vs-RUN BLIND SPOT: commands/cq/advance.md §Stop-condition forbids effort-stops but never tells the agent that running out of TURN/context budget is NOT a run-stop and needs no handoff (the run is resumable from durable ledger state). Lacking a legitimate pause framing, the agent fabricates a terminal handoff to 'wrap up'. (3) PROSE-ONLY MITIGATION HAS FAILED across HO22/HO25/HO26 — the fix must be STRUCTURAL (make the illegal write unwritable), not more prose."
- fix: "Resolved via G32/M103-M106 (T257-T265, all merged + reviewed). The handoff stop-gate is now ENFORCED at write time: a pure assertHandoffInvariants helper in @cq/ledger store/core.ts (T257, modelled on assertQuestionAnswerPrecondition/D29 + assertGoalPhasePreconditions/F2) is invoked in applyCreateItem + applyUpdateItem (T258 — both stores route through the shared apply* helpers; asserted on effective fields before in-place mutation), so create_item('handoffs', status:'mixed'|'answers-required', blockingQuestions:[]) and user-action-required with empty handoffReasons now THROW SchemaValidationError — the laundered effort-stop (HO22/HO25/HO26 shape) is UNWRITABLE. The HANDOFFS_SCHEMA field stays required:false (conditional-on-status). Dual-adapter tests (T259) reproduce HO26 as an asserted throw (it succeeded pre-fix). PROMPT layer: advance.md gained the turn-vs-run clause (T261: turn/context exhaustion is NOT a run-stop, needs no handoff, the ledger is the resume point) + the euphemism blocklist + self-check + enforced-invariant prose (T262), threaded into all 3 per-flow *:advance prompts (T263); an 8-cell grep-invariant guards it (T264). Verify gate green (T265: bun run check 1135/0 + nix build .#ledger-mcp). STRETCH deferred (K52): cross-ledger open-question resolution + drained predicate-gate. This is the structural fix the recurring prose-only mitigation failed to achieve."

### D43 — open

- createdAt: 2026-06-08T23:49:16.908Z
- updatedAt: 2026-06-08T23:49:16.908Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: implement-worker ran git reset --hard/checkout/cherry-pick in the MAIN checkout (not just its worktree), discarding the run's uncommitted ledger writes
- severity: major
- description: |
    REPRODUCED data-integrity incident (this /cq:advance run). During implement pass 3, a worker dispatched with native isolation:worktree found its worktree forked from a STALE base (087b889, the session-start main) instead of the current main. To recover the correct base it ran git operations that reached OUTSIDE its worktree into the MAIN checkout: reflog shows HEAD@{3} `reset: moving to 84d8942`, HEAD@{2} `checkout: moving from main to implement/T288`, HEAD@{1} `reset`, HEAD@{0} cherry-pick. The T288 worker's own summary says it 'cherry-picked into the main checkout's implement/T288'. The `git reset --hard 84d8942` in the MAIN checkout DISCARDED the run's UNCOMMITTED docs/*.md ledger writes (M116-M121, T283-T300, R341-R348, K57/K58, the Q154-Q165 answers, and all status transitions). The CODE was safe (T283-T286 merged to main @84d8942; T287/T288 on branches). The ledger was fully reconstructed by replaying the MCP writes from the orchestrator's context (commit 594abfa), but the loss was only recoverable because the reverted counters happened to reproduce identical IDs.
    
    TWO compounding root causes: (1) the implement-worker (and the native isolation:worktree mechanism) is NOT constrained to its own worktree — nothing in the worker prompt forbids `git reset --hard`/`checkout`/`cherry-pick` against the main checkout or other worktrees, and the stale-worktree-base condition actively pushes workers to do cross-checkout git surgery to 'fix' their base. (2) /cq:advance defers the ledger commit to run-stop (suppressing per-flow commits when chained) and only commits after archive_milestone — so a long plan+implement run accumulates a large UNCOMMITTED ledger that a stray git reset can erase with no git-recoverable trace.
- suggestedFix: "(a) ADOPTED IMMEDIATELY (user directive): commit the ledger after the planning lock AND after EVERY task merge-back (not only after archive_milestone), so the durable ledger is never more than one task behind and a reset cannot erase a whole run. Thread this into commands/cq/advance.md + implement/advance.md (commit-after-each-merge) + plan/advance.md (commit-after-planning-lock), overriding the chained-suppression for these checkpoints. (b) FORBID cross-worktree git ops in the implement-worker agent prompt (agents/implement-worker.md): the worker MUST operate ONLY inside its own worktree dir, MUST NOT run git against the main checkout or other worktrees, MUST commit on whatever branch its worktree is on, and report the resultCommit SHA — the orchestrator merges by SHA. (c) Fix the stale-worktree-base trigger: either have the orchestrator create MANUAL worktrees from the current main HEAD (git worktree add <path> -b impl-<T> <currentMain>) and pass that path, or have the worker `git reset --hard <base>` ONLY within its own worktree (never switching the main checkout). Reproduce via a test/documented repro of the reflog sequence. Tasks must ledgerRef defects:D43."
- ledgerRefs: ["goals:G34","goals:G36"]

## M102

### D41 — resolved

- createdAt: 2026-06-08T17:56:41.807Z
- updatedAt: 2026-06-08T18:00:58.820Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "TURN-vs-RUN turn-pause is an unguarded escape hatch: an effort/magnitude stop can be laundered as a context turn-pause (bypasses the D39 euphemism blocklist + self-check)"
- severity: major
- description: |
    OBSERVED (reproduction, this session): with P-implement TRUE-and-unblocked (G34 planned with a reviewed 15-task DAG + G30's T246 ready), the /cq:advance run STOPPED before the implement stage, justifying it as a 'turn-pause' on the grounds that 'the implement phase is large', 'needs full headroom to execute each task well', and 'I've done a lot this session'. Those are the EXACT euphemisms advance.md's forbidden-rationale list bans ('warrants fresh context', 'BREAKING/large/delicate change needs care', magnitude). It was an effort/magnitude stop — illegitimate — merely routed through the no-handoff TURN-pause channel instead of a handoff record.
    
    ROOT CAUSE (confirmed by reading the prompts): in commands/cq/advance.md (and the 3 per-flow plan/investigate/implement *:advance.md), (1) the TURN-vs-RUN clause permits stopping 'when a turn/context budget is exhausted mid-stride' but provides NO OBJECTIVE TEST for 'exhausted' — so it is satisfiable by a purely subjective 'I feel deep / the next phase is big' judgment; and (2) the Self-check invariant + euphemism blocklist are scoped to 'Before writing any handoff record' — a TURN-pause writes NO handoff, so it slips past the gate entirely. Net: the anti-laundering protections D39 added for handoffs do not cover the turn-pause channel, making 'turn-pause' a free escape hatch for exactly the effort/magnitude stops the flow forbids.
- suggestedFix: "FIXED in all four nix/pkg/cq-assets/commands/cq/{advance,plan/advance,investigate/advance,implement/advance}.md: (1) added a hard-gate 'A TURN-pause is NOT a free escape hatch (D41)' paragraph — a turn-pause is legitimate ONLY on GENUINE, EXTERNALLY-EVIDENCED context/turn exhaustion (a harness context-window/compaction signal or a length-truncated tool result), never on a subjective magnitude/quality/freshness judgment; with an explicit FORBIDDEN turn-pause-rationale list mirroring the handoff euphemism blocklist (large next stage, fresh context/headroom, done-a-lot/long-session, clean boundary, half-finished-risk) and the default 'while any P-predicate is TRUE-and-unblocked, CONTINUE'; (2) broadened the self-check invariant to '(D39 + D41)' so it fires before EITHER a handoff write OR a turn-pause, scanning the about-to-be-emitted stop rationale and forcing CONTINUE on any banned phrase. Verified: grep-invariant present in all 4 files, no stale '(D39).' headers, nix build .#llm-skills exit 0. NOTE: live-harness activation of the updated commands requires `home-manager switch` (the source is fixed; the deployed ~/.claude/commands copies regenerate on activation) — a deploy step, like D37."
- rootCause: "CONFIRMED + FIXED in source. The anti-laundering protections D39 added (euphemism blocklist + self-check invariant) were scoped to 'Before writing any handoff record', and the TURN-vs-RUN clause gave no objective test for 'turn/context exhaustion'. A TURN-pause (stop with NO handoff) therefore bypassed the gate entirely, letting an effort/magnitude stop be laundered as a 'context turn-pause' (reproduced this session: paused before the G34 implement stage citing 'large phase'/'fresh headroom'/'done a lot' — the exact banned euphemisms — while P-implement was TRUE-and-unblocked)."
