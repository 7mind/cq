---
ledger: questions
counters:
  milestone: 0
  item: 166
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

### Q139 — answered

- createdAt: 2026-06-08T00:05:10.088Z
- updatedAt: 2026-06-08T00:07:11.108Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: Is the new status DISTINCT from `answers-required`, or should `answers-required` be generalized to cover user-actions too? And how does the agent CHOOSE between them at end-of-run when BOTH an open question and a user-action blocker are present — does that become a `mixed` stop, and if so does `mixed`'s handoffReasons need to be able to list `user-action-required` as a component?
- context: "Today /cq:advance maps BLOCKED-ON-QUESTIONS→answers-required and ties answers-required/mixed to a non-empty blockingQuestions[] (advance.md L266-268). The goal explicitly wants the new status DISTINCT from answers-required: answers-required = a user REQUIREMENTS/clarification ANSWER (an `open` questions item); user-action-required = a manual/environment ACTION the agent cannot perform itself (no questions item involved). The `mixed` status already composes multiple reasons via handoffReasons[] (HANDOFFS_SCHEMA `handoffReasons: string[]`). If a run lands work AND is blocked partly on an open question AND partly on a user action, the natural classification is `mixed` with handoffReasons listing both components. The four prompt status-tables (advance.md L63-66, plan/advance.md L563-568, investigate/advance.md L355-360, implement/advance.md L422-427) each map an end-of-run classification to a handoff status and would each gain a row for the user-action case."
- suggestions: ["DISTINCT new status; answers-required stays exactly as-is (open-question only). When BOTH an open-question block and a user-action block co-occur with landed work → classify `mixed` and list both as handoffReasons components (e.g. [drained, answers-required, user-action-required]).","Generalize answers-required to mean 'needs user input of any kind' (question OR action) — fewer statuses but loses the question-vs-action distinction the goal asked for (NOT recommended).","DISTINCT new status, and when a user-action block co-occurs with an open question, prefer the NEW status over mixed (treat user-action as the dominant classification)."]
- recommendation: "DISTINCT new status (suggestion 1): keep answers-required strictly question-gated; introduce user-action-required as its own classification; and let `mixed` compose them via handoffReasons (which already exists for exactly this). This preserves the question-vs-action distinction the goal requires and reuses the existing mixed/handoffReasons machinery rather than inventing new composition rules."
- ledgerRefs: ["goals:G30"]
- answer: as recommended

### Q140 — answered

- createdAt: 2026-06-08T00:05:23.450Z
- updatedAt: 2026-06-08T00:07:22.917Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "Does the new status need a STRUCTURED 'required action' field so the user sees exactly what to do (the exact command/action + which item it unblocks), or is the existing free-text `handoffReasons[]` + `summary` + `ledgerRefs` enough? And does `user-action-required` belong ONLY on the handoffs lifecycle, or should an analogous concept also exist on goals/defects (so e.g. D37 itself carries a 'blocked on user action' marker)?"
- context: "HANDOFFS_SCHEMA fields today: summary (required), flow, ledgerRefs, blockingQuestions (ids of blocking questions — the structured carrier for answers-required), handoffReasons (string[]), sessionLogs, tags, sourceRefs. There is NO structured carrier for a user-action the way blockingQuestions structures the question case. Options: (a) reuse handoffReasons free-text; (b) add a new field e.g. `requiredActions: string[]` (each entry = one concrete action the user must take) parallel to blockingQuestions. The motivating D37 already encodes its action in defects.suggestedFix ('Re-run home-manager switch ...') and is an `open` defect — so the action detail can ALSO live on the linked defect via ledgerRefs. SCHEMA-COST NOTE: adding statusValues is a schema change (see the migration question); adding a NEW FIELD is also a schema change and triggers the same on-disk-divergence guard. Keeping to handoffReasons avoids a second schema-shape change. Separately: defects/goals have their own lifecycles — widening them is a much larger blast radius and likely out of scope."
- suggestions: ["No new field: carry the required action in `handoffReasons[]` (one entry per action, e.g. 'user-action-required: run `home-manager switch` to activate the merged extension (unblocks D37)') + `ledgerRefs` to the blocked item + `summary` prose. Handoffs-only; do NOT touch goals/defects lifecycles.","Add a structured `requiredActions: string[]` field to HANDOFFS_SCHEMA (parallel to blockingQuestions) so the user-action is first-class and machine-readable; handoffs-only.","Both a new handoffs field AND an analogous marker on goals/defects (largest scope — likely defer the goals/defects part to a separate goal)."]
- recommendation: Suggestion 1 (reuse handoffReasons, no new field, handoffs-only). The user-action detail is already capturable in handoffReasons + the linked defect's suggestedFix via ledgerRefs; adding a field is a second schema-shape change with its own migration cost for marginal benefit, and widening goals/defects lifecycles is out of scope for this goal. If a structured field is wanted, prefer suggestion 2 over 3 and keep it handoffs-only.
- ledgerRefs: ["goals:G30"]
- answer: as recommended

### Q141 — answered

- createdAt: 2026-06-08T00:05:51.295Z
- updatedAt: 2026-06-08T00:08:04.296Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: How should the schema change interact with the schema-divergence BACKUP-AND-REINIT behavior on existing deployments? Adding a value to HANDOFFS_SCHEMA.statusValues changes the canonical schema, so any ledger whose on-disk handoffs schema predates this change will DIVERGE on the next init() — and the DEFAULT (D2/G4 fix) is backup-and-reinit, which moves the existing handoffs file (all prior HO records) to docs/.backup/<ts>/ and writes a fresh-canonical (empty) handoffs ledger. Is that acceptable for this goal, or must existing handoff records be preserved in-place?
- context: "FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts) compares each on-disk ledger schema to its CANONICAL_LEDGERS schema; on divergence the DEFAULT onSchemaDivergence:'backup-reinit' (T95/T96) backs up the prior ledgers.yaml + the divergent .md file into docs/.backup/<sanitized-ts>/ and re-writes the affected ledger fresh-canonical (emitting one stderr WARNING with the backup path); the 'abort' opt-out preserves the old hard throw. So a deployed repo with existing HO records (e.g. THIS repo, which has HO22 etc.) would, on first run of the new binary, have its handoffs ledger reset and the old records relocated to the backup dir — NOT a silent loss, but the live handoffs ledger starts empty. This is the established/accepted migration mechanism for canonical-schema evolution in this codebase (it is how every prior statusValues addition has rolled out), but the goal should state explicitly whether that default is fine here or whether handoff history must survive in the live ledger."
- suggestions: ["Accept the established backup-and-reinit default: it is the codebase's standard canonical-schema-evolution path (prior records preserved in docs/.backup/<ts>/, live ledger fresh-canonical, one WARNING). No special migration code; just note it in the goal/acceptance and confirm `bun test`'s divergence suite still passes with the new statusValues. The repo's own handoffs ledger will reinit on next run — acceptable since HO records are session-exit logs, not work items.","Require an in-place, NON-destructive migration that ADDS the new statusValues to an existing handoffs ledger WITHOUT reinitializing (preserve all prior HO records in the live ledger). This is NEW behavior beyond the current backup-reinit mechanism and a larger change.","Defer/avoid: keep handoffs schema as-is and model user-action via handoffReasons text only (no new statusValue) — sidesteps migration entirely (but contradicts the goal's scope item (1))."]
- recommendation: Suggestion 1 (accept backup-and-reinit). It is the repo's established, tested mechanism for evolving a canonical schema (additive statusValues have always rolled out this way); records are preserved under docs/.backup/, not lost; and handoff items are immutable session-exit logs, so a fresh live ledger after one reinit is harmless. The only required test work is confirming the divergence suite still passes with the widened statusValues. Avoid building bespoke in-place migration (suggestion 2) unless preserving live HO history is an explicit requirement.
- ledgerRefs: ["goals:G30"]
- answer: "as recommended but: for this particular project - edit schema in place, don't backup and reinit, it's a simple change!"

### Q142 — answered

- createdAt: 2026-06-08T00:06:07.095Z
- updatedAt: 2026-06-08T00:08:17.438Z
- author: user
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- question: "For RENDERING (TUI/web): which semantic BUCKET should `user-action-required` map to, given that as a NEW terminal status it would otherwise default to the `done`/green bucket (mis-reading a 'you must act' state as complete)? And what is the acceptance bar overall — do you want (a) schema unit tests, (b) a grep-invariant that every handoff-writing prompt's status-table includes the new status, and (c) a TUI/web render test?"
- context: "Rendering is fully data-driven by statusBucket(status, schema) in packages/ledger-{tui,web}/src/status.ts (mirrored). For TERMINAL statuses it returns: WARNING.has(s)?'warning' : DROPPED.has(s)?'dropped' : 'done'. The existing terminal handoff statuses (drained/answers-required/mixed/illness-detected) currently fall through to 'done' (green) — EXCEPT none is in WARNING/DROPPED. A new terminal `user-action-required` with no set membership would ALSO render green/done, which is misleading (it signals the user must DO something, not that the run finished clean). The codebase already has a 'warning' bucket (magenta TUI / amber web CSS lw-status-warning) used for `revise`/`inconclusive` — the natural fit for 'needs user attention'. Adding the status to the WARNING set (TUI status.ts L28 + the mirrored web status.ts) makes both frontends render it distinctly with NO other code change (DagView/badges derive from the shared bucket). NOTE: arguably answers-required/illness-detected SHOULD also be 'warning' today and aren't — confirm whether to (i) only add user-action-required to WARNING, or (ii) also reclassify the sibling attention-statuses (larger, possibly out of scope)."
- suggestions: ["Map user-action-required to the existing 'warning' bucket (add it to WARNING in BOTH status.ts files); leave the other four handoff statuses' buckets unchanged (out of scope). Acceptance: (a) HANDOFFS_SCHEMA unit test asserting the new statusValue + terminal + transitions entry; (b) a grep/test invariant that all four prompt status-tables (advance/plan/investigate/implement) contain the new status token; (c) TUI + web render tests asserting user-action-required renders in the warning color/class (not green). `bun run check` green.","Same as 1 but ALSO reclassify answers-required + illness-detected into attention buckets for consistency (broader rendering change — likely a separate concern).","Introduce a NEW dedicated bucket (e.g. 'attention'/'action') distinct from 'warning', with its own TUI ink color + web CSS class, mapped only by user-action-required (more code, clearer semantics)."]
- recommendation: "Suggestion 1: reuse the existing 'warning' bucket (single-line addition to the WARNING set in both mirrored status.ts files — distinct from green 'done', no DagView/badge changes needed), and take all three acceptance gates (schema unit test + prompt-table grep-invariant + TUI/web render test). Reclassifying sibling handoff statuses (suggestion 2) and a brand-new bucket (suggestion 3) are out of scope for this goal unless you want them."
- ledgerRefs: ["goals:G30"]
- answer: as recommended

## M91

### Q143 — answered

- createdAt: 2026-06-08T11:51:20.482Z
- updatedAt: 2026-06-08T16:29:35.201Z
- author: user
- session: $CLAUDE_CODE_SESSION_ID
- question: "All autonomous code work is landed, reviewed, and verified green — the remaining steps require YOUR environment/deploy action (the agent physically cannot perform them, and doing them against the OLD running ledger-mcp would cause data loss/breakage). Please perform, then re-run /cq:advance: (1) run `home-manager switch` to activate the merged pi extension (RESOLVES D37 — the stale ~/.pi/agent/settings.json store path); (2) DEPLOY the new build — rebuild + restart the ledger-mcp so the running server picks up the new @cq/ledger (G32 handoff-enforcement + G30 user-action-required status) and @cq/config (G29 provider-qualified grammar); (3) AFTER the new ledger-mcp is the running build, apply the deploy-coupled LIVE-CONFIG migrations — T246: add `user-action-required` to the live gitignored docs/ledgers.yaml handoffs schema block so init() does NOT backup-reinit (preserving HO records); and T234/T239: migrate the live gitignored cq.toml [aliases]/[tiers] pi tokens to the qualified `pi:<provider>/<model>` form (minimax→pi:ollama-cloud/minimax-m3, codex/grok→pi:grok-build/grok-build) so the new grammar loads without a bare-pi error. (These migrations must NOT run against the old MCP — the schema/grammar divergence would trigger backup-reinit / load errors NOW.) Reply when deployed, or tell me to proceed differently."
- context: "Run state: P-investigate=FALSE (D36/D38/D39 resolved), P-plan=FALSE (G28-G32 planned), P-implement has no autonomously-actionable task (the only non-terminal task T246 is deploy-coupled). Everything autonomous is DONE; the remaining is exclusively user/deploy actions. This is the user-action-required class that G30 (now implemented in code) formalizes — but the running MCP is the old build and cannot express that status yet, so this open question is the legitimate blocking carrier. blocked items: D37 (home-manager switch); tasks T246/T234-live/T239-live (deploy + live-config migration)."
- ledgerRefs: ["defects:D37","tasks:T246","goals:G30","goals:G29"]
- answer: "I've redeployed. "

## M108

### Q145 — answered

- createdAt: 2026-06-08T15:08:07.859Z
- updatedAt: 2026-06-08T16:23:39.654Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: The help dialog with tabs (Keyboard shortcuts / State machines / Flows) lives ONLY in the web frontend (ledger-web/src/App.tsx HelpOverlay). The TUI (ledger-tui/src/app.tsx) has NO help overlay or tab UI at all. Should parts 1+2 (rename the tab, add the Agents tab) be applied to the web frontend ONLY, or must the TUI also gain an equivalent help/Agents view?
- context: "Verified by reading both packages: HelpOverlay, the 'statemachines' tab and the Flows tab (G23/T205) are web-only React/SVG; the TUI is a two-pane ledger browser with key hints in a status bar but no help popup or tabs. Adding a parallel TUI help-popup with diagrams/tabs would be a substantial separate effort (no elk/SVG renderer in the TUI). The goal text says 'cq flow UI' and mentions 'TUI and web frontends' generically."
- suggestions: ["Web frontend only — the help popup is a web feature; leave the TUI unchanged","Both — also build an equivalent help/tab/Agents view in the TUI (significantly larger scope)"]
- recommendation: Web frontend only. The tabbed help dialog has only ever existed in the web UI; scoping parts 1+2 to ledger-web matches the existing design and keeps the change tractable. Part 3 (cq.toml grammar) is shared and applies regardless.
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q146 — answered

- createdAt: 2026-06-08T15:08:15.345Z
- updatedAt: 2026-06-08T16:23:53.101Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: For part 1, the tab is RENAMED from 'State Machines' to 'Item States' — does this rename ALSO change the internal identifiers (the tab-state key 'statemachines', the data-testid values help-tab-statemachines / help-statemachines, and the per-diagram help-statemachine-<ledger> ids / CSS classes lw-statemachine*), or ONLY the human-visible button label text?
- context: In ledger-web/src/App.tsx the tab is keyed by a string union ('shortcuts' | 'statemachines' | 'flows') and exposes data-testid=help-tab-statemachines / help-statemachines plus per-ledger help-statemachine-<ledger> ids that the happy-dom tests assert against. Renaming only the label is one-line; renaming the identifiers too churns tests and the diagram id scheme. The diagrams themselves still depict per-ledger STATUS state machines, so 'Item States' is purely a label change in meaning.
- suggestions: ["Change only the visible label ('Item States'); keep all internal ids/testids/CSS as 'statemachines'","Rename label AND internal ids/testids/CSS to an item-states scheme (more churn, updates tests)"]
- recommendation: Change only the visible label; keep the internal 'statemachines' identifiers and testids stable to avoid unnecessary test churn.
- ledgerRefs: ["goals:G34"]
- answer: Rename label AND internal ids/testids/CSS to an item-states scheme (more churn, updates tests)

### Q147 — answered

- createdAt: 2026-06-08T15:08:29.449Z
- updatedAt: 2026-06-08T16:25:13.742Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "For the new Agents tab (part 2): what is the AUTHORITATIVE SOURCE of the per-agent data (inputs, outputs, I/O schemas, prompt template, model classes)? The agent/command behaviour today lives ONLY as prose markdown under nix/pkg/cq-assets/ (agents/*.md, commands/cq/*.md) — there is no typed/structured catalogue of agents anywhere in the codebase. Should we (a) hand-author a static typed catalogue in ledger-web (mirroring how the Flows tab's FLOWS data was hand-authored in T204), or (b) extract/generate it from the cq-assets prompt files at build time, or (c) load it at runtime from a new MCP endpoint?"
- context: "The Flows tab precedent (T204) is a hand-authored static FlowDefinition[] in the web bundle. There is no existing typed agent registry; prompt templates are the raw .md asset bodies (large). 'prompt template (folded by default)' implies embedding each agent's prompt text. Option (a) is self-contained and matches precedent but the data is manually kept in sync; (b)/(c) avoid drift but add a build step or server surface."
- suggestions: ["(a) Hand-author a static typed agent catalogue in ledger-web (mirrors the Flows/FLOWS precedent); prompt templates embedded as text constants","(b) Generate the catalogue from cq-assets prompt files at build time (Bun.build / a codegen script) so it stays in sync","(c) Add a new MCP endpoint that serves the agent catalogue at runtime"]
- recommendation: (a) Hand-author a static typed catalogue in ledger-web, mirroring the Flows tab. It is self-contained, testable under happy-dom, and consistent with how flow data was modeled. Drift risk is acceptable for a help/reference view; revisit codegen later if needed.
- ledgerRefs: ["goals:G34"]
- answer: (b) Generate the catalogue from cq-assets prompt files at build time (Bun.build / a codegen script) so it stays in sync

### Q148 — answered

- createdAt: 2026-06-08T15:08:39.559Z
- updatedAt: 2026-06-08T16:26:25.451Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Exactly WHICH agentic roles should the Agents tab enumerate? Candidate set, derived from cq-assets: the four flow orchestrators (cq:plan / cq:investigate / cq:implement loops + the top-level cq:advance sequencer), the plan-advance PLANNER (incl. its candidate-mode variant), the plan-REVIEWER, the implement-REVIEWER, the investigate explorer/adjudicator, and any synthesis judge. Should the tab list all of these, only the user-configurable ones (planners + reviewers, which map to cq.toml aliases), or a specific subset you have in mind?"
- context: "The goal names 'orchestrator/reviewer' as examples ('e.g.'). The roles differ in nature: orchestrators are command loops (no model alias of their own per-se), whereas planners/reviewers are the model-backed roles configured via cq.toml [aliases]+planners/reviewers and resolved through get_planners/get_reviewers. 'configured model classes + per-harness mappings' only makes sense for the model-backed roles. The exact roster determines how many catalogue entries to author."
- suggestions: ["All roles: 4 orchestrators + planner (+candidate mode) + plan-reviewer + implement-reviewer + investigator + synthesis judge","Only the model-backed configurable roles (planners + reviewers) that have cq.toml model/harness mappings","A subset — please name the exact roles to include"]
- recommendation: Enumerate all distinct roles (orchestrators + planner + both reviewers + investigator + judge), but only populate the 'model classes / per-harness mappings' fields for the model-backed roles; orchestrators show their I/O + prompt-template fields with model fields marked N/A. This gives the most complete reference. Please confirm or trim the roster.
- ledgerRefs: ["goals:G34"]
- answer: All the existing roles. Where the model is not configurable - we show "default" or "N/A" or smth alike.

### Q149 — answered

- createdAt: 2026-06-08T15:08:57.978Z
- updatedAt: 2026-06-08T16:28:32.354Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Part 3 inverts [tiers] from class->model to (harness+provider+model)->class. Today the dispatch chain is agent -> tier (via [agent_tiers]) -> a CONCRETE model token (via [tiers], one model per class), used by resolveTierToken/resolveAgentModel to pick WHICH model to run for a given suggestedModel tier. If [tiers] becomes triplet->class, that 'tier -> concrete model' lookup no longer exists. How should a suggestedModel tier (frontier/standard/fast) resolve to a concrete model to dispatch AFTER the inversion?"
- context: "cq-config/src/config.ts resolveAgentModel = resolveAgentTier (agent_tiers) then resolveTierToken (tiers[tier] -> ReviewerToken). The inverse map answers 'what class is THIS model?' but not 'which model do I run for class X?' — those are not the same function unless every class maps 1:1 to a model. Either (a) dispatch stops selecting a model from a tier (the planners/reviewers lists already name concrete tokens, and the triplet->class map is used only to LABEL/validate a token's tier, e.g. for the Agents tab and for choosing among already-listed candidates), or (b) we keep BOTH directions (a class still needs a default concrete model). This determines whether resolveTierToken/resolveAgentModel survive, change signature, or are removed, and is the core of part 3."
- suggestions: ["(a) Inversion only: [tiers] becomes a triplet->class lookup used to ANNOTATE/validate the tier of concrete tokens already listed in planners/reviewers; remove the tier->single-model dispatch (no agent auto-picks a model purely from its tier)","(b) Keep both directions: triplet->class for labeling PLUS a separate way to pick a concrete model per class for dispatch (e.g. first listed token of that class)","(c) Something else — describe the intended end-to-end resolution"]
- recommendation: "(a) Treat the new triplet->class map as a CLASSIFIER: it tells cq what tier any concrete (harness,provider,model) belongs to, so the Agents tab and dispatch can label/group already-configured tokens by class. Dispatch continues to use the explicitly-listed planner/reviewer tokens; a suggestedModel tier selects among the configured tokens whose class matches that tier (documented tie-break if several). This makes the mapping 'make actual sense' as the goal asks, without inventing a hidden default model per class. Please confirm the intended resolution direction."
- ledgerRefs: ["goals:G34"]
- answer: "as recommended. for completeness we can include claude mapping into the tiers config too (which is trivial, e.g. claude:haiku -> fast)"

### Q150 — answered

- createdAt: 2026-06-08T15:09:09.475Z
- updatedAt: 2026-06-08T16:28:53.656Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "What concrete cq.toml TOML SURFACE SYNTAX do you want for the new triplet->class [tiers] table, and is a BREAKING change (no migration of old class->model [tiers]) acceptable? Today [tiers] is e.g. `frontier = \"opus\"`. A triplet->class form could be e.g. `[tiers]` with entries keyed by the existing token grammar: `\"claude:opus-4.8[1m]\" = \"frontier\"` and `\"pi:ollama-cloud/minimax-m3\" = \"standard\"` (reusing parseReviewerToken's harness:provider/model token as the key), value = the tier class."
- context: "G29/T237 just made a BREAKING token-grammar change (pi:<provider>/<model>, claude:<model>); reusing that exact token form as the [tiers] KEY keeps one grammar. Project policy (CLAUDE.md) is 'no backwards compatibility in internal code', and current live cq.toml has tiers=null (no [tiers] table in use), so a breaking redefinition costs little. But the precise key spelling (full token string vs a [tiers.<harness>] sub-table vs an array of {harness,provider,model,class}) is a user-facing config decision I should not pick silently."
- suggestions: ["Token-keyed inline table: `\"claude:opus-4.8[1m]\" = \"frontier\"` (key = the existing harness:provider/model token grammar; value = class). Breaking; no migration.","Array-of-tables: `[[tiers]]` entries each with explicit harness/provider/model/class fields","Nested sub-tables per harness/provider, e.g. [tiers.claude] / [tiers.pi.<provider>]","Keep the old [tiers] working too (non-breaking; support both shapes)"]
- recommendation: "Token-keyed inline table reusing the existing parseReviewerToken grammar as the KEY (`\"<token>\" = \"<class>\"`), as a BREAKING replacement (no dual-shape support), since live config has no [tiers] today and project policy avoids internal backward-compat. Please confirm the syntax and that breaking is acceptable."
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q151 — answered

- createdAt: 2026-06-08T17:27:50.953Z
- updatedAt: 2026-06-08T17:32:34.463Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up field PRIVILEGE CLASS (RO/RW): should it be DERIVED mechanically from the agent's existing frontmatter, or AUTHORED explicitly into the `## Catalogue` block? For the seven subagents, the frontmatter is a DENY-list (`disallowedTools`) — a role is RW iff it can still mutate (i.e. none of Write/Edit/MultiEdit/NotebookEdit/Bash is in `disallowedTools`), otherwise RO. By that rule: RW = implement-worker, implement-conflict-resolver, investigate-prober (these disallow only `Agent`, often + `isolation: worktree`); RO = plan-advance, plan-reviewer, implement-reviewer, investigate-explorer (these disallow the mutating tools). I can derive it deterministically in codegen from disallowedTools (and the parser already extracts that field per T275), which keeps it drift-free and freshness-guarded (T277). The alternative is to author `privilege: RO|RW` into each `## Catalogue` block explicitly."
- context: "G34's locked plan (T275/T281/T276/T277) already establishes: agent frontmatter keys are name/description/disallowedTools/isolation (NOT a positive `tools` allow-list), parsed by parseAgentMarkdown; the `## Catalogue` yaml block (inputs/outputs/ioSchema) is the authored source of truth. Privilege class maps cleanly onto the deny-list: mutating-tool present in disallowedTools => RO. Deriving it reuses already-parsed data and is guarded by the freshness test; authoring it adds a per-file field but lets a role declare a privilege that differs from its raw tool set. The two are mutually exclusive design choices for this new field."
- suggestions: ["DERIVE: codegen computes RO/RW from disallowedTools (RW iff no mutating tool — Write/Edit/MultiEdit/NotebookEdit/Bash — is disallowed); no new authored field, freshness-guarded","AUTHOR: add an explicit `privilege: RO|RW` key to each `## Catalogue` block; codegen parses it verbatim","HYBRID: derive by default, but allow an optional `## Catalogue` `privilege:` override when a role's effective privilege differs from its raw toolset"]
- recommendation: DERIVE from disallowedTools (option 1). It is deterministic, reuses the field T275 already parses, stays automatically in sync with the assets, and is genuinely guarded by the T277 freshness test — matching the Q147 'generate, don't hand-curate' decision. Authoring invites the drift codegen was chosen to avoid.
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q152 — answered

- createdAt: 2026-06-08T17:28:06.541Z
- updatedAt: 2026-06-08T17:32:53.628Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up field EXPOSED TOOLS: what exactly does the card show, given the two asset kinds encode tools OPPOSITELY? Subagent files carry a DENY-list (`disallowedTools`, e.g. `Write, Edit, MultiEdit, NotebookEdit, Bash, Agent`) — there is NO positive allow-list, so a subagent's exposed toolset is 'everything the host grants MINUS disallowedTools', which we cannot enumerate without knowing the host's full tool universe. Orchestrator COMMAND files instead carry a positive `allowed-tools` allow-list (e.g. `mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob`), and some commands (implement-review.md, the shared review-rubric prompts) carry NO tools frontmatter at all. So 'exposed tools' means different things per kind. Should the card show: (a) the RAW frontmatter verbatim per kind (subagents: 'disallowed: …'; commands: 'allowed: …'); (b) a NORMALIZED resolved allow-list (requires a defined host tool-universe to subtract the deny-list from); or (c) a curated short summary (e.g. subagents: 'read-only' / 'read+write+exec in worktree'; commands: the allow-list)?"
- context: "Asymmetry confirmed by reading the assets: agents/*.md => disallowedTools (deny) + optional isolation; commands/cq/*.md => allowed-tools (allow) or nothing. T275's parser currently extracts disallowedTools+isolation for agents but does NOT parse command `allowed-tools`. A normalized allow-list (b) is only well-defined if we fix the host tool universe to subtract from — which the assets do not declare. Raw-per-kind (a) is faithful and parseable from what exists (but needs T275 to also parse command allowed-tools). Curated (c) is most readable but reintroduces hand-authoring unless encoded in `## Catalogue`."
- suggestions: ["(a) RAW per-kind: subagents show their `disallowedTools` (+ isolation); commands show their `allowed-tools`; missing => 'none declared'. Requires T275 parser to also read command allowed-tools.","(b) NORMALIZED resolved allow-list: define a canonical host tool universe and show (universe minus disallowedTools) for agents and the literal allow-list for commands","(c) CURATED summary string authored per role (e.g. 'RO: Read/Grep/Glob/WebSearch'); encoded in the `## Catalogue` block so codegen parses it"]
- recommendation: (a) RAW per-kind, labelled by semantics ('Disallowed tools' for subagents incl. isolation; 'Allowed tools' for commands; 'none declared' when absent). It is faithful to the actual assets, fully derivable (extend the T275 parser to also read command `allowed-tools` — a small addition to the existing frontmatter extraction), and freshness-guarded. (b) needs a host tool-universe the assets don't define; (c) reintroduces hand-curation. Please confirm, and confirm extending the parser to command allowed-tools is in scope.
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q153 — answered

- createdAt: 2026-06-08T17:28:20.554Z
- updatedAt: 2026-06-08T17:33:12.796Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "For ORCHESTRATOR roles (the cq:plan/investigate/implement :advance/:start/:follow-up + cq:advance commands) — what privilege class and exposed-tools do we display? These are command loops, not model-backed subagents, and several already show model = default/N-A (Q148). For privilege: a command like cq:plan/cq:investigate has `allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob` (it CAN write + dispatch subagents), so by its own allow-list it is RW; cq:advance allows `mcp__ledger__*, Read, Grep, Glob, Bash`; the planners/reviewers override commands allow only specific read-only MCP calls + Read (effectively RO). Should an orchestrator's privilege be derived from its own `allowed-tools` (RW iff it lists Write/Bash/Edit), shown as a fixed label (e.g. 'orchestrator'), or shown as the UNION of the privileges of the subagents it dispatches? And for 'exposed tools', is it the command's own `allowed-tools` list, or 'N/A' like the model field?"
- context: Q148 already settled that non-configurable roles show model = default/N-A. The follow-up adds privilege + tools, which DO have a concrete source for commands (the `allowed-tools` allow-list) — unlike model. So unlike the model field, privilege/tools need NOT be N/A for orchestrators; they can be derived from allowed-tools. But orchestrators are a different conceptual unit (they dispatch RO/RW subagents), so a 'union of dispatched privileges' or a flat 'orchestrator' label is also defensible. This determines whether the privilege/tools columns are populated uniformly across both kinds or only for subagents.
- suggestions: ["Derive orchestrator privilege from its OWN `allowed-tools` (RW iff it lists a mutating tool: Write/Edit/Bash); exposed tools = its `allowed-tools` list","Show orchestrators with a fixed privilege label 'orchestrator' (neither RO nor RW) and exposed tools = 'N/A' (consistent with the model=N/A treatment)","Show orchestrator privilege as the UNION of the RO/RW of the subagents it dispatches; exposed tools = its allowed-tools"]
- recommendation: "Derive from the command's own `allowed-tools` (option 1): RW iff its allow-list contains a mutating tool (Write/Edit/Bash), else RO; exposed tools = the literal allowed-tools entries (or 'none declared' for the rubric prompt files that have no frontmatter). This keeps a single uniform, derivable, freshness-guarded rule across both kinds, and is more informative than a flat 'N/A'. Please confirm (or pick the 'orchestrator' label if you prefer the two kinds visibly distinct)."
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q154 — answered

- createdAt: 2026-06-08T21:36:43.532Z
- updatedAt: 2026-06-08T23:41:05.858Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up #2 — server CAPABILITY shape: should the live model resolution be a NEW dedicated MCP tool `get_agent_models` (server resolves each agent's class + per-harness token mappings and returns the finished overlay table), OR an EXTENSION of the existing `get_config` to expose the raw inputs the client needs to resolve itself — i.e. agent_tiers + the full inverted [tiers] classifier entries + the alias-resolved planners/reviewers tokens?"
- context: "Grounded in packages/ledger-mcp/src/configCapability.ts: today get_config (computeConfig/projectConfig) returns { configured, aliases, reviewers(alias names), planners(alias names), tiers, agentTiers }. CRITICAL: the `tiers` field is a T268 MINIMAL BRIDGE — it collapses the inverted classifier into the OLD per-slot {fast,standard,frontier} shape by picking the FIRST token of each class, so it does NOT carry the full classifier `entries` (token->class) the client would need for classifyToken, and it gives no alias-resolved planner/reviewer TOKENS (only alias-name lists). So get_config AS-IS cannot reproduce the build-time derivation client-side. The build-time logic (gen-agents-catalogue.ts deriveModelClass=resolveAgentTier, deriveModelMappings=classifyToken over union(planners∪reviewers) grouped by harness) is exactly what must move to runtime. A dedicated get_agent_models would keep ALL resolution (resolveAgentTier/classifyToken/selectTokensForTier) server-side (where @cq/config already lives) and ship the finished {id->{class, mappings}} table; extending get_config keeps one tool but moves resolution INTO ledger-web (a pure MCP client that would then import @cq/config resolvers in the browser bundle)."
- suggestions: ["(a) NEW dedicated `get_agent_models` tool: server resolves per-agent class + per-harness mappings (reusing resolveAgentTier/classifyToken/selectTokensForTier against the LIVE cq.toml) and returns the finished overlay table keyed by agent id; ledger-web does no resolution","(b) EXTEND `get_config`: rework the `tiers` wire field to carry the full classifier entries (token->class) AND add alias-resolved planner/reviewer token lists, so ledger-web reproduces deriveModelClass/deriveModelMappings client-side","(c) something else — describe the intended capability + responsibility split"]
- recommendation: "(a) A dedicated get_agent_models. The server already OWNS the live config + every resolver (resolveAgentTier/classifyToken/selectTokensForTier); returning the finished {agent id -> {class, perHarnessMappings}} table keeps that logic server-side (one place, tested in @cq/config), avoids pulling @cq/config resolution into the browser bundle, and gives ledger-web a trivial mount-time overlay. It also leaves get_config's existing T268 bridge wire shape untouched (no risk to get_planners/get_reviewers consumers). The agent-id roster the tool resolves is question (e)."
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q155 — answered

- createdAt: 2026-06-08T21:36:55.810Z
- updatedAt: 2026-06-08T23:41:07.580Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up #2 — FALLBACK when the runtime overlay is unavailable: when the server/capability cannot supply live model data (older server without the new tool, fetch error, or get_agent_models throws), should ledger-web (1) KEEP the build-time-generated model/modelMappings fields as a static fallback and render those, or (2) DROP the build-time model fields entirely (gen-agents stops emitting model/modelMappings) and render 'default / not configured' until the live fetch resolves?"
- context: The goal text says 'KEEP the static fields (kind/description/inputs/outputs/ioSchema/prompt-template/privilege/exposedTools) build-time-generated... ONLY model class + mappings move to runtime' and 'the freshness test then only guards the static fields'. That phrasing implies the build-time catalogue STOPS carrying model/modelMappings (so they can't go stale and the T277 freshness test no longer guards them). But it does not explicitly state the no-server fallback. Today AgentRole.model/modelMappings are required fields baked into agentsCatalogue.gen.ts from cq.toml.example. Dropping them means the AgentRole type changes (model/modelMappings become runtime-only / optional) and gen-agents-catalogue.ts deletes deriveModelClass/deriveModelMappings + the cq.toml.example read; keeping them as fallback means the example-vs-live divergence the follow-up wants to eliminate still shows when offline.
- suggestions: ["DROP the build-time model fields: gen-agents stops emitting model/modelMappings (remove deriveModelClass/deriveModelMappings + the cq.toml.example read); AgentRole carries no static model data; when the live overlay is unavailable the tab shows 'default / not configured'. Matches the goal's 'freshness test only guards the static fields'.","KEEP a static fallback: gen-agents still emits model/modelMappings from cq.toml.example; the live overlay replaces them when present, else the build-time values render (offline-resilient, but reintroduces the example-vs-live divergence when the server is unavailable)"]
- recommendation: DROP the build-time model fields. It is what the goal text directs ('ONLY model class + mappings move to runtime'; 'freshness test then only guards the static fields'), and it actually ELIMINATES the example-vs-live divergence + staleness the follow-up targets — a static fallback would silently re-expose exactly the dead/example tokens the follow-up exists to remove. When the overlay is unavailable the cards show 'default / not configured', which is honest. Please confirm the AgentRole type + gen-agents may drop model/modelMappings.
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q156 — answered

- createdAt: 2026-06-08T21:37:15.604Z
- updatedAt: 2026-06-08T23:41:08.295Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up #2 — the CANDIDATE TOKEN SET for the per-harness mappings: which live-config tokens should the runtime resolution classify-and-group to populate a role's per-harness mappings? Today the build-time code uses the UNION of the config's resolved `planners` + `reviewers` alias lists (deriveModelMappings in gen-agents-catalogue.ts). Should the runtime keep exactly that union(planners∪reviewers), or use a different candidate set — e.g. ALL [aliases] entries, or only the role-relevant set (planners for the planner role, reviewers for the reviewer roles)?"
- context: "deriveModelMappings(config, modelClass) currently builds candidates = union of resolvePlanners + resolveReviewers (alias-resolved tokens), classifies each via classifyToken, keeps those matching the role's class, then groups by harness and de-dups+sorts. That answers 'which configured tokens of this class exist, per harness' but is the SAME set for every role of a given class (it's keyed only on class, not on whether the role is a planner vs reviewer vs worker). Using ALL [aliases] would show classified-but-unused tokens (incl. dead ones like grok-build) — the follow-up explicitly wants dead/unclassified tokens to show as 'not configured', so feeding ALL aliases risks re-advertising tokens that aren't actually in the active planner/reviewer set. A role-relevant split (planner role <- planners only; reviewer roles <- reviewers only) is more precise per-card but the worker/orchestrator roles have no natural list. Keeping the union matches the current behavior and the Q149 'classifier' model (selectTokensForTier over the active set)."
- suggestions: ["UNION of resolved planners + reviewers (unchanged from build-time): one candidate set = the active dispatch tokens; classify by the role's class, group by harness. Same set across roles of equal class.","ALL [aliases] entries: classify every declared alias regardless of whether it's an active planner/reviewer (broadest; risks showing dead/unused tokens the follow-up wants hidden)","ROLE-RELEVANT split: the planner role draws candidates from `planners`, the reviewer roles from `reviewers`; worker/orchestrator roles fall back to the union (or 'default')"]
- recommendation: UNION of resolved planners + reviewers — keep exactly the current build-time candidate set, just sourced from the LIVE cq.toml at runtime. It mirrors the Q149 classifier model (the active dispatch set is authoritative), it is the minimal behavioral change (only the config SOURCE moves example->live), and — because it draws ONLY from the active planners/reviewers — a declared-but-inactive or dead alias (e.g. grok-build) naturally falls out unless it is actually an active planner/reviewer, satisfying the 'dead token shows unclassified' aim. Please confirm, or pick a role-relevant split if you want per-card precision.
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q157 — answered

- createdAt: 2026-06-08T21:37:31.025Z
- updatedAt: 2026-06-08T23:41:10.256Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up #2 — UNCONFIGURED / embedded-mode rendering: in embedded web mode (the server is co-hosted in ledger-web's own process per main.ts attachMcpHttp, reading the live gitignored cq.toml) what should the tab show across these distinct states: (1) NO cq.toml present (configured:false); (2) cq.toml present but a role's [agent_tiers] tier has NO live token of that class in the active set; (3) a role that is not model-configurable at all (every orchestrator command, model='N/A' today)? Should all of (1)/(2) render the SAME 'default / not configured' string, or should they be visibly distinguished (e.g. 'not configured' for no-cq.toml vs 'no live token for tier X' for a configured-but-empty tier)?"
- context: "configCapability.computeConfig returns configured:false with empty tiers/agentTiers when loadConfig returns null (no cq.toml). The follow-up text wants 'default / not configured' when unconfigured OR when a tier has no live token (so a dead token like grok-build shows as unclassified rather than a confident mapping). Embedded web is the default deploy: serve.ts co-hosts the MCP server over the same live root, so the capability reads the user's real cq.toml. The three states above are semantically different (no config at all / configured-but-this-tier-empty / role-not-model-configurable) and the cards already show model='N/A' for orchestrators per Q148. Whether to collapse states 1+2 into one label or distinguish them is a UX decision affecting the capability's return shape (does it need to report WHY a mapping is empty?) and the AgentRole/overlay typing."
- suggestions: ["COLLAPSE: states (1) and (2) both render 'default / not configured'; state (3) keeps the existing 'N/A' (not model-configurable). Capability need only return class-or-null + mappings-or-empty.","DISTINGUISH: (1) -> 'not configured (no cq.toml)', (2) -> 'no live token for <tier>', (3) -> 'N/A'. Capability returns a reason/enum so the UI can label precisely.","Some other split — describe the exact labels per state"]
- recommendation: COLLAPSE (1)+(2) into 'default / not configured', keep (3) as the existing 'N/A' for non-model-configurable roles (consistent with Q148). From the user's standpoint 'no cq.toml' and 'configured but this tier has no live token' both mean 'cq will fall back to the host default for this role' — the same operational truth — so one honest label suffices and keeps the capability's return shape minimal (class-or-null + per-harness mappings, empty when none). If you'd rather see WHY a mapping is empty, pick DISTINGUISH and the capability will carry a reason. Confirm the label set.
- ledgerRefs: ["goals:G34"]
- answer: "DISTINGUISH: (1) -> 'not configured (no cq.toml)', (2) -> 'no live token for <tier>', (3) -> 'N/A'. Capability returns a reason/enum so the UI can label precisely."

### Q158 — answered

- createdAt: 2026-06-08T21:37:48.675Z
- updatedAt: 2026-06-08T23:41:11.030Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up #2 — WHO owns the agent-id roster the live capability resolves? The overlay must join live model data onto the static catalogue by agent id. Should the server-side capability resolve a roster it derives ITSELF (e.g. the [agent_tiers] keys present in the live cq.toml, plus 'N/A' for everything else), OR should it resolve exactly the codegen's fixed 19-role roster (the ROLES table in gen-agents-catalogue.ts, of which only the 7 subagents carry an agentTierKey)? And how does the overlay key the join — by the AgentRole.id (asset basename, e.g. 'implement-worker') which is ALSO the [agent_tiers] key for subagents?"
- context: "gen-agents-catalogue.ts ROLES is the canonical 19-role roster (7 agents/*.md subagents with agentTierKey = their name, + 12 commands/cq/*.md with agentTierKey=null). resolveAgentTier looks up [agent_tiers][agentName]. AgentRole.id for subagents equals the asset basename which equals the [agent_tiers] key (e.g. 'implement-worker', 'plan-reviewer'); orchestrator ids are command paths ('plan/advance') with no tier key. If the server derives the roster from live [agent_tiers] keys alone, it could surface a tier key the static catalogue has no card for (or miss a role), so the join must be anchored to the STATIC roster (the source of cards). The capability most likely should accept/emit results keyed by the SAME 19 ids the catalogue uses, marking the 12 commands 'N/A', so the overlay is a clean id->data join with no orphans."
- suggestions: ["Capability resolves the codegen's fixed 19-role roster (subagent ids = [agent_tiers] keys; commands -> N/A) and returns data keyed by those exact ids; the overlay joins by AgentRole.id with no orphans","Capability derives its own roster from live [agent_tiers] keys; the overlay joins what it can and shows 'default/not configured' for static cards with no match (risk: server roster and static roster drift)","Other — describe how the roster + join key are owned"]
- recommendation: "Resolve the codegen's fixed 19-role roster, keyed by AgentRole.id — the subagent id IS its [agent_tiers] key, so the server resolves class+mappings for those 7 and returns 'N/A'/empty for the 12 commands; the overlay is then a total, orphan-free join by id. The static catalogue is the authoritative card list (it owns inputs/outputs/ioSchema/privilege/tools), so the live data must conform to ITS ids, not the reverse. This also means adding/removing a role is still a single edit to the codegen ROLES table. Please confirm the roster is owned by the static catalogue and the join key is AgentRole.id."
- ledgerRefs: ["goals:G34"]
- answer: as recommended

### Q159 — answered

- createdAt: 2026-06-08T21:38:03.153Z
- updatedAt: 2026-06-08T23:41:11.864Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Follow-up #2 — ACCEPTANCE / TEST bar for the runtime overlay. The existing Agents-tab test (test/agentsTab.test.tsx) is explicitly STATIC-DATA-ONLY ('no async MCP fetch is needed') and asserts the build-time model text via `role.model`. Moving model+mappings to runtime breaks that contract: the test must drive an async overlay. What is the required test bar: (1) extend the FakeClient (test/fakeClient) with the new capability returning a synthetic LIVE-config table and assert the tab OVERLAYS those live values onto the static cards (the configured case); (2) ALSO assert the unconfigured/no-overlay case renders 'default / not configured'; and is a server-side @cq/config / capability unit test for the resolution (live cq.toml -> per-agent class+mappings) ALSO required, or is the happy-dom overlay test plus existing @cq/config resolver tests sufficient?"
- context: The web client LedgerClient interface (src/types.ts) currently has NO config/planner/reviewer method, so a new method (e.g. getAgentModels) must be added to the interface AND the test FakeClient must implement it — otherwise the existing suite won't typecheck. agentsTab.test.tsx asserts text.toContain(role.model) for implement-worker; once model is runtime, that assertion must come from the fake's returned overlay, not role.model. Server-side, configCapability.ts + @cq/config already have resolver tests; the NEW resolution (per-agent class+mappings over live config) needs its own coverage if a new computeAgentModels is added. The T277 freshness test must also be updated to NO LONGER guard model/modelMappings (they leave the gen file).
- suggestions: ["happy-dom overlay test (FakeClient returns a synthetic live table; assert configured-overlay AND unconfigured 'default/not configured') + a server-side unit test for the new resolution (live config -> per-agent class+mappings) + update T277 freshness to drop model/modelMappings","happy-dom overlay test only (configured + unconfigured), relying on existing @cq/config resolver tests for the resolution logic; update T277 freshness","Other — name the exact required tests"]
- recommendation: "The first option (full bar): a happy-dom test that drives the new client method via an extended FakeClient and asserts BOTH the configured overlay (live values replace the static cards) AND the unconfigured 'default / not configured' path, PLUS a focused server-side unit test for the new resolution (a fixture live cq.toml -> expected per-agent class + per-harness mappings), PLUS updating the T277 freshness test to stop guarding model/modelMappings (since they leave the generated file). This keeps the operational 'shows ACTUAL configured models' claim genuinely tested at both the server (resolution) and client (overlay) boundaries. Please confirm this is the intended test bar."
- ledgerRefs: ["goals:G34"]
- answer: as recommended

## M115

### Q160 — answered

- createdAt: 2026-06-08T21:41:24.198Z
- updatedAt: 2026-06-08T23:41:21.471Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Effort-suffix syntax and separator: what exact delimiter introduces the optional trailing effort, and does it apply to BOTH pi and claude tokens?"
- context: "parseReviewerToken (packages/cq-config/src/config.ts:62) splits on the FIRST ':' (harness | modelSegment), then on the FIRST '/' (provider | model for pi). Its doc explicitly says 'Further colons in the model segment (after the first \":\") are preserved' — so the model currently absorbs everything after the harness colon verbatim (e.g. claude:opus-4.8[1m] -> model='opus-4.8[1m]'). There is no reserved second colon today. A trailing ':<effort>' is therefore ambiguous: should the effort be the segment after the LAST ':' (so 'pi:grok-build/grok-build:xhigh' -> effort='xhigh', but a model that itself contained a colon would mis-split), or after a different/dedicated delimiter? Current model names I can see use '[1m]' brackets but no colons. I need the rule pinned to keep parsing unambiguous and round-trippable (formatReviewerToken at config.ts:390 must reproduce the input)."
- suggestions: ["Trailing ':<effort>' parsed off the END (last colon): pi:<provider>/<model>:<effort>, claude:<model>:<effort> — applies to BOTH harnesses; document that ':' is now reserved and may not appear in a model name","Dedicated non-colon delimiter to avoid any collision, e.g. '@' (claude:opus-4.8[1m]@high, pi:prov/model@high) or '#'","pi-only effort suffix (claude effort handled differently or out of scope), since pi has an explicit reasoning-effort flag"]
- recommendation: "Trailing ':<effort>' parsed off the LAST colon, applied to BOTH pi and claude tokens (matches the goal's examples pi:grok-build/grok-build:xhigh and claude:<model>:<effort>); reserve ':' so a model name may not contain one, and have formatReviewerToken re-append ':<effort>' when present."
- ledgerRefs: ["goals:G36"]
- answer: as recommended

### Q161 — answered

- createdAt: 2026-06-08T21:41:33.616Z
- updatedAt: 2026-06-08T23:41:21.570Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Allowed effort VALUE set: a fixed validated enum, or an opaque per-harness pass-through string?"
- context: The new optional ReviewerToken.effort field can either be validated at parse time against a closed vocabulary (like isHarness/isTier do today in types.ts) — failing fast on cq.toml load with a precise CqConfigError — or be carried verbatim as an opaque string and handed to the harness, letting the harness reject unknown values at invocation time. Different harnesses/providers expose different effort vocabularies (e.g. an xhigh/high/medium/low/minimal-style ladder vs provider-specific names vs a numeric thinking budget), so a single fixed enum may not fit all providers. This decision determines whether @cq/config needs an isEffort() guard + a canonical TIERS-like constant, and whether the pi-extension's lenient inlined parser must mirror it.
- suggestions: ["Fixed validated enum (e.g. minimal | low | medium | high | xhigh) — fail fast at config load, mirrored by an isEffort() guard in types.ts","Opaque pass-through string per harness — no validation in @cq/config; the harness validates at invocation","Hybrid: validate non-empty + a charset, but treat the value space as open/per-harness"]
- recommendation: Opaque pass-through string (validate only non-empty + a safe charset). Effort vocabularies are provider-specific and evolve faster than cq.toml; let each harness's invocation map/reject it (see the harness-mapping question), keeping @cq/config a pure carrier.
- ledgerRefs: ["goals:G36"]
- answer: we should have fixed validated per-harness enums

### Q162 — answered

- createdAt: 2026-06-08T21:41:43.493Z
- updatedAt: 2026-06-08T23:41:21.613Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Does effort participate in token IDENTITY/equality — i.e. is claude:opus:high a DIFFERENT token from claude:opus:low for reviewerTokensEqual, the D42 dup-token guard, and the [tiers] classifier?"
- context: "reviewerTokensEqual (config.ts:297) compares harness+model+provider only. It is consumed by: (a) parseTiers' D42 duplicate-token guard (config.ts:181) which fails loud if two [tiers] keys resolve to the same token; and (b) classifyToken (config.ts:316) which looks a candidate token up in the [tiers] classifier by structural equality. If effort is part of identity, then claude:opus:high and claude:opus:low are two distinct tokens — they could be classified into different tiers and would NOT trip the D42 dup guard. If effort is NOT part of identity, the two collapse to one token (effort becomes a non-identifying annotation): they'd trip D42 if both appear in [tiers], and classifyToken would match regardless of effort. This choice changes test expectations and the [tiers] semantics."
- suggestions: ["Effort IS identifying: include it in reviewerTokensEqual so claude:opus:high != claude:opus:low (distinct classification, no D42 collision between them)","Effort is NOT identifying: exclude it from reviewerTokensEqual (effort is a pure annotation; the two collapse, D42 fires if both keyed, classify ignores effort)","Effort identifying for equality/dedup but classifyToken matches effort-agnostically (asymmetric — likely confusing, listed for completeness)"]
- recommendation: "Effort IS part of token identity (include it in reviewerTokensEqual). This lets a config legitimately classify claude:opus:high as frontier and claude:opus:low as standard, which is the natural use of effort tiers; D42 still protects against literal duplicates of the SAME effort."
- ledgerRefs: ["goals:G36"]
- answer: as recommended

### Q163 — answered

- createdAt: 2026-06-08T21:41:54.840Z
- updatedAt: 2026-06-08T23:41:22.452Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: How does effort map to each harness's ACTUAL invocation flag, and what happens when a provider/model does not support the requested effort — error or silently ignore?
- context: "In nix/pkg/pi-extensions/cq-subagent-dispatch.ts, tokenToChildModel (line 327) maps a pi token to child '--provider'/'--model' args; effort would need to emit an ADDITIONAL pi flag (the reasoning/thinking-effort flag — exact flag name to confirm). The claude path there returns null and falls back to the PARENT model (a child pi process cannot drive claude), so a claude:<model>:<effort> token never reaches a pi invocation — where (if anywhere) does claude effort get applied (the parent Claude session's thinking budget?) or is claude effort simply recorded-but-inert in the pi-extension and only meaningful in a native-Claude dispatch path? Also: if a provider/model rejects or doesn't recognize the effort value, should cq fail the dispatch loudly or drop the effort and proceed at default?"
- suggestions: ["pi: emit the pi reasoning-effort CLI flag (confirm exact flag); claude effort applies only on the native-Claude dispatch path (not the pi-extension, which falls back to parent) — pi-extension records it inertly","On unsupported effort: fail fast (loud error) — consistent with the repo's fail-fast principle","On unsupported effort: drop effort + proceed at provider default (graceful), since effort is an optional hint","Need the exact pi flag name and the claude thinking/effort knob confirmed before deciding"]
- recommendation: "pi: pass effort through to the pi reasoning-effort flag (confirm the precise flag name during implementation); claude effort is meaningful only where a native Claude invocation is constructed (the pi-extension keeps falling back to the parent model and records effort inertly). For an unsupported value: fail fast at the harness boundary rather than silently downgrading, matching repo fail-fast policy — but confirm, since 'optional hint' arguably favors graceful ignore."
- ledgerRefs: ["goals:G36"]
- answer: as recommended

### Q164 — answered

- createdAt: 2026-06-08T21:42:05.144Z
- updatedAt: 2026-06-08T23:41:23.388Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Should the MCP wire shapes (get_planners / get_reviewers / get_config) carry the effort, and where may an effort suffix legally APPEAR in cq.toml — only in [aliases] token values, or also directly in [tiers] keys and reviewers/planners entries?"
- context: "get_planners/get_reviewers currently return { harness, model, alias } per token and get_config returns { aliases, reviewers, planners } (the wire shape advertised by the MCP tools — note it does not even expose 'provider' today). If effort must be observable to the orchestrator/TUI/web, these shapes need a new optional effort field. Separately: tokens enter from [aliases] values, but [tiers] KEYS are ALSO parsed as tokens (config.ts:167-168, via parseReviewerToken when not an alias name), and reviewers/planners are alias-name lists. So an effort suffix could appear (a) only inside [aliases] token strings, (b) also in a direct [tiers] key like 'claude:opus:high = \"frontier\"', and/or (c) nowhere else. Pinning the legal locations bounds the parser/test surface and the cq.toml.example + docs updates."
- suggestions: ["Add optional effort to get_planners/get_reviewers token shape AND get_config; allow effort in [aliases] values and in direct [tiers] keys (anywhere a token is parsed)","Allow effort only in [aliases] token values (single point of truth); [tiers] keys reference by alias name; still surface effort on the wire","Do NOT change the MCP wire shape (effort is internal to dispatch only) — surface it later if needed"]
- recommendation: "Allow an effort suffix anywhere parseReviewerToken runs (both [aliases] values and direct [tiers] keys), and add an optional effort field to the get_planners/get_reviewers token shape + get_config so the active set is fully observable. Confirm whether changing the wire shape is in scope for THIS goal or deferred."
- ledgerRefs: ["goals:G36"]
- answer: as recommended

### Q165 — answered

- createdAt: 2026-06-08T21:42:13.527Z
- updatedAt: 2026-06-08T23:41:24.310Z
- author: user
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "Acceptance / test bar: what concretely must pass for this goal to be 'done'?"
- context: The goal touches @cq/config (parser + types + equality + classifier), the MCP get_* wire shapes, the pi-extension's inlined resolver, plus cq.toml.example and the token-format docs. The repo bar is 'bun run check' (typecheck + lint + tests, from nix/pkg/cq-ledgers/) and nix build for products. I want the verification surface pinned so each task gets a testable acceptance criterion.
- suggestions: ["bun test covers: parseReviewerToken effort round-trip (parse+format) for pi and claude, omitted-effort default, malformed-suffix rejection, reviewerTokensEqual/classifyToken/D42 behavior under the chosen identity rule","Plus a pi-extension unit test for the inlined parseCqToken/tokenToChildModel mirror emitting the effort flag for a pi token and staying inert/fallback for claude","Plus cq.toml.example updated with an effort example and the token-format doc/comment updated; bun run check + nix build .#ledger-mcp green","All of the above"]
- recommendation: "All of the above: parser round-trip + equality/classifier/D42 tests in @cq/config; a mirror test for the pi-extension resolver; updated cq.toml.example + token-format docs; green 'bun run check' and 'nix build .#ledger-mcp'. Confirm whether the pi-extension (outside the bun workspace) has an existing test harness or if a documented manual repro suffices."
- ledgerRefs: ["goals:G36"]
- answer: as recommended

## M-AMBIENT

### Q166 — open

- createdAt: 2026-06-09T02:32:03.252Z
- updatedAt: 2026-06-09T02:32:03.252Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- question: "D43 fix approach (flow-governance change you wanted to steer): which design for each part? (1) STALE-WORKTREE-BASE root cause — (a) orchestrator creates MANUAL worktrees from the current main HEAD (git worktree add <path> -b impl-<T> <mainSha>) and passes that path to the worker, OR (b) keep native isolation:worktree but the implement-worker prompt FORBIDS any git op against the main checkout / other worktrees and the worker resets ONLY within its own worktree (this run's ad-hoc mitigation, which worked)? (2) COMMIT DISCIPLINE — thread 'commit ledger after planning-lock + after EVERY task merge-back' permanently into advance.md + implement/advance.md + plan/advance.md (overriding the chained-suppression for these checkpoints)? (3) Do you want to drive these cq-assets prompt edits yourself, or have me plan+implement the full D43 suggestedFix autonomously via a normal /cq:advance cycle?"
- context: "D43 (major, open) is the data-loss defect: an implement-worker under native isolation:worktree ran `git reset --hard`/checkout/cherry-pick in the MAIN checkout (not just its worktree), discarding the run's uncommitted ledger writes (recovered via replay, commit 343ef67-era; the loss was only recoverable because the reverted counters reproduced identical IDs). Root cause is CONFIRMED by inspection (reflog + prompt analysis) and documented in D43 with a 3-part suggestedFix. The LOAD-BEARING part (commit-after-merge) was ADOPTED ad-hoc THIS run (committed the ledger after every merge-back; D43 never recurred). Remaining: (b)/the prompt edits forbidding cross-checkout worker git ops + the stale-base fix. Because these edits change the flow's OWN governance and you signalled you want to steer the flow-fix, this is surfaced for your direction rather than auto-implemented mid-run. This question is HOW-to-fix (design/ownership), not whether-to-fix (D43's default disposition is FIX)."
- suggestions: ["(1b)+(2 yes)+(3 autonomous): keep native worktrees but harden the implement-worker prompt to forbid main-checkout git ops + worker-confined reset; permanently thread commit-after-planning/after-merge; let me plan+implement via /cq:advance","(1a)+(2 yes)+(3 autonomous): switch to orchestrator-managed manual worktrees; thread the commit discipline; autonomous implement","(3 steer): you take the cq-assets prompt edits yourself (I've adopted commit-after-merge already this run); leave D43 open for your manual fix"]
- recommendation: (1b) + (2 yes) + (3 autonomous). (1b) is the minimal, proven mitigation (it worked flawlessly across the 12 worker dispatches after the incident) and avoids the orchestrator-managed-worktree complexity; (2) makes the durable-ledger guarantee structural; (3) autonomous keeps momentum — but defer to you on ownership since it edits the flow's own prompts.
- ledgerRefs: ["defects:D43"]
