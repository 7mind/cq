---
ledger: questions
counters:
  milestone: 0
  item: 142
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

### Q131 — answered

- createdAt: 2026-06-07T20:49:24.305Z
- updatedAt: 2026-06-07T21:45:40.391Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "G28's integration + acceptance tail (T224 load the dispatch extension into a running pi; T225 observe tier resolution in pi's provider logs; T229 confirm an UNCHANGED cq prompt fires the dispatch tool under pi; T226/T227 the acceptance demos — one explorer + one reviewer dispatch under the wrapped pi harness) all require the new programs.pi/dev-llm.nix wiring to be HOME-MANAGER-ACTIVATED and the wrapped `pi` harness run with live provider auth (grok-build OAuth) to load the extension and perform live LLM-backed subagent dispatch. The autonomous sandbox session cannot run `home-manager switch` or drive the live interactive pi harness, so it cannot complete/verify Q128's acceptance bar. How do you want to proceed? (a) You activate the wiring (`home-manager switch`) and run the T226/T227 acceptance demos in your environment, reporting the transcripts back; (b) confirm the sandbox CAN activate home-manager + run pi headlessly (and the agent should attempt it); or (c) the agent keeps autonomously building the env-independent remainder (T228 runtime-config-access decision, T222 agents-dir nix projection — verifiable via nix eval / git diff) and you drive only the live-pi acceptance tail. Buildable-without-pi: T228, T222. Needs activated-pi-env: T224, T225, T229, T226, T227."
- context: "Plan G28 is `planned` (locked, R268 unanimous go-ahead). Implemented + merged this run: T223 (cq.toml [tiers]+[agent_tiers] + @cq/config parser/resolvers, bun run check green 1038/0, commit 92aae54) and T221 (go/no-go spike: GO — all 5 Pi 0.78.0 ExtensionAPI primitives confirmed at exact file:line, Route A subprocess `pi -p --mode json` recommended, commit bd6aa87). M87 complete; M89 has T223 done (T228 still planned). The DAG bottleneck is the live-pi environment for the integration/acceptance milestones M88/M90/M91. This question gates how the env-dependent tasks get executed; it does NOT block the env-independent T228/T222, which the next /cq:advance can build autonomously."
- suggestions: ["You run `home-manager switch` + the T226/T227 acceptance demos in your environment and report the pi transcripts","Confirm the sandbox can activate home-manager + run pi headlessly with provider auth, and the agent attempts the full tail","Agent autonomously builds the env-independent remainder (T228, T222) on the next /cq:advance; you drive the live-pi acceptance tail (T224–T227)"]
- recommendation: "Option (c) for the next /cq:advance pass (autonomously land T228 + T222 — both verifiable without pi), then option (a) for the acceptance tail: you activate the wiring and run the two demos, since live LLM-backed subagent dispatch under the interactive pi harness is best observed in your environment with provider auth. If the sandbox can in fact `home-manager switch` + run pi headlessly (option b), say so and the agent will drive the whole tail."
- ledgerRefs: ["goals:G28","tasks:T224","tasks:T226","tasks:T227"]
- answer: You should be able to build pi package autonomously and run within your sandbox - you have nix at your disposal, you don't need to switch system in order to test a package.

## M92

### Q132 — answered

- createdAt: 2026-06-07T23:59:18.898Z
- updatedAt: 2026-06-08T00:00:02.443Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Which IN-MODEL provider separator is canonical for the provider-qualified pi token — the colon you proposed (`pi:ollama-cloud:minimax-m3`), the slash already shipped in the T225 extension (`pi:ollama-cloud/minimax-m3`, which D36's suggestedFix also cites), or should both be accepted?"
- context: "GROUNDING — the harness split is NOT ambiguous: both `parseReviewerToken` (cq-config/src/config.ts L44-52) and the extension's `parseCqToken` (cq-subagent-dispatch.ts L251-258) split on the FIRST `:` and keep everything after it in `model`. So `pi:ollama-cloud:minimax-m3` ALREADY parses to `{harness:'pi', model:'ollama-cloud:minimax-m3'}` today — no collision. The real divergence is purely in PROVIDER EXTRACTION from the model segment: `tokenToChildModel` (L320-327) splits the model on `/` (not `:`) to emit `--provider`, so only the SLASH form yields a provider today; @cq/config performs NO provider extraction at all (it stores `model` opaquely). T225 already shipped+demoed the slash form (`pi:ollama-cloud/minimax-m3`). Choosing the canonical separator determines whether we add new colon-splitting logic to BOTH layers or simply add provider-extraction to @cq/config matching the slash the extension already uses."
- suggestions: ["Standardize on the slash `pi:<provider>/<model>` already shipped+demoed in T225 (extension unchanged; just teach @cq/config to extract the provider on `/`)","Adopt the colon `pi:<provider>:<model>` you proposed (requires NEW second-colon-split provider extraction in BOTH @cq/config and the extension's tokenToChildModel)","Accept BOTH separators everywhere (most permissive; both layers split on `/` OR a second `:`)"]
- recommendation: "Standardize on the slash `pi:<provider>/<model>` already shipped+demoed in T225 — it minimizes change (the extension already does this; @cq/config gains a small provider-extraction step that mirrors `tokenToChildModel`), keeps one grammar across both layers, and matches D36's suggestedFix verbatim. A second-colon scheme works mechanically but means writing and keeping-in-sync two new split paths for no functional gain over the slash."
- ledgerRefs: ["goals:G29"]
- answer: as recommended

### Q133 — answered

- createdAt: 2026-06-07T23:59:30.645Z
- updatedAt: 2026-06-08T00:00:56.572Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: What is the in-scope surface for this change — should the @cq/config layer be extended to EXTRACT and EXPOSE the provider (a structured `provider` field on ReviewerToken, surfaced via get_reviewers/get_planners/tier resolution), or only to PARSE-and-PRESERVE the qualified token string so the dispatch extension remains the sole place that splits out `--provider`?
- context: "GROUNDING — today @cq/config's `ReviewerToken` (cq-config/src/types.ts L20-23) is `{harness, model}` with NO provider field; `model` holds the entire post-harness segment opaquely. Provider extraction lives ONLY in the extension's `tokenToChildModel`. The two layers are COPIES, not shared code (the extension is a standalone store-path file outside the bun workspace and cannot import @cq/config — see cq-subagent-dispatch.ts L49-56). So 'add provider support to the config grammar' could mean (a) add a real `provider` field + extraction to @cq/config so get_reviewers/get_planners callers see provider=ollama-cloud, or (b) only validate/pass the qualified string through @cq/config and let the extension keep being the one place provider is split off. The defect D36 is specifically about the DISPATCH path (the extension), but the goal text says it must be 'parsed by the @cq/config layer' too."
- suggestions: ["Add a structured `provider: string | null` to @cq/config's ReviewerToken + extraction in parseReviewerToken, surfaced through get_reviewers/get_planners and tier resolution; the extension keeps its own mirrored copy in sync","@cq/config only parses+preserves the qualified token (no new field); only the extension's tokenToChildModel splits provider for `--provider`","Both layers extract provider, AND record a decisions item noting the two copies must stay in sync (no shared import is possible)"]
- recommendation: Add a structured `provider` field to @cq/config (option a) AND keep the extension's mirrored copy in sync — the goal explicitly requires @cq/config to honor the grammar, get_reviewers/get_planners consumers benefit from seeing the provider, and the existing K46/T223 'mirror, don't import' discipline already governs keeping the two copies aligned.
- ledgerRefs: ["goals:G29"]
- answer: as recommended

### Q134 — answered

- createdAt: 2026-06-07T23:59:38.157Z
- updatedAt: 2026-06-08T00:01:25.779Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Should the bare `pi:<model>` form (no provider) keep working unchanged (provider omitted → pi's fuzzy match, exactly today's behavior), or should it be deprecated/warned now that an explicit-provider form exists?"
- context: "GROUNDING — today a bare `pi:minimax-m3` resolves with NO `--provider` and lets pi's non-deterministic fuzzy matching pick — that IS the D36 defect. Many existing cq.toml entries (e.g. live `[aliases] grok = ...`, and the example's minimax) use the bare form and are unambiguous because their model registers under exactly one provider. Deprecating the bare form would be a breaking change to every existing config; keeping it backward-compatible means the bare form stays valid and only ambiguous models need the qualified form."
- suggestions: ["Keep the bare `pi:<model>` form fully backward-compatible (provider omitted → unchanged fuzzy behavior); only ambiguous models need the qualified form","Keep it working but emit a warning when a bare token resolves to a model registered under multiple providers","Deprecate the bare form (require explicit provider for all pi tokens) — breaking change"]
- recommendation: "Keep the bare `pi:<model>` form fully backward-compatible — it is non-breaking and the qualified form is purely additive; the bare form is only problematic for multi-provider models, which the user fixes by adding the provider. A multi-provider warning (option b) is a reasonable optional nicety but not required to resolve D36."
- ledgerRefs: ["goals:G29"]
- answer: Completely drop bare support

### Q135 — answered

- createdAt: 2026-06-07T23:59:44.740Z
- updatedAt: 2026-06-08T00:01:53.116Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Should the provider-qualified form apply ONLY to `pi:` tokens, or also to `claude:` tokens?"
- context: "GROUNDING — the harnesses are exactly `claude` and `pi` (types.ts L11). The provider concept (and `--provider`) is a pi runtime feature: `tokenToChildModel` returns null for any non-`pi` harness (cq-subagent-dispatch.ts L320-321), and a `claude:` token cannot be driven by a child pi process at all. D36 is entirely about pi/minimax. So a provider-qualified `claude:<provider>/<model>` form has no consumer today and would be dead grammar."
- suggestions: ["pi: only — a provider qualifier on a claude: token is a config error (or ignored)","Accept the qualifier syntactically on both, but it is only meaningful/honored for pi:"]
- recommendation: "pi: only — the provider qualifier is meaningful exclusively for the pi harness; reject (or document-as-ignored) a provider qualifier on a claude: token rather than carrying dead grammar. This keeps the validation surface honest and matches where `--provider` is actually consumed."
- ledgerRefs: ["goals:G29"]
- answer: as recommended

### Q136 — answered

- createdAt: 2026-06-07T23:59:55.797Z
- updatedAt: 2026-06-08T00:02:21.167Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "What is the acceptance bar that closes D36 — is `bun test` coverage in @cq/config for the new grammar (parse + resolve through tiers/reviewers/planners) PLUS an updated cq.toml.example sufficient, or do you also require a LIVE dispatch demonstration that `minimax = \"pi:ollama-cloud/...\"` actually emits `--provider ollama-cloud` and the minimax reviewer/planner no longer abstains?"
- context: "GROUNDING — @cq/config is unit-tested via `bun test` (run from nix/pkg/cq-ledgers/). D36's live evidence in T225 already demonstrated `pi:ollama-cloud/minimax-m3` emitting the correct `--provider` via the dispatch extension's `details.childProvider`. The goal also notes the minimax reviewer/planner shellouts ABSTAINED every run because they resolved to `--provider minimax` (key-gated, $MINIMAX_API_KEY absent). Whether a fresh live minimax run is part of acceptance — or whether unit tests + the prior T225 evidence suffice — sets how big the verification tasks are. The cq.toml.example to update lives under nix/pkg/cq-ledgers/ (planner will confirm exact filename)."
- suggestions: ["bun test coverage in @cq/config (parse the qualified token; resolve provider through tiers + get_reviewers/get_planners) + updated cq.toml.example + token-format docs — unit-level acceptance, reuse T225's prior live evidence for the dispatch half","The above PLUS a fresh live dispatch demo showing `--provider ollama-cloud` is emitted and a minimax reviewer/planner run no longer abstains","The above PLUS asserting the @cq/config copy and the extension's inlined copy agree on the same token (a cross-layer consistency test or a recorded decisions item)"]
- recommendation: Unit tests in @cq/config + updated cq.toml.example + token-format docs, and rely on T225's already-recorded live `--provider ollama-cloud` evidence for the dispatch half (option a). A fresh live minimax run (option b) is the strongest closure of D36 if you want it, but it depends on ollama-cloud OAuth being available in the run environment; I'll plan it as a separate, clearly-marked acceptance-demo task if you want the live demonstration.
- ledgerRefs: ["goals:G29"]
- answer: as recommended

## M93

### Q137 — answered

- createdAt: 2026-06-08T00:04:34.506Z
- updatedAt: 2026-06-08T00:06:27.359Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "What EXACT status string should the new handoff status be, and is it TERMINAL like the existing four? Proposed: `user-action-required`. Confirm the literal token (it goes into HANDOFFS_SCHEMA.statusValues + terminalStatuses + the transitions map, and is grepped verbatim across the four prompt status-tables)."
- context: "HANDOFFS_SCHEMA (nix/pkg/cq-ledgers/packages/ledger/src/constants.ts L341-361) currently has statusValues = [drained, answers-required, mixed, illness-detected], all four ALSO listed in terminalStatuses with an empty transitions[] entry each (a handoff is an immutable one-session exit record). idPrefix HO. A new status must be added to all three places consistently. The goal text proposes `user-action-required`; alternatives could be `user-action-needed`, `manual-action-required`, `env-action-required`. The token style of the set is kebab-case."
- suggestions: ["`user-action-required`, terminal (mirrors the other four — a handoff is an immutable exit record)","`user-action-required`, but NON-terminal (so the same handoff item can later be transitioned to `drained` once the user acts and a follow-up run verifies)","a different token (specify)"]
- recommendation: "`user-action-required`, terminal — matches the existing 'handoff is an immutable record of one session's exit state' invariant; the follow-up verification is a NEW handoff on the re-run, not a transition of this one."
- ledgerRefs: ["goals:G30"]
- answer: as recommended

### Q138 — answered

- createdAt: 2026-06-08T00:04:52.362Z
- updatedAt: 2026-06-08T00:07:03.392Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Is `user-action-required` a LEGAL stop even when a P-predicate (P-implement / P-investigate / P-plan) would otherwise be TRUE — i.e. does the agent stop with autonomous work still nominally available because a SPECIFIC remaining item genuinely requires the user's manual/environment action? And critically: what is the OPERATIONAL test that distinguishes a genuine user-action stop from a laundered effort/confirmation stop (the exact thing /cq:advance §Stop condition forbids)?"
- context: "advance.md §Stop condition (L253-325) is emphatic: a stop is PROGRESS-bounded never EFFORT-bounded; 'There is deliberately NO handoff status for an effort-based stop'; the ONLY legitimate user-facing pause today is BLOCKED-ON-QUESTIONS (an `open` questions item that changes WHAT/HOW to build or unblocks otherwise-impossible work — e.g. missing external access/credentials). Adding a 5th status that is a legal stop is exactly the kind of escape hatch the gate was written to prevent, UNLESS its trigger is pinned just as narrowly. Note the gate ALREADY admits 'missing external access/credentials' and 'a reproduction that cannot be produced from the repo' as legitimate — `user-action-required` looks like a SUPERSET of those (the agent did all autonomous work; the remaining step is physically the user's: re-activate, provision a credential, run an external/privileged command). The motivating D37 ('re-run home-manager switch') is NOT a requirements ambiguity and NOT an open question, yet it is a real environment blocker. We must pin the trigger so 'I just don't want to continue' / 'this is a natural stopping point' / 'the remaining fix is disproportionate' can NEVER be dressed as user-action-required."
- suggestions: ["LEGAL stop, narrowly pinned: permitted ONLY when a SPECIFIC, NAMED item cannot progress because the next physical step is exclusively the user's (re-activate an environment, provision a credential/secret, run a privileged/external command the agent cannot run) AND the agent has ALREADY done every autonomous step; never for magnitude/proportion/scope/disposition. Operational test: the agent must name the exact command/action the user runs and the exact item it unblocks (like D37's `home-manager switch`); if it cannot, it is NOT user-action-required — CONTINUE.","Treat it as a sub-kind of the existing 'missing external access/credentials' BLOCKED case — same gate, new status label only (so the predicate machinery is unchanged: it is reached only when every P-predicate is FALSE-or-blocked).","Keep it strictly NON-stop: it never authorizes ending while a P-predicate is TRUE-and-unblocked; it only re-labels a stop that was ALREADY legal under the existing blocked rules."]
- recommendation: "Narrowly-pinned legal stop (suggestion 1) with the SAME anti-laundering prose the §Stop condition uses for confirmations: enumerate the forbidden look-alikes (magnitude/proportion/scope/disposition/'natural stopping point') as explicitly NOT user-action-required, and require the agent to name the exact user command + the exact unblocked item. This makes it a distinct, auditable status rather than an effort escape hatch."
- ledgerRefs: ["goals:G30"]
- answer: as recommended

### Q139 — open

- createdAt: 2026-06-08T00:05:10.088Z
- updatedAt: 2026-06-08T00:05:10.088Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: Is the new status DISTINCT from `answers-required`, or should `answers-required` be generalized to cover user-actions too? And how does the agent CHOOSE between them at end-of-run when BOTH an open question and a user-action blocker are present — does that become a `mixed` stop, and if so does `mixed`'s handoffReasons need to be able to list `user-action-required` as a component?
- context: "Today /cq:advance maps BLOCKED-ON-QUESTIONS→answers-required and ties answers-required/mixed to a non-empty blockingQuestions[] (advance.md L266-268). The goal explicitly wants the new status DISTINCT from answers-required: answers-required = a user REQUIREMENTS/clarification ANSWER (an `open` questions item); user-action-required = a manual/environment ACTION the agent cannot perform itself (no questions item involved). The `mixed` status already composes multiple reasons via handoffReasons[] (HANDOFFS_SCHEMA `handoffReasons: string[]`). If a run lands work AND is blocked partly on an open question AND partly on a user action, the natural classification is `mixed` with handoffReasons listing both components. The four prompt status-tables (advance.md L63-66, plan/advance.md L563-568, investigate/advance.md L355-360, implement/advance.md L422-427) each map an end-of-run classification to a handoff status and would each gain a row for the user-action case."
- suggestions: ["DISTINCT new status; answers-required stays exactly as-is (open-question only). When BOTH an open-question block and a user-action block co-occur with landed work → classify `mixed` and list both as handoffReasons components (e.g. [drained, answers-required, user-action-required]).","Generalize answers-required to mean 'needs user input of any kind' (question OR action) — fewer statuses but loses the question-vs-action distinction the goal asked for (NOT recommended).","DISTINCT new status, and when a user-action block co-occurs with an open question, prefer the NEW status over mixed (treat user-action as the dominant classification)."]
- recommendation: "DISTINCT new status (suggestion 1): keep answers-required strictly question-gated; introduce user-action-required as its own classification; and let `mixed` compose them via handoffReasons (which already exists for exactly this). This preserves the question-vs-action distinction the goal requires and reuses the existing mixed/handoffReasons machinery rather than inventing new composition rules."
- ledgerRefs: ["goals:G30"]

### Q140 — open

- createdAt: 2026-06-08T00:05:23.450Z
- updatedAt: 2026-06-08T00:05:23.450Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Does the new status need a STRUCTURED 'required action' field so the user sees exactly what to do (the exact command/action + which item it unblocks), or is the existing free-text `handoffReasons[]` + `summary` + `ledgerRefs` enough? And does `user-action-required` belong ONLY on the handoffs lifecycle, or should an analogous concept also exist on goals/defects (so e.g. D37 itself carries a 'blocked on user action' marker)?"
- context: "HANDOFFS_SCHEMA fields today: summary (required), flow, ledgerRefs, blockingQuestions (ids of blocking questions — the structured carrier for answers-required), handoffReasons (string[]), sessionLogs, tags, sourceRefs. There is NO structured carrier for a user-action the way blockingQuestions structures the question case. Options: (a) reuse handoffReasons free-text; (b) add a new field e.g. `requiredActions: string[]` (each entry = one concrete action the user must take) parallel to blockingQuestions. The motivating D37 already encodes its action in defects.suggestedFix ('Re-run home-manager switch ...') and is an `open` defect — so the action detail can ALSO live on the linked defect via ledgerRefs. SCHEMA-COST NOTE: adding statusValues is a schema change (see the migration question); adding a NEW FIELD is also a schema change and triggers the same on-disk-divergence guard. Keeping to handoffReasons avoids a second schema-shape change. Separately: defects/goals have their own lifecycles — widening them is a much larger blast radius and likely out of scope."
- suggestions: ["No new field: carry the required action in `handoffReasons[]` (one entry per action, e.g. 'user-action-required: run `home-manager switch` to activate the merged extension (unblocks D37)') + `ledgerRefs` to the blocked item + `summary` prose. Handoffs-only; do NOT touch goals/defects lifecycles.","Add a structured `requiredActions: string[]` field to HANDOFFS_SCHEMA (parallel to blockingQuestions) so the user-action is first-class and machine-readable; handoffs-only.","Both a new handoffs field AND an analogous marker on goals/defects (largest scope — likely defer the goals/defects part to a separate goal)."]
- recommendation: Suggestion 1 (reuse handoffReasons, no new field, handoffs-only). The user-action detail is already capturable in handoffReasons + the linked defect's suggestedFix via ledgerRefs; adding a field is a second schema-shape change with its own migration cost for marginal benefit, and widening goals/defects lifecycles is out of scope for this goal. If a structured field is wanted, prefer suggestion 2 over 3 and keep it handoffs-only.
- ledgerRefs: ["goals:G30"]

### Q141 — open

- createdAt: 2026-06-08T00:05:51.295Z
- updatedAt: 2026-06-08T00:05:51.295Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: How should the schema change interact with the schema-divergence BACKUP-AND-REINIT behavior on existing deployments? Adding a value to HANDOFFS_SCHEMA.statusValues changes the canonical schema, so any ledger whose on-disk handoffs schema predates this change will DIVERGE on the next init() — and the DEFAULT (D2/G4 fix) is backup-and-reinit, which moves the existing handoffs file (all prior HO records) to docs/.backup/<ts>/ and writes a fresh-canonical (empty) handoffs ledger. Is that acceptable for this goal, or must existing handoff records be preserved in-place?
- context: "FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts) compares each on-disk ledger schema to its CANONICAL_LEDGERS schema; on divergence the DEFAULT onSchemaDivergence:'backup-reinit' (T95/T96) backs up the prior ledgers.yaml + the divergent .md file into docs/.backup/<sanitized-ts>/ and re-writes the affected ledger fresh-canonical (emitting one stderr WARNING with the backup path); the 'abort' opt-out preserves the old hard throw. So a deployed repo with existing HO records (e.g. THIS repo, which has HO22 etc.) would, on first run of the new binary, have its handoffs ledger reset and the old records relocated to the backup dir — NOT a silent loss, but the live handoffs ledger starts empty. This is the established/accepted migration mechanism for canonical-schema evolution in this codebase (it is how every prior statusValues addition has rolled out), but the goal should state explicitly whether that default is fine here or whether handoff history must survive in the live ledger."
- suggestions: ["Accept the established backup-and-reinit default: it is the codebase's standard canonical-schema-evolution path (prior records preserved in docs/.backup/<ts>/, live ledger fresh-canonical, one WARNING). No special migration code; just note it in the goal/acceptance and confirm `bun test`'s divergence suite still passes with the new statusValues. The repo's own handoffs ledger will reinit on next run — acceptable since HO records are session-exit logs, not work items.","Require an in-place, NON-destructive migration that ADDS the new statusValues to an existing handoffs ledger WITHOUT reinitializing (preserve all prior HO records in the live ledger). This is NEW behavior beyond the current backup-reinit mechanism and a larger change.","Defer/avoid: keep handoffs schema as-is and model user-action via handoffReasons text only (no new statusValue) — sidesteps migration entirely (but contradicts the goal's scope item (1))."]
- recommendation: Suggestion 1 (accept backup-and-reinit). It is the repo's established, tested mechanism for evolving a canonical schema (additive statusValues have always rolled out this way); records are preserved under docs/.backup/, not lost; and handoff items are immutable session-exit logs, so a fresh live ledger after one reinit is harmless. The only required test work is confirming the divergence suite still passes with the widened statusValues. Avoid building bespoke in-place migration (suggestion 2) unless preserving live HO history is an explicit requirement.
- ledgerRefs: ["goals:G30"]

### Q142 — open

- createdAt: 2026-06-08T00:06:07.095Z
- updatedAt: 2026-06-08T00:06:07.095Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "For RENDERING (TUI/web): which semantic BUCKET should `user-action-required` map to, given that as a NEW terminal status it would otherwise default to the `done`/green bucket (mis-reading a 'you must act' state as complete)? And what is the acceptance bar overall — do you want (a) schema unit tests, (b) a grep-invariant that every handoff-writing prompt's status-table includes the new status, and (c) a TUI/web render test?"
- context: "Rendering is fully data-driven by statusBucket(status, schema) in packages/ledger-{tui,web}/src/status.ts (mirrored). For TERMINAL statuses it returns: WARNING.has(s)?'warning' : DROPPED.has(s)?'dropped' : 'done'. The existing terminal handoff statuses (drained/answers-required/mixed/illness-detected) currently fall through to 'done' (green) — EXCEPT none is in WARNING/DROPPED. A new terminal `user-action-required` with no set membership would ALSO render green/done, which is misleading (it signals the user must DO something, not that the run finished clean). The codebase already has a 'warning' bucket (magenta TUI / amber web CSS lw-status-warning) used for `revise`/`inconclusive` — the natural fit for 'needs user attention'. Adding the status to the WARNING set (TUI status.ts L28 + the mirrored web status.ts) makes both frontends render it distinctly with NO other code change (DagView/badges derive from the shared bucket). NOTE: arguably answers-required/illness-detected SHOULD also be 'warning' today and aren't — confirm whether to (i) only add user-action-required to WARNING, or (ii) also reclassify the sibling attention-statuses (larger, possibly out of scope)."
- suggestions: ["Map user-action-required to the existing 'warning' bucket (add it to WARNING in BOTH status.ts files); leave the other four handoff statuses' buckets unchanged (out of scope). Acceptance: (a) HANDOFFS_SCHEMA unit test asserting the new statusValue + terminal + transitions entry; (b) a grep/test invariant that all four prompt status-tables (advance/plan/investigate/implement) contain the new status token; (c) TUI + web render tests asserting user-action-required renders in the warning color/class (not green). `bun run check` green.","Same as 1 but ALSO reclassify answers-required + illness-detected into attention buckets for consistency (broader rendering change — likely a separate concern).","Introduce a NEW dedicated bucket (e.g. 'attention'/'action') distinct from 'warning', with its own TUI ink color + web CSS class, mapped only by user-action-required (more code, clearer semantics)."]
- recommendation: "Suggestion 1: reuse the existing 'warning' bucket (single-line addition to the WARNING set in both mirrored status.ts files — distinct from green 'done', no DagView/badge changes needed), and take all three acceptance gates (schema unit test + prompt-table grep-invariant + TUI/web render test). Reclassifying sibling handoff statuses (suggestion 2) and a brand-new bucket (suggestion 3) are out of scope for this goal unless you want them."
- ledgerRefs: ["goals:G30"]
