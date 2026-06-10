---
ledger: questions
counters:
  milestone: 0
  item: 211
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
  - id: M52
    path: ./archive/questions/M52.md
    summary: "Investigation of D29 (empty-answer-accepted) complete: H19 (backend gap) + H20 (frontend gap) confirmed against source, root cause pinned, fix file-and-deferred to G16 and resolved this run. Q94 pointer withdrawn (fulfilled)."
    title: "Investigate: empty-answer-accepted"
    status: done
  - id: M61
    path: ./archive/questions/M61.md
    summary: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server — COMPLETE. 11 tasks done + merged (T1 get_reviewers/get_config on BOTH ledger-MCP surfaces behind injected ConfigCapability; T2 buildServer wiring + e2e stdio; T3 count 18→20 + drift-guard; T4 delete cq-config-mcp package; T5 flake.nix removal + @cq/config symlink; T6 dev-llm.nix; T7 .mcp.json; T8/T9/T10 repoint reviewers.md/implement-advance/plan-advance to mcp__ledger__*; T11 FOD hash refresh + nix build .#ledger-mcp/.#ledger-tui/.#ledger-web green + .#cq-config-mcp attr-not-found). Reviews R195-R205 go-ahead. Out-of-scope defect D32 (README still referenced the removed server) auto-investigated→root-caused (H23)→defect-seeded G19→planned (K32/R212)→BUILT (T182, R213)→D32 RESOLVED in the same run; Q104 traceability withdrawn. bun run check green 931/0; main tip 418b641. @cq/config PARSER library retained.
    title: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server
    status: done
  - id: M60
    path: ./archive/questions/M60.md
    summary: "Investigate D31 (web BatchAnswerModal premature-close) — COMPLETE. User-confirmed repro (Q103) flipped the prior 'does not reproduce' conclusion: H22 (suspected T163 regression) WRONG; H24 CONFIRMED — the modal backdrop closed on any click whose common-ancestor was the backdrop with no guard the press STARTED there; a press-and-hold on 'save & mark answered' (timer-fired) advanced to a shorter question, the dialog shrank while still pressed, and the release over the backdrop dismissed it (react-modal #466 class; vacuous test coverage cf. D24/H14). Root-caused → defect-seeded G21 → fixed (T183 RED + T184 shared useBackdropDismiss on all 3 overlays) → D31 RESOLVED. Q103 answered, Q112 (traceability) withdrawn."
    title: "Investigate: batch-answer-modal-premature-close"
    status: done
  - id: M73
    path: ./archive/questions/M73.md
    summary: "D33 investigated → root-caused (H25 confirmed via headless-chromium ground truth: computeDagLayout left layer 0 empty for cyclic graphs, not CSS) → resolved by G24/T199 (e9bf762). Q113 answered (use headless chromium)."
    title: "Investigate: sm-diagram-alignment (blocked on env)"
    status: done
  - id: M40
    path: ./archive/questions/M40.md
    summary: "G11 (agent-ergonomic ledger MCP: snapshot + handoffs + sessionLogs + click-protection) closed done; coordination milestone archived."
    title: "Plan: agent-ergonomic ledger MCP (state-overview endpoint + better descriptions)"
    status: done
  - id: M51
    path: ./archive/questions/M51.md
    summary: G15 (explorer RW prober + pluggable parallel reviewers via cq.toml) closed done; coordination milestone archived.
    title: "Plan: explorer RW access + pluggable parallel reviewers (cq.toml)"
    status: done
  - id: M57
    path: ./archive/questions/M57.md
    summary: G17 (fix D30 link-prompts stale llm/ root) closed done; coordination milestone archived.
    title: "Plan: fix D30 (link-prompts stale `llm/` root → dangling symlinks)"
    status: done
  - id: M59
    path: ./archive/questions/M59.md
    summary: G18 (merge cq-config into ledger MCP + parallel planners) closed done; coordination milestone archived.
    title: "Plan: merge cq-config into ledger MCP + parallel planners"
    status: done
  - id: M65
    path: ./archive/questions/M65.md
    summary: G20 (cq.toml [webui] + cq CLI init/reset/erase) closed done; coordination milestone archived.
    title: "Plan: cq.toml [webui] + cq CLI (init/reset/erase)"
    status: done
  - id: M74
    path: ./archive/questions/M74.md
    summary: G23 (flow state-machine docs + Flows help tab) closed done; coordination milestone archived.
    title: "Plan: flow state-machine docs + Flows help tab"
    status: done
  - id: M80
    path: ./archive/questions/M80.md
    summary: G25 (retire legacy skills + clean cq references) closed done; coordination milestone archived.
    title: "Plan: retire legacy skills + clean cq references"
    status: done
  - id: M81
    path: ./archive/questions/M81.md
    summary: G26 (render session-log markdown in a popup) closed done; coordination milestone archived.
    title: "Plan: render session logs as markdown in a popup"
    status: done
  - id: M11
    path: ./archive/questions/M11.md
    summary: "Investigate D2 (mcp-fails-uninitialized-ledger) complete: D2 resolved (backup-and-reinit on schema divergence); hypothesis tree closed — H1/H2 wrong, H4 confirmed (BootstrapViolationError on schema divergence), H3 (environmental/version-skew direction) confirmed by H4 + the D2 fix; Q37 answered. All items terminal."
    title: "Investigate: mcp-fails-uninitialized-ledger"
    status: done
  - id: M86
    path: ./archive/questions/M86.md
    summary: G28 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Enabled pi-harness subagent support for the cq flow; work milestones M87-M91 delivered (K44-K46 decisions, R265-R268 reviews). Closed + archived in the post-G37 cleanup sweep.
    title: "Plan: pi-agent subagent support for cq flow"
    status: done
  - id: M91
    path: ./archive/questions/M91.md
    summary: G28 W5 (pi subagent dispatch acceptance demo) COMPLETE — all tasks terminal. Archived in the post-G37 cleanup sweep.
    title: Pi subagent dispatch — acceptance demo
    status: done
  - id: M92
    path: ./archive/questions/M92.md
    summary: G29 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Provider-qualified pi token grammar (pi:<provider>/<model>); D36 resolved; work milestone M94 delivered (K47, R277-R278). Archived in the post-G37 cleanup sweep.
    title: "Plan: provider-qualified token support in cq config"
    status: done
  - id: M93
    path: ./archive/questions/M93.md
    summary: G30 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Added the user-action-required handoff status threaded through the flow prompts/schema; work milestones M97-M101 delivered (K49, R282-R284). Archived in the post-G37 cleanup sweep.
    title: "Plan: user-action-required handoff status"
    status: done
  - id: M108
    path: ./archive/questions/M108.md
    summary: G34 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Help-popup Item-States rename + Agents tab + cq.toml [tiers] triplet mapping + the two follow-ups (privilege/exposed-tools; live-model runtime overlay via get_agent_models); work milestones M109-M112/M116/M118/M120 delivered (K54/K55/K57, R324-R343). Archived in the post-G37 cleanup sweep.
    title: "Plan: help-popup item-states rename + Agents tab + tiers triplet mapping"
    status: done
  - id: M115
    path: ./archive/questions/M115.md
    summary: G36 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Optional thinking-effort suffix in cq model-identifier tokens; work milestones M117/M119/M121 delivered (K58, R342-R344). Archived in the post-G37 cleanup sweep.
    title: "Plan: optional thinking-effort suffix in cq model-identifier tokens"
    status: done
  - id: M132
    path: ./archive/questions/M132.md
    summary: "G39 (Fix D45 — mirror docs/ledgers.yaml on the 'create' op in cacheMirror) DONE: cacheMirror.ts mirrors layout.registryPath on op==='create'||'archive' + XDG_CACHE_HOME-redirected byte-equality test (T323); D45 resolved. Goal closed; coordination milestone archived."
    title: "Plan: fix D45 — cache mirror omits ledgers.yaml on createLedger"
    status: done
  - id: M143
    path: ./archive/questions/M143.md
    summary: "G43 (GitObjectLedgerBackend) planned + DELIVERED. The orphan-git-ref ledger backend is implemented end-to-end (15 tasks across W1-W6/M144-M149, all adversarially reviewed + merged; 5 hardening defects D49/D51/D52/D53/D54 resolved; check green 1597/0) and sits behind the same LedgerStore surface as FsLedgerStore, opt-in via cq.toml [ledger] backend='git-object'. Planning Q189-Q196 answered; multi-planner synthesis + revise→go-ahead review loop (R418/R419). One follow-up pending user sequencing: D50 (turn-pause-loophole Stop-hook gate, Q197)."
    title: "Plan: ledger-on-orphan-git-branch storage backend (GitObjectLedgerBackend)"
    status: done
---

# questions

## M-AMBIENT

### Q166 — answered

- createdAt: 2026-06-09T02:32:03.252Z
- updatedAt: 2026-06-09T09:31:18.545Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "D43 fix approach (flow-governance change you wanted to steer): which design for each part? (1) STALE-WORKTREE-BASE root cause — (a) orchestrator creates MANUAL worktrees from the current main HEAD (git worktree add <path> -b impl-<T> <mainSha>) and passes that path to the worker, OR (b) keep native isolation:worktree but the implement-worker prompt FORBIDS any git op against the main checkout / other worktrees and the worker resets ONLY within its own worktree (this run's ad-hoc mitigation, which worked)? (2) COMMIT DISCIPLINE — thread 'commit ledger after planning-lock + after EVERY task merge-back' permanently into advance.md + implement/advance.md + plan/advance.md (overriding the chained-suppression for these checkpoints)? (3) Do you want to drive these cq-assets prompt edits yourself, or have me plan+implement the full D43 suggestedFix autonomously via a normal /cq:advance cycle?"
- context: "D43 (major, open) is the data-loss defect: an implement-worker under native isolation:worktree ran `git reset --hard`/checkout/cherry-pick in the MAIN checkout (not just its worktree), discarding the run's uncommitted ledger writes (recovered via replay, commit 343ef67-era; the loss was only recoverable because the reverted counters reproduced identical IDs). Root cause is CONFIRMED by inspection (reflog + prompt analysis) and documented in D43 with a 3-part suggestedFix. The LOAD-BEARING part (commit-after-merge) was ADOPTED ad-hoc THIS run (committed the ledger after every merge-back; D43 never recurred). Remaining: (b)/the prompt edits forbidding cross-checkout worker git ops + the stale-base fix. Because these edits change the flow's OWN governance and you signalled you want to steer the flow-fix, this is surfaced for your direction rather than auto-implemented mid-run. This question is HOW-to-fix (design/ownership), not whether-to-fix (D43's default disposition is FIX)."
- suggestions: ["(1b)+(2 yes)+(3 autonomous): keep native worktrees but harden the implement-worker prompt to forbid main-checkout git ops + worker-confined reset; permanently thread commit-after-planning/after-merge; let me plan+implement via /cq:advance","(1a)+(2 yes)+(3 autonomous): switch to orchestrator-managed manual worktrees; thread the commit discipline; autonomous implement","(3 steer): you take the cq-assets prompt edits yourself (I've adopted commit-after-merge already this run); leave D43 open for your manual fix"]
- recommendation: (1b) + (2 yes) + (3 autonomous). (1b) is the minimal, proven mitigation (it worked flawlessly across the 12 worker dispatches after the incident) and avoids the orchestrator-managed-worktree complexity; (2) makes the durable-ledger guarantee structural; (3) autonomous keeps momentum — but defer to you on ownership since it edits the flow's own prompts.
- ledgerRefs: ["defects:D43"]
- answer: as recommended

### Q197 — answered

- createdAt: 2026-06-10T13:47:56.610Z
- updatedAt: 2026-06-10T14:56:21.494Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "D50 (cq:advance turn-pause loophole / Stop-hook gate): sequence it NOW as its own plan-flow goal, or DEFER to a later session?"
- context: "You raised the cq:advance turn-pause loophole this session (filed as D50, root-caused: the handoff exit is write-time-enforced but the turn-pause exit is pure honor-system; proposed fix = a Claude Code `Stop` hook that re-derives the three predicates via a `cq advance-gate` CLI and BLOCKS a premature stop unless a verbatim external-signal is recorded, with a run-active session marker so it never blocks ordinary chat). I recommended doing it AFTER G43 as its own goal (it shares the cq-cli surface G43 just extended). G43 is now COMPLETE (15/15 tasks merged + reviewed, check green) and its four low hardening defects (D49/D51/D52/D53) are fixed. So D50 is the only substantive item left, and it's yours to sequence."
- suggestions: ["Start D50 now: I bootstrap a plan-flow goal for the Stop-hook gate via /cq:plan (builds the `cq advance-gate` CLI + the Stop hook + the run-active marker)","Defer D50 to a later session (it stays root-caused + durable in the ledger; re-invoke /cq:plan when ready)"]
- recommendation: Either is fine — D50 is durable. If you want the loophole closed soon, start it now (option a); the `cq advance-gate` CLI is a natural extension of the cq-cli work G43 just landed. Otherwise defer.
- ledgerRefs: ["defects:D50","goals:G43"]
- answer: "Start D50 now: I bootstrap a plan-flow goal for the Stop-hook gate via /cq:plan (builds the `cq advance-gate` CLI + the Stop hook + the run-active marker)"

## M126

### Q167 — answered

- createdAt: 2026-06-09T11:08:11.842Z
- updatedAt: 2026-06-09T11:11:09.867Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[1a worktree cleanup] WHO removes a Claude worker's worktree after a successful merge-back, and HOW is a locked/changed worktree handled? Native Agent isolation:worktree auto-cleans only UNCHANGED worktrees; a worker that committed its task is CHANGED, so it is never auto-removed — the accumulation source. Should the implement/advance.md §7.3 orchestrator explicitly `git worktree remove --force` (+ `git branch -D implement/<taskId>` + `git worktree prune`) the worktree right after the per-task `done` write, symmetric with the Codex path that already does this?"
- context: "implement/advance.md §7.3 currently says 'remove the worktree (Claude: auto; Codex: git worktree remove + delete the branch)'. The Claude 'auto' is the native isolation:worktree mechanism, which per §K4 (L47-55) only auto-removes UNCHANGED worktrees — so a committed task's worktree persists (the ~140 stale locked worktrees observed). The blocked-task path (§5) deliberately keeps the worktree INTACT until the user answers. Fix is prompt-only (no code)."
- suggestions: ["Orchestrator explicitly removes the changed worktree + branch after the per-task done write in §7.3 (git worktree remove --force; git branch -D; git worktree prune); blocked-task worktrees (§5) stay intact until resumed/abandoned","Only force-prune lingering locked worktrees in a periodic/start-of-pass sweep, leaving per-merge removal to the native mechanism","Both: per-merge explicit removal (primary) PLUS a start-of-pass sweep that prunes any orphaned/locked worktrees from prior crashed runs"]
- recommendation: "Both (suggestion 3): make §7.3 explicitly `git worktree remove --force <wt> && git branch -D implement/<taskId> && git worktree prune` immediately after the per-task done write (the worktree is no longer needed once the SHA is merged), AND add a start-of-pass sweep that prunes orphaned/locked worktrees left by prior interrupted runs. Leave §5 blocked-task worktrees intact. This is prompt-only and directly stops the accumulation."
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q168 — answered

- createdAt: 2026-06-09T11:08:24.555Z
- updatedAt: 2026-06-09T11:11:42.385Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[1b ~/.cache backup] What is the backup GRANULARITY/FORMAT and WHEN is it written? Options: (A) mirror the docs/*.md tree (whole-tree copy of the active ledger files + archive) on every write; (B) an append-only journal of each mutation (create/update/archive op + payload) that a restore CLI replays; (C) both — a current-state mirror plus a journal. And is it written synchronously inside each write, or via the existing post-write onMutation hook (fired after lockfile release, must-not-block, swallows throws)?"
- context: FsLedgerStore funnels every write through writeLedgerFile()->atomicWrite() and exposes an onMutation(ledgerId, op) hook fired AFTER lockfile release for create/update/archive. The goal text says 'mirror every ledger write ... restorable WITHOUT replaying MCP writes' — which favors a current-state file mirror (A) over a replay journal (B), but explicitly lists both as options. The hook is the natural async trigger; a fully-synchronous-in-write mirror would add latency/fsync to every op.
- suggestions: ["(A) Whole-tree mirror of docs/*.md (+ docs/archive) into the ~/.cache dir on every onMutation, so the cache always holds the latest restorable snapshot (no replay needed); simplest restore = copy back","(B) Append-only journal of mutations the restore CLI replays into a fresh docs/ (smaller writes, but restore = replay, which the goal says to AVOID)","(C) Both — latest-state mirror for trivial restore PLUS a journal for point-in-time/audit","Mirror only the file(s) actually changed by each op (not the whole tree) on each onMutation, for lower write cost"]
- recommendation: "(A) restated as suggestion 4: on each onMutation, mirror the file(s) the op touched (the changed docs/<ledger>.md, plus the archive file + ledgers.yaml on archive) into the ~/.cache dir via the same atomic-write primitive, off the post-lock hook so it never blocks the write path. The cache then always holds the latest restorable copy and restore is a plain copy-back — matching 'restore WITHOUT replay'. Skip a journal unless point-in-time recovery is explicitly wanted."
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q169 — answered

- createdAt: 2026-06-09T11:08:41.009Z
- updatedAt: 2026-06-09T11:12:05.491Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[1b ~/.cache backup] Confirm the PATH SCHEME, PRUNING/ROTATION, and RESTORE entrypoint. (a) Path: ~/.cache/cq/ledgers/${basename(rootDir)}-${hash(absolute rootDir)}/ — which hash (sha256-hex truncated to N chars? which N?) and respect $XDG_CACHE_HOME with ~/.cache fallback? (b) Rotation: keep only the latest mirror (overwrite in place), or retain a bounded ring of timestamped snapshots (how many)? (c) Restore: a new subcommand on the ledger-mcp CLI (e.g. `ledger-mcp restore --from-cache [--cwd <root>]`) that copies the cache mirror back into docs/, symmetric with how reset() works today?"
- context: "The goal specifies ~/.cache/cq/ledgers/${dir-name}-${absolute-path-hash}/content. The hash keyed on the absolute root path disambiguates two checkouts with the same basename. Today the only operator entrypoint is FsLedgerStore.reset() (in-repo backup); there is no restore CLI. ledger-mcp is the package that owns the store and could host a restore subcommand. XDG_CACHE_HOME is the standard base-dir var on Linux."
- suggestions: ["Path: ${XDG_CACHE_HOME:-~/.cache}/cq/ledgers/${basename}-${sha256(absRoot) first 12 hex}/ ; Rotation: overwrite-in-place single latest mirror (the cache is a safety copy, not history) ; Restore: new `ledger-mcp restore --from-cache [--cwd]` subcommand copying cache->docs/","Same path; Rotation: keep a bounded ring of the last N timestamped snapshots (e.g. N=10) for point-in-time recovery","Restore is documented as a manual `cp -r` copy-back (no new CLI subcommand) to keep scope minimal"]
- recommendation: "Suggestion 1: ${XDG_CACHE_HOME:-~/.cache}/cq/ledgers/${basename}-${sha256(absoluteRoot).slice(0,12)}/; overwrite-in-place single latest mirror (the cache backstops a wipe, not version history — keep it dead simple); and add a `ledger-mcp restore --from-cache [--cwd <root>]` subcommand that atomically copies the cache mirror back into docs/ (symmetric with reset()). Use a ring of timestamped snapshots only if you want point-in-time recovery (suggestion 2)."
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q170 — answered

- createdAt: 2026-06-09T11:08:53.970Z
- updatedAt: 2026-06-09T11:18:46.568Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[2 Flows tab] What is the SOURCE OF TRUTH for the role→actions mapping, and the VISUAL FORM? The current Flows tab (G23/T204-T205) renders FLOW STATE diagrams from a hand-authored TS flow-data module via the elk DiagramSvg renderer; you want per-role ACTIONS instead (orchestrator dispatches planner, planner emits candidate plan, reviewer returns verdict, orchestrator merges by SHA). (a) Source: a NEW hand-authored role→actions catalogue (TS data module), or mechanically derived from the cq-assets agent/command prompt Catalogue blocks? (b) Visual form: per-role action LISTS (text), or a role-interaction/sequence diagram (who-calls-whom edges) rendered via the existing elk DiagramSvg? (c) Does this REPLACE the current state diagrams in the Flows tab, or ADD a new view alongside them?"
- context: "G23 built the Flows tab in ledger-web/src/App.tsx HelpOverlay: hand-authored TS flow-data -> elk DiagramSvg (testids help-tab-flows / help-flow-<id>). Deriving actions mechanically from the cq-assets prompts is fragile (prose, not structured); a hand-authored catalogue is the established pattern (Q114 chose hand-authored flow data for exactly this reason). The agent/command Catalogue yaml blocks (inputs/outputs/ioSchema) are the closest structured source if derivation is wanted."
- suggestions: ["Hand-authored role→actions catalogue (new TS data module, same pattern as the existing flow-data); REPLACE the abstract state diagrams in the Flows tab with per-role action views","Hand-authored catalogue, but ADD the role-actions view alongside the existing state diagrams (toggle or stacked) rather than replacing them","Mechanically derive role→actions from the cq-assets agent/command Catalogue blocks (single source of truth, but requires a parser and is prose-fragile)","Visual form = a role-INTERACTION/sequence diagram (role nodes, labeled action edges 'dispatches planner'/'returns verdict'/'merges by SHA') via the existing elk DiagramSvg, per flow"]
- recommendation: "Hand-authored role→actions catalogue (suggestion 1 for source: new TS data module, mirroring the existing hand-authored flow-data and Q114's rationale that prose prompts are not a reliable structured source), REPLACING the abstract state diagrams in the Flows tab. For visual form, suggestion 4: a per-flow role-interaction diagram (role nodes + labeled action edges) via the existing elk DiagramSvg, which reuses the tested renderer. Confirm replace-vs-add and list-vs-diagram."
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q171 — answered

- createdAt: 2026-06-09T11:09:05.787Z
- updatedAt: 2026-06-09T11:18:52.952Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[2 Flows tab] Is the per-role-actions Flows view WEB-ONLY, or must the TUI also gain it? The tabbed help dialog (Shortcuts / Item-States / Flows) exists ONLY in ledger-web; the TUI (ledger-tui/src/app.tsx) has no help overlay, tabs, or SVG/elk renderer at all. Adding an equivalent role-actions view to the TUI is a separate, substantial build (a new help-popup mechanism + a text rendering of the catalogue)."
- context: "Q145 (G34, answered 'web frontend only') already settled this exact web-only-vs-TUI scope question for the prior Flows/Item-States help-dialog work: the tabbed help dialog has only ever existed in the web UI. This item is a continuation of that same Flows tab. The goal text for item 2 says 'ledger-web help popup; possibly TUI too', leaving it open."
- suggestions: ["Web only — consistent with Q145; modify the existing ledger-web Flows tab, leave the TUI unchanged","Both — also add a role-actions help view to the TUI (new help-popup + text catalogue rendering; significantly larger scope)"]
- recommendation: Web only (suggestion 1). The Flows tab is a web help-dialog feature; Q145 already scoped the analogous help-dialog work to ledger-web for the same reason (the TUI has no help-popup or diagram renderer). Building a parallel TUI help view is a disproportionate separate effort not implied by the core ask.
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q172 — answered

- createdAt: 2026-06-09T11:09:15.776Z
- updatedAt: 2026-06-09T11:12:37.005Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[3 TUI keybinding] (ROUTING) Carry item 3 as a fix-task work-milestone UNDER G38, or file it as a standalone defect for /cq:investigate? You labeled it a 'TUI defect'; the cq convention normally routes a fault through /cq:investigate (reproduce -> root-cause -> defect-seeded fix). But the desired behavior is already fully specified and the root cause is already located (see context), so a separate investigate round would add little."
- context: "The behavior is pinned to ledger-tui/src/app.tsx useInput, LIST-focus branch (L840-845): key.pageUp/pageDown there scroll the CONTENT/detail pane (top.scroll, CONTENT_PAGE=10) WITHOUT switching focus — an INTENTIONAL prior affordance (comment L836-839). Home/End are not handled anywhere. So this is a known-locus behavior CHANGE with a clear spec, not an unknown fault needing investigation."
- suggestions: ["Keep it under G38 as a fix-task work-milestone (root cause + spec already known; skip a separate investigate round)","File a standalone defect linked to G38 and route it through /cq:investigate per the cq fault convention (reproduce -> root-cause -> defect-seeded fix)","File a defect record for traceability AND plan the fix task under G38 now (defect documents the fault; fix task executes it), without a separate investigate round"]
- recommendation: "Suggestion 3: file a defects record (so the fault is traceable, severity low/medium) linked to G38, AND plan the fix task(s) under a G38 work-milestone with the fix task ledgerRef'ing that defect — the defect-aware-planning pattern. The root cause is already located and the spec is unambiguous, so a separate /cq:investigate round is unnecessary; the defect record gives traceability without it."
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q173 — answered

- createdAt: 2026-06-09T11:09:32.859Z
- updatedAt: 2026-06-09T11:12:54.438Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[3 TUI keybinding] (BEHAVIOR) Confirm the exact desired key map. The requested change REVERSES a deliberate existing affordance: today, in LIST focus, PgUp/PgDn scroll the detail pane WITHOUT requiring Enter (a documented convenience). The new spec makes LIST-focus PgUp/PgDn page the CURSOR, and content scrolling happens only AFTER Enter into the item view. Confirm: (a) in LIST focus PgUp/PgDn move the cursor by one page (listInnerH rows? CONTENT_PAGE=10?) and Home/End jump to first/last row; (b) the no-Enter detail-scroll affordance is REMOVED (you accept that to scroll content you must Enter first); (c) in CONTENT focus, Home/End jump to top/bottom of the content and PgUp/PgDn page it (today only PgUp/PgDn page content, no Home/End)."
- context: "ledger-tui/src/app.tsx: LIST-focus PgUp/PgDn currently scroll top.scroll (the detail pane) by CONTENT_PAGE=10 without switching focus (comment L836-839 calls this intentional). CONTENT-focus PgUp/PgDn page content by CONTENT_PAGE; neither focus handles Home/End. FEASIBILITY NOTE: ink's useInput `key` object does not expose dedicated home/end booleans — Home/End arrive as raw escape sequences in `input` (e.g. \\x1b[H / \\x1b[F or [1~/[4~), so the fix must match those sequences directly. Please confirm a page = one screenful (listInnerH) is acceptable, or fix at 10."
- suggestions: ["Confirm full reversal: LIST focus — PgUp/PgDn page the cursor by one screenful (listInnerH rows), Home/End jump to first/last row; the no-Enter detail-scroll affordance is removed; CONTENT focus — PgUp/PgDn page content (CONTENT_PAGE), Home/End jump to content top/bottom","Same, but page size = fixed CONTENT_PAGE (10) rows for the cursor too, not a full screenful","Keep the no-Enter detail-scroll affordance on a DIFFERENT key and give PgUp/PgDn/Home/End to the cursor (so nothing is lost)"]
- recommendation: "Suggestion 1: in LIST focus, PgUp/PgDn page the cursor by one visible screenful (listInnerH rows — more natural than a fixed 10 for list paging) and Home/End jump to first/last row; remove the no-Enter detail-scroll (Enter-then-scroll is the consistent model the spec asks for). In CONTENT focus, PgUp/PgDn page content by CONTENT_PAGE and add Home/End to jump to content top/bottom. Implement Home/End by matching the raw escape sequences in `input` since ink exposes no key.home/key.end."
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q176 — answered

- createdAt: 2026-06-09T14:48:19.916Z
- updatedAt: 2026-06-09T15:24:30.791Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[FU-1 scope] Include the small App.tsx UX-message task that DISTINGUISHES a stale-server 'overlay unavailable' state from a genuine config-absent state? Today the `unavailable` AgentModelView (overlay fetch threw, App.tsx L1750-1751) renders the SAME 'default / not configured' label that reads like an unconfigured cq.toml — which is exactly what made the (correctly-diagnosed-as-stale-build) situation look like a config defect. The plannable improvement: split `unavailable` into a distinct label/message (e.g. 'model overlay unavailable - the server predates get_agent_models; rebuild + restart ledger-web/ledger-mcp') vs the genuine `not-configured` ('not configured (no cq.toml)') which already exists. NOTE: the underlying display was diagnosed as a STALE-DEPLOYED-BUILD issue fixed by a user rebuild+restart, NOT a code defect; this UX task is purely OPTIONAL polish so a future stale-server is self-explanatory."
- context: "App.tsx resolveAgentModelView() returns {kind:'unavailable'} when overlayError is true (the get_agent_models fetch at L436 threw) OR the role has no overlay entry. AgentModelCell renders that as 'default / not configured'. The genuine no-cq.toml case is a SEPARATE kind ('not-configured' -> 'not configured (no cq.toml)'). So distinguishing them is a label/message change in AgentModelCell plus optionally surfacing the overlayError reason. Web-only, tiny."
- suggestions: ["YES - include it: change the `unavailable` cell to a clearly stale-server-distinct message ('overlay unavailable - rebuild/restart the server'), so a stale deployment is self-explanatory and not mistaken for an unconfigured cq.toml","NO - leave it out: the root issue is a deploy action (rebuild+restart), the display is correct once rebuilt, and this is cosmetic; keep the follow-up focused on FU-2/3/4","YES but minimal: only reword the `unavailable` label string (no new wiring), the cheapest possible disambiguation"]
- recommendation: Suggestion 1 (include it, full disambiguation). The whole confusion that triggered FU-1 was the `unavailable` fallback being indistinguishable from a real config-absent state; a one-section message change that names the rebuild/restart remedy makes future stale-server situations self-diagnosing at near-zero cost and fits naturally beside the FU-2/3/4 HelpOverlay work. Cheap and directly addresses the reported confusion.
- ledgerRefs: ["goals:G38"]
- answer: "YES - include it: change the `unavailable` cell to a clearly stale-server-distinct message ('overlay unavailable - rebuild/restart the server'), so a stale deployment is self-explanatory and not mistaken for an unconfigured cq.toml"

### Q177 — answered

- createdAt: 2026-06-09T14:48:30.968Z
- updatedAt: 2026-06-09T15:22:45.220Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[FU-2 popup size] Is the ~90%-of-viewport help-popup size a HARD fixed 90% (width:90vw; height:90vh) or a RESPONSIVE cap (min(90vw, max-content) / max-height:90vh with internal scroll)? And should the body scroll internally (the diagrams can exceed the viewport) so the head/tabs stay pinned? Currently .lw-help has a smaller fixed/auto size; FU-2 wants it to fill ~90% of the viewport both dimensions."
- context: The popup is .lw-help inside .lw-help-backdrop (App.tsx L1564-1565); its size lives in the ledger-web stylesheet. The Flows/Item-States/Agents bodies render elk SVG diagrams + long agent prompt sections that can be taller/wider than the viewport, so a 90vh box needs an internally-scrolling .lw-help-body with a pinned .lw-help-head (tabs). FU-3's per-tab sidebar will also consume horizontal space inside this box.
- suggestions: ["Hard 90vw x 90vh box, with .lw-help-body { overflow:auto } scrolling internally and .lw-help-head (tabs) pinned at top","Responsive: width clamp(0, 90vw, content), max-height:90vh, body scrolls; popup only grows toward 90% when content needs it (small tabs like Shortcuts stay compact)","Hard 90% both axes only above a min viewport width, falling back to near-full-screen on small/mobile viewports"]
- recommendation: Suggestion 1 (hard 90vw x 90vh, internally-scrolling body, pinned tab head). The user asked specifically for ~90% of the viewport in BOTH dimensions; a fixed 90vw/90vh box is the literal, predictable interpretation and gives the diagram-heavy tabs (and the FU-3 sidebar) maximal room. Keep .lw-help-head pinned and let .lw-help-body scroll so tabs never scroll out of view.
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q178 — answered

- createdAt: 2026-06-09T14:48:48.965Z
- updatedAt: 2026-06-09T15:23:14.953Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[FU-3 sidebars] What is the VISUAL FORM and ENTRY SET of the per-tab jump-to sidebar on the Item-States, Flows, and Agents tabs? (a) Form: a persistent left-hand vertical nav list inside .lw-help-body (sidebar + scrollable content pane, like a docs layout), or a collapsible/togglable panel? (b) Entries: one link per top-level section already rendered on that tab — Item-States = one per ledger (goals/defects/tasks/...), Flows = one per ROLE_FLOWS entry (plan/investigate/implement/advance), Agents = one per AGENT_ROLES role (the ~19 roster) — and clicking scrolls that section into view (and/or highlights it). (c) Behavior: scroll-to-anchor (smooth scrollIntoView on the existing help-<...> testid'd sections) vs filter-to-show-only-selected."
- context: "Each of the 3 tabs already renders a flat list of testid'd sections: Item-States -> help-item-state-<ledger>; Flows -> help-flow-<id>; Agents -> help-agent-<id>. A sidebar can derive its entries directly from those same source arrays (schemas, ROLE_FLOWS, AGENT_ROLES) and jump via scrollIntoView on the existing ids. The Shortcuts tab is a flat dl and is explicitly NOT in scope. With FU-2's 90vh box the content pane scrolls, so a pinned sidebar + scrolling content is the natural layout."
- suggestions: ["Persistent left sidebar (vertical nav list) per tab; entries derived from the tab's existing section array (ledgers / ROLE_FLOWS / AGENT_ROLES); click = smooth scrollIntoView to that section's existing testid'd anchor; the content pane to the right scrolls","Same sidebar + scroll-to, PLUS an active-section highlight (scrollspy) that tracks which section is in view","Filtering sidebar: clicking an entry shows ONLY that one diagram/section (hides the rest) rather than scrolling among all","Collapsible sidebar (togglable open/closed) to preserve diagram width on narrow viewports"]
- recommendation: Suggestion 1 (persistent left sidebar, entries derived from each tab's existing section array, click = scrollIntoView to the existing testid'd anchor). It reuses the already-rendered sections and their stable testids, adds no new data model, matches the 'jump to a particular diagram/entry' ask literally, and pairs cleanly with FU-2's scrolling 90vh body. Scrollspy (suggestion 2) is a nice-to-have that can be added if cheap, but is not required by the ask.
- ledgerRefs: ["goals:G38"]
- answer: Same sidebar + scroll-to, PLUS an active-section highlight (scrollspy) that tracks which section is in view

### Q179 — answered

- createdAt: 2026-06-09T14:49:07.749Z
- updatedAt: 2026-06-09T15:25:29.390Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[FU-4a/b agent depiction + cross-nav] HOW should each flow depict the agents it dispatches, and what is the CLICK TARGET that cross-navigates to the Agents tab? Problem: ROLE_FLOWS nodes are ABSTRACT role labels (orchestrator/planner/reviewer/worker/explore) but the Agents tab is keyed by CONCRETE catalogue ids in AGENT_ROLES (e.g. plan-advance, plan-reviewer, implement-worker, implement-reviewer, conflict-resolver, investigate-explorer, prober + the orchestrator command ids). The two namespaces do not currently line up. (a) Depiction: add concrete AGENT NODES to each flow's DiagramModel (e.g. the plan flow's 'planner' role becomes/links to the 'plan-advance' agent node), or annotate existing role nodes with the agent id(s) they represent? (b) Click target: a node carrying an `agentId` (a catalogue id present in AGENT_ROLES) that, on click, switches tab->'agents' and scrollIntoView's help-agent-<agentId> (reusing FU-3's jump mechanism). This requires mapping each ROLE_FLOWS role node to its AGENT_ROLES id(s)."
- context: "DiagramNode (diagramLayout.ts) currently has only id/label/terminal/fill — no click handler, no href, no agent linkage; DiagramSvg renders a static <g>/<rect>/<text> with no onClick. So clickable agent nodes require (1) widening DiagramNode (or RoleNode) with an optional agentId/onClick affordance, (2) DiagramSvg rendering a clickable element (cursor:pointer, onClick, role=button/keyboard) for nodes that carry it, and (3) authoring the role->agentId mapping in roleActions.ts. The 7 model-configurable subagents have catalogue ids; orchestrator commands also have ids (plan/advance etc.). FU-3's scroll-to-anchor on help-agent-<id> is the landing mechanism."
- suggestions: ["Enrich ROLE_FLOWS so the relevant role nodes carry an `agentId` (the AGENT_ROLES catalogue id they map to); widen DiagramNode/RoleNode + DiagramSvg to render those nodes as clickable (cursor:pointer + keyboard-activatable) and on activate set tab='agents' + scrollIntoView(help-agent-<agentId>); keep abstract nodes (user/main-branch) non-clickable","Add SEPARATE concrete agent nodes (one per dispatched AGENT_ROLES agent) into each flow's diagram alongside the role nodes, each clickable to its Agents-tab entry, with edges 'dispatches <agent>'","Keep role nodes as-is but render a small clickable agent-chip list under each flow diagram (text links to the Agents tab), avoiding changes to the SVG renderer's interactivity","Annotate role nodes with agent id(s) as a tooltip/label only (no cross-navigation), deferring clickability"]
- recommendation: Suggestion 1 (carry an `agentId` on the mapped role nodes; make DiagramSvg nodes with an agentId clickable + keyboard-activatable; on activate switch to the Agents tab and scrollIntoView the help-agent-<agentId> anchor). It satisfies FU-4(a) and (b) together with one data enrichment (the role->agentId map in roleActions.ts) plus one renderer affordance, reuses FU-3's jump mechanism, and keeps the diagram readable (no node explosion). Please CONFIRM the role->agentId mapping intent (e.g. plan 'planner'->plan-advance, 'reviewer'->plan-reviewer; implement 'worker'->implement-worker, 'reviewer'->implement-reviewer + conflict-resolver; investigate 'explorer'->investigate-explorer/prober) so the catalogue can encode it.
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q180 — answered

- createdAt: 2026-06-09T14:49:28.136Z
- updatedAt: 2026-06-09T15:26:49.137Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[FU-4c surface git ops + handoffs] WHICH currently-invisible git operations and handoffs should each flow surface, and HOW (as extra labeled edges, a 'main branch'/'worktree' node, or both)? The implement flow already shows 'merges by SHA' (orchestrator->main) but NOT: worktree create/teardown (per the just-landed 1a auto-cleanup), per-merge ledger commits, cherry-pick onto main, the start-of-pass orphan-worktree sweep. The plan/investigate flows surface handoffs only abstractly. The ask: depict git operations + handoffs as first-class diagram elements. Decide the exact set per flow and whether new infra nodes (e.g. a 'worktree' node, a 'main branch' node already exists in implement) are added."
- context: "ROLE_FLOWS edges are the action vocabulary today (e.g. implement: 'dispatches worker', 'emits result commit', 'merges by SHA', 'files defect', 'registers question'). Git mechanics that exist in the prompts but are NOT depicted: worktree add/remove (1a), per-task ledger commit, cherry-pick/rebase to main, branch delete + worktree prune. Handoffs across flows are shown in the advance sequencer but not the git steps each performs. Adding them is pure ROLE_FLOWS data authoring (new edges / maybe a 'worktree' node); no renderer change beyond what FU-4a/b/d already need."
- suggestions: ["Add the git ops as labeled edges on the implement flow against a 'worktree' + existing 'main branch' node: orchestrator->worktree 'creates worktree', worker->worktree 'commits task', orchestrator->main 'cherry-picks by SHA', orchestrator->worktree 'removes worktree + prunes branch', orchestrator->ledger 'commits ledger'; plan/investigate get their real handoff edges (seeds goal, files defect->investigate)","Minimal: add ONLY the worktree create/teardown + cherry-pick edges to the implement flow (the 1a-relevant, most-requested invisibles); leave ledger-commit and cross-flow handoffs abstract","Comprehensive: model a dedicated 'git / worktree' lane node in EACH flow and route every git/ledger/handoff action through it, so all side effects are uniformly visible","Author this as a NEW separate 'git & handoffs' flow diagram rather than enriching the per-role flows, keeping the role flows clean"]
- recommendation: Suggestion 1 (add the concrete git-op + handoff edges where they actually occur — worktree create/commit/teardown + cherry-pick-by-SHA + ledger-commit on the implement flow against a 'worktree' node and the existing 'main branch' node, and the real cross-flow handoff edges 'seeds goal -> plan' / 'files defect -> investigate' on plan/investigate). It makes the previously-invisible mechanics first-class without a separate diagram, is pure roleActions.ts authoring, and aligns the diagram with the now-landed 1a worktree-cleanup behavior. Please confirm the exact op set you want surfaced (especially whether per-task ledger commits and the start-of-pass orphan sweep should appear).
- ledgerRefs: ["goals:G38"]
- answer: I want to surface all ops directly formalized in our flow. So, if flow says that a particular agent performs a merge or dispatches a subagent of particular type - it should be visible.

### Q181 — answered

- createdAt: 2026-06-09T14:49:40.626Z
- updatedAt: 2026-06-09T15:27:09.386Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[FU-4d colorize nodes] What is the COLOR SCHEME for flow-diagram nodes — color by ROLE KIND (orchestrator/planner/reviewer/worker/conflict-resolver/explore/user/external) using the existing RoleNode.roleKind discriminator, or by some ACTION/agent-kind dimension? And should it reuse the Item-States tab's bucket-hex palette convention for visual consistency? Today every flow node renders the renderer's single DEFAULT_FILL grey (#8b93a7) because ROLE_FLOWS nodes set no `fill` and the renderer never maps roleKind->color."
- context: RoleNode already carries a roleKind discriminator (orchestrator/planner/reviewer/worker/conflict-resolver/explore/user/external) that is currently UNUSED by the renderer. DiagramSvg already honors a per-node `fill` (n.fill ?? DEFAULT_FILL). So colorizing = either (i) author a roleKind->hex map and set node.fill in roleActions.ts, or (ii) pass roleKind through to DiagramSvg and map there. The Item-States tab uses a BUCKET_HEX status palette; a parallel role palette keeps the help dialog visually coherent. A legend may be wanted so colors are interpretable.
- suggestions: ["Color by roleKind: author a roleKind->hex palette (orchestrator/planner/reviewer/worker/conflict-resolver/explore/user/external each a distinct hue), set node.fill from it in roleActions.ts (no renderer change — reuses the existing fill path), and add a small color legend on the Flows tab","Color by roleKind via a map INSIDE DiagramSvg/diagramLayout (renderer maps roleKind->fill), keeping roleActions.ts free of hex values","Color by a coarser 'human vs orchestrator vs subagent vs external/infra' grouping (fewer colors, simpler legend)","Reuse the Item-States BUCKET_HEX palette family for the role colors so both diagram tabs share one visual language"]
- recommendation: Suggestion 1 (color by roleKind via a roleKind->hex palette, set node.fill in roleActions.ts so the existing renderer fill path is reused with zero renderer change, plus a small legend on the Flows tab). roleKind already exists as the natural color dimension, the renderer already honors per-node fill, and a legend makes the encoding interpretable. Optionally draw the hues from the Item-States palette family (suggestion 4) for cross-tab coherence — confirm if you want that shared-palette constraint.
- ledgerRefs: ["goals:G38"]
- answer: as recommended

### Q182 — answered

- createdAt: 2026-06-09T14:49:52.240Z
- updatedAt: 2026-06-09T15:23:50.762Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "[FU scope] Confirm the WHOLE follow-up (FU-1..FU-4) is WEB-ONLY (ledger-web HelpOverlay), leaving the TUI untouched. The TUI has no help overlay, no tabs, and no SVG/elk diagram renderer at all, so none of FU-2 (popup CSS), FU-3 (sidebars), or FU-4 (flow-diagram enrichment) has a TUI counterpart to modify; FU-1's fallback message is also a web-only App.tsx concern. Q145 (G34) and Q171 (the original G38 Flows work) both already scoped the help dialog to ledger-web for exactly this reason."
- context: ledger-tui/src/app.tsx has no help-popup mechanism; the tabbed Shortcuts/Item-States/Flows/Agents dialog has only ever existed in ledger-web. Building parallel TUI equivalents would be a large separate effort not implied by the follow-up text (which is explicitly about 'the ledger-web help popup'). The follow-up prose says WEB-ONLY 'unless the planner decides otherwise' — this question confirms that decision.
- suggestions: ["Web only (ledger-web) for all of FU-1..FU-4 — consistent with Q145/Q171; the TUI has no help overlay to modify","Also add TUI equivalents (substantially larger; requires building a TUI help-popup + diagram/text rendering from scratch)"]
- recommendation: Suggestion 1 (web only). Every follow-up item targets the ledger-web HelpOverlay, which has no TUI analogue; Q145 and Q171 already settled the same web-only scope for the help dialog. A TUI port is a disproportionate, separate goal not implied by this follow-up.
- ledgerRefs: ["goals:G38"]
- answer: Web only (ledger-web) for all of FU-1..FU-4 — consistent with Q145/Q171; the TUI has no help overlay to modify

## M135

### Q183 — answered

- createdAt: 2026-06-09T18:47:01.393Z
- updatedAt: 2026-06-09T18:48:53.599Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Item 0 (overall): Should G41 be planned and delivered as ONE bundled goal across five independent items, or split? In particular — do you want all five tackled in this goal, and is there a priority/sequencing preference, or any item you'd defer or drop (e.g. item 3 is flagged exploratory/feasibility-unknown)?"
- context: "The goal bundles five largely independent workstreams (cq init config, MCP prompt catalog, ledger-on-separate-branch, Flows-tab polish, Ideas ledger). They touch different packages (cq-cli/cq-config, ledger-mcp, ledger-web, plus the /cq:plan command grammar) and have very different risk profiles — item 4 is small/low-risk web polish while items 2 and 3 are large/architectural. Knowing whether all five stay in scope and their relative priority lets me sequence work milestones sensibly (e.g. ship item 4 quickly, gate item 3 behind a feasibility spike)."
- suggestions: ["Keep all five in one goal; planner decomposes into per-item work milestones in any order","Keep all five but prioritise: do 1,4,5 first (quick wins), then 2, then 3 last (exploratory)","Drop/defer item 3 (exploratory) to a separate later goal; do the other four now"]
- recommendation: Keep all five in this goal but plan them as independent work milestones, ordering the quick/low-risk items (1, 4, 5) before the large ones (2, then 3 gated behind a feasibility assessment).
- ledgerRefs: ["goals:G41"]
- answer: as recommended

### Q184 — answered

- createdAt: 2026-06-09T18:47:09.275Z
- updatedAt: 2026-06-09T18:49:42.276Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Item 1 (cq init cq.toml): What exact default content should the generated cq.toml carry, and what is the behaviour when a cq.toml already exists? Specifically: (a) which sections/keys beyond a single Opus model entry — planners set, reviewers set, aliases, any paths? (b) which Opus model id/tier string is the default? (c) overwrite, skip, or error on an existing cq.toml; and should there be a --force?"
- context: G34 already established cq.toml model-resolution and the get_agent_models MCP capability, and the cq-config package owns config parsing — so the schema/keys exist. The goal says 'reasonable defaults, Opus only configured', but the precise key set, the canonical Opus model string, and the idempotency/clobber behaviour of `cq init` are product decisions that determine the acceptance test for this task.
- suggestions: ["Minimal: only a [models]/planners entry with Opus; skip (no-op) if cq.toml exists unless --force","Fuller scaffold: models + planners + reviewers + aliases all defaulted to Opus, commented; error if file exists without --force","Write a fully-commented template documenting every available key, Opus active and others commented out"]
- recommendation: Write a fully-commented template documenting available keys with only Opus active (others commented); skip with an informative message if cq.toml already exists, and add --force to overwrite. Use the same canonical Opus model string get_agent_models resolves today.
- ledgerRefs: ["goals:G41"]
- answer: "as recommended with one correction: in the config we write Opus, Sonnet and Haiku should be configured and active. Other models available through pi should be commented out."

### Q185 — answered

- createdAt: 2026-06-09T18:47:24.050Z
- updatedAt: 2026-06-09T18:50:52.368Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Item 2 (formal MCP prompt catalog): What is the intended SOURCE OF TRUTH and migration path, and how far should the runtime validation flow go in THIS goal? Specifically: (a) where do the canonical prompt texts + input/output JSON Schemas live — hand-authored files the MCP serves, or fully migrated into the ledger/MCP store replacing today's hand-authored agentsCatalogue/roleActions.ts? (b) which agents/subagents must be catalogued first (all of them, or just the plan/implement/investigate roles)? (c) do you want the full fetch→validate-input→run→validate-output loop actually WIRED into dispatching agents now, or is this goal scoped to defining the catalog + MCP endpoints + schemas, with live dispatch wiring deferred?"
- context: The goal itself calls this possibly 'overkill now', expecting payoff once an agent SDK / pi extension feeds inputs. G38's open question about agentsCatalogue / ROLE_FLOWS being the single source of truth is explicitly cited for reconciliation. The scope boundary (define-the-catalog vs fully-wire-dispatch-time-validation) and the source-of-truth decision drive whether this is a few tasks or a large multi-milestone effort, and what the acceptance criteria are.
- suggestions: ["Phase 1 only: define the typed catalog + JSON Schemas + MCP fetch/validate endpoints; migrate agentsCatalogue/roleActions.ts to consume the catalog; DEFER live dispatch-time validation","Full flow now: catalog + schemas + endpoints AND wire at least one dispatching agent (e.g. plan-advance) to fetch/validate/run/validate end-to-end as a proof","Catalog data model + schemas only, served read-only for the Agents tab; no validation endpoints yet"]
- recommendation: "Phase 1: build the typed catalog as the single source of truth (replacing hand-authored agentsCatalogue/roleActions.ts, reconciling G38), expose MCP fetch + validate-input + validate-output endpoints with JSON Schema, but DEFER wiring live dispatch-time validation into running agents to a follow-up — catalogue all roles, prove the endpoints with tests rather than live orchestration."
- ledgerRefs: ["goals:G41"]
- answer: "Full flow now: catalog + schemas + endpoints then wire at one dispatching agent (e.g. plan-advance) to fetch/validate/run/validate end-to-end as a proof, then wire ALL the agents and clean up legacy code/prompts if any."

### Q186 — answered

- createdAt: 2026-06-09T18:47:33.799Z
- updatedAt: 2026-06-09T18:51:08.445Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Item 3 (ledger on a separate orphan git branch, EXPLORATORY): Do you want this goal to (a) produce only a feasibility ASSESSMENT/spike (a decision + documented findings, possibly a throwaway prototype) and stop there, or (b) commit to a full implementation if the spike concludes it is feasible? And what is the acceptable failure mode if a working-tree branch switch turns out to be unavoidable — recommend against and abandon, or accept a worktree-based approach?"
- context: "The goal explicitly flags this as feasibility-unknown and asks the planner to assess first and possibly recommend against. The hard constraint is: no working-tree branch switches — writes via git plumbing (hash-object/mktree/commit-tree/update-ref against an orphan ref) or a dedicated linked worktree. Whether the deliverable is a spike-then-decide or a committed implementation determines whether I plan a single investigation/decision task or a full implementation milestone gated behind it."
- suggestions: ["Spike-only this goal: deliver a feasibility decision + documented findings (and maybe a throwaway PoC); a real implementation becomes a separate goal if feasible","Spike then implement within this goal: if the plumbing approach proves out, proceed to a full implementation milestone gated behind the spike's go/no-go","Skip exploration; you've decided you want it — plan the plumbing-based implementation directly"]
- recommendation: "Spike then implement within this goal: first task is a time-boxed feasibility assessment of the orphan-ref + git-plumbing approach (no working-tree switch); a full implementation milestone follows ONLY on a positive go decision, otherwise the goal records a 'recommend against' decision and that item closes."
- ledgerRefs: ["goals:G41"]
- answer: "Spike-only this goal: deliver a feasibility decision + documented findings (and maybe a throwaway PoC); a real implementation becomes a separate goal if feasible"

### Q187 — answered

- createdAt: 2026-06-09T18:47:47.715Z
- updatedAt: 2026-06-09T18:51:33.299Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Item 4 (Flows-tab polish): For the unlabelled duplicate edges (2× orchestrator→ledger, 3× orchestrator→worktree in the Implement flow), do you want me to (a) author specific textual labels describing each distinct trigger/action, and if so are there canonical phrasings you prefer; or (b) collapse genuinely-identical edges into one? Also: G38 already shipped ROLE_FLOWS/DiagramSvg and its FU-4 covers 'Flows-tab depth' — should item 4 be folded into that existing G38 work, or implemented independently here in G41?"
- context: The goal says ALL edges must be labelled and asks me to determine whether the duplicate orchestrator→ledger/worktree edges are genuinely distinct (different triggers — then label each) or redundant (then collapse). The correct labels depend on what those edges actually represent in the implement flow's role model (e.g. 'read DAG' vs 'record review', 'create worktree' vs 'merge back'). The clickable-underline and terminal-node (no-rounding) sub-items are mechanical and I can spec them from the existing DiagramSvg code — they don't need clarification. The open decisions are the edge-label semantics and the G38-FU-4 reconciliation (avoid double-planning the same web work).
- suggestions: ["Implement item 4 here in G41; I derive edge labels from the role model and you review them in the plan; collapse only truly-identical edges","Fold item 4 into G38 FU-4 instead and drop it from G41 to avoid overlap","Implement here, but you will supply the exact label text for the orchestrator→ledger/worktree edges"]
- recommendation: Implement item 4 in G41 (G38 is already 'planned' and its FU-4 is about depth, not these specific affordances) — I will derive per-edge labels from the implement-flow role model, collapse only edges that are genuinely identical, and surface the proposed label text in the plan for your review.
- ledgerRefs: ["goals:G41"]
- answer: as recommended

### Q188 — answered

- createdAt: 2026-06-09T18:48:00.039Z
- updatedAt: 2026-06-09T18:52:51.783Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Item 5 (Ideas ledger + /cq:plan idea-id arguments): Two decisions. (A) Ideas ledger shape — what status values should an Idea have (e.g. just open/done, or open/planned/discarded), and is 'description' the only field beyond a headline/title? (B) Idea→goal mapping when /cq:plan or /cq:plan:follow-up is given I-ids: should `/cq:plan I01 I02 I03` create ONE goal aggregating all three ideas, or one goal PER idea; how does the idea's text seed the new goal's description; and once an idea has spawned a goal, does the idea get marked (e.g. status→planned) or linked to that goal?"
- context: "The goal says the Ideas ledger is simple (status + description, no milestones) and that /cq:plan and /cq:plan:follow-up must accept I-ids alongside or instead of free text — but the exact status enum, the one-goal-vs-one-goal-per-idea aggregation rule, how idea text becomes goal description, and the idea-to-goal back-link/status-transition are all undecided and directly shape both the ledger schema and the command-grammar changes. Note: the canonical ledger set is fixed unless you ask — this explicitly asks for a new 'Ideas' ledger, so I'll add it."
- suggestions: ["One goal per idea; idea description seeds the goal description verbatim; idea marked status→planned and linked to the spawned goal; Idea statuses: open → planned → done, plus discarded","/cq:plan with multiple I-ids creates ONE aggregate goal whose description concatenates the ideas; /cq:plan:follow-up G35 I01 appends that idea's text to G35; ideas marked planned + linked","Free choice at invocation: /cq:plan I01 I02 = one goal each by default, with a flag to aggregate"]
- recommendation: "Idea shape: title + description + status open→planned→discarded (no milestones). /cq:plan I01 I02 I03 creates ONE goal per idea by default (each idea's description seeds that goal's description), and /cq:plan:follow-up G35 I01 appends idea I01's text as new scope on G35; in all cases the consumed idea is linked to the goal (ledgerRefs) and moved to status 'planned'."
- ledgerRefs: ["goals:G41"]
- answer: as recommended but I think the statuses should be open|planned|discarded|postponed, postponed is non-terminal and can go back to open.

## M150

### Q198 — answered

- createdAt: 2026-06-10T15:04:44.489Z
- updatedAt: 2026-06-10T15:09:08.995Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Where should the Claude Code `Stop` hook be REGISTERED, and is its installation in-scope for this goal or a documented manual step? Options: (a) repo-level `.claude/settings.json` (committed, travels with the repo, applies to anyone who opens this checkout in Claude Code); (b) user-level `~/.claude/settings.json` (per-machine, does not travel with the repo); (c) the Nix home-manager dev-llm module (`nix/hm/dev-llm.nix`) that already provisions the agent harness (the cq-assets contributed commands/skills), so the hook ships with the same mechanism that ships advance.md itself. Also: must the hook actually be INSTALLED by this goal's tasks, or is the deliverable the hook SCRIPT + a documented registration step the user performs?"
- context: "D50's key constraint is that enforcement must live in the HARNESS (no prompt can force the next token). The hook only fires for THIS repo's /cq:advance runs, but where it is registered determines whether it travels with the repo, is per-developer, or is provisioned by Nix. The dev-llm.nix module already provisions the cq-assets harness (the commands and skills under nix/pkg/cq-assets), so option (c) is the most consistent with how advance.md itself is delivered — but it couples the hook to the home-manager install. This is the central user-environment decision and gates how tasks #(install) are scoped."
- suggestions: ["(c) Register via nix/hm/dev-llm.nix — ships with the harness exactly like advance.md; installation in-scope (Nix-managed settings.json fragment)","(a) Repo-level .claude/settings.json — committed, travels with the checkout; installation in-scope","(b) Deliver the hook script + a documented manual registration step in ~/.claude/settings.json; installation is a documented manual step, NOT in-scope"]
- recommendation: (c) — register the Stop hook through nix/hm/dev-llm.nix so it ships with the same home-manager mechanism that already provisions the cq-assets harness (advance.md, the cq CLI). This keeps the gate co-located with the prose+CLI it enforces and avoids a per-developer manual step, matching how the rest of the harness is delivered. If the user prefers the gate to be checkout-local rather than machine-global, fall back to (a).
- ledgerRefs: ["goals:G44"]
- answer: (c) Register via nix/hm/dev-llm.nix — ships with the harness exactly like advance.md; installation in-scope (Nix-managed settings.json fragment)

### Q199 — answered

- createdAt: 2026-06-10T15:05:00.958Z
- updatedAt: 2026-06-10T15:09:45.645Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "What is the exact output contract for `cq advance-gate` (the CLI the Stop hook consumes), and how does it map to Claude Code's Stop-hook decision protocol? Claude Code Stop hooks read a JSON decision from the hook process: `{\"decision\":\"block\",\"reason\":\"...\"}` on stdout FORCES continuation (the reason is fed back to the model); absence of a block decision (or exit 0 with no block) ALLOWS the stop. Two layers must be pinned: (1) the `cq advance-gate` CLI's OWN stdout/exit-code contract (what it prints, what exit codes it uses for allow-stop vs force-continue vs error); (2) WHO emits the final `{\"decision\":\"block\",...}` JSON the harness reads — the CLI itself, or a thin shell wrapper script that interprets the CLI's verdict and emits the hook JSON."
- context: "D50 proposes the hook returns {decision:'block', reason:'P-...=TRUE; continue per D41'} when a predicate is TRUE-and-unblocked, else allows. Claude Code's documented Stop-hook protocol uses exactly a stdout JSON `{decision, reason}` (block to force continuation) or a 0/2 exit-code convention. We must decide whether `cq advance-gate` emits the hook-protocol JSON directly (simplest — the hook config calls the CLI as the command) or emits a neutral verdict (e.g. its own JSON / exit code) that a small wrapper translates into the harness protocol (more portable to other harnesses that need their own equivalent per D50's LIMITS). Pinning the exact strings (the `reason` text, the predicate restatement) also matters because that text is fed back to the model to make it continue."
- suggestions: ["`cq advance-gate` emits the Claude Code hook JSON DIRECTLY on stdout (exit 0 always; `{decision:'block',reason:'P-...=TRUE; continue per D41'}` to force-continue, `{}`/no-decision to allow) — hook config calls the CLI as the command, no wrapper","`cq advance-gate` emits a NEUTRAL verdict (its own JSON `{block:bool, reason, predicates:{...}}` + exit 0=allow / non-zero=block); a thin harness-specific wrapper translates it into Claude Code's {decision,reason} — keeps the CLI harness-agnostic for the Codex/other-harness equivalents D50 anticipates","Exit-code-only contract (exit 0 = allow-stop, exit 2 = force-continue with reason on stderr per Claude Code's exit-2 convention), no stdout JSON"]
- recommendation: "Option 2 (neutral verdict + thin wrapper). `cq advance-gate` should print a harness-agnostic JSON verdict and use exit code for the allow/block signal; a small Claude-Code-specific wrapper (registered as the Stop hook) translates that into `{decision:'block',reason}`. D50 explicitly anticipates other harnesses (Codex) needing their own stop-hook equivalent — keeping the CLI's contract neutral lets each harness wrapper reuse the same predicate engine. Confirm the exact `reason` string to feed back (proposed: `P-<which>=TRUE and unblocked; continue per D41 — turn-pause is not a stop condition`)."
- ledgerRefs: ["goals:G44"]
- answer: as recommended

### Q200 — answered

- createdAt: 2026-06-10T15:05:25.061Z
- updatedAt: 2026-06-10T15:10:05.184Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Where does the SESSION-SCOPED run-active marker live, and what is its exact lifecycle? It must be (a) keyed so the Stop hook fires ONLY during an active /cq:advance run in THIS session and never blocks ordinary chat turns, and (b) dropped at /cq:advance run start and removed exactly when the terminal handoffs item is written. Candidate locations: (1) a file under `docs/` (committed/visible, but the ledger commit rules forbid committing non-ledger junk and it would be shared across checkouts — wrong scope for a per-session marker); (2) a file under `.git/` (repo-local, gitignored, not shared — but couples to git internals); (3) a `/tmp` (or `$XDG_RUNTIME_DIR`) path keyed on `$CLAUDE_CODE_SESSION_ID` (truly session-scoped, auto-cleaned, never committed). How do the hook and advance.md both reference the SAME marker path deterministically without racing (the hook must compute the identical path the command wrote)?"
- context: "The marker is the engage/disengage switch for the whole gate: if it leaks (left present after a legitimate stop) the hook blocks ordinary chat; if it is absent during a run the gate never fires. Session-scoping on $CLAUDE_CODE_SESSION_ID is the natural key because the Stop hook receives the session id and /cq:advance can read the same env var, so both sides derive the identical path with no shared state. A /tmp or $XDG_RUNTIME_DIR path is auto-cleaned and never risks a stray git commit; a docs/ path would violate the ledger-only commit discipline and be wrongly shared across checkouts. The removal MUST be tied to the SAME create_item that writes the terminal handoff (advance.md's one write) so the two cannot diverge."
- suggestions: ["A `/tmp` (or `$XDG_RUNTIME_DIR`) file keyed on $CLAUDE_CODE_SESSION_ID, e.g. `${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-<session-id>` — dropped at run start, unlinked immediately after the terminal handoffs create_item; both hook and advance.md derive the path from the session-id env var","A gitignored file under the ledger root, e.g. `<root>/docs/.advance-active-<session-id>` (added to the git-backend .gitignore block) — co-located with the ledger but never committed","A file under `.git/` (e.g. `.git/cq-advance-active-<session-id>`) — repo-local and inherently gitignored"]
- recommendation: "Option 1 — a session-keyed file under `${XDG_RUNTIME_DIR:-/tmp}` named with `$CLAUDE_CODE_SESSION_ID`. It is genuinely session-scoped (the hook receives the session id and advance.md reads the same env var, so both compute the identical path with no race), auto-cleaned by the OS, and structurally incapable of polluting a git commit. advance.md drops it as its first run-start action and unlinks it in the same step that writes the terminal handoff. Please confirm $CLAUDE_CODE_SESSION_ID is available both to advance.md at runtime AND in the Stop-hook process environment (this is the load-bearing assumption)."
- ledgerRefs: ["goals:G44"]
- answer: as recommended

### Q201 — answered

- createdAt: 2026-06-10T15:05:42.429Z
- updatedAt: 2026-06-10T15:12:03.515Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "What is the EXACT external-signal escape — the verbatim artifact the agent records to legitimately end a run on genuine context/compaction exhaustion, that `cq advance-gate` recognizes and treats as allow-stop even while a predicate is TRUE? Pin: (1) the exact recognizable form (e.g. a line `external-signal: \"<verbatim harness quote>\"` where the quote is the literal context-window/compaction warning text the harness emitted); (2) WHERE it is written that the gate (a docs/*.md-reading CLI with no MCP) can see it within the same turn — the run-active marker file, a dedicated sidecar file, or a ledger item; (3) how the gate distinguishes a genuine harness-emitted signal from a model-fabricated one (can it? D50 concedes a forced degraded continuation is acceptable, so is a recorded verbatim quote sufficient even though it is ultimately self-attested?)."
- context: "D50/D41 draw the line at GENUINE externally-evidenced exhaustion: the harness itself signalled the limit (a context-window/compaction warning, or a tool result truncated for length). The escape must let a real exhaustion-stop through while making the UNLABELED effort-stop impossible. Because the gate reads docs/*.md directly with no MCP, the signal must be in a place the CLI reads at hook time. There is an inherent limit — the agent self-reports the quote, so the gate cannot cryptographically verify provenance; D50 accepts this (degraded forced-continuation beats silent premature stop, and the verbatim-quote requirement at least forces the agent to surface a concrete artifact rather than a vague euphemism). We need the exact string format and storage location pinned so the CLI's recognizer and advance.md's recording step agree."
- suggestions: ["A line in the run-active marker / a sidecar file under the same session-keyed path: `external-signal: \"<verbatim harness warning text>\"`; the gate greps for the `external-signal:` key with a non-empty quoted value and allows the stop — self-attested but forces a concrete verbatim artifact","A dedicated ledger `handoffs` (or notes) item recording the verbatim signal, which the gate reads from docs/*.md — durable + provenance-stamped, but couples the escape to a ledger write (and the gate must parse the markdown ledger for it)","No separate escape artifact: rely solely on the predicate-gated handoff (D39) as the ONLY legal stop, and treat genuine exhaustion as a TURN-pause that the hook simply cannot prevent (accept that the hook may force one extra continuation) — simplest, but loses the honor-real-exhaustion goal"]
- recommendation: "Option 1 — a `external-signal: \"<verbatim harness quote>\"` line in the session-keyed sidecar/marker file the gate already reads. The CLI recognizes a non-empty quoted value and allows the stop; the verbatim-quote requirement forces the agent to surface the concrete harness warning rather than a vague euphemism (D41's whole point). Provenance is self-attested and cannot be cryptographically verified — D50 explicitly accepts this limit (a degraded forced continuation still beats a silent premature stop). Please confirm self-attestation is acceptable, or whether you want the gate to additionally require evidence the agent cannot easily fabricate."
- ledgerRefs: ["goals:G44"]
- answer: as recommended

### Q202 — answered

- createdAt: 2026-06-10T15:06:07.631Z
- updatedAt: 2026-06-10T15:13:09.373Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "How should `cq advance-gate` re-derive the THREE predicates (P-investigate / P-plan / P-implement) + the open-question gate WITHOUT a running MCP server — and is sharing that derivation with @cq/ledger acceptable, or must it be a standalone reader? The predicate semantics already exist (advance.md §Detection predicates; the lifecycles from T116/M33). Options: (a) the CLI imports @cq/ledger, constructs the SAME LedgerStore (fs backend) the MCP server uses, reads items in-process, and applies a SHARED predicate function (single source of truth, no duplication — mirrors how G43's move-ledger reuses @cq/ledger); (b) the CLI uses @cq/ledger only to PARSE docs/*.md into items, but the three-predicate logic is a new standalone function the CLI owns; (c) the CLI is a fully standalone markdown reader with zero @cq/ledger dependency. Confirm the no-MCP-at-hook-time constraint means 'no running MCP SERVER process' (the CLI may still link the @cq/ledger LIBRARY and read the markdown files directly) — NOT 'no @cq/ledger code at all'."
- context: "The whole point of a CLI gate is that the Stop hook runs in a fast subprocess with no MCP server to talk to. But @cq/ledger is a LIBRARY: the existing cq subcommands (init/reset/erase/move-ledger) all `createLedgerStore(args.cwd)` and read/write the markdown directly with no MCP server. So 'no MCP dependency at hook time' almost certainly means 'no running ledger-mcp PROCESS', not 'no @cq/ledger import' — the CLI should link the library and read docs/*.md in-process exactly like move-ledger does. The remaining real decision is whether the predicate DERIVATION (the advance.md §Detection-predicates logic) becomes a SHARED, tested function in @cq/ledger (so the prose, the CLI, and any future consumer agree by construction) or stays duplicated in the CLI. Duplicating it risks the gate drifting from advance.md's prose — the exact failure mode D39/D50 are about (prose vs enforcement divergence). DRY + single-source-of-truth argues strongly for a shared function."
- suggestions: ["(a) Add a SHARED, dual-tested predicate-derivation function to @cq/ledger (e.g. `derivePredicates(store): {pInvestigate, pPlan, pImplement, openQuestionGate}`) consumed by `cq advance-gate`; the CLI constructs the fs-backed LedgerStore in-process (no MCP server) — single source of truth","(b) CLI reuses @cq/ledger only to parse docs/*.md into items; the three-predicate logic is a new function owned by the CLI (acceptable duplication, simpler dependency story)","(c) Fully standalone markdown reader in the CLI with zero @cq/ledger dependency"]
- recommendation: (a) — add the predicate derivation as a SHARED, dual-tested function in @cq/ledger and have `cq advance-gate` construct the fs-backed LedgerStore in-process (exactly as move-ledger/init/reset already do — no MCP server, just the library reading docs/*.md). This makes the gate's verdict the SAME logic the flow describes, eliminating the prose-vs-enforcement drift that D39/D50 exist to prevent, and gives the predicate semantics a test home. Confirm the 'no-MCP' constraint means no running MCP server PROCESS (the library import + direct markdown read is fine), and that adding the derivation to @cq/ledger (vs the CLI package) is acceptable.
- ledgerRefs: ["goals:G44"]
- answer: As recommended. Also, I think that if we express predicates in code, we can expose them through MCP and correct our prompts so the agent reads predicates from an MCP instead of deriving on its own!

### Q203 — answered

- createdAt: 2026-06-10T15:06:25.617Z
- updatedAt: 2026-06-10T15:13:51.529Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "What is the exact SCOPE of the commands/cq/advance.md edits, and do sibling commands need the marker too? Specifically: (1) which exact sections gain the marker drop/remove + external-signal-recording steps — §Bootstrap recipe (run start, drop marker), §The one write / §End-of-run (remove marker in the SAME step as the terminal handoffs create_item), §Stop-condition gate (cross-reference the hook + the external-signal escape), and the §Auto-fetch run-START step (where to drop relative to the git-object fetch)? (2) Do the CHAINED per-flow commands (`/cq:plan:advance`, `/cq:investigate:advance`, `/cq:implement:advance`) or any wrapper/start commands need to drop the marker when run STANDALONE — i.e. is the turn-pause gate scoped ONLY to /cq:advance, or to every long autonomous run? (3) Should the existing prose (the D41 blocklist / self-check) be UPDATED to reference the new hard enforcement, or left intact as the fallback for non-Claude harnesses?"
- context: "advance.md is the only command that writes a run-level handoff and is the locus of the turn-pause prose (D41). The marker drop must happen at run start and the removal must be atomic with the terminal handoff write (advance.md's single ledger write, in §The one write / §End-of-run). The chained sub-commands SUPPRESS their own handoff when run under /cq:advance (Q85) but DO write their own when standalone — so whether THEY also need the gate depends on whether premature turn-pause is a risk for a standalone /cq:plan:advance or /cq:implement:advance run, not just the top-level /cq:advance. D50's evidence was specifically about /cq:advance runs. Keeping scope to /cq:advance only is the minimal change; extending to the sub-commands is broader but more uniform. The existing D41 prose should stay (it is the documented fallback for Codex/other harnesses per D50's LIMITS) but may need a sentence noting the Claude-Code hook now enforces it."
- suggestions: ["Scope the gate to /cq:advance ONLY (matches D50's evidence): edit §Bootstrap (drop marker after the git-object fetch), §End-of-run / §The one write (remove marker atomically with the terminal handoff), §Stop-condition gate (cross-ref the hook + external-signal escape); keep the D41 prose, add one sentence that the hook now enforces it for Claude Code; do NOT touch the sub-commands","Extend the marker+gate to the standalone sub-commands too (/cq:plan:advance, /cq:investigate:advance, /cq:implement:advance) so any long autonomous run is gated, not just /cq:advance — broader, more uniform, more edits","Minimal: only §Bootstrap (drop) + §End-of-run (remove) edits in advance.md; leave the Stop-condition prose entirely untouched"]
- recommendation: "Option 1 — scope to /cq:advance only (where D50's evidence lies), editing §Bootstrap recipe (drop the marker at run start, after the git-object fetch), §End-of-run / §The one write (unlink the marker in the SAME step that writes the terminal handoffs item, so the two cannot diverge), and §Stop-condition gate (cross-reference the hook + the external-signal escape). KEEP the existing D41 blocklist/self-check prose intact as the documented fallback for non-Claude harnesses (D50's LIMITS), adding a single sentence that the Stop hook now mechanically enforces it for Claude Code runs. Do NOT modify the sub-commands unless you specifically want standalone sub-command runs gated too. Confirm this scope."
- ledgerRefs: ["goals:G44"]
- answer: as recommended

### Q204 — answered

- createdAt: 2026-06-10T15:06:54.333Z
- updatedAt: 2026-06-10T15:14:09.428Z
- author: user
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "What is the acceptance/verification bar for this gate, given it enforces a BEHAVIORAL property in a harness hook that bun test cannot directly exercise? D39 (the precedent) was verified by (a) dual-adapter unit tests asserting the now-unwritable handoff THROWS, plus (b) a grep-invariant guarding the advance.md prose. For D50 the analogues are: (1) UNIT-test `cq advance-gate`'s verdict logic against fabricated ledger states (predicate TRUE-and-unblocked => block; all-FALSE => allow; external-signal present => allow) — directly testable; (2) an INTEGRATION test of the hook script's stdout/exit contract; (3) the actual end-to-end 'model cannot turn-pause prematurely' behavior is NOT unit-testable (it is the LLM's behavior). Do you accept that the verification bar is (1)+(2) + a documented manual repro, and that the irreducible behavioral property is covered only by the forced-continuation mechanism itself (D50's accepted LIMIT)? Should a grep-invariant (like D39's 8-cell guard) assert the marker-drop/remove + external-signal steps stay present in advance.md?"
- context: Per the repo's reproduce-before-fix discipline and D39's precedent, this fix needs a concrete verification story before planning the tasks. The CLI verdict logic is cleanly unit-testable against synthetic ledger fixtures (the dual-tests pattern the repo already uses). The hook's stdout/exit contract is integration-testable by invoking the script with a stub gate. But the ULTIMATE property — 'a real model no longer turn-pauses prematurely' — cannot be asserted by a deterministic test (it is the very LLM behavior D50 says prose failed to bind); the gate's value is the forced continuation, not a provable behavior change. D39 also added a grep-invariant to stop the advance.md prose from silently regressing; an analogous guard could pin the new marker/external-signal steps. We need the acceptance bar agreed so the plan's tasks carry the right `acceptance` fields.
- suggestions: ["Bar = (1) dual-adapter unit tests of `cq advance-gate`'s verdict against synthetic ledger states + (2) an integration test of the hook script's stdout/exit contract + (3) a documented manual repro (drop marker, leave a TRUE predicate, attempt stop, observe forced continuation); ADD a grep-invariant pinning the advance.md marker/external-signal steps (mirrors D39's 8-cell guard)","Bar = unit tests of the CLI verdict logic ONLY; skip the hook integration test and the grep-invariant (lighter, but less regression protection)","Bar = the above PLUS a recorded live /cq:advance session demonstrating the hook firing end-to-end (strongest evidence, but depends on a live harness run that cannot be a CI gate)"]
- recommendation: Option 1 — unit-test the CLI verdict logic via the dual-tests pattern (synthetic ledger fixtures covering predicate-TRUE-and-unblocked => block, all-FALSE => allow, external-signal-present => allow, marker-absent => allow), add an integration test of the hook script's stdout/exit contract, document a manual repro for the irreducible behavioral edge, and add a grep-invariant pinning the new advance.md marker/external-signal steps exactly as D39 guarded its prose. Explicitly accept (per D50's LIMITS) that the end-to-end 'model stops turn-pausing' property is covered by the forced-continuation mechanism, not by a deterministic test. Confirm this is the acceptance bar.
- ledgerRefs: ["goals:G44"]
- answer: "Bar = the above PLUS a recorded live /cq:advance session demonstrating the hook firing end-to-end (strongest evidence, but depends on a live harness run that cannot be a CI gate)"

## M156

### Q205 — open

- createdAt: 2026-06-10T18:17:27.857Z
- updatedAt: 2026-06-10T18:17:27.857Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Namespacing mechanism, separator, and DEFAULT for cq products: should namespacing be a tool-name PREFIX (e.g. `myproj_create_item`), and critically — does cq keep its CURRENT UNPREFIXED names (`create_item`, `snapshot`, `fetch_ledger`, …) by default so the frontends and `mcp__ledger__<tool>` command references DON'T break, with the prefix being opt-in only for 3rd-party consumers?"
- context: "LEDGER_TOOL_NAMES (ledgerTools.ts:739-766) is a hardcoded 26-name array; the same literals are registered in BOTH factories (createLedgerMcpTools tool() + registerLedgerStdioTools server.registerTool). MCP tool names must match `^[a-zA-Z0-9_-]+$` (safeIdSchema regex in both factories uses exactly this charset for ids). The frontends + cq command prompts address tools as `mcp__ledger__create_item` etc., so any change to cq's own names is breaking. The goal description already hypothesizes cq's default prefix stays empty."
- suggestions: ["PREFIX with `_` separator (e.g. `myproj_create_item`); cq default prefix = empty (names unchanged); prefix validated as `^[a-zA-Z0-9]+$` so prefix+`_`+name stays within `^[a-zA-Z0-9_-]+$`","PREFIX with `_`, but allow any MCP-safe prefix matching `^[a-zA-Z0-9-]+$`","A more general namespacing scheme (e.g. configurable transform fn) rather than a fixed prefix+separator"]
- recommendation: "Tool-name PREFIX with `_` separator; cq's default prefix is EMPTY so all current names + frontend/command references are byte-identical; prefix constrained to `^[a-zA-Z0-9]+$` (letters/digits) so `<prefix>_<name>` always satisfies the MCP-safe `^[a-zA-Z0-9_-]+$` charset. Opt-in only for 3rd-party consumers."
- ledgerRefs: ["goals:G45"]

### Q206 — open

- createdAt: 2026-06-10T18:17:35.843Z
- updatedAt: 2026-06-10T18:17:35.843Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Where is the prefix configured? The 3rd-party path is programmatic (they import @cq/ledger and call the factory), but should the prefix ALSO be reachable via a cq.toml `[ledger]` key and/or a `ledger-mcp` CLI flag (e.g. `--tool-prefix`)? Or is the programmatic parameter the only surface, with cq itself never setting a prefix?"
- context: "createLedgerMcpTools / registerLedgerStdioTools / buildServer take no prefix today. The 3rd-party reusable path is programmatic: a consumer calls registerLedgerStdioTools(server, store, …) (exported from @cq/ledger, index.ts:84) or builds their own server. cq's own ledger-mcp main.ts parses --cwd/--http and reads cq.toml `[ledger]` (backend/branch) via createLedgerStore. If cq's default prefix is empty, cq's server may need NO new flag at all."
- suggestions: ["Programmatic parameter ONLY (thread `toolPrefix` through the two factories + buildServer); no cq.toml key, no CLI flag — cq never sets a prefix","Programmatic parameter PLUS a `ledger-mcp --tool-prefix <p>` CLI flag for standalone reuse without writing code","Programmatic + CLI flag + cq.toml `[ledger] toolPrefix` key (all three surfaces)"]
- recommendation: Programmatic parameter as the primary surface (threaded through both factories + buildServer), PLUS a `ledger-mcp --tool-prefix <p>` CLI flag so a 3rd party can stand up a prefixed standalone server without writing TS. No cq.toml key needed (cq's default stays empty / unprefixed).
- ledgerRefs: ["goals:G45"]

### Q207 — open

- createdAt: 2026-06-10T18:17:44.833Z
- updatedAt: 2026-06-10T18:17:44.833Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Scope of 'reusable component': is the deliverable JUST the prefix knob threaded through the tool factories + drift-guard + instructions? Or ALSO (a) a documented PUBLIC builder API (e.g. `createLedgerMcpServer({ store, toolPrefix, … })`) as a first-class @cq/ledger / @cq/ledger-mcp export, (b) an explicit packaging/exports decision (what becomes public vs internal), and (c) a short example/doc showing a 3rd party building their own ledger MCP?"
- context: "@cq/ledger already exports the building blocks (createLedgerMcpTools, registerLedgerStdioTools, LEDGER_TOOL_NAMES, createLedgerStore — index.ts:62,83,84). But the cohesive 'build-your-own server' wrapper is buildServer(), which lives in @cq/ledger-mcp/main.ts and is NOT exported as a public API; a 3rd party would today have to hand-assemble McpServer + registerLedgerStdioTools + createLedgerStore themselves. The user called this a MINOR feature."
- suggestions: ["Prefix knob ONLY — thread toolPrefix through the existing exported factories; no new wrapper, no doc (3rd parties assemble from existing exports)","Prefix knob + a thin documented public builder (`createLedgerMcpServer({ store, toolPrefix })`) exported from @cq/ledger-mcp + a short README example","Prefix knob + public builder + a worked example package/dir + packaging/exports review"]
- recommendation: "Prefix knob PLUS a thin documented public builder (extract/export the existing buildServer as `createLedgerMcpServer({ store, displayName, toolPrefix })` from @cq/ledger-mcp) PLUS a short README example. This is the minimal surface that makes it genuinely reusable without an API overhaul — matches 'MINOR'."
- ledgerRefs: ["goals:G45"]

### Q208 — open

- createdAt: 2026-06-10T18:17:55.199Z
- updatedAt: 2026-06-10T18:17:55.199Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Prefix-propagation completeness: must the prefix apply consistently to ALL tool names across (1) the Claude tool() factory, (2) the raw registerTool factory, (3) the LEDGER_TOOL_NAMES-derived drift-guard test, and (4) the server `instructions` overview text (which names tools like snapshot/derive_predicates/fetch_ledger/create_item)? And do you confirm the prefix is PURELY a name transformation — handler bodies, Zod input schemas, and the `mcp__ledger__` MCP-server-namespace component are all unchanged?"
- context: "There are 4 places tool NAMES appear: createLedgerMcpTools (ledgerTools.ts), registerLedgerStdioTools (stdioLedgerTools.ts), the LEDGER_TOOL_NAMES array (ledgerTools.ts:739), and SERVER_INSTRUCTIONS (main.ts:229-277, e.g. lines naming `create_item`, `snapshot()`, `derive_predicates()`, `fetch_ledger`). A drift-guard test asserts the registered tool set equals LEDGER_TOOL_NAMES. The `mcp__<server>__<tool>` prefix is applied by the host/SDK from the SERVER name, which is a separate axis from the per-tool prefix."
- suggestions: ["Prefix applies to all 4 surfaces; instructions text is regenerated to use prefixed names when a prefix is set; handlers/schemas unchanged; `mcp__ledger__` server component untouched","Prefix applies to the registered tool names + drift-guard only; leave instructions naming the BARE names (documented as logical names)","Prefix applies to tools + drift-guard + instructions, AND a helper exposes the resolved prefixed name list for tests/consumers"]
- recommendation: "Apply the prefix to all 4 surfaces (both factories, the drift-guard, and the instructions overview, regenerated to show prefixed names when set), as a PURE name transformation: handler bodies, Zod schemas, and the `mcp__<server>__` server-namespace component are untouched. Derive LEDGER_TOOL_NAMES-prefixed once and reuse so the drift-guard stays the single source of truth."
- ledgerRefs: ["goals:G45"]

### Q209 — open

- createdAt: 2026-06-10T18:18:07.193Z
- updatedAt: 2026-06-10T18:18:07.193Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Frontend/client impact and reverse-direction discovery: (a) Confirm that because cq's default prefix stays empty, cq's own frontends (ledger-tui / ledger-web) and command prompts that address `mcp__ledger__<tool>` are UNAFFECTED. (b) Is exposing the resolved (possibly-prefixed) tool-name list to a 3rd-party's OWN client in scope, or out of scope because a standard MCP client simply lists tools at runtime (tools/list) and needs no compile-time name table?"
- context: cq's frontends are pure MCP clients; they call tools by the SERVER-namespaced name `mcp__ledger__<tool>`. A standard MCP client discovers tool names dynamically via the protocol's tools/list, so it does not hardcode names. Only the drift-guard TEST and cq's own prompts hardcode bare names — and those use cq's empty prefix. A 3rd party choosing a prefix would see their prefixed names in tools/list automatically.
- suggestions: ["Confirm frontends unaffected (empty cq prefix); reverse-direction name export OUT of scope — consumers rely on MCP tools/list","Confirm frontends unaffected; ALSO export a small helper (e.g. `prefixedToolNames(prefix)`) for consumers who want a compile-time table or to assert non-collision in tests","Frontends unaffected; provide a typed name map AND document the tools/list discovery path"]
- recommendation: "Confirm cq frontends + command prompts are unaffected (cq prefix stays empty). Reverse-direction client name export is OUT of scope for runtime (consumers use MCP tools/list), but export a tiny pure helper `prefixedToolNames(prefix): string[]` (reused by the drift-guard) so a consumer CAN assert non-collision in their own tests if desired."
- ledgerRefs: ["goals:G45"]

### Q210 — open

- createdAt: 2026-06-10T18:18:16.136Z
- updatedAt: 2026-06-10T18:18:16.136Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Storage-customization confirmation: the goal states storage (directory/branch) is already solved and out of scope. Confirm NO storage work is in scope — i.e. the existing createLedgerStore(cwd) + `[ledger]` backend/branch params are deemed sufficient for a 3rd party to point a reusable ledger MCP at their own storage, and this goal touches ONLY tool-name namespacing + the minimal public-builder surface?"
- context: "@cq/ledger exports createLedgerStore / FsLedgerStore / GitObjectLedgerBackend / InMemoryLedgerStore (index.ts), and ledger-mcp's createEmbeddedStore wraps createLedgerStore(cwd) with `[ledger]` backend selection. The goal description explicitly lists storage as 'already solved (out of scope)'. This question just pins that no incidental storage-API work creeps into the plan."
- suggestions: ["Confirm: zero storage work; reuse existing createLedgerStore/backend params as-is","Confirm storage out of scope, but the public-builder example should DEMONSTRATE wiring a custom store (doc-only, no new storage code)","Storage needs a small touch-up (specify what) — not purely out of scope"]
- recommendation: "Confirm storage is fully out of scope: no new storage code. The 3rd-party builder example may merely DEMONSTRATE passing a store the consumer constructed (FsLedgerStore / their own LedgerStore impl), but that is documentation, not new storage work."
- ledgerRefs: ["goals:G45"]

### Q211 — open

- createdAt: 2026-06-10T18:18:25.403Z
- updatedAt: 2026-06-10T18:18:25.403Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- question: "Acceptance bar: what concretely must hold for this goal to be 'done'? Proposed: (1) a test constructs TWO ledger MCP servers with DIFFERENT prefixes in ONE process and asserts ZERO tool-name collision and that both servers' tools work; (2) cq's own server is unchanged — default unprefixed, and the existing LEDGER_TOOL_NAMES drift-guard stays green; (3) if a public builder is in scope, a doc/example shows a 3rd party building their own prefixed ledger MCP; (4) `bun run check` (test + typecheck + lint) passes. Confirm / amend."
- context: Acceptance must be operational. The existing drift-guard test asserts the registered tool set equals LEDGER_TOOL_NAMES; the new prefix behaviour needs its own collision/both-work test. The non-collision-in-one-process scenario is the exact motivating use case in the goal description (host runs cq ledger MCP + a 3rd-party ledger MCP together).
- suggestions: ["All four criteria as stated (two-prefixed-servers collision test + cq-unchanged drift-guard + builder doc/example + bun run check green)","Criteria 1+2+4 only (defer the doc/example if the public builder is descoped per Q207)","Add a 5th: an explicit test asserting the prefixed `instructions` text names the prefixed tools when a prefix is set"]
- recommendation: Adopt criteria 1–4 as written; the two-prefixed-servers-in-one-process test (zero collision + both functional) is the core acceptance gate, the unchanged cq drift-guard proves no regression, and `bun run check` is the standing repo gate. Include the doc/example only if Q207 keeps the public builder in scope; add the instructions-naming assertion (suggestion 3) since the prefix touches the instructions text per Q208.
- ledgerRefs: ["goals:G45"]
