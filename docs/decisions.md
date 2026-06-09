---
ledger: decisions
counters:
  milestone: 0
  item: 61
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
---

# decisions

## M122

### K59 — locked

- createdAt: 2026-06-09T10:05:22.355Z
- updatedAt: 2026-06-09T10:05:22.355Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "G37 plan review: approved (R364 go-ahead) — D43 fix LOCKED"
- rationale: "G37 (defect-seeded fix for D43 — worktree-confine implement-worker + commit ledger after planning-lock and every merge) reached reconciled go-ahead at review round 2 (R364; panel opus[claude] + minimax[pi:ollama-cloud], both go-ahead; grok+codex abstained — no API key) after one revise round (R363, 6 criticisms). Locked plan: 3 work milestones M123/M124/M125, 7 tasks T301-T307 decomposing the Q166-locked fix (1b worker-confined-reset + commit-after-planning-lock + commit-after-every-merge + autonomous): T301 worktree-confinement hard Boundary in implement-worker.md (part a, general cross-checkout-git prohibition); T302 commit-after-planning-lock in plan/advance.md + T303 commit-after-every-merge-back in implement/advance.md §7 + T304 chained-path clause in advance.md (part b, override chained-suppression for THESE checkpoints only); T305 documented reflog repro (reproduction-first) + T306 file-scoped grep-invariant guard (4 distinct (file,marker) cells, extending the T255/T264 pattern) + T307 final verify. R363 fixes: T307+G37 nix-build claim demoted to a smoke — SUBSTANTIVE gate = bun run check + the T306 grep-invariant (cq-assets eval-time-only; matches the G31/R281 adjudication); T304 distinct-marker; T306 file-scoped; T301 generalized prohibition; T305 reproduction-first narration; live-activation home-manager-switch kept as a user follow-up note. DAG acyclic (T304→T303; T306→T301-T304; T307→T305+T306; rest no-dep). Resolves D43; every task ledgerRefs defects:D43. G37 → planned."
- ledgerRefs: ["goals:G37","defects:D43"]

## M126

### K60 — locked

- createdAt: 2026-06-09T12:37:00.524Z
- updatedAt: 2026-06-09T12:37:00.524Z
- author: "opus-4.8[1m]"
- session: 242ca46f-d593-40f1-9dc2-480c12cf887c
- headline: "G38 plan review: approved (R374 go-ahead) — flow-hardening + UI plan LOCKED"
- rationale: "G38 (4 bundled work items, all 7 clarifying questions Q167-Q173 answered 'as recommended') reached reconciled go-ahead at review round 3 (R374; full panel opus[claude] + codex/grok/minimax[pi]; opus+codex+minimax go-ahead, grok's lone revise ADJUDICATED non-blocking as a verification artifact — it judged the round-3 prompt's recap shorthand, not the live ledger, and every cited point is satisfied in the actual task items) after two revise rounds (R372: 12 substantive criticisms incl. the LOAD-BEARING gen-agents-catalogues-commands finding; R373: 3 precision nits). Multi-planner synthesis (opus[claude]+grok+minimax[pi] candidates, orchestrator-synthesized + persisted). Locked plan: 5 work milestones M127-M131, 14 active tasks (T308/T309/T310/T322/T311; T312/T313; T315/T316; T318/T319; T321), 3 abandoned (T314/T317/T320 folded into owners), + defect D44 (low) for item 3. Decomposition: (1a, prompt-only, M127) T308 advance.md §7.3 explicit `git worktree remove --force + branch -D + prune` after the per-task done write (marker G38-1a-post-done-cleanup) + T309 §1 start-of-pass orphan/locked sweep excluding blocked/wip (G38-1a-start-sweep) + T310 implement-worker.md alignment (G38-1a-worker-ephemeral) + T322 gen-agents regen (advance.md+worker.md ARE catalogued into agentsCatalogue.gen.ts — R372/opus, verified) + T311 file-scoped grep-invariant cells over sources AND the generated gen.ts. (1b, M128) T312 @cq/ledger onMutation-driven atomic post-lock non-blocking ~/.cache mirror via a SHARED cacheMirrorDir(absRoot)=${XDG_CACHE_HOME:-~/.cache}/cq/ledgers/${basename}-${sha256(absRoot).slice(0,12)} + T313 `ledger-mcp restore --from-cache [--cwd]` positional subcommand reusing cacheMirrorDir + updating the main.ts header boundary. (2, web-only, M129) T315 hand-authored roleActions.ts ROLE_FLOWS (role nodes + labeled action edges as DiagramModel) + T316 render the Flows tab from ROLE_FLOWS via the existing elk DiagramSvg, REPLACING the flowData state diagrams, testids preserved. (3, defect-aware, M130) T318 LIST-focus PgUp/PgDn page cursor by listInnerH + Home/End jump first/last + remove no-Enter detail-scroll + module-level matchHomeEnd(input) ESC helper + T319 CONTENT-focus Home/End reusing the helper; both ledgerRef defects:D44. (M131) T321 cross-cutting verify (bun run check + grep the 3 markers + nix build ledger-mcp/-tui/-web + §5 intact). DAG acyclic (T309→T308 same-file serialization; T322→T308/T309/T310; T311→T322; T313→T312; T316→T315; T319→T318; T321→T311/T313/T316/T319). G38 → planned."
- ledgerRefs: ["goals:G38","defects:D44"]
