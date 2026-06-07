---
ledger: questions
counters:
  milestone: 0
  item: 131
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
---

# questions

## M86

### Q125 — answered

- createdAt: 2026-06-07T19:00:04.930Z
- updatedAt: 2026-06-07T19:10:51.932Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Which subagent mechanism should we adopt for Pi: (a) the third-party npm extension `nicobailon/pi-subagents`, (b) badlogic's own example subagent extension shipped in pi-mono's examples/extensions, or (c) a bespoke in-repo Pi extension (nix/pkg/pi-extensions/*.ts via pi.registerTool) purpose-built for the cq flow? Or do you want the plan to start with an evaluation/spike task that compares them and a follow-up to commit the choice?"
- context: "Pi has no native subagents (pi-context.md says so explicitly). The flow needs to dispatch explorers/reviewers/workers. nicobailon/pi-subagents is the closest off-the-shelf match: it already uses agent markdown files with YAML frontmatter (model/tools/skills), /chain + /parallel slash commands, and a 'children do not register the subagent tool' boundary that mirrors our own 'subagents-cannot-spawn-subagents' invariant. The tradeoff is third-party-dependency risk + frontmatter-shape mismatch vs. our existing `mergedAgents` definitions, versus the control (and maintenance cost) of a bespoke extension. This choice determines essentially the entire task breakdown."
- suggestions: ["Adopt nicobailon/pi-subagents (npm package), adapt our agent bundle to its frontmatter","Vendor/port badlogic's example subagent extension into nix/pkg/pi-extensions","Write a bespoke in-repo pi.registerTool extension driven by our existing mergedAgents","First task: spike/compare all three read-only, then a decision item picks one before implementation"]
- recommendation: Start with a short spike comparing nicobailon/pi-subagents against a bespoke extension, but bias toward the bespoke in-repo extension if its frontmatter/dispatch contract diverges from our mergedAgents shape — it keeps the cross-harness dispatch contract under our control and avoids a third-party dependency in the unattended worker path.
- ledgerRefs: ["goals:G28"]
- answer: "Counter questions: you haven't provided me pros and cons, how hard is that to implement a custom extension? Any downsides?"

### Q126 — answered

- createdAt: 2026-06-07T19:00:14.387Z
- updatedAt: 2026-06-07T19:11:22.469Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "How portable must the cq command prompts (plan/investigate/implement *:advance) be once Pi gains subagents? Should the prompts dispatch subagents through a single harness-agnostic abstraction (so the SAME prompt text works on Claude's Task tool, Codex multi_agent, and Pi), or is it acceptable for the prompts to branch on harness ('if Pi, call the pi-subagents tool; if Claude, use Task')?"
- context: The cq command prompts currently assume Claude Code's native `Task`-tool dispatch and encode rules like 'you never spawn subagents' / 'subagents cannot spawn subagents'. Codex already diverges (features.multi_agent). The portability target dictates whether this goal also requires editing the shared command prompts in nix/pkg/cq-assets, or only adds a Pi-side adapter that maps the existing dispatch convention onto Pi's mechanism. This is load-bearing for scope (touch shared prompts vs Pi-only).
- suggestions: ["Single harness-agnostic dispatch abstraction; minimize/avoid harness-specific branches in prompts","Pi-side adapter only: keep prompts as-is, the Pi mechanism interprets the existing dispatch convention","Explicit per-harness branches in the prompts are acceptable"]
- recommendation: Prefer a Pi-side adapter that interprets the EXISTING dispatch convention (the agent name + task the prompt already specifies), so the shared command prompts stay unchanged and Claude/Codex are unaffected; only fall back to prompt edits if the convention can't be expressed Pi-side.
- ledgerRefs: ["goals:G28"]
- answer: I would prefer these prompts to work unchanged in all harnesses

### Q127 — answered

- createdAt: 2026-06-07T19:00:23.389Z
- updatedAt: 2026-06-07T19:12:58.602Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: Which model/provider should Pi subagents run under, and does each cq subagent role's `suggestedModel` tier (frontier/standard/fast) need to map to a concrete Pi provider+model? Pi's default is grok-build, but the cq agents carry Claude-oriented model hints.
- context: Under Claude Code each subagent inherits a Claude model; the cq agent definitions and task `suggestedModel` tiers assume that resolution. Pi can route to grok-build, openrouter, ollama-cloud, minimax, anthropic-OAuth, etc. (see programs.pi packages). A subagent extension typically lets an agent's frontmatter pin a model. We need to know whether Pi subagents should (a) all inherit the parent's active Pi model, (b) map our frontier/standard/fast tiers to specific Pi providers, or (c) be left to the chosen extension's defaults. This affects whether the plan must add a tier->Pi-model mapping.
- suggestions: ["Subagents inherit the parent Pi session's active model (simplest)","Map frontier/standard/fast tiers to specific Pi providers+models (e.g. frontier=grok-build or anthropic, fast=ollama/minimax)","Defer to the chosen extension's per-agent frontmatter defaults"]
- recommendation: Have subagents inherit the parent Pi model for the first iteration (least new config, matches how Claude subagents inherit), and defer a tier->provider mapping to a follow-up unless you already want cost/latency tiering on day one.
- ledgerRefs: ["goals:G28"]
- answer: Essentially, it orchestrator should be able to specify which agents it wants to run. Also we need specific fast-standard-frontier mapping defined in cq.toml

### Q128 — answered

- createdAt: 2026-06-07T19:00:32.369Z
- updatedAt: 2026-06-07T19:13:18.859Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "What is the acceptance/verification bar for this goal — how do we prove Pi subagents 'work correctly, mirroring Claude Code'? Specifically, which cq flow(s) must run end-to-end under Pi as the success criterion (e.g. a full /cq:plan:advance round dispatching candidate planners, or /cq:investigate:advance dispatching read-only explorers, or /cq:implement:advance dispatching workers+reviewers), and on what target repo?"
- context: Per operationalism, 'works correctly under pi' needs a concrete, observable test. The cq flow uses subagents in distinct shapes per phase (read-only explorers in investigate, candidate planners + reviewers in plan, isolated-worktree workers + reviewers in implement). Knowing the minimum demonstrable flow (and whether it must run unattended in the yolo/bubblewrap sandbox) sets each task's `acceptance` field and bounds scope.
- suggestions: ["A single phase end-to-end under Pi is sufficient acceptance (name which)","All three phases (plan/investigate/implement) must dispatch subagents successfully under Pi","Just the dispatch primitive working (spawn a child, get a structured result back) is enough; full-flow validation is a follow-up"]
- recommendation: "Make the acceptance bar: one read-only explorer dispatch (investigate-style) AND one reviewer dispatch (plan-review-style) complete under Pi and return a parseable result, demonstrated on THIS repo in the normal (non-sandboxed) environment first; full unattended-sandbox + implement-worker validation as a follow-up goal."
- ledgerRefs: ["goals:G28"]
- answer: as recommended

### Q129 — answered

- createdAt: 2026-06-07T19:00:41.311Z
- updatedAt: 2026-06-07T19:14:21.925Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: If we adopt an npm-distributed extension (e.g. nicobailon/pi-subagents), is adding it to programs.pi.settings.packages (Pi's managed --legacy-peer-deps npm install on first run) acceptable, or must it be vendored/pinned into the Nix store like the codex-plugin-cc and pi-extensions are, for reproducibility on the unattended llm-worker hosts?
- context: The existing Pi packages (rpiv-web-tools, pi-anthropic-auth, pi-ollama-cloud, minimax, pi-xai) are installed from npm at first run, NOT pinned in Nix — but the comments note self-containedness constraints around Pi's loader/jiti alias map. A subagent extension that spawns child Pi sessions and reads agent markdown is more load-bearing for the flow than a provider shim, so reproducibility/pinning policy matters. This determines whether a packaging task (vendor + FOD hash, like pkg/pi-coding-agent) is in scope.
- suggestions: ["npm install via programs.pi.settings.packages is fine (matches existing providers)","Must be vendored/pinned in the Nix store for unattended-host reproducibility","Prefer a local extension (nix/pkg/pi-extensions/*.ts) precisely to avoid the npm-pinning question"]
- recommendation: If we go with a third-party extension, vendor+pin it in the Nix store (it is load-bearing for the flow on unattended hosts); if that vendoring cost is high, that is itself an argument for the bespoke local nix/pkg/pi-extensions approach from Q1.
- ledgerRefs: ["goals:G28"]
- answer: If we use a third party extension there is no need to vendor it BUT I'm biased towards custom extension - because we will need one later for a determenistic logic governing the orchestrating session

### Q130 — answered

- createdAt: 2026-06-07T19:19:40.150Z
- updatedAt: 2026-06-07T19:28:39.847Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Mechanism lock-in (re Q125 counter-question): given the now-fixed constraints — Q126 the shared cq command prompts must work UNCHANGED across harnesses (Pi-side adapter only, interpreting the existing dispatch convention), Q127 the orchestrator must be able to name which agent to run and the fast/standard/frontier tiers must resolve via a cq.toml mapping to concrete Pi provider+model pairs, Q128 acceptance = one read-only explorer dispatch + one reviewer dispatch returning a parseable result on THIS repo non-sandboxed, and Q129 no Nix-vendoring requirement plus your stated bias toward a bespoke in-repo extension (also needed later for deterministic orchestration-session logic) — which subagent mechanism do we lock for Pi: (a) third-party npm `nicobailon/pi-subagents`, (b) vendor/port badlogic's example subagent extension, or (c) a bespoke in-repo `nix/pkg/pi-extensions` `pi.registerTool` extension? Full grounded pros/cons/difficulty/downsides analysis is in the context field below."
- context: |
    EVIDENCE-BASED ANALYSIS (read-only grounding this round; opus-4.8[1m]).
    
    === What the mechanism must actually do (derived from the repo, not assumed) ===
    The cq commands already encode a PER-HARNESS dispatch split, not a single abstraction. In nix/pkg/cq-assets/commands/cq/investigate/advance.md (L42-44) and implement/advance.md the convention is literally: 'Claude -> dispatch via the Agent tool with subagent_type: "<agent-name>" (+ isolation: "worktree"); Codex -> native multi_agent + manual git worktree add/remove'. There is currently NO Pi branch. The agents are named markdown files at nix/pkg/cq-assets/agents/<name>.md (plan-advance, plan-reviewer, investigate-explorer/-prober, implement-worker/-reviewer/-conflict-resolver) carrying `name` / `description` / `disallowedTools` frontmatter; dev-llm.nix materializes them into Claude via programs.claude-code.agents (-> ~/.claude/agents/<name>.md) but does NOT project them to Pi at all (programs.pi consumes only commands as promptTemplates + skills). So under Pi, every dispatch step has no runtime mechanism. The Pi mechanism must therefore: (1) be invokable in a way the EXISTING prompt text already says (the prompt names an agent + a task + sometimes isolation:worktree), (2) read the mergedAgents markdown for that name (its description + disallowedTools), (3) spawn a child Pi session with the agent's tools filtered + a resolved model, (4) enforce subagents-cannot-spawn-subagents (the child must NOT see the dispatch tool), and (5) return a structured, parseable result to the parent (the orchestrator parses explorer evidence-json / reviewer verdict-json).
    
    === How hard is a bespoke extension, concretely? (the user's direct question) ===
    The in-repo extension API is compact and already proven. The two existing extensions are the evidence: patch-grok-build-context-window.ts (~75 lines) and drop-client-web-search-for-grok.ts (~40 lines). They show the whole surface we need: `export default function(pi: ExtensionAPI)`, `pi.on("session_start"|"before_provider_request", handler)`, `pi.registerProvider(...)`, payload inspection/mutation, and event ordering guarantees. A subagent extension additionally needs `pi.registerTool` (register one tool, e.g. dispatch_agent({agent, task})) and the ability to run a child Pi turn with a filtered toolset + chosen model. Loading is one line in programs.pi.settings.extensions (a store path), exactly like the two existing ones. Realistic size: a single TS file on the order of 150-300 lines (tool registration + read agent markdown + spawn child session with filtered tools + resolved model + return structured result), NOT a package. The hard/uncertain part is NOT the cq-side glue — it is the child-session spawning primitive: we must confirm Pi's ExtensionAPI exposes a supported way to run an isolated child agent turn (its own context, filtered tools) and capture its final output. That is the ONE thing to de-risk; badlogic's example extension and nicobailon/pi-subagents BOTH already do exactly this, which is direct proof the primitive exists in this Pi version — we would lift the spawning technique from them even if we don't depend on them.
    
    === Option (a) nicobailon/pi-subagents (npm) ===
    Pros: closest off-the-shelf fit; already does isolated child sessions, agent-markdown-with-YAML-frontmatter (model/tools/skills), /chain + /parallel slash commands, AND a 'children do not register the subagent tool' boundary that mirrors our subagents-cannot-spawn-subagents invariant. Cons measured against the fixed constraints: (i) Q126 — its dispatch surface is /chain + /parallel slash commands and its OWN frontmatter shape, which is NOT the convention our shared prompts speak (Agent tool + subagent_type + isolation:worktree). To make the prompts work unchanged we would STILL need an adapter that maps our convention onto its tool, so we don't actually avoid writing in-repo glue — we add a third-party dep ON TOP of glue. (ii) Frontmatter mismatch vs our mergedAgents (name/description/disallowedTools) means either rewriting our agents to its schema or writing a shim — friction either way. (iii) Q129 — you explicitly do NOT want to depend on it long-term and it CANNOT host the future deterministic orchestration-session logic. (iv) third-party maintenance/version risk on the load-bearing worker path. No vendoring required per Q129, but the dependency itself is the objection.
    
    === Option (b) vendor/port badlogic's example extension ===
    Pros: first-party badlogic example (isolated-context child sessions, filtered tools) — a clean, minimal reference and the most authoritative proof of the spawning primitive. Cons: it is an EXAMPLE, not a maintained package, so adopting it = porting it into nix/pkg/pi-extensions anyway (i.e. it collapses into option (c) with a head start). Same Q126 adapter work needed (it isn't built around our convention). Net: best treated as a CODE REFERENCE for option (c), not a separate adopt-able mechanism.
    
    === Option (c) bespoke in-repo pi.registerTool extension (RECOMMENDED) ===
    Pros: (i) Q126 — we own the dispatch contract, so we register a tool whose call shape matches what the shared prompts ALREADY say (agent name + task [+ isolation]); prompts stay byte-for-byte unchanged and Claude/Codex are untouched. (ii) Q127 — naturally supports orchestrator-named agents (the tool takes the agent name) and a tier->provider mapping: cq.toml already parses an [aliases] table (harness/model) via the ledger config layer; we add a [tiers] (fast/standard/frontier -> alias-or-provider+model) mapping and the extension resolves suggestedModel through it. (iii) Q129 — it is the SAME extension surface (nix/pkg/pi-extensions/*.ts, pi.registerTool/registerProvider) we will need for the future deterministic orchestration-session logic, so the investment compounds. (iv) no third-party dependency on the unattended worker path. Cons/downsides (stated honestly): we own the child-session lifecycle (spawn, tool-filtering, result capture, error handling) and its maintenance; we carry the risk if Pi's ExtensionAPI child-session surface changes across Pi bumps (mitigated: only this one extension breaks, and the two existing extensions show bumps are manageable); and we must first DE-RISK the child-session spawning primitive (a tiny spike reading badlogic's example + Pi's coding-agent extension API) before committing the task breakdown. That spike is the single genuine unknown.
    
    === RECOMMENDATION ===
    Lock option (c), the bespoke in-repo nix/pkg/pi-extensions extension, with badlogic's example used as a code reference for the child-session spawning primitive. Justification: the three fixed constraints all point the same way — Q126 (prompts unchanged) and Q127 (orchestrator-named agent + cq.toml tier mapping) are most directly satisfied by a tool WE shape to the existing convention; Q129 (no-vendor bias + future deterministic-orchestration extension) makes the in-repo extension the reusable foundation rather than a throwaway. The only real cost is owning the child-session lifecycle + one de-risking spike of the spawning primitive, which is bounded and which options (a)/(b) prove is achievable. If the spike reveals Pi's ExtensionAPI cannot spawn a filtered-tool child session at all, that single finding would reopen this choice toward (a)/(b) — so the first planned task should be that read-only spike with a go/no-go on the primitive.
- suggestions: ["(a) Adopt third-party npm nicobailon/pi-subagents (no vendoring per Q129) + an adapter mapping our dispatch convention onto its tool, and reshape agent frontmatter to its schema","(b) Vendor/port badlogic's example subagent extension into nix/pkg/pi-extensions (collapses into option c with a head start)","(c) RECOMMENDED: bespoke in-repo nix/pkg/pi-extensions pi.registerTool extension shaped to the existing dispatch convention, reading mergedAgents + resolving suggestedModel via a new cq.toml [tiers] mapping, using badlogic's example as a spawning-primitive reference"]
- recommendation: "Lock (c) the bespoke in-repo extension. It is the only option that satisfies Q126 (shared prompts unchanged — we shape the tool to the existing Agent/subagent_type convention), Q127 (orchestrator names the agent; fast/standard/frontier resolve via a new cq.toml [tiers] mapping the config layer already supports alongside [aliases]), and Q129 (no third-party worker-path dependency, and it IS the extension surface the future deterministic orchestration-session logic will reuse). Implementation difficulty is moderate and bounded: ~150-300 lines in one TS file using the same ExtensionAPI the two existing pi-extensions already use; the single real unknown is whether Pi's ExtensionAPI can spawn a filtered-tool child session and capture its result — which badlogic's example and nicobailon/pi-subagents both prove it can. The honest downside is that we own the child-session lifecycle and its maintenance across Pi version bumps. Recommend the first planned task be a read-only spike confirming that spawning primitive (go/no-go), after which the rest of the breakdown is committed."
- ledgerRefs: ["goals:G28"]
- answer: as recommended

### Q131 — open

- createdAt: 2026-06-07T20:49:24.305Z
- updatedAt: 2026-06-07T20:49:24.305Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "G28's integration + acceptance tail (T224 load the dispatch extension into a running pi; T225 observe tier resolution in pi's provider logs; T229 confirm an UNCHANGED cq prompt fires the dispatch tool under pi; T226/T227 the acceptance demos — one explorer + one reviewer dispatch under the wrapped pi harness) all require the new programs.pi/dev-llm.nix wiring to be HOME-MANAGER-ACTIVATED and the wrapped `pi` harness run with live provider auth (grok-build OAuth) to load the extension and perform live LLM-backed subagent dispatch. The autonomous sandbox session cannot run `home-manager switch` or drive the live interactive pi harness, so it cannot complete/verify Q128's acceptance bar. How do you want to proceed? (a) You activate the wiring (`home-manager switch`) and run the T226/T227 acceptance demos in your environment, reporting the transcripts back; (b) confirm the sandbox CAN activate home-manager + run pi headlessly (and the agent should attempt it); or (c) the agent keeps autonomously building the env-independent remainder (T228 runtime-config-access decision, T222 agents-dir nix projection — verifiable via nix eval / git diff) and you drive only the live-pi acceptance tail. Buildable-without-pi: T228, T222. Needs activated-pi-env: T224, T225, T229, T226, T227."
- context: "Plan G28 is `planned` (locked, R268 unanimous go-ahead). Implemented + merged this run: T223 (cq.toml [tiers]+[agent_tiers] + @cq/config parser/resolvers, bun run check green 1038/0, commit 92aae54) and T221 (go/no-go spike: GO — all 5 Pi 0.78.0 ExtensionAPI primitives confirmed at exact file:line, Route A subprocess `pi -p --mode json` recommended, commit bd6aa87). M87 complete; M89 has T223 done (T228 still planned). The DAG bottleneck is the live-pi environment for the integration/acceptance milestones M88/M90/M91. This question gates how the env-dependent tasks get executed; it does NOT block the env-independent T228/T222, which the next /cq:advance can build autonomously."
- suggestions: ["You run `home-manager switch` + the T226/T227 acceptance demos in your environment and report the pi transcripts","Confirm the sandbox can activate home-manager + run pi headlessly with provider auth, and the agent attempts the full tail","Agent autonomously builds the env-independent remainder (T228, T222) on the next /cq:advance; you drive the live-pi acceptance tail (T224–T227)"]
- recommendation: "Option (c) for the next /cq:advance pass (autonomously land T228 + T222 — both verifiable without pi), then option (a) for the acceptance tail: you activate the wiring and run the two demos, since live LLM-backed subagent dispatch under the interactive pi harness is best observed in your environment with provider auth. If the sandbox can in fact `home-manager switch` + run pi headlessly (option b), say so and the agent will drive the whole tail."
- ledgerRefs: ["goals:G28","tasks:T224","tasks:T226","tasks:T227"]
