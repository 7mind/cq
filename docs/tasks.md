---
ledger: tasks
counters:
  milestone: 0
  item: 25
archives:
  - id: M5
    path: ./archive/tasks/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
---

# tasks

## M2

### T1 — done

- createdAt: 2026-06-01T19:32:17.922Z
- updatedAt: 2026-06-01T19:37:11.989Z
- author: "opus-4.8[1m]"
- session: b946b5c5-0dca-4058-a5bf-45caaea6111d
- headline: Show per-ledger item count in the ledgers list (right-aligned), TUI + web
- description: "DONE. enumerate_ledgers (both the Claude-side factory and the stdio variant) now additively returns a `counts` map alongside `ledgers` (active-item count per ledger; existing `.ledgers` consumers untouched). Added LedgerSummary {name,itemCount} to @cq/ledger types; LedgerClient.enumerateLedgers() now returns LedgerSummary[] in both frontends. TUI sidebar: ScrollList renderLabel pads the name so the dim count sits flush-right (accounts for cursor prefix + scrollbar). Web sidebar: each ledger button is flex space-between with a .lw-ledger-name span and a right-aligned dim .lw-ledger-count span (data-testid ledger-count-<name>). Updated all fakes + the mcpClient assertion; added render tests in both UIs. bun run check: 371 pass, typecheck + lint clean."

### T2 — done

- createdAt: 2026-06-01T19:45:56.021Z
- updatedAt: 2026-06-01T19:58:58.643Z
- author: "opus-4.8[1m]"
- session: b946b5c5-0dca-4058-a5bf-45caaea6111d
- headline: Answer-and-resolve affordance for questions (open → answered) in TUI + web
- description: "DONE. Data-driven gate canAnswer(schema,status) in both status.ts: schema has `answer` field AND `answered` reachable from current status. Web DetailPanel: answer textarea + 'save & mark answered' button (writes answer + transitions in one updateItem); the bare `answered` quick-transition is replaced by the box, `withdrawn` stays. Plus a second 'as recommended' button (shown when a non-empty `recommendation` field exists) that writes the literal string 'as recommended' and marks answered. TUI: `a` opens a prefilled answer prompt (save+transition); `r` answers 'as recommended' in one key when a recommendation exists; hints advertise both. Constants ANSWER_FIELD/ANSWERED_STATUS/RECOMMENDATION_FIELD/AS_RECOMMENDED_ANSWER shared in status.ts. Added a `questions` ledger to both fakes + 4 tests. NOTE: 'as recommended' writes the literal phrase per the request's wording; flagged to user as a choice vs copying the recommendation text."

### T3 — done

- createdAt: 2026-06-01T19:45:58.747Z
- updatedAt: 2026-06-01T19:59:03.275Z
- author: "opus-4.8[1m]"
- session: b946b5c5-0dca-4058-a5bf-45caaea6111d
- headline: Preserve current view in ledger-web across page reload
- description: "DONE. Persist {ledger, itemId, mainView} to localStorage key ledger-web.view (mirrors the panel-layout persistence) on every nav change. On connect, capture the saved view synchronously before the reset clears it, then after enumerate re-open the saved ledger, re-select the saved item, and re-enter graph mode (loadDagData) if it was active; silently skipped when the saved ledger/item no longer exists. Added localStorage.clear() to both web test files' beforeEach for isolation (a leak otherwise auto-restored across tests — caught a dagView regression). 4 new tests (persist + restore table + restore graph). bun run check: 379 pass, typecheck + lint clean."

### T17 — done

- createdAt: 2026-06-01T20:13:19.995Z
- updatedAt: 2026-06-01T22:17:33.813Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: Extract a reusable embedded ledger-MCP server module (handler + WS hub + watcher)
- description: |
    Foundation for in-process UIs (BLOCKS T18, T20). Refactor packages/ledger-mcp/src/main.ts so the request handler, WS pub/sub hub, and startLedgerWatcher wiring become reusable factories rather than being inlined in serveHttp()/main(). Proposed surface (e.g. in @cq/ledger-mcp index or a new embedded.ts):
    - buildServer(store) [already exists — export it]
    - createEmbeddedStore(cwd): new FsLedgerStore({root})+init
    - attachMcpHttp(store): { handle(req): Promise<Response>, onWsOpen(ws), onWsMessage(ws,raw) } so any Bun.serve (standalone binary OR ledger-web) mounts the same /mcp + /ws logic; the watcher's onChange calls server.publish(LEDGER_TOPIC, changedFrame(ledger)).
    Refactor main.ts to consume these — NO behavior change; all existing ledger-mcp tests stay green. Verify: bun test packages/ledger-mcp + packages/ledger.
- resultCommit: 63df0f3
- completion: "Extracted buildServer (exported), createEmbeddedStore(cwd), attachMcpHttp(store) {handle,onWsOpen,onWsMessage} from ledger-mcp/src/main.ts; serveHttp composes attachMcpHttp; startLedgerWatcher re-exported. No behavior change — ledger-mcp tests green. Branch feat/m2-embedded-ui."

### T18 — done

- createdAt: 2026-06-01T20:13:25.127Z
- updatedAt: 2026-06-01T22:17:37.109Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "ledger-tui: embedded in-process mode via InMemoryTransport when --mcp-url omitted"
- description: |
    DEPENDS ON T17. Add McpLedgerClient.embedded(cwd) (or a small factory) that: createEmbeddedStore(cwd) → buildServer(store) → InMemoryTransport.createLinkedPair() → server.connect(serverT) + new Client().connect(clientT) → new McpLedgerClient(client). main.tsx: when --mcp-url is omitted, run embedded; when provided, keep today's HTTP connect.
    
    RESOLVED (Q9): rename the TUI flag --url → --mcp-url and DROP --url (no alias). RESOLVED (Q10): embedded ledger-root precedence --cwd > $LEDGER_ROOT > process.cwd() (mirrors ledger-mcp). Lifecycle: on exit close client, dispose store, close watcher. Live updates handled in T19.
- resultCommit: 63df0f3
- completion: "McpLedgerClient.embedded(cwd) over InMemoryTransport (owns+disposes the store). main.tsx: --url renamed to --mcp-url (dropped), added --cwd; default embedded, root --cwd>$LEDGER_ROOT>CWD. PTY e2e updated to --mcp-url."

### T19 — done

- createdAt: 2026-06-01T20:13:30.302Z
- updatedAt: 2026-06-01T22:17:39.464Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "ledger-tui: in-process live refresh + hide WS health badge in embedded mode"
- description: "DEPENDS ON T18. There is no WebSocket in embedded mode, so the App's live wiring (LiveManager keyed on liveUrl) must be generalized to accept an in-process change source. Plan: App takes an optional change-source/onSubscribe(refresh) prop; in embedded mode wire startLedgerWatcher(store, cwd, () => refreshRef.current()) so external edits (the agent's stdio server, git, a second UI) refresh the view; self-edits already refetch post-mutation. The LiveBadge (connecting/alive/stale) is meaningless without a socket — hide it (or show a static 'in-process' indicator) when embedded. Verify the watcher triggers a refetch on a file write."
- resultCommit: 63df0f3
- completion: App gained an onSubscribe change-source prop; embedded mode wires startLedgerWatcher(store,cwd,refresh) for external-edit live refresh and shows a static '◆ in-process' indicator instead of the WS LiveBadge.

### T20 — done

- createdAt: 2026-06-01T20:13:35.052Z
- updatedAt: 2026-06-01T22:17:41.814Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "ledger-web: embedded mode — serve process hosts /mcp + /ws from an embedded store when --mcp-url omitted"
- description: |
    DEPENDS ON T17. Add --cwd to ledger-web. In serve(): when --mcp-url is omitted, createEmbeddedStore(cwd) and mount the shared attachMcpHttp(store) handlers on /mcp and /ws (+ startLedgerWatcher → publish changed frames) INSTEAD of proxyToMcp/WS-proxy; when --mcp-url is given, keep today's reverse-proxy. index.html already points the browser at same-origin /mcp, so the browser is unchanged.
    
    RESOLVED (Q10): embedded root precedence --cwd > $LEDGER_ROOT > process.cwd(); default when neither flag given = embedded at that root. --host/--port unchanged.
- resultCommit: 63df0f3
- completion: "serve() branches on --mcp-url: reverse-proxy when set, else embedded (createEmbeddedStore + attachMcpHttp on /mcp+/ws + watcher publishing changed frames). Added --cwd (same root precedence). Browser unchanged (same-origin /mcp)."

### T21 — done

- createdAt: 2026-06-01T20:13:40.728Z
- updatedAt: 2026-06-01T22:17:45.112Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: Tests for in-process modes (TUI in-memory client + web embedded serve)
- description: "DEPENDS ON T18/T19/T20. (1) TUI: a round-trip test of McpLedgerClient.embedded(tmpRoot) against a seeded temp FsLedgerStore over InMemoryTransport — enumerate/fetch/create/update/fts — mirroring mcpClient.test.ts but with no subprocess. (2) Web: spin serve({cwd: tmpRoot}) with NO --mcp-url, connect a real MCP client to /mcp end-to-end (create+fetch), and assert a /ws 'changed' frame arrives after an out-of-band file write to docs/. (3) Update ledger-tui/ledger-web parseArgs tests for the new flag/cwd semantics. Verify: bun run check stays green."
- resultCommit: 63df0f3
- completion: "TUI in-process round-trip (embedded.test.ts), web embedded e2e (serveEmbedded.test.ts: same-origin MCP client + /ws changed-frame via the real binary as a subprocess — avoids a second in-process Bun.build), parseArgs tests for both. All green."

### T22 — done

- createdAt: 2026-06-01T20:13:46.023Z
- updatedAt: 2026-06-01T22:17:48.412Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: Docs + Nix packaging + convention note for standalone (embedded) UIs
- description: "DEPENDS ON T18/T20. Update README + each binary's header/usage to document running with no --mcp-url (embedded; root from --cwd/$LEDGER_ROOT/CWD). Clarify the CLAUDE.md invariant: 'frontends are pure MCP clients — never read ledger files directly' STILL holds; embedded mode co-locates the MCP server in-process (in-memory transport for TUI, co-hosted HTTP for web), it does not make the UI read files. Verify the Nix products (nix build .#ledger-tui / .#ledger-web) run standalone; refresh the FOD hash only if deps changed."
- resultCommit: 63df0f3
- completion: "README quick-start (embedded + remote; fixed stale --url), pure-MCP-client invariant clarified in README + CLAUDE.md, binary headers. flake.nix: ledger-tui/-web products stage the @cq/ledger + @cq/ledger-mcp embedded closure (shared embedServerClosure); node-modules FOD hash refreshed (sha256-ItCIWnqn...). nix build .#ledger-tui/.#ledger-web built + verified to run standalone embedded."

### T23 — done

- createdAt: 2026-06-01T20:17:50.387Z
- updatedAt: 2026-06-01T22:17:51.695Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "Questions view: reorder fields + highlight the recommendation (TUI + web)"
- description: |
    Minor/cosmetic. Independent of the embedded-mode work (T17–T22). In both detail views, when the item is a question (data-driven gate: schema declares a `question` field), render fields in this fixed order instead of the generic orderItemFields (short-first): 1) short/metadata fields first (e.g. ledgerRefs/tags and other compact fields), then 2) question, 3) context, 4) recommendation — visually HIGHLIGHTED, 5) answer.
    
    Highlight the recommendation: web = a distinct styled block (e.g. .lw-recommendation accent border/background) on the recommendation dd; TUI ContentPane = a colored/bold block. Preserve the existing answer affordance from T2: for an answerable (open) question the editable answer box stays, sitting just BELOW the highlighted recommendation; for an answered/terminal question the answer renders as the final field. Touch web DetailPanel (App.tsx) and TUI ContentPane (app.tsx); add a small ordering/highlight constant alongside the ANSWER_FIELD/RECOMMENDATION_FIELD constants in status.ts. Tests: web asserts the recommendation carries the highlight class and that question precedes context precedes recommendation precedes answer in DOM order.
- resultCommit: 5cf4916
- completion: "Question detail (web+tui): fixed field order metadata→question→context→recommendation(highlighted)→answer; recommendation gets .lw-recommendation accent block (web) / bordered accent box (tui). T2 answer affordance preserved. status.ts gained QUESTION_FIELD/CONTEXT_FIELD/QUESTION_FIELD_ORDER/isQuestion. Web test asserts highlight class + DOM order."

## M3

### T4 — done

- createdAt: 2026-06-01T19:53:03.892Z
- updatedAt: 2026-06-01T20:23:08.075Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "Design decision: cross-tool model resolution + worktree strategy"
- suggestedModel: frontier
- description: |
    Foundational design task. Lock the conventions every other task depends on:
    
    1. PORTABLE MODEL LABELS (Q3/Q4). `tasks.suggestedModel` already exists in the schema. Define a small portable tier vocabulary (e.g. `frontier` = most capable, `standard` = mid, `fast` = cheap) and a per-host mapping: Claude -> opus/sonnet/haiku; Codex -> its model tiers (e.g. gpt-5.x top / mid). The orchestrator resolves a task's label to the host tool's concrete model. If `suggestedModel` is unset -> default to the orchestrator's OWN class and emit a WARNING.
    2. REVIEWER 'most capable' resolves per host: Claude -> opus; Codex -> its top tier.
    3. WORKTREE STRATEGY (Q1). Native `isolation: worktree` is a Claude-Code-only subagent feature. Codex has no equivalent declarative subagent-worktree mechanism, so under Codex the orchestrator must run manual `git worktree add/remove`. Specify the branch in the advance command body: native isolation under Claude, manual git worktree under Codex.
- acceptance: "A `decisions` item is created and locked capturing: the tier vocabulary + per-host model map, the reviewer capability resolution, and the dual worktree strategy (Claude native / Codex manual). The mapping is concrete enough that the advance command can implement it without further questions."
- ledgerRefs: ["goals:G1","decisions:K4"]

### T5 — done

- createdAt: 2026-06-01T19:53:14.108Z
- updatedAt: 2026-06-01T20:28:10.323Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: implement-worker subagent (llm/agents/implement-worker.md)
- suggestedModel: frontier
- description: "Subagent that implements ONE task end-to-end inside an isolated worktree. Frontmatter carries `isolation: worktree` for Claude. Brief: read the task's description/acceptance from the ledger, implement the change, run `bun run check`, and return a STRUCTURED result (status pass/fail, resultCommit, check output tail, summary, files touched). It must NOT mutate task status or merge — the orchestrator owns ledger state and merge-back. Reads its inputs (task id, resolved model, any prior-round criticism) from the dispatch prompt. Tool-agnostic body so Codex can route it as a sub-agent."
- acceptance: "Agent file mirrors plan-flow agent conventions (name/description/frontmatter + tool-agnostic body with an explicit Output contract). Body specifies: ensure deps available in the worktree (node_modules), implement, `bun run check`, structured return. Does not write the ledger or merge. Per T15: emits a 'Session summary' section in its final message for the orchestrator to log (no file write by the subagent)."
- dependsOn: ["T4","T15"]
- ledgerRefs: ["goals:G1"]

### T6 — done

- createdAt: 2026-06-01T19:53:20.720Z
- updatedAt: 2026-06-01T20:28:11.698Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: implement-reviewer subagent (llm/agents/implement-reviewer.md)
- suggestedModel: frontier
- description: "Adversarial per-task reviewer, dispatched at the host's most-capable model. Reads the task acceptance + the worktree diff + check output, returns a STRUCTURED verdict: approve | disapprove, with `criticism[]` (autonomously fixable) and `questions[]` (need the user). Distinguishes the two: criticism = objective defects the implementor can fix; questions = genuine ambiguities/decisions only the user can resolve. DESIGN POINT to resolve here: per-round verdicts return to the orchestrator (which records ONE terminal `reviews` item per task), rather than flooding the ledger with a review per round."
- acceptance: "Agent file with frontmatter + tool-agnostic body and an explicit Output contract separating criticism from questions. Specifies the criticism-vs-question discrimination rule and that the orchestrator (not the reviewer) records the terminal review item. Per T15: emits a 'Session summary' section in its final message for the orchestrator to log (no file write by the subagent)."
- dependsOn: ["T4","T15"]
- ledgerRefs: ["goals:G1"]

### T7 — done

- createdAt: 2026-06-01T19:53:25.932Z
- updatedAt: 2026-06-01T20:28:12.695Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: implement-conflict-resolver subagent (llm/agents/implement-conflict-resolver.md)
- suggestedModel: frontier
- description: "Subagent invoked during merge-back (Q6) when a rebase-before-merge produces a conflict. Brief: given the conflicting worktree/branch and the updated base, resolve the conflict preserving both intents, re-run `bun run check`, return structured success/failure. On unresolvable conflict it returns failure so the orchestrator registers a question and leaves the worktree intact."
- acceptance: "Agent file with frontmatter + tool-agnostic body + Output contract. Specifies: rebase conflict resolution preserving both sides' intent, mandatory `bun run check` after resolution, structured pass/fail return, no ledger mutation. Per T15: emits a 'Session summary' section in its final message for the orchestrator to log (no file write by the subagent)."
- dependsOn: ["T4","T15"]
- ledgerRefs: ["goals:G1"]

### T8 — done

- createdAt: 2026-06-01T19:53:31.570Z
- updatedAt: 2026-06-01T20:30:33.070Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "/implement:start command prompt (llm/commands/implement/start.md)"
- suggestedModel: frontier
- description: "Thin bootstrap command, mirroring plan/start.md. Args = list of milestone ids; if empty -> target ALL non-archived, non-terminal milestones in the `milestones` ledger. Validate the targets exist and resolve their task DAG. Record the execution scope (e.g. a marker/decision or just report it). Then hand off to the same loop body as /implement:advance (do not duplicate loop logic — delegate to advance, exactly as plan:start hands to plan-advance). Carries provenance + the runtime-identity author rule."
- acceptance: Command file with frontmatter (description, argument-hint, allowed-tools). Resolves default-all-milestones, validates, and hands to the advance loop without duplicating loop logic. Reports the resolved target set + first actions.
- dependsOn: ["T4"]
- ledgerRefs: ["goals:G1"]

### T9 — done

- createdAt: 2026-06-01T19:53:43.394Z
- updatedAt: 2026-06-01T20:30:05.495Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "/implement:advance orchestrator command (llm/commands/implement/advance.md)"
- suggestedModel: frontier
- description: |
    The core loop, living in the main session (subagents cannot spawn subagents). Per round:
    1. READY-SET: scan target milestones; a task is ready iff not terminal, not `blocked`, all `dependsOn` are `done`, its milestone's deps are satisfied, and it has no linked `open` question. Also flip `blocked`->`planned` for tasks whose blocking question is now `answered` (Q7 resume).
    2. DISPATCH up to N concurrent implement-worker subagents (N configurable, default 4 — Q2), each in a worktree (Claude native isolation / Codex manual — per T4), at the task's resolved model (warn if suggestedModel unset — Q4).
    3. REVIEW each finished worker with implement-reviewer at the most-capable model.
    4. AUTONOMOUS CRITICISM LOOP (Q5): NO fixed cap. Feed criticism back to the worker in the same worktree, re-review, repeat. The orchestrator validates worker/reviewer output for sanity and detects ILL LOOPS — stop and register a question when: a round yields no file changes; the diff/criticism repeats without shrinking across rounds; the same check failure recurs. Keep a high absolute safety ceiling as defense-in-depth even though there is no normal cap.
    5. QUESTIONS: reviewer questions OR ill-loop bailout -> create `questions` items linked `tasks:<id>`, set task `blocked`. User answers in TUI/web then runs /implement:advance to resume.
    6. SUCCESS GATE (Q8): success = `bun run check` green AND reviewer approval.
    7. MERGE-BACK (Q6): sequential in dependency order; rebase each remaining worktree on the updated base; on conflict dispatch implement-conflict-resolver; on success set task `done` + record resultCommit/completion. Loop until no ready tasks remain; report done / blocked / failed.
- acceptance: "Command file with frontmatter + the full loop spec above. Idempotent/resumable across invocations (re-derives state from the ledger). Concrete ill-loop heuristics + safety ceiling documented. Merge order respects the DAG; conflict path dispatches the resolver. Per T15: after each spawned subagent returns, the orchestrator writes ./docs/logs/<timestamp>-<agent-id>.md from the subagent's returned 'Session summary' (orchestrator writes; subagents stay read-only)."
- dependsOn: ["T4","T5","T6","T7","T15"]
- ledgerRefs: ["goals:G1"]

### T10 — done

- createdAt: 2026-06-01T19:53:48.977Z
- updatedAt: 2026-06-01T20:33:35.779Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: Wire links + docs (link-prompts.ts, .codex/prompts, READMEs)
- suggestedModel: standard
- description: "Add the new assets to the symlink wiring so both tools discover them. Extend the LINKS array in scripts/link-prompts.ts with .claude entries for implement/start, implement/advance, and the three implement-* agents. Add the committed .codex/prompts symlinks (flat names mirroring the plan-flow convention: implement-start.md, implement-advance.md, implement-*-agent.md). Update .codex/prompts/README.md and llm/README.md tables to list the new prompts. Run `bun run link-prompts`."
- acceptance: "`bun run link-prompts` recreates all .claude links without error; .codex/prompts has the committed symlinks; README tables list the new implement prompts. `git status` shows the expected new committed symlinks."
- dependsOn: ["T5","T6","T7","T8","T9"]
- ledgerRefs: ["goals:G1"]

### T11 — done

- createdAt: 2026-06-01T19:53:54.172Z
- updatedAt: 2026-06-01T20:26:10.601Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "Make /plan:* populate tasks.suggestedModel"
- suggestedModel: standard
- description: "Q3 follow-up: the plan-flow planner must fill the `suggestedModel` field when it emits work tasks, so the downstream /implement:* loop has a model hint. Update llm/agents/plan-advance.md so each created `tasks` item carries a `suggestedModel` (using the portable tier vocabulary locked in T4). Add brief guidance on choosing the tier from task nature (design/architecture -> frontier; mechanical -> standard/fast). Independent of the implement command files."
- acceptance: plan-advance agent body instructs setting suggestedModel on every emitted task using T4's tier vocabulary, with selection guidance. Consistent with the T4 decision.
- dependsOn: ["T4"]
- ledgerRefs: ["goals:G1","decisions:K4"]

### T12 — done

- createdAt: 2026-06-01T19:53:59.674Z
- updatedAt: 2026-06-01T20:42:55.041Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: End-to-end dogfood + check
- suggestedModel: frontier
- description: "Validate the full loop against a real, trivial task. Pick or create a tiny task in a throwaway milestone, run /implement (start->advance) on it, and confirm the chain works: worktree created -> implement-worker implements -> `bun run check` green -> implement-reviewer approves -> rebase + merge-back -> task set `done` with resultCommit. Exercise at least one criticism round and one blocked-on-question path if feasible. Confirm `bun run check` passes at repo root afterward."
- acceptance: A documented dogfood run shows a task driven to `done` through the real loop (worktree, review, merge-back). Repo-root `bun run check` is green. Any defects found are filed in the `defects` ledger.
- dependsOn: ["T10"]
- ledgerRefs: ["goals:G1"]
- completion: "Dogfood ran the real loop end-to-end on throwaway task T24 (milestone M5, now archived): manual worktree (K4 Codex path) -> real implement-worker subagent created+committed the marker (resultCommit 6653815) -> bun run check green in worktree (379 pass) -> real implement-reviewer subagent approved (0 criticism/0 questions) -> ff merge-back into throwaway dogfood/base -> task set done + terminal review R2 recorded + two session logs written to docs/logs/. Worktree+branches cleaned; nothing landed on main; repo-root bun run check green. Criticism/blocked-question paths not exercised (trivial task converged round 1) but are specified in advance.md. One hardening finding filed+resolved as defect D2 (worktree node_modules bootstrap). Note: subagent_type name-resolution needs a session restart (T13), so the worker/reviewer ran as general-purpose agents carrying the agent bodies inline."

### T15 — done

- createdAt: 2026-06-01T20:03:42.221Z
- updatedAt: 2026-06-01T20:25:47.867Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "Cross-flow convention: subagents write a session-log on handover"
- suggestedModel: frontier
- description: |
    Every subagent we dispatch (BOTH /plan:* and /implement:* flows) must produce a brief session summary on handover: what it did, what it achieved, what it discovered, any issues/blockers/observations.
    
    RESOLVED (see decision D-log): the subagent does NOT write a file. It RETURNS the summary as a clearly-delimited section at the end of its final message; the ORCHESTRATOR writes ./docs/logs/<timestamp>-<agent-id>.md from that returned summary. The orchestrator takes <agent-id> from the Agent tool result and stamps <timestamp> itself. This keeps subagents read-only (no Write needed; T13 denylist unchanged), avoids worktree-log-merge issues, and is concurrency-safe (one writer, unique filenames).
    
    Scope of the change:
    1. Subagent BODIES (plan-advance, plan-reviewer, implement-worker, implement-reviewer, implement-conflict-resolver): add an explicit 'Session summary' output section to each Output contract (did / achieved / discovered / issues).
    2. ORCHESTRATOR commands (plan/advance, plan/start, implement/advance, implement/start): after each spawned subagent returns, write ./docs/logs/<timestamp>-<agent-id>.md from its returned summary.
    3. Ensure ./docs/logs/ exists (add .gitkeep or create on write). docs/*.md ledger files are unaffected (different directory).
    4. Document the convention in llm/README.md and .codex/prompts/README.md.
- acceptance: All five subagent bodies emit a 'Session summary' section in their final message. All four orchestrator commands write ./docs/logs/<timestamp>-<agent-id>.md from the returned summary. Subagents need NO Write tool (T13 denylist unchanged). Convention documented in both READMEs.
- dependsOn: ["T4"]
- ledgerRefs: ["goals:G1"]

## M4

### T13 — done

- createdAt: 2026-06-01T20:03:22.573Z
- updatedAt: 2026-06-01T20:07:58.480Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- headline: Fix plan-flow subagent MCP tool access (server-name independent)
- suggestedModel: standard
- description: |
    DEFECT: plan-advance/plan-reviewer declared `tools: mcp__ledger__*` (an exact-name allowlist). When the ledger MCP server is exposed under a different name (e.g. the home-manager plugin's `mcp__plugin_claude-code-home-manager_ledger__*` instead of the repo .mcp.json `ledger`), the allowlist matches nothing and the subagents get ZERO ledger tools, so they cannot write. Reproduced: a spawned plan-advance reported it had no ledger tools and could not persist questions. Docs confirm there is no cross-server `mcp__*` wildcard, and that subagents inherit all MCP tools by default unless a `tools:` allowlist restricts them.
    
    FIX (done): replaced the `tools:` allowlist in both llm/agents/plan-advance.md and llm/agents/plan-reviewer.md with `disallowedTools: Write, Edit, MultiEdit, NotebookEdit, Bash`. This inherits ALL MCP servers regardless of name while preserving each agent's read-only-on-repo posture. Ran `bun run link-prompts` to materialise .claude/agents symlinks (project agents override the plugin copies).
- acceptance: VERIFIED at the mechanism level (subagent reaches plugin ledger with no allowlist). Live end-to-end on the named plan agents pending a session restart / plugin rebuild. Both plan agents use a denylist, not an MCP-name allowlist.
- ledgerRefs: ["goals:G1"]
- completion: |
    Source fix complete + mechanism verified; live activation needs a session restart.
    
    EVIDENCE: (1) A general-purpose subagent (no tools allowlist) successfully loaded and called mcp__plugin_claude-code-home-manager_ledger__fetch_item from inside a subagent -> subagents DO inherit the plugin-namespaced ledger server; the denylist approach is sound. (2) The bare mcp__ledger__* server does not exist in this environment. (3) A spawned plan-reviewer still failed (only Read/Grep/Glob/Web) -> it ran the PLUGIN's bundled copy (mcp__ledger__* allowlist), not my edited .claude/agents symlink.
    
    ROOT OF THE LIVE MISS: the agent registry loads at session start; the .claude/agents symlinks were created mid-session by link-prompts, so the registry still holds the plugin copy. Docs: subagent precedence is Project > User > Plugin, so after a RESTART the project symlinks (-> fixed llm/) override the plugin.
    
    TO ACTIVATE: (a) restart the Claude session (project .claude/agents override the plugin) for the local fix; (b) for users who get these agents via the home-manager plugin, rebuild the plugin from this repo's updated llm/ (llmAssets) so the bundled copies carry the denylist. NOTE: uncommitted working-tree change in llm/agents/plan-advance.md and llm/agents/plan-reviewer.md.

### T14 — done

- createdAt: 2026-06-01T20:03:30.163Z
- updatedAt: 2026-06-01T22:29:27.495Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "/plan:advance with no args advances all unlocked goals"
- suggestedModel: frontier
- description: "Currently /plan:advance requires a goal id ($ARGUMENTS). Improvement: when called WITHOUT arguments, it should advance ALL 'unlocked' goals — i.e. every goal not in a terminal/locked phase. Define 'unlocked' precisely: goals in `clarifying` or `planning` (not `planned`, `done`, or `abandoned`). For each such goal, run the existing planner<->reviewer round (the same per-goal loop). Iterate goals independently; a goal that hits `awaiting-answers` is reported and skipped, others continue. Update llm/commands/plan/advance.md: when $ARGUMENTS is empty, enumerate goals via the goals ledger and loop over the unlocked set; when an id is given, keep current single-goal behaviour. Report a per-goal summary (phase + next action) at the end."
- acceptance: advance.md handles empty $ARGUMENTS by selecting all goals in clarifying/planning and running the round on each; explicit-id behaviour unchanged. The 4-iteration cap applies per goal. Per-goal outcome summary is reported.
- dependsOn: ["T13"]
- ledgerRefs: ["goals:G1"]
- completion: "plan/advance.md now handles an empty argument: it reads the goals ledger and runs the per-goal round on every UNLOCKED goal (clarifying/planning), independently (one stopping at awaiting-answers doesn't block others), with the 4-iteration cap applied per goal and a per-goal + roll-up report. Explicit-id behavior unchanged. argument-hint relaxed to [goalId]. Markdown-only (allowed-tools already include fetch_ledger/enumerate_ledgers)."

### T25 — done

- createdAt: 2026-06-01T20:49:09.369Z
- updatedAt: 2026-06-01T20:53:29.939Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "Add /plan:follow-up <id> <request> command (+ goal re-open transitions)"
- suggestedModel: frontier
- description: |
    User request: a command to add more scope to an EXISTING goal once its plan is done. Decisions (asked + answered): re-open the SAME goal via a schema change; clarify-first.
    
    Constraint found in code: GOALS_SCHEMA forbids leaving terminal states, and validateSchema enforces 'a terminal status must have no outgoing transitions' (core.ts:177). So done/abandoned cannot gain a ->planning edge without dropping them from terminalStatuses (which regresses milestone archiving + the meaning of done). The plan-flow/implement-flow only ever drive a goal to `planned` or `building` (both non-terminal), so re-open from those covers every reachable state incl. G1 (currently planned).
    
    Scope:
    1. @cq/ledger: add `planned->planning` and `building->planning` to GOALS_SCHEMA.transitions (constants.ts). Leave done/abandoned terminal+empty. Update the comment.
    2. Tests (repro-first): transitions.test.ts behavioral re-open (planned->planning, building->planning) over both adapters + pinned-edge assertions.
    3. New asset llm/commands/plan/follow-up.md: thin, mirrors plan/start.md. Validate goal exists & is non-terminal; append the follow-up request to the goal description (preserve history); re-open planned/building -> planning -> clarifying; hand to plan-advance (clarify-first); write session log; report. Terminal goal -> refuse with guidance.
    4. Wire: link-prompts.ts LINKS + .codex/prompts/plan-follow-up.md symlink + both README tables (+ How-Codex list).
    5. bun run check green.
- ledgerRefs: ["goals:G1"]
- completion: "Done. (1) GOALS_SCHEMA gained planned->planning + building->planning re-open edges (constants.ts); docs/ledgers.yaml regenerated. (2) transitions.test.ts: behavioral re-open tests over both adapters + pinned-edge assertions (repro-first: confirmed 5 failures pre-change, all green after). (3) llm/commands/plan/follow-up.md created (parse id+request, phase-gate terminal goals, append request to description, re-open ->planning->clarifying, hand to plan-advance, write session log, report). (4) Wired: link-prompts.ts, .codex/prompts/plan-follow-up.md symlink, both README tables + How-Codex list + ledger-ref; plan-advance.md transitions note updated. bun run check green (384 pass). RESTART CAVEAT: the running ledger MCP server loaded the OLD schema at session start, so planned->planning is rejected until it restarts (same registry-load-at-start limitation as T13); docs/ledgers.yaml is already correct for the next boot."
