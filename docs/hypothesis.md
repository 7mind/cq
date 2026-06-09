---
ledger: hypothesis
counters:
  milestone: 0
  item: 31
archives:
  - id: M14
    path: ./archive/hypothesis/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/hypothesis/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M27
    path: ./archive/hypothesis/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M35
    path: ./archive/hypothesis/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
  - id: M43
    path: ./archive/hypothesis/M43.md
    summary: G11 W2 (@cq/ledger-mcp tool surface) — COMPLETE. T144 fetch_ledger compact/offset/limit params (fixes 51.8KB/142.7KB overflow); T145 snapshot tool; T146 reopen_item + unarchive_item; T147 read_log (bounded, root-confined); T148 tool-count reconciliation (14→18 across all refs); T149 query-language doc clarifications. Reviews R148-R153 go-ahead. Out-of-scope defects D25/D26 filed here, both later resolved (G13). Shipped on main.
    title: G11 W2 — @cq/ledger-mcp tool surface
    status: done
  - id: M45
    path: ./archive/hypothesis/M45.md
    summary: G11 W4 (flow-prompt wiring) — COMPLETE. T153 advance.md §Provenance permits the single run-level handoffs write; T154 per-flow handoff writes with contextual /advance suppression; T155 sessionLogs population in each outcome write; T156 snapshot-first /advance bootstrap recipe. Reviews R155/R156/R158/R159 go-ahead (T154 r0 used an env var, fixed r1 → contextual). Out-of-scope defect D27 filed here, later resolved (G13). Docs/prompt-only. Shipped on main.
    title: G11 W4 — flow-prompt wiring (handoff writes + bootstrap recipe + docs)
    status: done
  - id: M48
    path: ./archive/hypothesis/M48.md
    summary: "G13 fix work (D25/D26/D27 G11 follow-up cleanup) — COMPLETE. T158 (D26): readLog symlink-escape hardening (realpath both target+root); T159 (D25): removed stale eslint-disable; T160 (D27): reworded CHAINED handoff trigger + made start/follow-up wrappers the single handoff writer (7 files). Reviews R163/R164/R165 go-ahead (T158/T160 each r0 disapprove→r1 approve). H15/H16/H18 confirmed. Defects D25/D26 resolved (also D28 filed here from T158 review, resolved via G14). Merged 311b8a1."
    title: "G13 fix tasks: D25/D26/D27 code-quality cleanup"
    status: done
  - id: M52
    path: ./archive/hypothesis/M52.md
    summary: "Investigation of D29 (empty-answer-accepted) complete: H19 (backend gap) + H20 (frontend gap) confirmed against source, root cause pinned, fix file-and-deferred to G16 and resolved this run. Q94 pointer withdrawn (fulfilled)."
    title: "Investigate: empty-answer-accepted"
    status: done
  - id: M61
    path: ./archive/hypothesis/M61.md
    summary: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server — COMPLETE. 11 tasks done + merged (T1 get_reviewers/get_config on BOTH ledger-MCP surfaces behind injected ConfigCapability; T2 buildServer wiring + e2e stdio; T3 count 18→20 + drift-guard; T4 delete cq-config-mcp package; T5 flake.nix removal + @cq/config symlink; T6 dev-llm.nix; T7 .mcp.json; T8/T9/T10 repoint reviewers.md/implement-advance/plan-advance to mcp__ledger__*; T11 FOD hash refresh + nix build .#ledger-mcp/.#ledger-tui/.#ledger-web green + .#cq-config-mcp attr-not-found). Reviews R195-R205 go-ahead. Out-of-scope defect D32 (README still referenced the removed server) auto-investigated→root-caused (H23)→defect-seeded G19→planned (K32/R212)→BUILT (T182, R213)→D32 RESOLVED in the same run; Q104 traceability withdrawn. bun run check green 931/0; main tip 418b641. @cq/config PARSER library retained.
    title: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server
    status: done
  - id: M60
    path: ./archive/hypothesis/M60.md
    summary: "Investigate D31 (web BatchAnswerModal premature-close) — COMPLETE. User-confirmed repro (Q103) flipped the prior 'does not reproduce' conclusion: H22 (suspected T163 regression) WRONG; H24 CONFIRMED — the modal backdrop closed on any click whose common-ancestor was the backdrop with no guard the press STARTED there; a press-and-hold on 'save & mark answered' (timer-fired) advanced to a shorter question, the dialog shrank while still pressed, and the release over the backdrop dismissed it (react-modal #466 class; vacuous test coverage cf. D24/H14). Root-caused → defect-seeded G21 → fixed (T183 RED + T184 shared useBackdropDismiss on all 3 overlays) → D31 RESOLVED. Q103 answered, Q112 (traceability) withdrawn."
    title: "Investigate: batch-answer-modal-premature-close"
    status: done
  - id: M73
    path: ./archive/hypothesis/M73.md
    summary: "D33 investigated → root-caused (H25 confirmed via headless-chromium ground truth: computeDagLayout left layer 0 empty for cyclic graphs, not CSS) → resolved by G24/T199 (e9bf762). Q113 answered (use headless chromium)."
    title: "Investigate: sm-diagram-alignment (blocked on env)"
    status: done
  - id: M79
    path: ./archive/hypothesis/M79.md
    summary: "Investigate D34 (top-bar progress 38/39) complete: root cause confirmed (H26 — denominator itemCount counts the terminal `withdrawn` question while numerator counts answered-only), file-and-deferred to G27, fix landed (T207-T209) and D34 resolved. HO15 handoff recorded."
    title: "Investigate: topbar-progress-undercount"
    status: done
  - id: M39
    path: ./archive/hypothesis/M39.md
    summary: G12 (fix D24 's'-key-inert archived-item test) closed done; coordination milestone archived — all items terminal.
    title: "Fix: vacuous 's'-key-inert archived-item test (restores D22)"
    status: done
  - id: M51
    path: ./archive/hypothesis/M51.md
    summary: G15 (explorer RW prober + pluggable parallel reviewers via cq.toml) closed done; coordination milestone archived.
    title: "Plan: explorer RW access + pluggable parallel reviewers (cq.toml)"
    status: done
  - id: M11
    path: ./archive/hypothesis/M11.md
    summary: "Investigate D2 (mcp-fails-uninitialized-ledger) complete: D2 resolved (backup-and-reinit on schema divergence); hypothesis tree closed — H1/H2 wrong, H4 confirmed (BootstrapViolationError on schema divergence), H3 (environmental/version-skew direction) confirmed by H4 + the D2 fix; Q37 answered. All items terminal."
    title: "Investigate: mcp-fails-uninitialized-ledger"
    status: done
  - id: M110
    path: ./archive/hypothesis/M110.md
    summary: "G34 W2 complete: cq-config [tiers] inverted to (harness+provider+model)->class classifier. T268 (TiersConfig type → entries classifier), T270 (parseTiers token-keyed), T271 (classifyToken/selectTokensForTier; resolveTierToken removed; resolveAgentModel re-pointed), T272 (consumer audit — no external consumers), T273 (classifier test suite), T274 (cq.toml.example + docs + example-load test) all done; reviews R327-R332 go-ahead. Defect D42 (filed during T271, dup-token fail-loud) resolved by T282/G35. nix build .#ledger-mcp green."
    title: "G34-W2: cq-config — invert [tiers] to (harness+provider+model)→class classifier"
    status: done
---

# hypothesis

## M91

### H27 — confirmed

- createdAt: 2026-06-08T07:45:10.922Z
- updatedAt: 2026-06-08T07:48:50.787Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Pi dispatch path never pins the child's verdict to the cq agent's canonical enum, and no orchestrator-side validation rejects/normalizes off-enum verdicts, so the Pi child model paraphrases the verdict string (e.g. "fail" instead of go-ahead|revise)
- description: "Would be TRUE if ALL hold: (1) the cq plan-review / implement-review agent contract specifies a literal verdict ENUM (go-ahead|revise; approve|disapprove); (2) the Pi-side dispatch-trigger instruction in nix/pkg/cq-assets contexts (pi-context.md, T229) and the dispatch_agent tool's task-passing in nix/pkg/pi-extensions/cq-subagent-dispatch.ts do NOT re-assert that the child must emit the EXACT enum (they ask only for a 'parseable verdict-json'), and/or the parent injects a JSON skeleton with placeholder verdict values the model fills loosely; (3) there is NO orchestrator-side normalization/validation step that maps or rejects a non-enum verdict string before the go-ahead/revise gating logic consumes it."
- ledgerRefs: ["defects:D38"]
- evidence: ["[correct] plan-review.md:82-86 — `\"verdict\": \"go-ahead | revise\"`: the rubric specifies the literal enum (sub-claim 1).","[correct] implement-review.md:81-83 — `\"verdict\": \"approve | disapprove\"`: implement-review enum (sub-claim 1).","[correct] pi-context.md:51-67 — the Pi dispatch trigger maps the named-agent+task convention onto `dispatch_agent({agent,task})` and asserts only 'emit the tool call'; it never re-asserts the verdict enum or output contract (sub-claim 2).","[correct] cq-subagent-dispatch.ts:605-607 — the tool passes `args.task` verbatim as the child prompt + the agent md as append-system-prompt; injects NO JSON skeleton, NO placeholder verdict, NO enum (sub-claim 2).","[correct] cq-subagent-dispatch.ts:687-694 — returns the child's raw final text via `textResult(capOutput(finalText))`; performs no verdict parse/normalization/enum validation (sub-claim 3).","[correct] plan/advance.md:291-299 — abstention keys ONLY on whether stdout parses into the verdict CONTRACT (keys present), not on enum-literal validity; an off-enum `verdict:\"fail\"` parses and survives (sub-claim 3).","[correct] plan/advance.md:310-311 — reconcile is bare string-equality: `revise` if any reviewer == revise, `go-ahead` only if all == go-ahead; an off-enum value matches neither branch (sub-claim 3).","[correct] implement/advance.md:145-150 — same parseability-only abstention on the implement side (sub-claim 3, approve|disapprove).","[correct] implement/advance.md:174-177 — strictest-wins reconcile is string-equality vs approve|disapprove literals; off-enum matches neither (sub-claim 3)."]
- sessionLogs: ["docs/logs/20260608-074755-aa243a5b68b5e3c0e.md"]

### H29 — confirmed

- createdAt: 2026-06-08T16:36:02.023Z
- updatedAt: 2026-06-08T16:36:02.023Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: D37 root cause = stale pre-T225 cq-subagent-dispatch.ts store path in ~/.pi/agent/settings.json because home-manager activation was not re-run after the T222/T224/T225 merge; re-running activation remediates it
- description: "Known-cause user-action defect: the fix is `home-manager switch` (re-activation), not a repo code change. This round verifies (a) the documented cause and (b) that the user's reported re-deploy (Q143 answer: \"I've redeployed.\") actually remediated it, by direct static inspection of the live environment."
- evidence: ["[correct] ~/.pi/agent/settings.json `extensions[]` now lists `/nix/store/zs2p73sj31k2140y4ylb245wn433wigb-cq-subagent-dispatch.ts` (read 2026-06-08 from the live home-manager-activated file) — i.e. activation regenerated settings.json after the merge, pointing the dispatch extension at a current store path, not the stale pre-T225 one D37 reported.","[correct] `diff /nix/store/zs2p73sj31k2140y4ylb245wn433wigb-cq-subagent-dispatch.ts nix/pkg/pi-extensions/cq-subagent-dispatch.ts` exits 0 (byte-identical, 30452 bytes) — the registered extension is exactly the repo's current MERGED post-T222/T224/T225 source, confirming the stale-path condition no longer holds and the merged extension is what the locally-installed pi now loads (no PI_CODING_AGENT_DIR override needed).","[correct] Q143 (status:answered, author:user) answer = \"I've redeployed.\" — its step (1) is `home-manager switch` annotated \"(RESOLVES D37)\"; the static evidence above confirms that activation took effect."]
- ledgerRefs: ["defects:D37"]

## M-AMBIENT

### H31 — confirmed

- createdAt: 2026-06-09T09:33:21.822Z
- updatedAt: 2026-06-09T09:35:40.241Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "D43 root cause = a two-part prompt gap: (a) the implement-worker agent prompt does not confine the worker to its own worktree (no ban on git ops against the main checkout) while native isolation:worktree's stale-base drives cross-checkout git surgery; (b) the *:advance commit discipline defers ledger commits (only after archive_milestone + at run-stop), so a long run accrues uncommitted ledger a stray reset erases"
- description: "What would make this true: (a) nix/pkg/cq-assets/agents/implement-worker.md contains NO instruction forbidding the worker from running git against the main checkout / other worktrees and no 'reset only within your own worktree' rule; the native worktree forks from a stale base (observed 087b889 vs current main). (b) nix/pkg/cq-assets/commands/cq/advance.md + commands/cq/implement/advance.md commit the ledger ONLY after archive_milestone + at the run/standalone stop (no commit-after-every-merge), and commands/cq/plan/advance.md has no commit-after-planning-lock; chained sub-flows suppress at-stop commits. Confirm by reading the current prompt files. Evidence basis: this session's reflog (HEAD@{3} reset in the MAIN checkout discarded uncommitted docs/*.md) is already captured in D43.description."
- ledgerRefs: ["defects:D43"]
- evidence: ["[correct] agents/implement-worker.md:47-55 — 'Boundaries (hard rules)': 'No merge, no push, no rebase. Stay on your task branch inside the worktree' + 'Scope = this task only' — forbids merge/push/rebase + scope but NO rule confining git ops to the worktree / forbidding git against the main checkout. Validated: excerpt matches source. [part a]","[correct] agents/implement-worker.md:25-29 — 'working entirely inside your own isolated git worktree' is a descriptive premise, not an enforceable prohibition with examples of forbidden cross-checkout git. [part a]","[correct] agents/implement-worker.md:38-43 — the base commit + worktree path are PASSED IN by the harness (Claude native isolation:worktree); the worker does NOT establish its own base, so a stale base is a harness-side fact the worker inherits with no sanctioned base-fixing procedure. [part a / stale-base trigger]","[correct] agents/implement-worker.md:71-73 — the ONLY sanctioned worker git mutation is `git add -A && git commit` on the task branch + report the SHA; no instruction restricting git invocation to the worktree dir. Validated: matches source. [part a]","[correct] commands/cq/implement/advance.md:293-302 — merge-back (rebase + ff merge) is the ORCHESTRATOR's job, confirming the worker's git role is solely commit-on-branch + report-SHA. [part a]","[correct] commands/cq/implement/advance.md:395-405 — 'Commit the ledger (after every milestone archive + at the standalone stop)': commits ONLY after archive_milestone + at the standalone at-stop (suppressed when chained). No commit-after-every-task-merge. Validated: matches source. [part b]","[correct] commands/cq/advance.md:506-518 — top-level wrapper commits after every archive + at the single run-stop, NOT after every task merge. [part b]","[correct] commands/cq/plan/advance.md:717+ — 'Commit the ledger (standalone stop)': only commit is at the standalone stop, suppressed when chained; no commit-after-planning-lock checkpoint. Validated: section present at L717. [part b]","[correct] commands/cq/implement/advance.md:542-549 — chained sub-flows SUPPRESS the at-stop commit; under /cq:advance only the wrapper's run-stop + per-archive commits fire, maximizing the uncommitted-ledger window between archives. [part b]"]
- sessionLogs: ["docs/logs/20260609-093502-a4b0d0d4f781c94c2.md"]
