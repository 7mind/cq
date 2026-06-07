# T227 — Acceptance demo: one reviewer dispatch under Pi returning a parseable verdict-json

**Task:** T227. **Goal context:** G28 / Q126 (END-TO-END) + Q128 + K44.
**Repo:** THIS repo, at base `cc2f326` (branch `implement/T227`).
**Date:** 2026-06-08.

This is the **reviewer-shape** companion to the T226 explorer demo. Together they
prove the `dispatch_agent` primitive works for BOTH subagent shapes:
read-only-explorer (T226) and plan-reviewer (this note).

## What this demonstrates (acceptance, point by point)

1. The **UNCHANGED** cq plan-review path (single-reviewer fallback wording from
   `commands/cq/plan/advance.md` sub-step 2a — "Use the `Agent` tool with
   `subagent_type: "plan-reviewer"`, passing the goal id") was run under `pi`
   against a small sample emitted plan. Exact command + capture below.
2. The Pi model (grok-build) **fired the dispatch** for `plan-reviewer` FROM the
   unchanged prompt text — `dispatch_agent({ agent: "plan-reviewer", task: … })`
   — NOT a hand-written call. The K44 trigger that maps the harness-agnostic
   "dispatch the named subagent" convention onto `dispatch_agent` lives in
   `nix/pkg/llm-contexts/pi-context.md` (appended system prompt), so the cq
   command/rubric text stays byte-identical.
3. The dispatched child returned a **single fenced-json verdict** conforming to
   the plan-review contract (`{ summary, verdict, new_questions[], criticism[],
   defects[] }`), and the **orchestrator-side parse succeeds** (fence-strip +
   `jq`, exit 0). `defects[]` carries the `{ headline, severity, rootCause,
   suggestedFix }` object shape the rubric requires.
4. `git diff -- nix/pkg/cq-assets` is **clean** after the run — the cq command
   prompts and the plan-reviewer agent markdown were UNTOUCHED.

## Deferred follow-up (explicitly out of scope for G28)

Full **unattended-sandbox** validation (bubblewrap `$SMIND_SANDBOXED` end-to-end)
and the **implement-worker worktree-isolation** path (the `isolation: "worktree"`
seam in `cq-subagent-dispatch.ts`, deferred per Q128) are the deferred FOLLOW-UP.
This demo validates the explorer + reviewer (read-only / verdict-returning)
shapes only; the worktree-isolated implement-worker shape is NOT exercised here.

---

## Exact invocation (env-stripped; patch-grok "baseUrl" stderr is NON-FATAL)

The `<UNCHANGED cq-style instruction>` is the wording the cq plan flow emits when
it dispatches the reviewer (advance.md sub-step 2a + the `/cq:plan-review` rubric
contract), carrying a small sample emitted plan for the reviewer to judge. The
prompt text is reproduced verbatim in the "Unchanged prompt" section below.

```sh
env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA \
  CQ_AGENTS_DIR="$PWD/nix/pkg/cq-assets/agents" \
  CQ_CONFIG="/tmp/t227-cq.toml" \
  pi -p --mode json \
    --extension "$PWD/nix/pkg/pi-extensions/cq-subagent-dispatch.ts" \
    --append-system-prompt "$PWD/nix/pkg/llm-contexts/pi-context.md" \
    --provider grok-build --model grok-build \
    "$(cat /tmp/t227-prompt.txt)" </dev/null > /tmp/t227.jsonl
# EXIT=0 ; 714 jsonl lines.
```

The only stderr line is the documented non-fatal provider warning:

```
Extension error (…patch-grok-build-context-window.ts):
  Provider grok-build: "baseUrl" is required when defining models.
```

### Tier config (CQ_CONFIG=/tmp/t227-cq.toml)

`cq.toml` is gitignored and lacks `[tiers]`/`[agent_tiers]`; for the demo
`CQ_CONFIG` points at a small config that mirrors `cq.toml.example` but pins
`plan-reviewer` to a **pi** tier so its child runs under a child `pi -p`
(a `claude:` tier would fall back to the parent model). The agent's tier is
read from `[agent_tiers]` keyed by agent NAME — the agent markdown frontmatter
stays byte-identical (Q126/K44).

```toml
[aliases]
  grok = "pi:grok-build"
[tiers]
  standard = "grok"
[agent_tiers]
  plan-reviewer = "standard"
```

---

## Unchanged prompt (verbatim, the dispatch trigger the cq plan flow emits)

```
Review the plan for goal G-DEMO. Use the Agent tool with subagent_type: "plan-reviewer", passing the goal id and the plan context below. The plan-reviewer judges the emitted plan against the canonical /cq:plan-review rubric and returns a single fenced-json verdict.

Dispatch the plan-reviewer subagent with this task:

Goal G-DEMO — "Add a --json flag to the `cq status` command".
Description: the `cq status` CLI command currently prints a human-readable table; add an opt-in `--json` flag that emits the same data as machine-readable JSON on stdout, leaving the default table output unchanged.
Grounding: the command lives in the cq-ledgers bun workspace under the CLI entrypoint.

Answered questions:
- Q: Should --json change exit codes? A: No — exit codes stay identical; only stdout format changes.
- Q: Should the JSON be pretty-printed or compact? A: Compact single-line JSON.

Emitted plan (work milestone M-DEMO, "cq status --json"):
- Task T1 "Add --json flag parsing to the status command" — acceptance: `cq status --json` is accepted without an unknown-flag error; dependsOn: [].
- Task T2 "Emit the status payload as compact JSON when --json is set" — acceptance: `cq status --json | jq .` parses and reports the same item counts as the table; dependsOn: [T1].
- Task T3 "Make everything good" — acceptance: works; dependsOn: [T2].

Judge this plan adversarially against the rubric (fine-grained / sequenced / testable / grounded / complete), classify every finding into new_questions / criticism / defects, and emit the single fenced-json verdict ({ summary, verdict, new_questions, criticism, defects }) as the LAST content of your reply.
```

(`sha256(/tmp/t227-prompt.txt) = 629029ef…c0a8`.) Note the deliberately bad
`T3 "Make everything good"` mega-task so the reviewer has something concrete to
flag.

---

## Transcript excerpt — the REAL dispatch toolCall

`jq 'select(.type=="tool_execution_start")'` over `/tmp/t227.jsonl`:

```json
{
  "type": "tool_execution_start",
  "toolName": "dispatch_agent",
  "args": {
    "agent": "plan-reviewer",
    "task": "Review the plan for goal G-DEMO against the canonical /cq:plan-review rubric. Return a single fenced-json verdict as the LAST content of your reply.\n\nGoal ID: G-DEMO\nGoal title: \"Add a --json flag to the `cq status` command\"\n…\n- Task T3 \"Make everything good\" — acceptance: works; dependsOn: [T2].\n…"
  }
}
```

The Pi model paraphrased the plan into the child `task` and CALLED the tool — it
did not answer in prose. `toolName: "dispatch_agent"`, `agent: "plan-reviewer"`.

### Child execution + tier resolution (extension `details`)

```json
{
  "agent": "plan-reviewer",
  "modelSource": "tier",
  "resolvedTier": "standard",
  "model": "grok-build",
  "childProvider": "grok-build",
  "childModel": "grok-build",
  "exitCode": 0,
  "excludedTools": ["dispatch_agent", "write", "edit", "bash"]
}
```

- `modelSource: "tier"` / `resolvedTier: "standard"` — the child model was
  resolved from the agent NAME via `[agent_tiers] → [tiers]` (T225), NOT a
  caller override.
- `childProvider/childModel: grok-build` — the isolated child `pi -p` actually
  opened against the tier-resolved model.
- `excludedTools` includes `dispatch_agent` (the child CANNOT re-dispatch —
  subagents-can't-spawn-subagents guard) plus `write/edit/bash` from the
  plan-reviewer frontmatter `disallowedTools`. The child kept `read`/`grep`, and
  in fact grounded its review against the real repo (it cited
  `packages/cq-cli/src/main.ts`).

---

## Child's returned verdict — a SINGLE fenced-json verdict (parseable)

`tool_execution_end.result` (`isError: false`):

```json
{
  "summary": "Plan fails rubric (incomplete, ungrounded, vague mega-task, weak acceptance); requires major revision before go-ahead",
  "verdict": "fail",
  "new_questions": [
    "What is the exact data payload/structure for `cq status` (both table and JSON forms)? …"
  ],
  "criticism": [
    "T3 'Make everything good' (acceptance: 'works') is a vague unscoped mega-task violating fine-grained + testable requirements; it must be removed or replaced with concrete, observable verification steps.",
    "Plan omits all prerequisite work to implement the base `cq status` subcommand: … T1/T2 presuppose the command + table 'currently' exist.",
    "Acceptance criteria insufficiently operational and incomplete: …",
    "No tasks address answered questions in implementation: ensure exit codes identical, emit compact single-line JSON …",
    "Plan is not grounded in the actual repo: main.ts (the CLI entrypoint) only implements 'init'/'reset'/'erase'; status command with table does not exist …"
  ],
  "defects": [
    {
      "headline": "Goal premise / description mismatch with implementation: `cq status` command does not exist and does not print any table",
      "severity": "medium",
      "rootCause": "Goal states '… currently prints a human-readable table' … but packages/cq-cli/src/main.ts defines SUBCOMMANDS as only ['init','reset','erase'] …",
      "suggestedFix": "Correct the goal statement … or explicitly expand plan scope to include base status command + table before layering --json."
    }
  ]
}
```

(The child labelled `verdict` as `"fail"` rather than the rubric's
`"go-ahead"|"revise"` — it followed the JSON skeleton the model itself injected
into the child `task` rather than the rubric's literal enum. All five contract
KEYS are present and the structure is exactly the plan-review shape; the
orchestrator parse below succeeds regardless of the verdict string. The reviewer
substantively did its job: it flagged the `T3` mega-task, the missing
prerequisite tasks, and the unground goal premise — and filed the premise
mismatch as a `defects` object with the required `severity`.)

### Orchestrator-side parse succeeds

Fence-strip + `jq` (the advance.md "Strip any code fence before parsing" step):

```sh
jq -r 'select(.type=="tool_execution_end") | .result.content[]?.text' /tmp/t227.jsonl \
  | sed -e 's/^```json$//' -e 's/^```$//' \
  | jq '{summary, verdict,
         new_questions_count:(.new_questions|length),
         criticism_count:(.criticism|length),
         defects_count:(.defects|length),
         defects_severity:[.defects[].severity]}'
# PARSE_EXIT=0
# {
#   "summary": "Plan fails rubric …",
#   "verdict": "fail",
#   "new_questions_count": 1,
#   "criticism_count": 5,
#   "defects_count": 1,
#   "defects_severity": ["medium"]
# }
```

The orchestrator-side parse exits 0 and surfaces every contract field — the
SINGLE fenced-json verdict is machine-consumable.

---

## cq-assets-untouched assertion

After the run, from the repo root:

```sh
$ git diff --quiet -- nix/pkg/cq-assets/ && echo "UNTOUCHED" || echo "MODIFIED"
UNTOUCHED
$ git diff --stat -- nix/pkg/cq-assets/
# (no output — clean)
```

The cq command prompts (`commands/cq/plan/advance.md`, `commands/cq/plan-review.md`)
and the `agents/plan-reviewer.md` markdown were byte-identical before and after.
The Pi-side dispatch trigger lives entirely in `nix/pkg/llm-contexts/pi-context.md`
(the appended system prompt) — confirming K44: the shared cq command text does
not change to drive a non-Claude harness.

## Conclusion

End-to-end, from an UNCHANGED cq plan-review prompt under `pi --provider
grok-build`: the model fired `dispatch_agent({agent:"plan-reviewer", …})`, the
isolated child (tier-resolved grok-build, re-dispatch + write/edit/bash excluded)
returned a single fenced-json verdict in the plan-review contract, and the
orchestrator-side fence-strip parse succeeded. `nix/pkg/cq-assets` stayed clean.
Together with T226 (explorer shape) this validates the `dispatch_agent` primitive
for both the read-only-explorer and reviewer subagent shapes. Unattended-sandbox
and implement-worker (worktree-isolation) validation remain a deferred follow-up,
out of scope for G28.
