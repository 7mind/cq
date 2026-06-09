---
ledger: decisions
counters:
  milestone: 0
  item: 59
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
---

# decisions

## M86

### K44 — locked

- createdAt: 2026-06-07T19:55:48.265Z
- updatedAt: 2026-06-07T19:55:48.265Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: "Pi dispatch trigger: a Pi-side context asset MAY carry the harness-agnostic dispatch instruction; cq command prompts stay byte-unchanged"
- rationale: "Resolves R265's new_question from the LOCKED answers + repo grounding (no fresh user input needed). Q126 (\"prompts work unchanged in all harnesses\") constrains the SHARED cq command prompts in nix/pkg/cq-assets (which encode only Claude Agent/subagent_type + Codex multi_agent, no Pi branch) — it does NOT constrain Pi's own system context. pi-context.md (nix/pkg/llm-contexts/pi-context.md) and an APPEND_SYSTEM-style Pi asset are ALREADY harness-specific, additive, Pi-only assets — not cq command prompts and not consumed by Claude/Codex. Therefore the dispatch trigger may be supplied two complementary ways, BOTH in scope and BOTH honoring Q126: (1) PRIMARY — register the Pi tool with a call shape/name that matches what the shared prompts ALREADY say (agent name + task [+ isolation:worktree]) per the locked Q130 recommendation, so the existing wording itself can fire it; (2) PERMITTED SUPPLEMENT — add a harness-agnostic dispatch instruction to a Pi-SIDE asset (pi-context.md / an APPEND_SYSTEM addition) telling the Pi model HOW to map the prompts' named-agent+task convention onto the dispatch tool. What stays byte-identical: every file under nix/pkg/cq-assets (commands + agents + skills) and the Claude/Codex wiring. What may change: Pi-side assets (pi-context.md / APPEND_SYSTEM) and nix/hm/dev-llm.nix programs.pi wiring. T224's dispatch design and T226/T227's end-to-end demo are bound by this decision (the demo drives the UNCHANGED cq prompt under Pi and asserts via git diff that nix/pkg/cq-assets is untouched)."
- ledgerRefs: ["goals:G28"]

### K45 — locked

- createdAt: 2026-06-07T20:20:28.362Z
- updatedAt: 2026-06-07T20:20:28.362Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: "plan review: approved"
- rationale: Reviewer go-ahead (R268, round 4) — unanimous opus + grok + codex (minimax abstained, no API key); no new_questions, no criticism, no defects. G28 plan (work milestones M87-M91, tasks T221-T229) is fine-grained, sequenced, testable, grounded, and complete to Q128's acceptance bar; milestone DAG acyclic and consistent with task dependsOn. G28 plan LOCKED/approved.
- ledgerRefs: ["goals:G28"]

### K46 — locked

- createdAt: 2026-06-07T20:50:42.751Z
- updatedAt: 2026-06-07T20:50:42.751Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: K46 — Pi dispatch extension reads cq.toml at runtime via $CQ_CONFIG (default $CQ_PROJECT_ROOT/cq.toml) with an INLINED flat-table TOML reader + INLINED resolver (Route A; no cross-workspace import)
- rationale: "T228 deliverable. The dispatch extension is a standalone store-path .ts loaded by the pi runtime (jiti) via programs.pi.settings.extensions — NOT in the @cq/cq-ledgers workspace, so it CANNOT import @cq/config/@cq/ledger at runtime (rejected option B) and must NOT bake values at build time (rejected option C). CHOSEN (Route A): the extension locates cq.toml via env var CQ_CONFIG (else $CQ_PROJECT_ROOT/cq.toml, else process.cwd()/cq.toml), with CQ_CONFIG/CQ_PROJECT_ROOT set on the piWrapped wrapper in nix/hm/dev-llm.nix ALONGSIDE CQ_AGENTS_DIR (T222). It parses [tiers]+[agent_tiers] with an INLINED, dependency-free reader for cq.toml's flat string-table subset ([table] headers + key=\"value\"; do NOT import smol-toml — a workspace dep the store-path extension can't resolve). The agent-name->tier->provider+model resolution is an INLINED tiny helper mirroring @cq/config's resolveAgentTier/resolveTierToken/resolveAgentModel (copied, not imported); T224's tests assert it matches @cq/config on the same cq.toml. Missing cq.toml / unlisted agent / absent table -> fall back to the parent pi session's active model. CONSUMPTION: T224 implements the extension's config read against THIS contract and T225 reuses the SAME inlined helper — neither re-decides the access strategy; both cite K46. Full backing note: docs/drafts/20260607-2049-pi-runtime-config-access.md."
- ledgerRefs: ["goals:G28","tasks:T224","tasks:T225"]

## M92

### K47 — locked

- createdAt: 2026-06-08T01:01:35.528Z
- updatedAt: 2026-06-08T01:01:35.528Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: "plan review: approved"
- rationale: Reviewer go-ahead on the G29 plan (work milestone M94, tasks T231-T239), ref review R278 — opus + codex + grok all go-ahead, all 9 R277 criticisms verified resolved; DAG acyclic, fine-grained/sequenced/testable/grounded/complete, honors locked Q132-Q136. Locking the plan; G29 -> planned.
- ledgerRefs: ["goals:G29"]

## M95

### K48 — locked

- createdAt: 2026-06-08T08:24:44.646Z
- updatedAt: 2026-06-08T08:24:56.207Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: "G31 plan review: approved"
- rationale: "G31 (fix D38 — pin the cq verdict enum on the Pi subagent path) reached unanimous go-ahead (R281) after a 3-round planner↔reviewer loop (R279 revise → R280 revise → R281 go-ahead). Locked plan: work milestone M96, tasks T240 (reinforce verdict enum in pi-context.md), T241/T242 (symmetric fail-loud off-enum→abstention validation in plan/advance.md + implement/advance.md, no synonym coercion), T243 (verify: bun run check + scoped nix build), T244 (documented why-it-can-no-longer-mis-gate argument). All tasks ledgerRef defects:D38."
- ledgerRefs: ["goals:G31"]

## M93

### K49 — locked

- createdAt: 2026-06-08T08:54:05.369Z
- updatedAt: 2026-06-08T08:54:05.369Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: "G30 plan review: approved"
- rationale: "G30 (add a `user-action-required` handoff status + thread it through the flow prompts) reached unanimous go-ahead (R284) after a 3-round planner↔reviewer loop (R282 revise → R283 revise → R284 go-ahead). Locked plan: 5 work milestones M97-M101, 12 tasks T245-T256. Honors locked answers Q137 (token=user-action-required, terminal), Q138 (narrow legal stop + anti-laundering, no-effort-gate intact), Q139 (distinct from answers-required, mixed via handoffReasons, 4 prompt tables), Q140 (no new schema field), Q141 (in-place schema edit, no backup-reinit, preserve HO records — committed: constants.ts + CI fixture test; operational: gitignored ledgers.yaml on main checkout), Q142 (warning bucket render + schema unit/grep-invariant/render tests + bun run check + scoped nix build)."
- ledgerRefs: ["goals:G30"]

## M102

### K51 — locked

- createdAt: 2026-06-08T11:18:52.721Z
- updatedAt: 2026-06-08T11:18:52.721Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: "G32 plan review: approved"
- rationale: "G32 (fix D39 — enforce handoff stop-gate invariants at write time + close the turn-vs-run blind spot) reached go-ahead (R313) after a 4-round planner↔reviewer loop (R310 revise → R311 revise → R312 revise → R313 go-ahead; opus go-ahead rounds 1-4, codex go-ahead round 3). Locked plan: 4 work milestones M103-M106, 9 tasks T257-T265. Design: a handoffs-specific PURE assertHandoffInvariants helper in @cq/ledger store/core.ts (modelled on assertQuestionAnswerPrecondition/D29 + assertGoalPhasePreconditions/F2; mixed/answers-required⇒non-empty blockingQuestions, user-action-required⇒non-empty handoffReasons, else SchemaValidationError), invoked in applyCreateItem (both stores route through it) + applyUpdateItem; NOT a generic schema DSL (core.ts:790 out-of-scope); the schema field stays required:false (conditional-on-status). Reproduce-first; dual-adapter tests reproducing HO26 as an asserted throw; advance.md + 3 per-flow prompts get the turn-vs-run clause + euphemism blocklist + self-check + enforced-invariant prose; 8-cell grep-invariant; verify gate. Stretch (cross-ledger open-question resolution + drained predicate-gate) deferred (T260, zero-code). All tasks ledgerRef defects:D39."
- ledgerRefs: ["goals:G32"]

## M108

### K54 — locked

- createdAt: 2026-06-08T17:24:03.339Z
- updatedAt: 2026-06-08T17:24:03.339Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "G34 plan review: approved"
- rationale: "G34's plan (W1 rename M109 / W2 cq-config [tiers] inversion M110 / W3 Agents codegen+tab M111 / W4 verify M112; tasks T267–T281) reached unanimous go-ahead at review round 2 (R325) from the surviving reviewer panel opus[claude] + minimax[pi:ollama-cloud], after one revise round (R324, 10 criticisms) that added the `## Catalogue` structured source-of-truth convention (T275/T281), fixed the W3 dependency chain, and tightened acceptances. The grok-build reviewers (grok+codex) abstained as a documented operational stall this run. Honors locked answers: Q145 (web-only), Q146 (rename label + internal ids/testids/CSS), Q147 (build-time codegen from cq-assets), Q148 (all roles, default/N/A for non-configurable), Q149 ([tiers] as classifier, resolveTierToken removed / classifyToken+selectTokensForTier added, include claude mappings), Q150 (token-keyed inline [tiers], breaking, no migration). Plan locked; G34 -> planned."
- ledgerRefs: ["goals:G34"]

### K55 — locked

- createdAt: 2026-06-08T17:39:51.804Z
- updatedAt: 2026-06-08T17:39:51.804Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "G34 follow-up plan (privilege class + exposed tools) review: approved"
- rationale: "The follow-up extension to G34 (add per-role PRIVILEGE class RO/RW + EXPOSED TOOLS to the Agents-tab cards) reached unanimous go-ahead at review R326 (panel opus[claude] + minimax[pi:ollama-cloud]; grok-build excluded as a documented operational stall). Per locked answers Q151-Q153 the two fields are DERIVED MECHANICALLY (not authored): subagent privilege = RW iff none of {Write,Edit,MultiEdit,NotebookEdit,Bash} in disallowedTools else RO; command privilege = RW iff allowed-tools contains {Write,Edit,Bash} else RO; exposed tools shown RAW per-kind (disallowedTools+isolation for subagents / allowed-tools for commands / 'none declared'); the T275 parser is extended to read command allowed-tools. The extension folds into the existing W3 tasks T275/T276/T278/T279/T281 (no new tasks) and leaves the R325-approved base (W1/W2/W4, decision K54) and its sequencing intact. Known faithful consequence (recorded, not a defect): implement-reviewer's frontmatter omits Bash, so the strict rule derives it RW. G34 -> planned (extends K54)."
- ledgerRefs: ["goals:G34"]

### K57 — locked

- createdAt: 2026-06-08T23:46:57.362Z
- updatedAt: 2026-06-08T23:46:57.362Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "G34 follow-up #2 plan LOCKED (go-ahead R343): live-model Agents-tab overlay via runtime get_agent_models"
- rationale: "Plan for G34 follow-up #2 locked after a 2-round multi-planner/reviewer cycle (planners opus+minimax synthesized by the orchestrator, grok abstained; reviewers opus go-ahead + minimax abstained R2, grok/codex abstained — no API keys). 3 work milestones (M116 server / M118 web / M120 codegen), 10 tasks T283-T300. Architecture: NEW dedicated get_agent_models MCP tool (server-resolved 4-state overlay: resolved/not-configured/no-live-token/not-model-configurable) over the fixed 19-role roster keyed by AgentRole.id; ledger-web overlays it and DROPS the build-time model/modelMappings entirely (Q155), rendering distinguished labels (incl. 'default / not configured' on overlay-unavailable) with a catch-ANY-error fallback. R341 corrected the candidate planners' KEEP-as-fallback misread of Q155 + a LedgerToolError-narrowing gap + a false enum-identity claim + test-coverage gaps; R343 confirmed go-ahead."
- ledgerRefs: ["goals:G34"]

## M113

### K56 — locked

- createdAt: 2026-06-08T20:45:22.441Z
- updatedAt: 2026-06-08T20:45:22.441Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "G35 plan review: approved"
- rationale: "G35 (defect-seeded fix for D42 — fail-loud on duplicate-token [tiers] classification in parseTiers) reached go-ahead at plan review (opus[claude] authoritative; grok-build stall, minimax not run for this tiny fully-specified plan). Locked plan: 1 work milestone M114, 1 task T282 (parseTiers throws CqConfigError naming both conflicting keys on a duplicate-token classification + tests: dup-throws, single-no-throw, existing-fixtures-still-parse). Grounded in confirmed root cause H30. G35 -> planned."
- ledgerRefs: ["goals:G35"]

## M115

### K58 — locked

- createdAt: 2026-06-08T23:47:06.291Z
- updatedAt: 2026-06-08T23:47:06.291Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "G36 plan LOCKED (go-ahead R344): optional thinking-effort suffix in cq model-identifier tokens"
- rationale: "Plan for G36 locked after a 2-round multi-planner/reviewer cycle (planners opus+minimax synthesized, grok abstained; reviewers opus+minimax both go-ahead R2, grok/codex abstained — no API keys). 3 work milestones (M117 @cq/config core / M119 wire+extension / M121 docs+check), 8 tasks T284-T298. Locked design: trailing ':<effort>' off the LAST colon (Q160), gated by isEffort(harness,suffix) so opus-4.8[1m] stays unambiguous; ':' RESERVED in BOTH model halves; FIXED VALIDATED PER-HARNESS enums (Q161 — PI_EFFORTS off/minimal/low/medium/high/xhigh, CLAUDE_EFFORTS low/medium/high/xhigh/max) w/ fail-fast; effort IS part of token identity (reviewerTokensEqual; Q162); pi emits effort via the '--model provider/model:<effort>' SHORTHAND (R342 correction — NOT a --thinking flag), claude path inert in the pi-extension (Q163); optional effort on get_planners/get_reviewers/get_config (Q164). R342 corrected the wrong '--thinking' emission + 2 spurious dependsOn edges + the pi-model-half colon-reservation gap; R344 confirmed go-ahead."
- ledgerRefs: ["goals:G36"]

## M122

### K59 — locked

- createdAt: 2026-06-09T10:05:22.355Z
- updatedAt: 2026-06-09T10:05:22.355Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "G37 plan review: approved (R364 go-ahead) — D43 fix LOCKED"
- rationale: "G37 (defect-seeded fix for D43 — worktree-confine implement-worker + commit ledger after planning-lock and every merge) reached reconciled go-ahead at review round 2 (R364; panel opus[claude] + minimax[pi:ollama-cloud], both go-ahead; grok+codex abstained — no API key) after one revise round (R363, 6 criticisms). Locked plan: 3 work milestones M123/M124/M125, 7 tasks T301-T307 decomposing the Q166-locked fix (1b worker-confined-reset + commit-after-planning-lock + commit-after-every-merge + autonomous): T301 worktree-confinement hard Boundary in implement-worker.md (part a, general cross-checkout-git prohibition); T302 commit-after-planning-lock in plan/advance.md + T303 commit-after-every-merge-back in implement/advance.md §7 + T304 chained-path clause in advance.md (part b, override chained-suppression for THESE checkpoints only); T305 documented reflog repro (reproduction-first) + T306 file-scoped grep-invariant guard (4 distinct (file,marker) cells, extending the T255/T264 pattern) + T307 final verify. R363 fixes: T307+G37 nix-build claim demoted to a smoke — SUBSTANTIVE gate = bun run check + the T306 grep-invariant (cq-assets eval-time-only; matches the G31/R281 adjudication); T304 distinct-marker; T306 file-scoped; T301 generalized prohibition; T305 reproduction-first narration; live-activation home-manager-switch kept as a user follow-up note. DAG acyclic (T304→T303; T306→T301-T304; T307→T305+T306; rest no-dep). Resolves D43; every task ledgerRefs defects:D43. G37 → planned."
- ledgerRefs: ["goals:G37","defects:D43"]
