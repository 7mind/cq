---
ledger: tasks
counters:
  milestone: 0
  item: 49
archives:
  - id: M5
    path: ./archive/tasks/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
  - id: M2
    path: ./archive/tasks/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
  - id: M3
    path: ./archive/tasks/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
  - id: M4
    path: ./archive/tasks/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
---

# tasks

## M6

### T26 — done

- createdAt: 2026-06-01T23:18:10.880Z
- updatedAt: 2026-06-02T06:24:07.110Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req5: add optional `summary` field to reviews schema (lib + registry + sample + tests)"
- description: "Add an OPTIONAL single-line `summary: { type: 'string', required: false }` to REVIEWS_SCHEMA in packages/ledger/src/constants.ts. Mirror the change in the live registry docs/ledgers.yaml and the examples/sample-ledger/docs/ledgers.yaml copy. Update packages/ledger/test/canonical-ledgers.test.ts (and any other test asserting the reviews field set) so the canonical-set assertion includes `summary`. Keep it optional so existing reviews (R1, and any prior) remain valid — no migration/backfill. This is the foundational schema change other Req5 tasks build on. Per Q16 'as recommended': optional single-line summary, all three registry copies + canonical test updated."
- acceptance: "REVIEWS_SCHEMA.fields.summary exists with type 'string' and required:false (assert this EXPLICITLY in a test — do NOT rely on the canonical-ledgers test, which only exercises specific fields plus a schema-divergence guard and does NOT assert an exact reviews field-SET). Add/extend an assertion that all THREE registry copies declare `summary`: the lib constant REVIEWS_SCHEMA, docs/ledgers.yaml, and examples/sample-ledger/docs/ledgers.yaml. The existing canonical-ledgers.test.ts must still pass on divergence-guard parity (its role here is only to confirm the three copies stay in sync, NOT to verify the field's presence/type). Existing reviews items with no summary still load/validate. `bun test packages/ledger` green; `bun run typecheck` green."
- suggestedModel: standard
- ledgerRefs: ["goals:G1"]
- resultCommit: 99fad44
- completion: Added optional `summary` to REVIEWS_SCHEMA + both YAML registry copies; explicit field test + backward-compat test. Reviewer approve 0/0. Merged to main 99fad44; integration check 422 pass.

### T27 — done

- createdAt: 2026-06-01T23:18:23.231Z
- updatedAt: 2026-06-02T06:55:04.394Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req5: prefer `summary` in summarize() + fix status-badge/summary-cell wrapping in both UIs"
- description: "summarize() is NOT a shared util — it is duplicated VERBATIM in TWO files: packages/ledger-tui/src/app.tsx:63 and packages/ledger-web/src/App.tsx:110, both bodies `f[\"headline\"] ?? f[\"title\"] ?? f[\"question\"] ?? f[\"summary\"] ?? Object.values(f)[0]`. With the schema field added (T26), reviews now carry a short summary, but LEGACY reviews (R1, R3) have none and BOTH copies fall through to the long criticism string[]. Scope BOTH copies in this task: (a-web) packages/ledger-web/src/App.tsx summarize() — already prefers `summary`; add a graceful fallback for legacy reviews with no summary (truncate the FIRST criticism line rather than dumping the whole joined string[]). (a-tui) packages/ledger-tui/src/app.tsx summarize() — apply the IDENTICAL truncate-first-criticism fallback so the TUI does not render the full joined criticism for legacy reviews. (b) Web ItemTable CSS/markup: set white-space:nowrap on the `.lw-status` badge AND clamp the summary <td> to a single line with ellipsis for ALL ledgers (uniform row height) — per Q17 'as recommended'. Locate the web ItemTable component + its stylesheet. NOTE: if the two summarize() bodies are easy to converge, optionally extract a shared helper, but the contract here is that BOTH frontends get the legacy-review fallback — do not deliver Req5 for the web only."
- acceptance: "BOTH frontends: reviews rows show the short `summary`, not the long criticism. WEB: a legacy review with no summary renders a truncated single-line fallback (not the full joined criticism); the `go-ahead`/`revise` badge no longer wraps; summary cell is single-line ellipsis across all ledgers — assert via happy-dom web tests. TUI: an ink-testing-library test asserts that a legacy review with no summary renders a truncated SINGLE line (not the full joined criticism string[]). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T26"]
- ledgerRefs: ["goals:G1"]
- resultCommit: dc7af9c
- completion: Both summarize() copies (web+TUI) fall back to truncated first criticism line (not joined) for legacy summary-less reviews; web .lw-status nowrap + .lw-summary-cell ellipsis on all ledgers. 5 tests (happy-dom + ink). Reviewer approve 0/0. Merged dc7af9c; integration 438 pass.

### T28 — done

- createdAt: 2026-06-01T23:18:30.286Z
- updatedAt: 2026-06-02T06:45:45.934Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req5: thread `summary` through both reviewer prompts + the implement:advance recorder"
- description: "Per Q18 'as recommended', all three are in scope: (a) llm/agents/plan-reviewer.md — add an optional one-line `summary` to its create_item('reviews', ...) fields and update its R-format examples. (b) llm/agents/implement-reviewer.md — add a `summary` field to the JSON contract the reviewer returns (taskId/verdict/criticism/questions/rationale + summary). (c) llm/commands/implement/advance.md — map the reviewer JSON `summary` into the create_item('reviews', ...) fields when recording the terminal review, synthesizing a one-line fallback from rationale/verdict if the model omits it. Note these implement-* prompts are authored under M3 (depends-on); coordinate so summary is baked in rather than retrofitted. Edits are prompt/markdown only — no code paths."
- acceptance: plan-reviewer.md create_item example includes summary; implement-reviewer.md JSON contract documents a `summary` string; implement/advance.md explicitly maps summary into the recorded reviews item with a documented fallback. No schema/type regressions; `bun run check` unaffected (markdown-only) but run it to confirm.
- suggestedModel: standard
- dependsOn: ["T26"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 58eb3af
- completion: Threaded `summary` through plan-reviewer.md (both create_item examples), implement-reviewer.md JSON contract, and implement/advance.md recorder with a single documented fallback. Round-0 criticism (two divergent fallback formulas) fixed in round 1. Reviewer approve. Merged 58eb3af.

### T29 — done

- createdAt: 2026-06-01T23:18:36.874Z
- updatedAt: 2026-06-02T06:24:12.766Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req1: implement fetchLedgerArchive in the web MCP client (+ TUI client parity)"
- description: "Per Q11 'as recommended': reuse existing archivePointers + fetch_ledger_archive plumbing; no new MCP tool required (the store/MCP layer already exposes both). The web mcpClient does NOT yet implement fetchLedgerArchive — add it so the web frontend can read a chosen milestone's archived items over MCP (frontends never read docs/ directly). Confirm the TUI client has (or add) the same archive-read method for parity so T31 can consume it. This task is plumbing only: client method + types; no UI rendering yet. archivePointers already arrive on fetch_ledger."
- acceptance: web mcpClient exposes fetchLedgerArchive(ledgerId, archiveId) returning the typed archived group/item; TUI client has the equivalent; a unit/integration test exercises a fetch against a seeded archive (read-only). `bun run check` green.
- suggestedModel: standard
- ledgerRefs: ["goals:G1"]
- resultCommit: 0b025a7
- completion: fetchLedgerArchive(ledgerId, archiveId) added to web + TUI McpLedgerClient (typed ArchiveContent), 7 fakes updated, integration test seeds archive + reads group/item variants. Reviewer approve 0/0. Merged to main 0b025a7.

### T30 — done

- createdAt: 2026-06-01T23:18:43.575Z
- updatedAt: 2026-06-02T06:39:51.590Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req2+Req3 (web): per-milestone dropdown filter + collapsible milestone subsections in ItemTable"
- description: "Per Q13/Q14 'as recommended', unified: render the web ItemTable as per-milestone SUBSECTIONS (collapsible header = resolved milestone id + title + status, ordered as fetch_ledger returns the FetchedMilestoneGroup[] = insertion order) AND add a milestone DROPDOWN that narrows to a single milestone; the existing status filter ANDs with it. Drop the now-redundant per-row milestone column (the subsection header carries it). Exclude the milestones ledger itself (no meaningful sub-grouping). fetch_ledger already returns items grouped with resolved milestone title/status, so no extra calls. Touches the web ItemTable component, its toolbar (add the milestone <select> beside the status <select>), and styles."
- acceptance: Web ItemTable shows collapsible per-milestone subsections in fetch_ledger group order with id+title+status headers; a milestone dropdown narrows to one milestone and ANDs with status; per-row milestone column removed; milestones ledger view unaffected. happy-dom tests for the new controls pass (selects are controlled — fine under happy-dom); `bun run check` green.
- suggestedModel: standard
- ledgerRefs: ["goals:G1"]
- resultCommit: a149b06
- completion: Web ItemTable → per-milestone collapsible subsections (group order, id+title+status headers) + milestone dropdown ANDing with status; per-row milestone column removed; milestones ledger flat table unaffected; 6 happy-dom tests. Reviewer approve 0/0. Merged a149b06.

### T31 — done

- createdAt: 2026-06-01T23:18:50.534Z
- updatedAt: 2026-06-02T06:39:54.385Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req4+Req3 (TUI): column-aligned item table (id | status | summary) with per-milestone subsections"
- description: "Per Q15/Q14 'as recommended': replace the flat 'id [status] summary' ink <Text> row in the TUI list with a COLUMN layout: id padded to the max id width among visible rows, status padded to the schema's max statusValue width, summary truncate-end (already the wrap mode). Columns are id | status | summary — NO milestone column (the Req3 subsection header carries milestone). Add per-milestone SUBSECTIONS to the TUI list too (header = resolved milestone id+title+status, fetch_ledger group order), excluding the milestones ledger. Must degrade in a narrow, resizable left pane (ratio 0.2-0.8, dockable right/bottom): id/status fixed-padded, summary absorbs remaining width and truncates. Preserve the cursor prefix and optional 1-char scrollbar column in ScrollList."
- acceptance: TUI rows align in columns regardless of id width ('T1' vs 'T14'); status column aligned; summary truncates to fit a narrow pane; per-milestone subsection headers render in group order; milestones ledger view unaffected; cursor + scrollbar still work. ink-testing-library tests assert column alignment + subsection headers; `bun run check` green.
- suggestedModel: standard
- ledgerRefs: ["goals:G1"]
- resultCommit: c6e2e80
- completion: TUI list → column-aligned (id|status|summary, padded) with per-milestone subsection headers (group order); milestones ledger unaffected; cursor+scrollbar preserved (ListEntry<T> union); 5 ink tests. Reviewer approve 0/0. Merged c6e2e80.

### T32 — done

- createdAt: 2026-06-01T23:18:59.949Z
- updatedAt: 2026-06-02T07:08:12.889Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req1 (web): read-only archive affordance — per-ledger 'show archived' toggle + expand pointer"
- description: "Per Q11/Q12 'as recommended': add a per-ledger 'show archived' toggle/section that lists the ledger's archivePointers (id, path, summary from fetch_ledger) and, on selecting one, lazily calls fetchLedgerArchive (T29) and renders that milestone's archived items READ-ONLY. Archived items are detached/terminal: suppress ALL edit affordances (status edit, field save, quick-transition buttons, answer) for them in the web detail panel. No new MCP tool (the user permitted adding one only if it benefits agents — not needed for this read-only UI). Touches the web toolbar/ledger view + detail panel (gate its edit controls on an isArchived flag)."
- acceptance: Web shows a per-ledger 'show archived' control; selecting a pointer lists that milestone's archived items; opening one shows fields read-only with NO edit/transition/answer controls; active-item editing unchanged. happy-dom tests cover the toggle + read-only suppression; `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T29"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 44b63bb
- completion: Web per-ledger 'show archived' toggle (gated on archivePointers); lazy fetchLedgerArchive; archived items read-only (DetailPanel isArchived + no onSave suppresses edit/transition/answer); active editing unchanged; 5 happy-dom tests. Reviewer approve 0/0. Merged 44b63bb.

### T33 — done

- createdAt: 2026-06-01T23:19:05.614Z
- updatedAt: 2026-06-02T07:08:15.562Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Req1 (TUI): read-only archive view — per-ledger 'show archived' affordance + read-only items"
- description: "Per Q11/Q12 'as recommended': the TUI currently has NO archive affordance (only status filters). Add a per-ledger 'show archived' toggle/section that lists archivePointers and, on selection, lazily fetches that milestone's archived items (TUI client method from T29) and renders them READ-ONLY — suppress every edit/transition/answer keybinding for archived items. Reach archives via a toggle within the existing ledger view (mirror the web affordance) rather than a separate top-level pseudo-ledger. Integrate with the new column table/subsections (T31) so archived items use the same row layout."
- acceptance: TUI exposes a 'show archived' affordance per ledger; selecting a pointer lists archived items read-only; edit/transition/answer keys are inert on archived items; layout matches the T31 column table. ink-testing-library tests cover the archive toggle + read-only suppression; `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T29","T31"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 39197bb
- completion: TUI 'A' archive toggle per ledger; lazy fetchLedgerArchive; archived rows read-only (s/a/r/e/n inert via !cursorInArchive in both focus modes); T31 column layout reused; 7 ink tests. Reviewer approve 0/0. Merged 39197bb.

### T34 — planned

- createdAt: 2026-06-01T23:19:11.872Z
- updatedAt: 2026-06-01T23:22:28.071Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Follow-up integration gate: `bun run check` green + cross-cutting regression assertion"
- description: "Objective integration gate for the whole follow-up — NO manual smoke sweep (per-request verification lives in the per-task automated tests each request already owns: T27 happy-dom + ink, T30 happy-dom, T31 ink, T32 happy-dom, T33 ink; T26 lib tests). This task is reduced to: (1) run `bun run check` (tsc + eslint + bun test) at repo root — must be fully green, confirming all the per-task suites pass together; (2) add/confirm a cross-cutting regression assertion that the changes do not break active-item editing or the plan/implement flows (the one verification that no single per-task test owns because it spans the UI changes collectively) — e.g. an existing-behavior smoke test that active items still render with edit/transition affordances after the archive/subsection/column work. Any defect surfaced by the green-check run is filed as a `defects` item linked to G1 before this task is marked done. The five per-request behaviors are NOT re-verified manually here — they are owned by T27/T30/T31/T32/T33 acceptance tests."
- acceptance: "`bun run check` green at repo root (all per-task suites pass together); a cross-cutting regression check confirms active-item editing and the plan/implement flows are unaffected by the follow-up UI/schema changes; any defect found is filed as a defects item linked to G1 before done. No manual observed-vs-expected sweep — per-request behavior is verified by the owning tasks' tests."
- suggestedModel: standard
- dependsOn: ["T26","T27","T28","T29","T30","T31","T32","T33"]
- ledgerRefs: ["goals:G1"]

## M7

### T35 — done

- createdAt: 2026-06-01T23:36:19.863Z
- updatedAt: 2026-06-02T06:06:57.909Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Lock the investigate:* design decision (hypothesis-ledger tree, loop owner, file-and-defer handoff)"
- description: "Record a `decisions` item under M1 (the G1 coordination milestone) capturing the investigate:* architecture so the prompt authors share one contract: (1) the `hypothesis` ledger IS the durable tree — each node a hypothesis item, `parentHypothesis` = ancestry, `evidence[]` = validated citations with a `[correct]`/`[incorrect]` prefix convention (research-loop E-item format), `status` open|uncertain|confirmed|wrong, each node `ledgerRefs` its defect `defects:<D>` (Q24/Q27); (2) the DFS/adjudication loop lives in the `/investigate:advance` COMMAND body (subagents cannot spawn subagents), `investigate-explorer` is the read-only evidence-gatherer, no separate reviewer (Q23); (3) HANDOFF MECHANISM — EXPLICITLY file-and-defer, NOT an inline plan loop (resolves R5 criticism #1): on a confirmed root cause, /investigate:advance (a) writes `defects.rootCause`+`suggestedFix`, (b) creates OR extends a plan-flow goal SEEDED from the defect — the goal description embeds the confirmed root cause + suggestedFix + a `ledgerRefs: [defects:<D>]` link, (c) files an `open` question (or report line) pointing the user to run `/plan:advance <G>`, and STOPS. /investigate:advance must NOT re-implement or invoke the planner<->plan-reviewer loop itself (a command cannot run another command's loop, and inline duplication contradicts the Q26 file-and-defer principle the rest of the plan adopts). The subsequent /plan:advance round is what produces reviewed fix tasks that ledgerRef defects:<D> (Q25); (4) CLARIFY-SKIP for the defect-seeded goal (resolves R5 criticism #2): because the root cause is ALREADY confirmed, the seeded goal must enter planning WITHOUT a wasted clarifying round. The decision fixes the mechanism: the seeding step writes the confirmed root cause + suggestedFix into the goal so plan-advance has nothing left to clarify, and the planner prompt (T41) explicitly permits skipping the clarifying round when a goal is defect-seeded (carries a defects:<D> ledgerRef + an embedded confirmed root cause). State that /plan:start and /plan:follow-up normally re-open to `clarifying`, but a defect-seeded goal proceeds straight to planning; (5) parallel explorers ONLY when seeding disjoint top-level hypotheses, serial while drilling a branch (Q27). This is the spec the M7 (and the defect-seeding part of M8/T41) tasks implement."
- acceptance: "A `locked` decisions item exists under M1 with ledgerRefs:[goals:G1], stating the five points above — in particular the file-and-defer handoff (no inline plan loop) and the defect-seeded clarify-skip mechanism; subsequent M7 prompt tasks (T37) and the T41 planner edit cite this decision id. No code/prompt change in this task — it is the design lock the reviewer can check the prompts against."
- suggestedModel: frontier
- ledgerRefs: ["goals:G1"]
- completion: "Orchestrator-handled meta-task (workers cannot write the ledger): locked decision K8 under M1 (ledgerRefs goals:G1) stating all five investigate:* design points. No code/prompt change; T36-T39 and T41 cite K8. No worktree/review (the design was already adversarially reviewed in R5/R6)."

### T36 — done

- createdAt: 2026-06-01T23:36:30.265Z
- updatedAt: 2026-06-02T06:24:15.090Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Author llm/agents/investigate-explorer.md (read-only evidence-gatherer)
- description: "Create the new investigate-explorer subagent prompt, modeled on plan-reviewer.md's read-only frontmatter (`disallowedTools: Write, Edit, MultiEdit, NotebookEdit, Bash` plus Agent so it cannot spawn subagents; NO isolation:worktree — it shares the main checkout and makes no edits). Per the T35 decision and Q27: the explorer receives ONE hypothesis (id + statement + the branch context) in its prompt, gathers evidence read-only (codegraph/Read/Grep/Glob, WebSearch/WebFetch as needed), and RETURNS numbered evidence as a structured block — each item with file:line (or URL) + a 3-5 line excerpt and a one-line relevance note. It does NOT write the hypothesis ledger and does NOT adjudicate (the /investigate:advance command validates citations and sets status). Include the standard Provenance and `### Session summary` handover sections and a final pointer line, matching plan-reviewer.md's structure."
- acceptance: "llm/agents/investigate-explorer.md exists with read-only frontmatter (Write/Edit/MultiEdit/NotebookEdit/Bash/Agent disallowed, no isolation:worktree); body specifies single-hypothesis input, numbered evidence output with file:line+excerpt, no ledger writes/no adjudication, plus Provenance + Session summary sections. `bun run check` stays green (markdown-only addition)."
- suggestedModel: frontier
- dependsOn: ["T35"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 48a98b4
- completion: Authored llm/agents/investigate-explorer.md (read-only evidence-gatherer; honors K8). Reviewer approve 0/0. Merged to main 48a98b4.

### T37 — done

- createdAt: 2026-06-01T23:36:41.930Z
- updatedAt: 2026-06-02T06:39:57.237Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Author llm/commands/investigate/advance.md (the DFS/adjudication loop owner)
- description: "Create the /investigate:advance command — the orchestrator/brain of the investigation loop, modeled structurally on llm/commands/implement/advance.md (idempotent, fully state-derived from the ledger, resumable). It is given a defect id D. Per the T35 decision: (1) READ state — the defect, its linked `hypothesis` nodes (ledgerRefs defects:<D>), and any linked open `questions`; (2) FORM hypotheses — create root hypothesis nodes (open) for distinct candidate root causes, children via parentHypothesis while drilling; (3) DISPATCH investigate-explorer subagents read-only to gather evidence (parallel ONLY for disjoint top-level hypotheses being seeded, serial while drilling one branch — Q27); (4) VALIDATE every returned citation against source ITSELF (re-open the file:line), store each into hypothesis.evidence[] with a `[correct]`/`[incorrect]` prefix, and ADJUDICATE the node status (uncertain/confirmed/wrong) only from [correct] evidence; (5) on a CONFIRMED root cause, execute the T35 file-and-defer HANDOFF — NOT an inline plan loop (resolves R5 criticism #1): (a) write `defects.rootCause`+`suggestedFix`; (b) create OR extend a plan-flow goal SEEDED from the defect, embedding the confirmed root cause + suggestedFix in the goal description and a `ledgerRefs: [defects:<D>]` link, so plan-advance has nothing left to clarify (the defect-seeded CLARIFY-SKIP, resolves R5 criticism #2 — cite the T35 decision); (c) file an `open` question / emit a report line instructing the user to run `/plan:advance <G>`, and STOP. The command MUST NOT re-implement or invoke the planner<->plan-reviewer loop itself — a command cannot run another command's loop; the subsequent user-run /plan:advance round produces the reviewed fix tasks that ledgerRef defects:<D> (Q25/Q26); (6) if investigation needs user input (ambiguous scope/missing access), file an open `questions` item linked to the defect and stop (resumable). Include Provenance, per-subagent Session-log writing (like implement/advance.md), and an end-of-round Report. ONE invocation = ONE research round."
- acceptance: "llm/commands/investigate/advance.md exists with frontmatter allowed-tools (mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob) and a body covering the six numbered steps. The confirmed-root-cause step (5) MUST state EXPLICITLY: file-and-defer handoff only — write rootCause/suggestedFix, seed/extend a goal (root cause + suggestedFix embedded, ledgerRefs defects:<D>), point the user to /plan:advance <G>, and STOP; it MUST NOT describe running or duplicating the plan-advance<->plan-reviewer loop inline. The seeding language MUST state the goal is defect-seeded so the planner skips the clarifying round (cite the T35 decision). Also covers: read state, form hypotheses, dispatch read-only explorers with the parallel-only-when-seeding rule, orchestrator-side citation validation + [correct]/[incorrect] storage, file-and-resume on user-needed input, plus session-log + provenance + report sections. Idempotent/resumable language present. `bun run check` green (markdown-only)."
- suggestedModel: frontier
- dependsOn: ["T35","T36"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 3bfe470
- completion: "Authored llm/commands/investigate/advance.md (six-step DFS/adjudication loop; file-and-defer handoff, defect-seeded clarify-skip citing K8; [correct]/[incorrect] + parallel-only-when-seeding). Reviewer approve 0/0. Merged 3bfe470."

### T38 — done

- createdAt: 2026-06-01T23:36:52.804Z
- updatedAt: 2026-06-02T07:08:18.351Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Author llm/commands/investigate/start.md (defect intake + bootstrap)
- description: "Create the /investigate:start command, modeled on llm/commands/plan/start.md and implement/start.md (thin bootstrap, no loop logic of its own). Per Q21: `argument-hint: <defect description | defectId>`. Behavior: (a) `/investigate:start <defect description>` — fts_search defects to avoid duplicates; create a coordination milestone (title 'Investigate: <slug>') and an `open` defects item with headline+description, CAPTURING `severity` (required field) — if the user gave no severity, default a sensible tier and note it (a one-line clarifying question may be filed if genuinely ambiguous); then hand off to /investigate:advance for the first research round. (b) `/investigate:start <defectId>` — resume an existing defect: validate it exists and is non-terminal, then hand to /investigate:advance. Include Provenance, a session-log write for the advance handoff (like plan/start.md), and a Report telling the user the defect id D, milestone, and to run /investigate:advance D to continue. Do NOT restate the advance loop logic — invoke it."
- acceptance: "llm/commands/investigate/start.md exists; handles both the description (create open defect with required severity + coordination milestone, then hand off) and the bare-defectId (resume) forms; defers all research logic to /investigate:advance; includes Provenance + report. `bun run check` green (markdown-only)."
- suggestedModel: standard
- dependsOn: ["T37"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 6f13e2d
- completion: "Authored llm/commands/investigate/start.md (both intake + bare-defectId resume forms; inline /investigate:advance hand-off mirroring implement/start.md). Round-0 criticism (phantom investigate-advance subagent) fixed in round 1. Reviewer approve. Merged 6f13e2d."

### T39 — done

- createdAt: 2026-06-01T23:36:58.691Z
- updatedAt: 2026-06-02T07:27:19.682Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Wire the investigate:* assets into scripts/link-prompts.ts LINKS"
- description: "Extend the `LINKS` array in scripts/link-prompts.ts with three new entries pointing the .claude symlinks at the new llm/ sources: `.claude/commands/investigate/start.md` -> `llm/commands/investigate/start.md`; `.claude/commands/investigate/advance.md` -> `llm/commands/investigate/advance.md`; `.claude/agents/investigate-explorer.md` -> `llm/agents/investigate-explorer.md`. Match the existing entry style (PromptLink {link, source}). The .codex/prompts symlinks are committed and the .claude tree is gitignored — follow whatever the existing implement/* entries do for codex (the script only manages the .claude links; codex links are committed separately if the convention requires)."
- acceptance: "scripts/link-prompts.ts LINKS contains the three investigate:* entries; `bun run link-prompts` runs without error and creates the three .claude symlinks resolving to the new llm/ files (`readlink` each resolves to an existing file). `bun run check` green."
- suggestedModel: fast
- dependsOn: ["T36","T37","T38"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 08dc295
- completion: "Added 3 investigate:* entries to scripts/link-prompts.ts LINKS; link-prompts runs clean, symlinks resolve. Reviewer approve 0/0. Merged 08dc295. M7 now complete."

## M8

### T40 — planned

- createdAt: 2026-06-01T23:37:11.212Z
- updatedAt: 2026-06-01T23:43:20.650Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan-reviewer.md: add the defects[] bucket for out-of-scope defects"
- description: "Edit llm/agents/plan-reviewer.md so the reviewer's problem-classification gains a THIRD bucket beyond new_questions/criticism: out-of-scope or pre-existing DEFECTS (a fault not caused by, and not fixable within, the current plan) (Q22). Since plan-reviewer writes its review item directly, give it the contract: in-scope plan defects stay `criticism`; out-of-scope/pre-existing faults are reported in the review so the orchestrator (/plan:advance) files them as open `defects` items (severity from the reviewer) linked to goals:<G> and routed to investigate:* per Q26 (file-and-defer, do NOT block the plan). Document where the reviewer surfaces these (e.g. a `defects` consideration in its output / review notes) and that the planner/command does the actual defects-ledger write. CROSS-MILESTONE NOTE (resolves R5 criticism #3): M6/T28 separately threads an optional `summary` field into this same prompt's `create_item('reviews', ...)` fields. This task's defects[] addition is INDEPENDENT of that `summary` work — do NOT presuppose `summary` already exists in the prompt; only add/extend the defects-bucket language and leave the reviews create_item fields otherwise as found. M8 now dependsOn M6 so T28 lands first and the two edits to plan-reviewer.md are sequenced rather than concurrent; if executing before T28 for any reason, still avoid touching the summary field. Keep the change surgical and consistent with the existing review-write section."
- acceptance: "llm/agents/plan-reviewer.md documents the third 'out-of-scope defect' bucket, distinguishes in-scope criticism from out-of-scope defects, and specifies file-and-defer routing to investigate:* (not blocking the plan). The edit does NOT add or depend on the `summary` field (that is T28/M6's edit to the same prompt; this task is independent of it). plan-advance.md is updated in T41 to consume the defects bucket. `bun run check` green (markdown-only)."
- suggestedModel: frontier
- ledgerRefs: ["goals:G1"]
- dependsOn: ["T28"]

### T41 — planned

- createdAt: 2026-06-01T23:37:19.748Z
- updatedAt: 2026-06-01T23:37:19.748Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan-advance.md + plan/start.md + plan/follow-up.md: defect intake & defect->task linkage"
- description: "Edit the plan-flow command/agent prompts so plan-flow operates on BOTH ledgers (Q19/Q20/Q26): (1) plan-advance.md — when the goal/answers describe a DEFECT (a fault to fix) rather than greenfield work, the emitted plan models it as an `open` defects item PLUS one-or-more fix `tasks`; each fix task carries `ledgerRefs: [defects:<D>, goals:<G>]` and the defect's `dependsOn` lists those fix-task ids (bidirectional link, Q20). Execution still happens on TASKS only (Q19 spine — defects are problem records, never directly implemented). (2) plan-advance.md must also consume plan-reviewer's out-of-scope `defects` bucket (T40): file each as an open defect linked goals:<G> and route to investigate:* (file a question pointing the user to /investigate:start <D>), without blocking the current plan (Q26). (3) plan/start.md + plan/follow-up.md — note that a user-reported DEFECT should be intaked via /investigate:start (the defects ledger), not as a goal, and cross-reference the new command. Keep edits surgical."
- acceptance: "plan-advance.md documents defect-aware planning (open defect + linked fix tasks, bidirectional dependsOn/ledgerRefs, tasks remain the only executable unit) AND consuming the reviewer defects[] bucket with file-and-defer routing; plan/start.md and plan/follow-up.md cross-reference /investigate:start for defect intake. `bun run check` green (markdown-only)."
- suggestedModel: frontier
- dependsOn: ["T40"]
- ledgerRefs: ["goals:G1"]

### T42 — planned

- createdAt: 2026-06-01T23:37:28.713Z
- updatedAt: 2026-06-01T23:43:29.121Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "implement-reviewer.md: add a defects[] field to its JSON contract"
- description: "Edit llm/agents/implement-reviewer.md so the JSON block it returns gains a `defects[]` array (Q22). Each entry describes an OUT-OF-SCOPE or pre-existing defect the reviewer found while reviewing the task diff (a fault not caused by, and not fixable within, the current task): { headline, description, severity, suggestedFix? }. In-scope regressions caused by the task stay in `criticism` (fixed this round in the same worktree). The reviewer still writes NOTHING to the ledger — it only returns JSON; the /implement:advance orchestrator (T43) files the defects. Update the JSON schema/example in the prompt accordingly. CROSS-MILESTONE NOTE (resolves R5 criticism #3): M6/T28 separately adds the `summary` field to THIS SAME returned-JSON contract. This task's `defects[]` addition is INDEPENDENT of the `summary` work — do NOT assert the contract 'currently carries summary' as a premise; the existing fields are taskId/verdict/criticism/questions/rationale, and `summary` is being added by T28. M8 now dependsOn M6 so T28 lands first; author T42 by ADDING `defects[]` to whatever contract is present at execution time (with or without `summary`), without rewriting the summary line. Keep the edit surgical."
- acceptance: "implement-reviewer.md's returned-JSON contract documents a `defects[]` array (headline/description/severity/suggestedFix?) reserved for out-of-scope/pre-existing faults, distinct from in-scope `criticism`; reviewer remains ledger-read-only. The edit adds only `defects[]` and does NOT presuppose or rewrite the `summary` field (that is T28/M6's edit to the same JSON block; sequenced via the M8->M6 dependency). `bun run check` green (markdown-only)."
- suggestedModel: frontier
- ledgerRefs: ["goals:G1"]

### T43 — planned

- createdAt: 2026-06-01T23:37:37.779Z
- updatedAt: 2026-06-01T23:37:37.779Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "implement/advance.md: file reviewer defects, route to investigate, and close defects on merge-back"
- description: "Edit llm/commands/implement/advance.md so the orchestrator operates on BOTH ledgers (Q20/Q22/Q26): (1) when an implement-reviewer return carries a non-empty `defects[]` (T42), the orchestrator files each as an `open` defects item (severity from the reviewer) linked goals:<G> and routes it to investigate:* via file-and-defer — it does NOT block the current in-scope task on it (Q26); optionally file a question pointing the user to /investigate:start <D>. (2) Defect CLOSURE on merge-back (Q20): after a task merges, if that task `ledgerRefs` a `defects:<D>` and EVERY fix task linked to D (D's `dependsOn`, equivalently every task whose ledgerRefs include defects:<D>) is now `done`, set the defect `update_item(defects, D, status: 'resolved', fields: { fix: '<1-line: what landed>' })`. The orchestrator OWNS this closure. (3) Update the READY-SET / milestone-completion language so a milestone with linked defects is only considered fully done once its defects are terminal too (or explicitly note defects are tracked separately and do not gate task merge-back). Keep edits surgical and consistent with the existing numbered-step structure."
- acceptance: "implement/advance.md documents: filing reviewer defects[] as open defects + file-and-defer routing to investigate:* (not blocking the task); orchestrator-owned defect closure on merge-back (resolve D + set defects.fix when all its linked fix tasks are done); and the relationship between defect terminality and milestone completion. `bun run check` green (markdown-only)."
- suggestedModel: frontier
- dependsOn: ["T42"]
- ledgerRefs: ["goals:G1"]

### T44 — planned

- createdAt: 2026-06-01T23:37:49.948Z
- updatedAt: 2026-06-01T23:43:44.171Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Cross-prompt consistency audit of the defect/investigate vocabulary (grep-able invariants)
- description: "Read the full edited prompt suite (plan/start, plan/advance(agent), plan/follow-up, plan-reviewer, implement/start, implement/advance, implement-reviewer, implement-conflict-resolver if touched, investigate/start, investigate/advance, investigate-explorer) end-to-end and confirm the defect/task/hypothesis vocabulary is CONSISTENT and the routing forms a closed loop: user defect -> /investigate:start -> hypothesis tree -> confirmed root cause -> file-and-defer seed of a plan-flow goal -> /plan:advance produces fix tasks (ledgerRef defects:<D>) -> /implement:advance executes tasks -> orchestrator resolves the defect when all fix tasks done. Per R5 criticism #4 (repeat of R3 on old T34), the audit's conclusion MUST rest on ENUMERABLE, grep-able checks rather than a narrative. Define and run the invariant set below, capture each command + its output, and fix any drift the checks surface. This is a read-mostly reconciliation task whose verdict is the grep results, not prose."
- acceptance: |
    Operationally verifiable — every check is a command with an asserted result, run from repo root, output captured in the completion notes:
    (1) No prompt instructs implement to execute a defect directly: `grep -rniE "(execute|implement|run) .*defect" llm/commands/implement llm/agents` returns ZERO matches that direct execution of a defect (tasks remain the only executable unit).
    (2) Fix-task<->defect link convention stated identically: the bidirectional convention string (`ledgerRefs` includes `defects:<D>` on the fix task; `defects.dependsOn` lists the fix-task ids) appears in plan-advance.md and implement/advance.md — `grep -rn "defects:<D>" llm/` shows the same phrasing in both.
    (3) The evidence-prefix convention is identical across investigate prompts: `grep -rn "\[correct\]" llm/commands/investigate llm/agents/investigate-explorer.md` shows the `[correct]`/`[incorrect]` token present in BOTH investigate/advance.md and investigate-explorer.md.
    (4) Handoff is uniformly file-and-defer (no inline-loop language): `grep -rniE "run .*plan-advance.*loop|invoke .*plan:advance" llm/commands/investigate` returns ZERO matches asserting an inline plan loop; investigate/advance.md instead contains the 'run /plan:advance <G>' user-deferral string.
    (5) Defect-seeded clarify-skip present: `grep -rni "defect-seeded" llm/` shows the clarify-skip note in both plan-advance.md (or plan/start/follow-up) and investigate/advance.md.
    (6) `bun run link-prompts` succeeds and `bun run check` is green.
    The written audit records each command and its actual output; a non-empty result on checks (1)/(4) or an empty result on (2)/(3)/(5) is a failure to be fixed within this task.
- suggestedModel: frontier
- dependsOn: ["T39","T41","T43"]
- ledgerRefs: ["goals:G1"]

## M9

### T45 — done

- createdAt: 2026-06-01T23:38:12.555Z
- updatedAt: 2026-06-02T06:07:25.151Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Confirm existing dependsOn/ledgerRefs/parentHypothesis suffice for the relationship views (Q28 schema gate)
- description: "Spike/confirm step gating any schema change. Per Q28 the user chose 'Full ... any schema tweaks IF the existing dependsOn/ledgerRefs prove insufficient'. Verify against packages/ledger/src/types.ts + constants.ts and docs/ledgers.yaml that: (a) a defect's fix-task set is recoverable from defects.dependsOn (id[]) and/or tasks.ledgerRefs containing defects:<D>; (b) a hypothesis tree is recoverable from hypothesis.parentHypothesis (id) for ancestry and by scanning siblings sharing a parent for children; (c) fetch_ledger already returns the grouped items + resolved milestone metadata needed to build these views client-side without a new MCP read. Conclusion: state whether a new schema field or MCP tool is required. EXPECTATION (from grounding): existing fields suffice -> no @cq/ledger change; if the spike finds a gap, record a decisions item and add a follow-up task. No code change unless a gap is found."
- acceptance: "A written determination (in completion notes + a decisions item if a schema/MCP change is warranted) stating whether existing dependsOn/ledgerRefs/parentHypothesis + fetch_ledger suffice for the defect-fix-task view and hypothesis-tree view. If sufficient: no schema change, downstream UI tasks proceed. If not: a scoped schema/MCP task is added with the exact field/tool. `bun run check` unaffected (read-only spike)."
- suggestedModel: frontier
- ledgerRefs: ["goals:G1"]
- completion: "Read-only spike (orchestrator-handled; no commit to merge). Determination: existing fields SUFFICE — no @cq/ledger schema change and no new MCP tool required. Verified in packages/ledger/src/constants.ts: (a) defect->fix-tasks recoverable from DEFECTS_SCHEMA.dependsOn (id[], via COMMON_REF_FIELDS) UNION reverse scan of TASKS_SCHEMA.ledgerRefs containing defects:<D>; (b) hypothesis tree recoverable from HYPOTHESIS_SCHEMA.parentHypothesis (id) for ancestry + sibling-by-shared-parent scan for children; (c) fetch_ledger already returns grouped items + resolved milestone metadata, so both views build client-side with no new MCP read. No gap found, so no decisions item filed. Downstream M9 UI tasks (T46-T49) proceed unchanged."

### T46 — done

- createdAt: 2026-06-01T23:38:20.964Z
- updatedAt: 2026-06-02T06:24:09.916Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Shared relationship-resolution helper: defect->fix-tasks and hypothesis ancestry/children"
- description: "Both UIs need the same derivation logic, so implement it once in @cq/ledger (or a shared client util both packages already import) and unit-test it: given the fetched items for a ledger set, compute (1) for a defect D: its fix-task ids = D.dependsOn (filtered to tasks) UNION every task whose ledgerRefs include `defects:D` (dedup); (2) for a hypothesis H: its ancestry chain via parentHypothesis up to a root, and its direct children = hypotheses whose parentHypothesis === H.id. Keep the helper pure (takes items in, returns id lists / a small tree structure) so it is trivially blackbox-testable and reused by web + TUI. Match existing repo style; add it where the existing summarize()/status helpers live or in @cq/ledger if cross-package reuse is cleaner. Follow the constructive-test-taxonomy: a pure function -> Blackbox-Atomic unit tests."
- acceptance: "A pure, exported helper computes defect->fix-task ids (union of dependsOn + reverse ledgerRefs, deduped) and hypothesis ancestry+children; unit tests cover: a defect with both link directions, a defect with only one direction, a 3-level hypothesis chain, and a hypothesis with multiple children. `bun test` green for the new tests; `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T45"]
- ledgerRefs: ["goals:G1"]
- resultCommit: 4274f0f
- completion: Pure helpers defectFixTaskIds + hypothesisRelationships in @cq/ledger (relationships.ts), exported from index; 10 unit tests. Reviewer approve 0/0. Merged to main 4274f0f.

### T47 — done

- createdAt: 2026-06-01T23:38:32.464Z
- updatedAt: 2026-06-02T07:27:23.296Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web UI: defect->fix-task and hypothesis-tree relationship view in the detail panel"
- description: "In packages/ledger-web/src/App.tsx, extend the item DETAIL panel so that when the selected item is a `defects` item it renders a 'Fix tasks' section listing the linked fix tasks (from the T46 helper) — each a clickable link that selects that task (id + status badge + summarize()); and when the selected item is a `hypothesis` item it renders its ancestry breadcrumb (root..parent) and a 'Children' list, each navigable. Reuse existing selection/navigation plumbing and the existing status-badge/summarize helpers; do NOT read the ledger files directly (pure MCP client — use the already-fetched items). Surgical CSS for the new sections consistent with existing .lw-* classes. Tests: happy-dom — selecting a defect renders its fix tasks with correct ids/links; selecting a child hypothesis renders the ancestry chain and its children. Remember happy-dom controlled text inputs don't fire onChange (not relevant here — these are links/clicks)."
- acceptance: Selecting a defects item shows a 'Fix tasks' section with the correct linked task ids (both link directions) as clickable rows; selecting a hypothesis shows ancestry + children, each navigable. happy-dom tests assert the rendered task ids and hypothesis tree for a seeded ledger. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T46"]
- ledgerRefs: ["goals:G1"]
- resultCommit: e996620
- completion: "Web detail panel: Fix-tasks section (defectFixTaskIds, both link directions) + hypothesis ancestry/children (hypothesisRelationships), clickable/navigable; shared @cq/ledger helper via new ./relationships browser-safe subpath export; 13 happy-dom tests. Reviewer approve 0/0. Merged e996620. NOTE: touched bun.lock + package.json (flake FOD hash refresh needed before nix build)."

### T48 — done

- createdAt: 2026-06-01T23:38:39.271Z
- updatedAt: 2026-06-02T07:27:25.649Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: defect->fix-task and hypothesis-tree relationship view in the content pane"
- description: "In packages/ledger-tui/src/app.tsx, mirror the web relationship view in the ink content pane: when the selected item is a `defects` item, render a 'Fix tasks' block listing its linked fix tasks (from the T46 helper) as id [status] summary lines; when it is a `hypothesis` item, render its ancestry chain and direct children. Make these navigable consistent with the TUI's existing keyboard/selection model (e.g. jump-to-related, if the app already supports cross-item navigation; otherwise render them as a read-only related-items block — match whatever navigation affordance the app already provides). Reuse the shared T46 helper and the existing summarize()/status coloring. Pure MCP client — use already-fetched items, do not read ledger files. Tests: ink-testing-library — a seeded defect renders its fix-task ids; a child hypothesis renders ancestry + children."
- acceptance: ink-testing-library tests assert that selecting a defects item renders a 'Fix tasks' block with the correct linked task ids and that selecting a hypothesis renders its ancestry + children; alignment consistent with the column-table work from the #1 follow-up. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T46"]
- ledgerRefs: ["goals:G1"]
- resultCommit: bb4d341
- completion: "TUI content pane: Fix-tasks block + hypothesis ancestry/children via shared @cq/ledger helpers; bounded lazy cross-ledger fetch (crossItems.has guard); 9 ink tests. Reviewer approve 0/0. Merged bb4d341."

### T49 — planned

- createdAt: 2026-06-01T23:38:48.528Z
- updatedAt: 2026-06-01T23:38:48.528Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Full-suite verification of the #2 follow-up (check green + end-to-end relationship-view regression)
- description: "Final gate for the #2 follow-up across M7/M8/M9. Run `bun run check` (tsc + eslint + bun test) from the repo root and confirm green. Add one cross-cutting regression assertion that the new web + TUI relationship views agree on the SAME derived links for an identical seeded ledger (the T46 helper is the single source, so both UIs must show the same fix-task ids and hypothesis tree). Confirm `bun run link-prompts` materializes all investigate:* symlinks (T39) and that no prompt file references a non-existent command/agent. This task is verification + any small fixes the full run surfaces; it does NOT introduce new behavior."
- acceptance: "`bun run check` green at repo root; `bun run link-prompts` succeeds and all investigate:* + implement:* + plan:* symlinks resolve; a regression test confirms web and TUI derive identical defect->fix-task and hypothesis-tree relationships from one seeded ledger. Any failures found are fixed within this task."
- suggestedModel: frontier
- dependsOn: ["T44","T47","T48"]
- ledgerRefs: ["goals:G1"]
