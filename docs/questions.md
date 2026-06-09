---
ledger: questions
counters:
  milestone: 0
  item: 175
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

## M132

### Q174 — open

- createdAt: 2026-06-09T13:56:38.293Z
- updatedAt: 2026-06-09T13:56:38.293Z
- author: "opus-4.8[1m]"
- session: 242ca46f-d593-40f1-9dc2-480c12cf887c
- question: Root cause of D45 confirmed (H32) and a defect-seeded goal G39 is ready to plan — the fix is a one-line cacheMirror change (mirror docs/ledgers.yaml on the 'create' op). Traceability only.
- context: "Auto-launched inside /cq:advance (NOT standalone): this investigation was chained, so the parent /cq:advance session auto-resumes G39 in its plan stage — a manual /cq:plan:advance G39 is NOT needed. Root cause: cacheMirror.ts:82 early-returns before mirroring registryPath; createLedger fires a 'create' op. Fix: mirror registryPath on 'create' too. This question is filed for traceability per the file-and-defer step."
- ledgerRefs: ["defects:D45","goals:G39"]
