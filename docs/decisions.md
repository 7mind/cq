---
ledger: decisions
counters:
  milestone: 0
  item: 69
archives:
  - id: M2
    path: ./archive/decisions/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: TUI + web UI improvements
    status: done
  - id: M3
    path: ./archive/decisions/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
    title: Build /implement:* command family
    status: done
  - id: M4
    path: ./archive/decisions/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
    title: Plan-flow maintenance and improvements
    status: done
  - id: M15
    path: ./archive/decisions/M15.md
    summary: "G3 coordination — COMPLETE (auto-archived by the new milestone-sweep rule, T129). Goal G3 (plan/implement flow-behavior changes: auto-investigate + never-auto-close-goals) done; work milestones M16/M17 archived; decisions K10/K12 (K12 supersedes K8 pt3); questions Q42-Q47 answered; reviews R31/R32."
    title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
    status: done
  - id: M20
    path: ./archive/decisions/M20.md
    summary: G4 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G4 (D2 backup-and-reinit on schema divergence) done; work milestone M22 archived; decision K15; reviews R75/R76. D2 resolved.
    title: "Plan: fix D2 — graceful backup-and-reinit on ledger schema divergence"
    status: done
  - id: M23
    path: ./archive/decisions/M23.md
    summary: G5 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G5 (@cq/ledger packaging + UI-eligibility defects D3-D6) done; work milestones M24/M25/M26 archived; decision K16; reviews R77/R78. D3-D6 resolved.
    title: "Plan: @cq/ledger packaging + UI-eligibility defect cleanup (D3-D6)"
    status: done
  - id: M1
    path: ./archive/decisions/M1.md
    summary: G1 coordination — COMPLETE. Goal G1 (build the /implement:* command family) done; work milestones M3/M6/M7/M8/M9 archived; clarifying questions answered, reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: /implement:* command family"
    status: done
  - id: M10
    path: ./archive/decisions/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/decisions/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M29
    path: ./archive/decisions/M29.md
    summary: G7 coordination — COMPLETE. Goal G7 (fix confirmed dogfood UI/store defects D14-D19) done; work milestone M30 archived; defects D14-D19 resolved; reviews + approval decision (K19) terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix confirmed dogfood UI/store defects (D14-D19)"
    status: done
  - id: M35
    path: ./archive/decisions/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
  - id: M56
    path: ./archive/decisions/M56.md
    summary: "G15 Feature 2 (pluggable parallel reviewers) built+merged: pi non-interactive spike confirmed (K30 invocation contract) (T169); @cq/config cq.toml parser package (T170) + cq-config MCP server exposing get_reviewers + Nix package (T171); registered in dev-llm.nix + .mcp.json (T172); shared /cq:plan-review (T173) + /cq:implement-review (T174) rubrics; reconciliation (strictest-wins+union-with-source-tags, get_reviewers MCP tool, pi shellout) wired into plan/advance.md (T175) + implement/advance.md (T176); /cq:reviewers session-only override (T177); cq.toml.example + cq/* link entries + README (T178). Tasks T169-T178 done, reviews go-ahead, K30 locked. Integrated bun run check green 930/0; all new asset symlinks resolve."
    title: G15 W2 — Pluggable parallel reviewers (cq.toml + cq-config MCP + pi shellout)
    status: done
  - id: M37
    path: ./archive/decisions/M37.md
    summary: G10 (fix D13 TUI nav perf + D23 test flake) closed done; coordination milestone archived — all items terminal.
    title: "Plan: fix D13 (TUI nav perf — memo boundaries) + D23 (multi-step-form test flake)"
    status: done
  - id: M39
    path: ./archive/decisions/M39.md
    summary: G12 (fix D24 's'-key-inert archived-item test) closed done; coordination milestone archived — all items terminal.
    title: "Fix: vacuous 's'-key-inert archived-item test (restores D22)"
    status: done
  - id: M40
    path: ./archive/decisions/M40.md
    summary: "G11 (agent-ergonomic ledger MCP: snapshot + handoffs + sessionLogs + click-protection) closed done; coordination milestone archived."
    title: "Plan: agent-ergonomic ledger MCP (state-overview endpoint + better descriptions)"
    status: done
  - id: M47
    path: ./archive/decisions/M47.md
    summary: G13 (fix D25/D26/D27 G11 follow-up cleanup) closed done; coordination milestone archived.
    title: "Plan: fix D25/D26/D27 (G11 follow-up cleanup)"
    status: done
  - id: M49
    path: ./archive/decisions/M49.md
    summary: G14 (fix D28 readLog TOCTOU) closed done; coordination milestone archived.
    title: "Plan: fix D28 (readLog TOCTOU)"
    status: done
  - id: M51
    path: ./archive/decisions/M51.md
    summary: G15 (explorer RW prober + pluggable parallel reviewers via cq.toml) closed done; coordination milestone archived.
    title: "Plan: explorer RW access + pluggable parallel reviewers (cq.toml)"
    status: done
  - id: M53
    path: ./archive/decisions/M53.md
    summary: G16 (fix D29 reject empty answer on `answered`) closed done; coordination milestone archived.
    title: "Plan: fix D29 (reject empty answer on question `answered`)"
    status: done
  - id: M57
    path: ./archive/decisions/M57.md
    summary: G17 (fix D30 link-prompts stale llm/ root) closed done; coordination milestone archived.
    title: "Plan: fix D30 (link-prompts stale `llm/` root → dangling symlinks)"
    status: done
  - id: M59
    path: ./archive/decisions/M59.md
    summary: G18 (merge cq-config into ledger MCP + parallel planners) closed done; coordination milestone archived.
    title: "Plan: merge cq-config into ledger MCP + parallel planners"
    status: done
  - id: M63
    path: ./archive/decisions/M63.md
    summary: G19 (fix D32 README cq-config repoint) closed done; coordination milestone archived.
    title: "Plan: fix D32 (README cq-config repoint)"
    status: done
  - id: M65
    path: ./archive/decisions/M65.md
    summary: G20 (cq.toml [webui] + cq CLI init/reset/erase) closed done; coordination milestone archived.
    title: "Plan: cq.toml [webui] + cq CLI (init/reset/erase)"
    status: done
  - id: M66
    path: ./archive/decisions/M66.md
    summary: G21 (fix D31 modal backdrop press-started dismiss) closed done; coordination milestone archived.
    title: "Plan: fix D31 (modal backdrop press-started-inside dismiss)"
    status: done
  - id: M70
    path: ./archive/decisions/M70.md
    summary: "G22 (sidebar reorder + help-size + SVG align + cq: renames) closed done; coordination milestone archived."
    title: "Plan: sidebar reorder + help-size + SVG align + cq: command renames"
    status: done
  - id: M74
    path: ./archive/decisions/M74.md
    summary: G23 (flow state-machine docs + Flows help tab) closed done; coordination milestone archived.
    title: "Plan: flow state-machine docs + Flows help tab"
    status: done
  - id: M75
    path: ./archive/decisions/M75.md
    summary: G24 (fix D33 left-align cyclic state-machine diagrams) closed done; coordination milestone archived.
    title: "Plan: fix D33 (sm-diagram layer-0 left gap)"
    status: done
  - id: M80
    path: ./archive/decisions/M80.md
    summary: G25 (retire legacy skills + clean cq references) closed done; coordination milestone archived.
    title: "Plan: retire legacy skills + clean cq references"
    status: done
  - id: M81
    path: ./archive/decisions/M81.md
    summary: G26 (render session-log markdown in a popup) closed done; coordination milestone archived.
    title: "Plan: render session logs as markdown in a popup"
    status: done
  - id: M82
    path: ./archive/decisions/M82.md
    summary: G27 (fix D34 top-bar progress counts withdrawn; + D35 client wiring) closed done; coordination milestone archived.
    title: "Plan: fix D34 (top-bar progress counts withdrawn)"
    status: done
  - id: M94
    path: ./archive/decisions/M94.md
    summary: "G29 provider-qualified pi token grammar COMPLETE: T231-T239 all merged + reviewed; D36 RESOLVED. pi:<provider>/<model> slash grammar (bare rejected) threaded through @cq/config (parseReviewerToken + resolvers), the @cq/ledger(-mcp) config-capability surface, and the cq-subagent-dispatch extension mirror (K50 cross-layer guard); cq.toml.example migrated + documented; fixtures adapted; final gate green (bun run check 1089/0 + nix builds + bare-pi audit clean). ACTIVATION TAIL: live cq.toml migration + get_config spot-check deferred to the rebuilt-MCP restart."
    title: "G29 W: provider-qualified pi token grammar"
    status: done
  - id: M103
    path: ./archive/decisions/M103.md
    summary: "G32 W1 COMPLETE: write-time handoff invariant enforcement. assertHandoffInvariants pure helper (core.ts) wired into applyCreateItem+applyUpdateItem (both adapters); mixed/answers-required⇒non-empty blockingQuestions, user-action-required⇒non-empty handoffReasons, else SchemaValidationError. Dual-adapter tests reproduce HO26 as an asserted throw. K52 deferred the stretch hardenings. T257-T260 done, R314-R317 go-ahead."
    title: "G32 W1: write-time handoff invariant enforcement (@cq/ledger, load-bearing)"
    status: done
  - id: M86
    path: ./archive/decisions/M86.md
    summary: G28 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Enabled pi-harness subagent support for the cq flow; work milestones M87-M91 delivered (K44-K46 decisions, R265-R268 reviews). Closed + archived in the post-G37 cleanup sweep.
    title: "Plan: pi-agent subagent support for cq flow"
    status: done
  - id: M92
    path: ./archive/decisions/M92.md
    summary: G29 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Provider-qualified pi token grammar (pi:<provider>/<model>); D36 resolved; work milestone M94 delivered (K47, R277-R278). Archived in the post-G37 cleanup sweep.
    title: "Plan: provider-qualified token support in cq config"
    status: done
  - id: M93
    path: ./archive/decisions/M93.md
    summary: G30 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Added the user-action-required handoff status threaded through the flow prompts/schema; work milestones M97-M101 delivered (K49, R282-R284). Archived in the post-G37 cleanup sweep.
    title: "Plan: user-action-required handoff status"
    status: done
  - id: M95
    path: ./archive/decisions/M95.md
    summary: G31 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Fixed D38 (pinned the cq verdict enum on the Pi subagent path + fail-loud off-enum validation); work milestone M96 delivered (K48, R279-R281). Archived in the post-G37 cleanup sweep.
    title: "Plan: fix D38 — pin verdict enum on the Pi subagent path"
    status: done
  - id: M102
    path: ./archive/decisions/M102.md
    summary: G32 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Fixed D39 (write-time handoff stop-gate invariant enforcement + turn-vs-run clause + euphemism blocklist); work milestones M103-M106 delivered (K51, R310-R313). Archived in the post-G37 cleanup sweep.
    title: "Plan: fix D39 — enforce handoff stop-gate invariants (make effort-stops unwritable)"
    status: done
  - id: M108
    path: ./archive/decisions/M108.md
    summary: G34 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Help-popup Item-States rename + Agents tab + cq.toml [tiers] triplet mapping + the two follow-ups (privilege/exposed-tools; live-model runtime overlay via get_agent_models); work milestones M109-M112/M116/M118/M120 delivered (K54/K55/K57, R324-R343). Archived in the post-G37 cleanup sweep.
    title: "Plan: help-popup item-states rename + Agents tab + tiers triplet mapping"
    status: done
  - id: M113
    path: ./archive/decisions/M113.md
    summary: G35 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Fixed D42 (fail-loud on duplicate-token [tiers] classification in parseTiers); work milestone M114 delivered (K56, T282). Archived in the post-G37 cleanup sweep.
    title: "Plan: fix D42 — fail-loud on duplicate-token [tiers] classification in parseTiers"
    status: done
  - id: M115
    path: ./archive/decisions/M115.md
    summary: G36 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Optional thinking-effort suffix in cq model-identifier tokens; work milestones M117/M119/M121 delivered (K58, R342-R344). Archived in the post-G37 cleanup sweep.
    title: "Plan: optional thinking-effort suffix in cq model-identifier tokens"
    status: done
  - id: M134
    path: ./archive/decisions/M134.md
    summary: "G38 follow-up #1 (ledger-web help-popup UX + deepened Flows tab) COMPLETE. 6 tasks: T324 FU-2 (.lw-help hard 90vw×90vh + pinned head), T325 FU-1 (AgentModelCell stale-server message), T326 FU-4 renderer+data foundation (agentId on DiagramNode/RoleNode + exported RoleKind/ROLE_KIND_FILL/fillForRoleKind + clickable/keyboard DiagramSvg nodes; renderer fill unchanged per Q181), T327 FU-4a/c/d catalogue (agentId map ∈ AGENT_ROLES + all formalized ops as edges/worktree-main-ledger infra nodes grounded in cq-assets prompts + roleKind fills), T328 FU-3 (HelpDocsLayout sidebar + IntersectionObserver scrollspy + exported scrollToHelpSection), T329 FU-4b/d (agentId-node cross-nav to Agents tab + roleKind legend). Reviews R392-R397 go-ahead (T325 took 1 criticism round). Merged 04cc14d/82c0b66/fe7205f/b2a9b9f/891a39f/768a10d. bun run check green 1368/0; nix build .#ledger-web exit 0. FU-1's underlying Agents-tab display issue is a deploy action (rebuild+restart), out of scope."
    title: "G38 follow-up #1 — ledger-web help-popup UX + deepened Flows tab"
    status: done
  - id: M122
    path: ./archive/decisions/M122.md
    summary: "G37 (Fix D43 — worktree-confine implement-worker + commit ledger after planning-lock and every merge) DONE: cq-assets prompt edits landed (T305–T307), grep-invariant guard + documented repro green under bun run check; D43 resolved. Goal closed; coordination milestone archived."
    title: "Plan: fix D43 — worktree-confine implement-worker + commit ledger after planning/every-merge"
    status: done
  - id: M132
    path: ./archive/decisions/M132.md
    summary: "G39 (Fix D45 — mirror docs/ledgers.yaml on the 'create' op in cacheMirror) DONE: cacheMirror.ts mirrors layout.registryPath on op==='create'||'archive' + XDG_CACHE_HOME-redirected byte-equality test (T323); D45 resolved. Goal closed; coordination milestone archived."
    title: "Plan: fix D45 — cache mirror omits ledgers.yaml on createLedger"
    status: done
  - id: M139
    path: ./archive/decisions/M139.md
    summary: "G41 item 2 COMPLETE (formal typed MCP prompt catalog): T336 typed PromptCatalogEntry model + RoleKind split + plan-advance JSON Schemas in @cq/config (Ajv2020 + FOD refresh; K65 locked); T341 catalog store + 7 dispatched-role schema sidecars + gen-agents emits typed schemas (deterministic, drift-guarded, ledger-mcp-importable); T343 fetch_prompt/validate_input/validate_output MCP tools (both stdio+SDK factories); T344 plan-advance dispatch wired through the catalog (proof) + Agents tab renders typed schemas; T345 all 7 dispatched subagents wired at plan/implement/investigate advance.md + duplicated prose ioSchema removed. Reviews R410-R414 go-ahead. bun run check green (1486). Merged bcafd66/b502a61/dc87ba7/c2fa526/a873912."
    title: G41-2 Formal typed MCP prompt catalog
    status: done
  - id: M140
    path: ./archive/decisions/M140.md
    summary: "G41 item 3 COMPLETE (orphan-branch feasibility SPIKE): T337 — verdict FEASIBLE-WITH-CAVEATS (GO) in locked decision K66, with an executed throwaway PoC proving the pure git-plumbing path (hash-object→scratch-index write-tree→commit-tree→CAS update-ref) advances an orphan ledger ref while the main checkout HEAD/worktree/index stay byte-identical; findings doc docs/drafts/20260609-221530-orphan-ledger-feasibility.md + PoC under debug/; no production code. A separate follow-up goal would implement a GitObjectLedgerBackend + drop the per-merge chore(ledger) commits + explicit push/fetch of the orphan ref. Review R415 go-ahead. Merged e108827."
    title: G41-3 Ledger-on-orphan-branch feasibility spike
    status: done
---

# decisions

## M126

### K60 — locked

- createdAt: 2026-06-09T12:37:00.524Z
- updatedAt: 2026-06-09T12:37:00.524Z
- author: "opus-4.8[1m]"
- session: 242ca46f-d593-40f1-9dc2-480c12cf887c
- headline: "G38 plan review: approved (R374 go-ahead) — flow-hardening + UI plan LOCKED"
- rationale: "G38 (4 bundled work items, all 7 clarifying questions Q167-Q173 answered 'as recommended') reached reconciled go-ahead at review round 3 (R374; full panel opus[claude] + codex/grok/minimax[pi]; opus+codex+minimax go-ahead, grok's lone revise ADJUDICATED non-blocking as a verification artifact — it judged the round-3 prompt's recap shorthand, not the live ledger, and every cited point is satisfied in the actual task items) after two revise rounds (R372: 12 substantive criticisms incl. the LOAD-BEARING gen-agents-catalogues-commands finding; R373: 3 precision nits). Multi-planner synthesis (opus[claude]+grok+minimax[pi] candidates, orchestrator-synthesized + persisted). Locked plan: 5 work milestones M127-M131, 14 active tasks (T308/T309/T310/T322/T311; T312/T313; T315/T316; T318/T319; T321), 3 abandoned (T314/T317/T320 folded into owners), + defect D44 (low) for item 3. Decomposition: (1a, prompt-only, M127) T308 advance.md §7.3 explicit `git worktree remove --force + branch -D + prune` after the per-task done write (marker G38-1a-post-done-cleanup) + T309 §1 start-of-pass orphan/locked sweep excluding blocked/wip (G38-1a-start-sweep) + T310 implement-worker.md alignment (G38-1a-worker-ephemeral) + T322 gen-agents regen (advance.md+worker.md ARE catalogued into agentsCatalogue.gen.ts — R372/opus, verified) + T311 file-scoped grep-invariant cells over sources AND the generated gen.ts. (1b, M128) T312 @cq/ledger onMutation-driven atomic post-lock non-blocking ~/.cache mirror via a SHARED cacheMirrorDir(absRoot)=${XDG_CACHE_HOME:-~/.cache}/cq/ledgers/${basename}-${sha256(absRoot).slice(0,12)} + T313 `ledger-mcp restore --from-cache [--cwd]` positional subcommand reusing cacheMirrorDir + updating the main.ts header boundary. (2, web-only, M129) T315 hand-authored roleActions.ts ROLE_FLOWS (role nodes + labeled action edges as DiagramModel) + T316 render the Flows tab from ROLE_FLOWS via the existing elk DiagramSvg, REPLACING the flowData state diagrams, testids preserved. (3, defect-aware, M130) T318 LIST-focus PgUp/PgDn page cursor by listInnerH + Home/End jump first/last + remove no-Enter detail-scroll + module-level matchHomeEnd(input) ESC helper + T319 CONTENT-focus Home/End reusing the helper; both ledgerRef defects:D44. (M131) T321 cross-cutting verify (bun run check + grep the 3 markers + nix build ledger-mcp/-tui/-web + §5 intact). DAG acyclic (T309→T308 same-file serialization; T322→T308/T309/T310; T311→T322; T313→T312; T316→T315; T319→T318; T321→T311/T313/T316/T319). G38 → planned."
- ledgerRefs: ["goals:G38","defects:D44"]

## M135

### K64 — locked

- createdAt: 2026-06-09T19:42:20.232Z
- updatedAt: 2026-06-09T19:42:20.232Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "G41 plan review: approved (R400 go-ahead) — 5-item next-batch plan LOCKED"
- rationale: |
    G41 (5 bundled items, all 6 clarifying questions Q183-Q188 answered) reached reconciled go-ahead at review round 2 (R400; full panel opus[claude]+codex+grok+minimax[pi]; opus+grok+minimax go-ahead, codex's lone revise ADJUDICATED — its #2 cq.toml.example-sync + #3 ideas-no-milestone-assertion were valid and APPLIED to T331/T335, its #1 milestone-dep concern is a defensible design choice that correctly encodes Q183's quick-wins-first ordering) after one revise round (R399: 12 substantive criticisms). Multi-planner synthesis (opus[claude] base + grok+minimax[pi] fold-ins, orchestrator-synthesized + persisted). Per Q183 the 5 items are INDEPENDENT work milestones sequenced quick-first (advisory milestone dependsOn encodes the order, not a technical prereq). LOCKED plan: 5 work milestones M136-M140, 15 tasks T331-T345.
    
    M136 (cq init cq.toml, Q184): T331 hand-authored CQ_TOML_TEMPLATE in cq-cli (opus/sonnet[claude:sonnet-4.6]/haiku[claude:haiku-4.5] active, pi commented; cq.toml.example is an existing read-basis, updated to stay consistent; no TOML serializer → literal) → T338 runInit writes cq.toml, skip-with-message if exists, --force overwrites (Q184 literal; symlink special-casing removed).
    
    M137 (Flows-tab polish, web, Q187): T332 underline activatable node labels in DiagramSvg; T333 derive zero-outgoing-edge→terminal:true in roleActions.ts (DiagramSvg already keys rx on n.terminal) all 4 flows; T334 RENDERING fix for overlapping parallel same-pair edge labels (reproduce-first layout test → fix diagramLayout elk routing + per-index labelPos) + distinct trigger label text + docs/drafts labels note.
    
    M138 (Ideas ledger + idea-id grammar, Q188): T335 IDEAS_SCHEMA in CANONICAL_LEDGERS (idPrefix I, title+description, statuses open|planned|discarded|postponed, terminalStatuses=[planned,discarded], postponed→open; attach to M-AMBIENT, flat render, no user milestones) → T339 ledger-web 'Ideas' SIDEBAR_GROUP above goals + flat view; T340 plan.md I-id grammar (EITHER /^I\d+$/ ids OR free text) + one-goal-per-idea + named consume-an-idea sub-procedure (fetch→seed verbatim→bidirectional ledgerRefs→idea→planned) → T342 follow-up.md appends idea text as new scope via existing re-open path + reuses the consume sub-procedure.
    
    M139 (typed MCP prompt catalog, Q185, advisory-deps M136/M137/M138): T336 design + LOCK decisions (dispatched-subagent vs orchestrator-command role split; validator: prefer in-workspace else Ajv+flake.nix FOD refresh; per-role schema sidecar storage) + plan-advance schemas first → T341 catalog store + gen-agents-catalogue emits typed schemas for dispatched roles, importable by ledger-mcp → T343 ledger-mcp fetch_prompt/validate_input/validate_output tools → T344 prove plan-advance end-to-end + Agents tab renders typed schemas → T345 wire all dispatched dispatch sites (plan/advance, implement/advance, investigate/advance) + remove duplicated prose ioSchema.
    
    M140 (orphan-branch SPIKE-ONLY, Q186, advisory-deps M139): T337 feasibility decision+findings (+ optional throwaway PoC on a throwaway repo; hash-object/mktree/commit-tree/update-ref or linked worktree; proof main checkout HEAD+worktree byte-identical; NO prod code in packages/*/src).
    
    DAG acyclic: T338→T331; T342→T340→T335, T339→T335; T341→T336, T343→T341, T344→T343, T345→T344; milestone advisory ordering M136/M137/M138 → M139 → M140. G41 → planned.
- ledgerRefs: ["goals:G41"]

## M141

### K67 — locked

- createdAt: 2026-06-09T22:38:47.426Z
- updatedAt: 2026-06-09T22:38:47.426Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "G42 plan review: approved (go-ahead) — D47 fix plan LOCKED (single test-only task T346)"
- rationale: "Defect-seeded goal G42 (fix D47, root cause confirmed via H34, clarification skipped). Orchestrator-authored plan (the confirmed root cause + exact fix locus leave nothing for parallel candidate planners to diverge on) reviewed by a single opus plan-reviewer → go-ahead (0 criticisms; all cited symbols verified against source). LOCKED plan: 1 work milestone M142, 1 task T346 (standard). T346 (test-only, packages/ledger/test/canonical-ledgers.test.ts): (1) flip the existing committed-vs-canon guard test to `new FsLedgerStore({root, onSchemaDivergence:'abort'})` so structural drift THROWS instead of silently self-healing (default backup-reinit); (2) add a byte-equality assertion (committed docs/ledgers.yaml === serializeRegistry(CANONICAL_LEDGERS)) running under bun run check so serialization-order drift fails too; (3) exclude the intentionally-frozen examples/sample-ledger fixture; reproduce-first against a deliberately-staled fixture copy. G42 → planned."
- ledgerRefs: ["goals:G42","defects:D47"]

## M143

### K68 — locked

- createdAt: 2026-06-10T09:28:50.527Z
- updatedAt: 2026-06-10T09:28:50.527Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "G43 plan review: approved (R419 go-ahead) — GitObjectLedgerBackend plan LOCKED"
- rationale: |
    G43 (ledger-on-orphan-git-branch storage backend, the K66-spike production follow-up; all 8 clarifying questions Q189-Q196 answered) reached reconciled go-ahead at review round 2 (R419; opus[claude]+codex+minimax[pi], 3/4 panel — grok conserved on the surgical convergence round; unanimous go-ahead) after one revise round (R418: 7 substantive criticisms, all applied; pi 'mega-task' splits adjudicated non-blocking per the repo-grounded opus reviewer). Multi-planner synthesis (opus[claude] base + minimax git-env-validation fold-in). LOCKED plan: 6 work milestones M144-M149, 14 tasks T347-T360.
    
    M144 (Q190 shared-base refactor): T347 LedgerPersistence seam interface → T350 AbstractLedgerStore base (map/parse/FTS/AsyncMutex/lockfile/schema-divergence shared) → T351 FsLedgerStore = base + FsPersistence (behaviour-preserving; canonical-ledgers guard still passes; ~/.cache mirror stays FS-only). M145 (Q191): T348 GitPlumbing (hash-object→scratch-index write-tree→commit-tree→CAS update-ref/StaleRefError) → T352 GitObjectLedgerBackend (in-memory sync reads via cat-file/ls-tree at init; writes-in-lock with CAS; orphan ref; backup-tag on reinit; no cache mirror) → T353 ref-sha coherence watcher (resolves ref via git rev-parse --git-path; per-backend). M146 (Q189/Q192): T349 cq.toml [ledger] backend key (git-object|fs default fs) → T357 createLedgerStore factory at all sites + git-env fail-fast + fresh-init gitignore + capability-gate generalisation → T360 zero-frontend-change confirmation. M147 (Q193, depsOn M145+M146): T354 native `cq move-ledger --to git|local` lossless bidirectional (git rm --cached + reversible gitignore + docs left-in-place + cq.toml flip). M148 (Q194/K66-4, depsOn M146): T355 backend-guarded auto-fetch/non-forced-push of refs/heads/cq-ledger in all FOUR commands + concrete runbook (rejected-push/shallow-clone/linked-worktree fallback) → T358 make the chore(ledger) commit steps in all four commands backend-conditional. M149 (Q196, depsOn M145): T356 shared conformance suite over Fs+InMemory+Git (throwaway repo per test) → T359 git-invariant tests (byte-identical tree/HEAD/index, orphan-ref advance + parentless first, CAS stale reject, lock-not-committed, backup-tag). Milestone DAG acyclic. G43 → planned.
- ledgerRefs: ["goals:G43"]

## M146

### K69 — locked

- createdAt: 2026-06-10T12:48:25.608Z
- updatedAt: 2026-06-10T12:48:25.608Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "T360: frontends key change-detection on the WS `changed` frame only — no docs/*.md-mtime dependency (git-backend-safe), with one embedded-TUI watcher gap (→ D51)"
- rationale: |
    Read-through verification (Q192) of ledger-tui + ledger-web refresh paths. FINDING: both frontends learn of changes ONLY via the internal WS `changed` frame and refetch through MCP — NEITHER reads docs/*.md mtimes for change detection (grep of both src/ trees: zero fs.stat/mtime/watch/readdir on docs). So the frontend code itself needs ZERO change under the git-object backend.
    
    Exact refresh paths:
    - ledger-web (remote+embedded): App.tsx:750-772 LiveManager({url, onChanged:()=>refreshRef.current()}) over /ws; the `changed` frame is parsed in ledger-live/src/index.ts:242-244 (msg.type==changed → onChanged(msg.ledger)); refreshRef refetches via MCP enumerateLedgers()+reload().
    - ledger-tui (remote): app.tsx:513-534 LiveManager over /ws → onChanged → refreshRef.current() → MCP refetch.
    - `changed` frame is server-emitted backend-agnostically: ledger-mcp/src/main.ts changedFrame() on LEDGER_TOPIC; per-backend coherence watcher selected SERVER-side by startLedgerCoherenceWatcher (main.ts:319-328 — startLedgerRefWatcher for git-object, startLedgerWatcher for fs), both firing the SAME onChange → same frame. ledger-web embedded correctly uses startLedgerCoherenceWatcher (serve.ts:321).
    - All frontend DATA reads go through MCP tool calls (tui/web mcpClient.ts), never direct docs/ reads. read_log (docs/logs) is an MCP FS-only capability, not change detection.
    
    CONCLUSION: zero frontend SOURCE change for the git backend — verification holds. ONE GAP filed as D51 (out of scope per T360, not a trivial repoint): the EMBEDDED TUI wires the FS file-watcher directly (main.tsx:128 startLedgerWatcher) instead of the backend-selecting startLedgerCoherenceWatcher; EmbeddedContext (mcpClient.ts:46-50) exposes no backend descriptor. Under embedded-TUI + git-object, that watcher (purpose: catch EXTERNAL edits) watches a static docs/ and won't fire; self-edits still refetch.
- ledgerRefs: ["tasks:T360","goals:G43","defects:D51"]
