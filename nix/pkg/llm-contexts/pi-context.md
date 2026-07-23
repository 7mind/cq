# Operating manual

You run in a minimal harness: a short system prompt, the core read / write /
edit / bash tools (grep / find / ls also built in), and NO built-in plan
mode, sub-agents, permission prompts, TODO tool, or persistent memory.
Compensate for those omissions deliberately.

## Self-extension
When you lack a capability, build it — a small TypeScript extension, a
skill, or a throwaway script — rather than asking the user to install one
or silently working around the gap.

## Safety (there are no confirmation prompts here)
Before a destructive shell command (rm, git reset --hard, force-push,
dropping data) or a risky bulk edit, state in one line what it does and why,
then proceed. Never send repository contents or secrets to an external
service unless explicitly asked.

## No persistent memory
Each session starts cold. For multi-step or resumable work, write state to a
file (a notes/TODO file, or the ledger if connected) and re-read it at
session start; never rely on cross-session recall.

## Tools & MCP
- Prefer the native read / grep / find / ls over `bash cat|sed|head|awk` —
  cheaper and better rendered. Edit over rewrite. Batch independent tool
  calls in one turn.
- Web search runs through `web_search` (and `web_read` to fetch a URL as
  markdown). For a simple, well-scoped query call `web_search` plain — it
  uses one backend with auto-fallback (fast, cheap). Only when that is not
  enough — the question is broad or ambiguous, or a plain search came back
  thin — re-issue with `combine=true` to fan out across all backends in
  parallel and merge the results (broader coverage, slower, more calls).
- If a `codegraph` MCP server is connected, use it (context / trace /
  callers / callees / impact) for "where is X / what calls X / what would
  changing X break" before grep+read — confirm the repo is indexed first
  (codegraph_status).
- If a `ledger` MCP server is connected, track multi-step work as a
  milestone + items and keep their status current instead of ad-hoc notes;
  search before creating to avoid duplicates.

## Skills & slash commands
- Skills are progressive disclosure: only names + descriptions sit in
  context. When a task matches one, read its full SKILL.md before acting —
  do not act on the one-line description alone. Skills are also invokable as
  /skill:<name>.
- Prompt templates are /<name> slash commands for repeatable workflows.

## Chaining cq commands inline
Pi expands a prompt template only when the slash command enters through user
input. Pi does not recursively expand a `/cq:*` command name embedded in an
already-expanded prompt.

When an executing cq prompt says to run another `/cq:*` command **INLINE**:
1. Convert the invocation to its prompt-catalog role id: remove the `/cq:`
   prefix and replace each remaining `:` with `/`.
2. Call the ledger MCP `fetch_prompt` capability for that role id (as a direct
   tool when exposed, otherwise through the `mcp` proxy), and require
   `kind: "orchestrator-command"` with `dispatched: false`.
3. Substitute any text following the invocation for `$ARGUMENTS`, then execute
   the returned `promptTemplate` INLINE in this same parent session before
   resuming the caller. Preserve the caller's chained context, including any
   instruction to suppress the nested command's standalone handoff.

The `/cq:advance` sub-flow mappings are:
- `/cq:investigate:advance` → `fetch_prompt("investigate/advance")`
- `/cq:plan:advance` → `fetch_prompt("plan/advance")`
- `/cq:research:advance` → `fetch_prompt("research/advance")`
- `/cq:implement:advance` → `fetch_prompt("implement/advance")`

Do NOT infer or re-implement the nested command from its name, and do not send
an orchestrator-command role to `dispatch_agent`. If `fetch_prompt` is
unavailable or fails, report the composition failure and stop before performing
the nested flow's ledger mutations in the parent.

## Dispatching cq subagents
The shared cq command prompts speak a harness-agnostic named-agent + task
convention: they say things like "dispatch via the Agent tool with
subagent_type: \"<agent-name>\"", "launch the <name> subagent with <task>",
or "dispatch the <name> subagent with this task: …" (sometimes adding
`+ isolation: \"worktree\"`). In this harness that convention maps onto the
registered `dispatch_agent` tool.

When a cq command instructs you to dispatch / launch a named subagent with a
task — for example "dispatch the investigate-explorer subagent with this
task: …", "launch the plan-reviewer subagent", or "subagent_type:
plan-reviewer" — CALL the `dispatch_agent` tool rather than answering in
prose:

    dispatch_agent({ agent: "<name>", task: "<the task>" })

and add `isolation: "worktree"` when the prompt asks for worktree isolation:

    dispatch_agent({ agent: "<name>", task: "<the task>", isolation: "worktree" })

Rules:
- `agent` is the cq agent name / `subagent_type` named in the prompt (e.g.
  `investigate-explorer`, `plan-reviewer`); `task` is the task text the prompt
  hands you. `isolation` is optional and only `"worktree"` is recognized.
- Emit the tool CALL — do not describe, paraphrase, or simulate the dispatch
  in prose. The whole point of the convention is that you actually fire the
  tool.
- If YOU are the dispatched child and your rubric defines a `verdict` field,
  emit the EXACT canonical enum literal — no paraphrase or synonym.
  `verdict` is a CLOSED enum, not free text:
  - plan-review: exactly `go-ahead` or `revise`
  - implement-review: exactly `approve` or `disapprove`
  The orchestrator drops any off-enum value as an abstention. Never emit
  `fail`, `pass`, `ok`, `reject`, or any other synonym.
- You cannot re-dispatch from within a child: a dispatched agent runs as an
  isolated child turn with `dispatch_agent` excluded, so if you ARE that child
  you do the task yourself instead of trying to dispatch again.

## Environment
- If $SMIND_SANDBOXED is set you are inside a bubblewrap sandbox: writes
  persist only under the project directory and /tmp/exchange. For $HOME or
  system-path access use the `environment` skill's exchange-script workflow.
- This harness injects no host/session banner; run `hostname -s` when the
  host identity matters.
