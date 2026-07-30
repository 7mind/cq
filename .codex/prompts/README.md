# Codex prompts — plan-flow + implement-flow

These prompts are **symlinks into the repo-root `llm/` asset tree**, the
single source of truth shared with Claude Code (`.claude/commands/plan/*`,
`.claude/agents/*`) and the `llmAssets` flake output. Edit the files under
`llm/`; never edit the symlinks. See `llm/README.md` for the full layout.

| Codex prompt file              | Source (`llm/`)                  | Claude location                      | Role |
|--------------------------------|----------------------------------|--------------------------------------|------|
| `plan-start.md`                | `commands/plan/start.md`         | `.claude/commands/plan/start.md`     | slash command — start a goal, file first questions |
| `plan-advance.md`              | `commands/plan/advance.md`       | `.claude/commands/plan/advance.md`   | slash command — thin planner↔reviewer loop |
| `plan-follow-up.md`            | `commands/plan/follow-up.md`     | `.claude/commands/plan/follow-up.md` | slash command — add scope to an existing goal, re-clarify |
| `plan-advance-agent.md`        | `agents/plan-advance.md`         | `.claude/agents/plan-advance.md`     | subagent — the planner (one state step) |
| `plan-reviewer.md`             | `agents/plan-reviewer.md`        | `.claude/agents/plan-reviewer.md`    | subagent — the adversarial reviewer |
| `implement-start.md`           | `commands/implement/start.md`    | `.claude/commands/implement/start.md`   | slash command — resolve scope, hand to advance loop |
| `implement-advance.md`         | `commands/implement/advance.md`  | `.claude/commands/implement/advance.md` | slash command — the implement orchestrator loop |
| `implement-worker.md`          | `agents/implement-worker.md`     | `.claude/agents/implement-worker.md`    | subagent — implements one task in an isolated worktree |
| `implement-reviewer.md`        | `agents/implement-reviewer.md`   | `.claude/agents/implement-reviewer.md`  | subagent — adversarial per-task reviewer |
| `implement-conflict-resolver.md` | `agents/implement-conflict-resolver.md` | `.claude/agents/implement-conflict-resolver.md` | subagent — resolves rebase conflicts on merge-back |

## How Codex consumes these

- Codex exposes files in a `prompts/` directory as slash commands. The command
  prompts (`plan-start`, `plan-advance`, `plan-follow-up`, `implement-start`,
  `implement-advance`) are usable directly.
- The agent prompts (`plan-advance-agent`, `plan-reviewer`, `implement-worker`,
  `implement-reviewer`, `implement-conflict-resolver`) carry Claude-style
  `name:` / `description:` / `isolation:` / `disallowedTools:` YAML frontmatter.
  Codex may ignore unknown frontmatter keys — that is acceptable; the canonical
  content is the prompt BODY, which is tool-agnostic. Under Codex's multi-agent
  mode, route those bodies to sub-agents accordingly (the orchestrator command
  performs the manual `git worktree` lifecycle the worker body assumes — see
  decision K4). The body's "Output contract" / structured-return discipline is
  what the loop depends on, not the frontmatter.

## Runtime identity (read before running)

Every ledger write in these prompts must carry provenance:

- `author` = the class of the model **actually executing the prompt**, derived
  from runtime identity — never a hardcoded literal. A Codex GPT-5.x run writes
  its own class (e.g. `"gpt-5.5"`); a Claude Opus 4.8 (1M) run writes
  `"opus-4.8[1m]"`.
- `session` = the running session id (`$CLAUDE_CODE_SESSION_ID` under Claude, or
  the Codex session-id equivalent).

## Session logs — subagent handover convention

Every subagent (plan-flow and implement-flow) ends its final message with a
`### Session summary` block (**Did / Achieved / Discovered / Issues**). The
subagent writes no file; the **orchestrator** prompt persists it to
`docs/logs/<timestamp>-<agent-id>.md` after the sub-agent returns
(`<agent-id>` from the dispatch result, `<timestamp>` stamped by the
orchestrator). Under Codex, the multi-agent driver plays the orchestrator role
and performs that write. This keeps sub-agents read-only and is concurrency-safe
(one writer, unique filenames).

## Ledger reference (must match the `@cq/ledger` schema exactly)

- `goals` phases: `clarifying → planning → planned → building → done / abandoned`
  (server-enforced transition guard; `planning ↔ clarifying` allowed; `planned`
  and `building` may re-open to `planning` for `/plan:follow-up`; `done` /
  `abandoned` are terminal).
- A goal cannot LEAVE `clarifying` while any linked `questions` item is `open`;
  cannot ENTER `planned` without a `locked` `decisions` item linking it.
- `questions` statuses: `open → answered / withdrawn`. Fields: `question`
  (required), `context`, `suggestions` (string[]), `recommendation`, `answer`.
- `decisions` statuses: `proposed → locked / superseded`. Field `headline`
  required.
- `reviews` statuses (the verdict): `go-ahead` | `revise` (both terminal).
  Fields: `new_questions` (string[]), `criticism` (string[]), `ledgerRefs`.
- Cross-ledger link: `fields.ledgerRefs: ["goals:<G>"]`.
- MCP tools (server name `ledger`): `create_item(ledger_id,
  milestone_id?, status, fields, author?, session?)`, `update_item(ledger_id,
  item_id, status?, fields?, author?, session?)`, `fetch_item`, `fetch_ledger`,
  `fts_search`, `list_milestone_items`, `enumerate_ledgers`.
