# T979 — Cross-surface conformance of the compact-dispatch sub-graph (claude / codex / pi)

- **Task**: T979 (milestone M316, goal G94). A probe, not a feature — the deliverable is evidence.
- **Date**: 2026-07-28, ~06:30–07:50 UTC.
- **Host**: NixOS, x86_64. `codex-cli 0.145.0`, `pi 0.82.0` (both OBSERVED, §2).
- **Base commit**: `e241e518657ba85e59a8e004e5e30482891bec3d`. The worktree was handed out at
  `0f3ff1ab` — **4 commits STALE**; corrected with an in-worktree `git reset --hard e241e518`
  before any work, then branched to `implement/T979`.
- **Builds on T713** (`docs/drafts/20260727-2200-t713-codex-reffirst-probe.md`). T713's
  observations are CITED, not re-derived.

Every claim is tagged **OBSERVED** (a command was executed and its output is quoted) or
**INFERRED** (read from source, help text, or reasoning over observations). Where the two
could be confused, the confusion is named. Secrets are redacted; §10 records the check.

---

## 1. Verdicts

Three checks, three surfaces. **A surface is only "conformant" where a command was run or a
committed artifact was read — never by analogy with another surface.**

| # | In-scope check | claude | codex | pi |
|---|---|---|---|---|
| 1 | Role prompt injected ONCE at the child boundary; absent from parent context | **CONFORMANT** (child-side OBSERVED; parent-side INFERRED) | **NOT CONFORMANT** (OBSERVED) | **CONFORMANT** (OBSERVED, both directions) |
| 2 | No ordinary parent-side `validate_input` round-trip on the dispatch path | **CONFORMANT** (OBSERVED) | **CONFORMANT** (OBSERVED) | **CONFORMANT** (OBSERVED) |
| 3 | The same structured input fields still reach the child | **CONFORMANT** (OBSERVED) | **CONFORMANT** (OBSERVED) | **CONFORMANT** (OBSERVED) |

**Check 1 is NOT uniform.** claude and pi keep a dispatched role's prompt out of the parent
model's context by construction. **codex does not**: its skill projection instructs the parent
to read the role's prompt into its own context before dispatching, and a live `codex exec -p`
run confirms the parent does exactly that. See §5 and divergence **D-1** (§8).

**Checks 2 and 3 ARE uniform**, and measured on the RENDERED artifact of each surface — not
just on the canonical sources, which is what the pre-existing T975 guard scans (§4, §7).

**Availability changed since T713 and both abstentions it recorded are now resolved** (§2). No
surface was abstained on for checks 1–3. Two narrower abstentions remain, named in §6.

---

## 2. Availability — T713's central abstention is RESOLVED (OBSERVED)

T713 abstained because both Codex routes were unauthenticated. Re-probed first, as instructed.

```
$ codex --version
codex-cli 0.145.0
$ pi --version
0.82.0
$ codex login status
Logged in using ChatGPT
EXIT=0
```

T713 observed `Not logged in` / `EXIT=1` here. **Route B (native codex CLI) is now
authenticated.** A real model turn:

```
$ timeout 180 codex exec --json --skip-git-repo-check --ephemeral \
    'Reply with exactly the word PONG and nothing else.' </dev/null
{"type":"thread.started","thread_id":"019fa76b-b4d7-7123-b6fc-0adc8c7bec27"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
{"type":"turn.completed","usage":{"input_tokens":24709,"cached_input_tokens":0,
  "cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0}}
EXIT=0
```

**Route A (Codex via `pi`), the route `cq.toml` configures** — the T169/K30 shape, `env -u`
strip and `</dev/null` included:

```
$ env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session \
    --provider openai-codex --model gpt-5.6-sol:xhigh \
    'Reply with exactly the word PONG and nothing else.' </dev/null
PONG
… Error: This extension ctx is stale after session replacement or reload …
    at setStatus (/nix/store/…-ledger-status/index.ts:186:13)
    at refresh (/nix/store/…-ledger-status/index.ts:205:7)
EXIT=1
```

**The model turn SUCCEEDS** (`PONG`) — T713's `No API key found for openai-codex` is gone.
But the process **exits 1 anyway**, because the `ledger-status` pi extension throws after the
turn. Isolated:

```
$ env -u … pi -p --no-tools --no-session --no-extensions \
    --provider openai-codex --model gpt-5.6-sol:xhigh '…PONG…' </dev/null
PONG
EXIT=0
```

`--no-extensions` → **EXIT=0**. The failure is the extension, not the provider and not the
model. T713 saw this same crash but *after* a provider-auth failure and recorded it as
incidental; **it now corrupts the exit code of a SUCCEEDING turn**, which is a different and
worse consequence. See divergence **D-3** (§8).

`cq.toml`'s note was already corrected by T713 and this probe **confirms the corrected
diagnosis** (`cq.toml:25-28`, verbatim, non-secret):

```toml
  # re-add to [harness.pi] to re-enable. NOTE (T713, 2026-07-27): the earlier
  # "GPT quota exhausted" note here was WRONG — the probe observed a MISSING
  # CREDENTIAL on both routes (pi's openai-codex provider and the native codex
  # CLI, which has its own auth domain). Different remedy: authenticate, not wait.
```

The remedy named there — authenticate — is what changed, and it worked.

---

## 3. What the three surfaces actually are

All three install a rendered tree from ONE catalog (`renderPromptSurfaceTree`,
`packages/cq-config/src/promptRenderer.ts:558`): `catalog.json`, `surface.json`, and
`roles/<roleId>.md` for each of 24 roles (9 `dispatched-subagent`, 15
`orchestrator-command`). **OBSERVED** — 26 artifacts per surface, all three surfaces.

The measurements in §4 were taken by rendering all three surfaces in-process from the same
`nix eval --raw .#llmAssets.catalogJson` (51,613 bytes, 24 roles). **They match the
LIVE-DEPLOYED artifacts byte for byte**, so they describe deployed reality, not a local build:

| deployed path | bytes | matches render |
|---|---|---|
| `~/.claude/agents/implement-worker.md` | **7 469** | claude render 7 469 ✓ |
| `~/.codex/skills/cq-implement-advance/references/role-implement-worker.md` | **7 431** | codex render 7 431 ✓ |
| `~/.pi/agent/cq-agents/implement-worker.md` | **7 449** | pi render 7 449 ✓ |

```
$ wc -c ~/.pi/agent/cq-agents/implement-worker.md ~/.claude/agents/implement-worker.md \
        ~/.codex/skills/cq-implement-advance/references/role-implement-worker.md
 7449 …/.pi/agent/cq-agents/implement-worker.md
 7469 …/.claude/agents/implement-worker.md
 7431 …/.codex/skills/cq-implement-advance/references/role-implement-worker.md
```

The three surfaces differ only in the substituted fragments, so the same role differs by tens
of bytes, never structurally.

### The three dispatch transports (OBSERVED — `fragments/<surface>/subagent-dispatch.md`)

| surface | `CQ_SUBAGENT` means | who reads the role prompt |
|---|---|---|
| claude | `Agent(subagent_type: "<role>", ...)` | the **harness**, from `~/.claude/agents/<role>.md`, at the child's system boundary |
| pi | `dispatch_agent(agent: "<role>", task: "<complete prompt>")` | the **`cq-subagent-dispatch` extension** (Node code), from `$CQ_AGENTS_DIR/<role>.md`, passed as `--append-system-prompt` to a child `pi -p` |
| codex | the collaboration `spawn_agent` transport | the **PARENT MODEL** — instructed to by the skill wrapper (§5) |

All three transports are addressed by role **NAME**. The codex non-conformance is in the
**skill wrapper around** the transport, not in the transport sentence itself.

---

## 4. Checks 2 and 3, measured on the RENDERED artifact of all three surfaces

Command (probe source in §9):

```
$ cd nix/pkg/cq-ledgers && bun run packages/cq-config/t979-probe2.ts
```

### CHECK 2 — `validate_input` is GONE, uniformly (OBSERVED)

Occurrences of `validate_input` across all 15 rendered orchestrator commands, and separately
across all 9 rendered dispatched-role prompts:

| surface | rendered orchestrator commands | canonical sources | dispatched-role prompts |
|---|---|---|---|
| claude | **0** | 0 | **0** |
| codex | **0** | 0 | **0** |
| pi | **0** | 0 | **0** |

Zero on every surface, on both sides of the boundary. **Check 2 is uniform and conformant.**

### The (a)-leg spellings, with provenance — why a naive scan MISREADS this

A naive scan for `fetch_prompt` / `prompt-catalog fetch (` / `promptTemplate` in the rendered
bodies is **not** a conformance signal, because the *allowlisted glossary* legitimately
contains those tokens (T975 §(5) deliberately keeps them). Exact counts, with every non-zero
attributed:

| token | claude | codex | pi | provenance of the non-zero counts |
|---|---|---|---|---|
| `prompt-catalog fetch (` | 5 | 5 | 5 | `operational-tool-vocabulary` fragment — the ALLOWLISTED glossary line, in the 5 commands declaring that slot |
| `fetch_prompt` | 5 | 5 | **13** | 5 as above on every surface; **pi adds 8** from its `inline-command-recursion` fragment |
| `promptTemplate` | 3 | 3 | **11** | 3 from the CANONICAL sources on every surface (`plan-review` ×1, `implement-review` ×2 — the portable-rubric commands that exist to hand a promptTemplate to a non-Claude harness); **pi adds 8** from the same fragment |
| `validate_input` | **0** | **0** | **0** | — |

The pi surplus is one fragment, quoted verbatim
(`fragments/pi/inline-command-recursion.md`):

> **Inline CQ recursion (Pi).** When this workflow says to run a `CQ::<path>` command INLINE,
> load that command through `fetch_prompt("<path>")`, execute its `promptTemplate` in this
> session, and complete it before resuming this workflow.

versus claude ("invoke the mapped slash command in this session") and codex ("read the mapped
`$cq-<path>` skill completely"). **This concerns ORCHESTRATOR-COMMAND inline recursion, a
different artifact class from a dispatched role's prompt, and inline recursion is
by-design same-session.** It is therefore **NOT** a check-1 violation, and it is **NOT**
counted against pi above. It is reported as divergence **D-2** (§8) because the three
surfaces resolve the same neutral token by three different mechanisms, only one of which
costs a parent-side MCP round-trip.

### CHECK 3 — the structured input survives the render, uniformly (OBSERVED)

Each of the 9 dispatch edges' verbatim `inputSchema` field literal (the same literals
`packages/ledger/test/cq-parent-dispatch-inventory.test.ts` pins on the canonical sources) is
present in the RENDERED flow body, on all three surfaces:

| rendered flow body | claude | codex | pi |
|---|---|---|---|
| `plan/advance` (2 literals) | all present | all present | all present |
| `investigate/advance` (2) | all present | all present | all present |
| `research/advance` (2) | all present | all present | all present |
| `implement/advance` (3) | all present | all present | all present |

`validate_output("<role>", …)` — the surviving (g) leg, which T979 must not be mistaken for
retiring — is intact for all 9 edges on all 3 surfaces. **OBSERVED.**

### CHECK 1 — the bytes that do not enter parent context, per surface (MEASURED)

The rendered `dispatched-subagent` prompt bytes, i.e. what a parent-side `fetch_prompt` would
pull in per dispatch:

| role | claude | codex | pi |
|---|---|---|---|
| `plan-advance` | 36 597 | 36 546 | 36 579 |
| `plan-reviewer` | 13 659 | 13 607 | 13 641 |
| `implement-worker` | 7 469 | 7 431 | 7 449 |
| `implement-reviewer` | 7 153 | 7 095 | 7 128 |
| `implement-conflict-resolver` | 4 596 | 4 567 | 4 596 |
| `investigate-explorer` | 8 385 | 8 319 | 8 360 |
| `investigate-prober` | 10 379 | 10 339 | 10 359 |
| `research-explorer` | 10 307 | 10 244 | 10 282 |
| `research-experimenter` | 12 440 | 12 405 | 12 425 |
| **TOTAL (9 roles)** | **110 985** | **110 553** | **110 819** |

**Read this table with §5.** These are the bytes the check is *about*, not a saving each
surface achieves:

- **claude — 110 985 B stay out of parent context**; per implement-flow round the parent avoids
  7 469 B (worker) + 7 153 B (reviewer) = **14 622 B**.
- **pi — 110 819 B stay out of parent context**; per round **14 577 B** (7 449 + 7 128).
- **codex — 0 B are saved.** The parent is instructed to read the role reference, and does
  (§5), so the full **7 431 B** (worker) enters parent context on every dispatch — plus, in one
  of two runs, again inside the `spawn_agent` prompt. The 110 553 B column is what codex
  *would* save if D-1 were fixed; it currently saves none of it.

---

## 5. Check 1, driven live through `-p` on codex and pi (OBSERVED)

A two-sentinel design, so injection and leakage are measured independently:

- `T979-ROLEBODY-a71c3d` sits in the role prompt BODY, and the role forbids the child from
  ever echoing it. **Any occurrence in the parent's own stream is parent-side materialization.**
- `T979-CHILDSAW-b82e4f` is the only thing the role tells the child to reply. **Its presence
  proves the body actually reached the child** — the positive control, without which a "clean
  parent" result would be worthless (a dispatch that never happened also leaks nothing).

### 5.1 pi — CONFORMANT, both directions (OBSERVED)

The `piWrapped` wrapper **overwrites** `$CQ_AGENTS_DIR` unconditionally
(`nix/hm/pi.nix:96`: `--run 'export CQ_AGENTS_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cq-agents"'`),
so the first attempt was redirected to the real agents dir and the probe role was not found —
a wrong run, kept because it is the reason for the workaround (and for divergence **D-4**).
The working probe shadows `$PI_CODING_AGENT_DIR` with symlinks to every real entry except
`cq-agents`. **Nothing under `~/.pi/agent` was written.**

```
$ export PI_CODING_AGENT_DIR=<shadow>            # shadow/cq-agents -> throwaway role dir
$ env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA \
    pi -p --mode json --no-session \
    --provider openai-codex --model gpt-5.6-luna:low \
    'Call the dispatch_agent tool exactly once, with agent "t979probe" and task
     "Report your assigned token now." Do not read any file. After the tool returns,
     reply with only the word DONE.' </dev/null
EXIT=1                                            # the D-3 extension crash, not the turn
stdout bytes: 43891
```

Parent event stream, decoded:

```
TOOLCALL name= dispatch_agent args= {"agent": "t979probe", "task": "Report your assigned token now."}
toolResult TEXT= T979-CHILDSAW-b82e4f
DETAILS= {"agent":"t979probe","agentFile":"<shadow>/cq-agents/t979probe.md",
          "model":"gpt-5.6-luna","provider":"openai-codex","modelSource":"parent",
          "childProvider":"openai-codex","childModel":"gpt-5.6-luna","exitCode":1,
          "excludedTools":["dispatch_agent","bash","write","edit","read","grep","find"], …}
assistant TEXT= DONE
```

Sentinel counts over the parent's **entire 43 891-byte** stream:

| sentinel | count | meaning |
|---|---|---|
| `T979-CHILDSAW-b82e4f` | **5** | positive control PASSES — the body reached the child and the child obeyed it |
| `T979-ROLEBODY-a71c3d` | **0** | **the role prompt never entered parent context** |

The parent's tool call carries **two fields — a role NAME and a task**. The role body was read
by extension code (`agentFile` in the details) and handed to the child as
`--append-system-prompt`; `excludedTools` contains `dispatch_agent`, so the child cannot
re-dispatch. **Check 1 CONFORMANT on pi, measured in both directions.**

*(`exitCode: 1` on the child is the same D-3 extension crash; the extension is resilient to
it because it prefers the captured final text over the exit code —
`cq-subagent-dispatch.ts:869`.)*

### 5.2 codex — NOT CONFORMANT (OBSERVED, twice, with two different failure shapes)

Setup: a **throwaway `CODEX_HOME`** with `auth.json` **symlinked** (not copied) from
`~/.codex`, a `probe.config.toml` for `-p probe`, and a skill whose `SKILL.md` is the
**verbatim wording emitted by `nix/lib/codex-command-skills.nix` `mkSkillSpec`** and whose
entry workflow carries the **verbatim `fragments/codex/subagent-dispatch.md`** text. The
user's `~/.codex` was never written.

`-p` selection works, as T713 established (`RUN A`, no network needed):

```
$ CODEX_HOME=<throwaway> codex exec -p probe --skip-git-repo-check --ephemeral --cd <ws> 'hi'
OpenAI Codex v0.145.0
--------
model: gpt-5.6-luna          ← from probe.config.toml
provider: openai
approval: never
sandbox: read-only
reasoning effort: low        ← from probe.config.toml
--------
```

**RUN C** — `codex exec -p probe --json … '$cq-t979probe Execute the cq-t979probe workflow now.'`
(EXIT=0, 4 452-byte parent stream). The parent's own event stream, decoded:

```
item.completed agent_message  "I'm using the `cq-t979probe` skill … I'll read its workflow
                               and role instructions, then execute the workflow in this session."
item.completed command_execution
   command: zsh -lc "sed -n '1,240p' …/references/cq-t979probe.md && printf '\n---ROLE---\n'
                     && sed -n '1,240p' …/references/role-t979probe.md"
   aggregated_output bytes: 992      has ROLEBODY sentinel: True      exit_code: 0
item.completed collab_tool_call tool=spawn_agent
   prompt: "{\"taskId\":\"T979\",\"headline\":\"cross-surface probe\",
             \"acceptance\":\"the child reports its assigned token\"}"
   prompt bytes: 102
   receiver_thread_ids: ["019fa775-2da5-7492-a485-5572f13eea0a"]
item.completed collab_tool_call tool=wait
   agents_states: {"019fa775-…": {"status":"completed","message":"T979-CHILDSAW-b82e4f DONE"}}
```

The parent ran ONE shell command that read **both** references into its own context: 992 bytes
= the two files (613 + 367) plus the 12-byte separator, i.e. **100 % of both references,
sentinel included**. Sentinel counts in the parent stream: **`ROLEBODY` = 1, `CHILDSAW` = 3**.

**RUN D** — identical but **without `--ephemeral`**, so the child thread persists and its OWN
context can be read (EXIT=0, 6 143-byte parent stream):

```
parent shell read output bytes: 2032   has ROLEBODY: True
spawn_agent prompt bytes:        408   has ROLEBODY: True
  prompt: "You are the T979 cross-surface conformance probe role.\n\n
           ROLE-BODY-SENTINEL: T979-ROLEBODY-a71c3d\n\n … \n\n
           Structured input: { taskId: \"T979\", headline: \"cross-surface probe\",
                               acceptance: \"the child reports its assigned token\" }"
parent stream: ROLEBODY = 3, CHILDSAW = 5
```

The persisted child thread (`sessions/2026/07/28/rollout-…-019fa776-e801-….jsonl`,
36 281 bytes, `parent_thread_id: 019fa776-a863-…`) shows how the prompt arrives:

```
session_meta      {'id':'019fa776-e801-…','parent_thread_id':'019fa776-a863-…'}
response_item message role='developer'  '<permissions instructions> Filesystem sandboxing …'
response_item message role='user'       'You are the T979 cross-surface conformance probe role.
                                         ROLE-BODY-SENTINEL: T979-ROLEBODY-a71c3d …'
event_msg agent_message  {'message':'T979-CHILDSAW-b82e4f','phase':'final_answer'}
event_msg token_count    {'input_tokens': 12453, …}
```

Three things are OBSERVED here, and they are the finding:

1. **The parent materializes the full role prompt into its own context, in both runs.** The
   `command_execution.aggregated_output` in the parent's stream contains the sentinel. This is
   precisely the (a) leg T975 removed for claude, reintroduced through the skill wrapper.
2. **What `spawn_agent` carries is model-discretionary and varied between two runs of the same
   command**: 102 bytes (structured input only) in RUN C, 408 bytes (full role body +
   structured input) in RUN D. There is no "injected once" here — it is injected zero or one
   times at the child boundary, at the model's discretion, *after* being injected into the
   parent.
3. **When the role prompt does reach the child, it arrives as a `role: "user"` message**, not
   as a system/developer-boundary injection (the only `developer` message is codex's own
   permissions text). So even the conforming-looking run does not satisfy "injected at the
   child boundary" in the sense claude and pi satisfy it.

**Check 3 does hold on codex**: the structured input `{ taskId, headline, acceptance }` reached
the child verbatim in both runs.

**Not claimed.** In RUN C the child answered with the correct token although the 102-byte
`spawn_agent` prompt did not contain it. RUN C was `--ephemeral`, so its child thread was not
persisted and **I cannot say how that child obtained the token.** Context inheritance is the
obvious candidate, and RUN D's child thread shows no inherited parent conversation, which
argues against it — the two are in tension and I leave it **UNRESOLVED** rather than pick one.
It does not affect the verdict, which rests on point 1.

### 5.3 claude — CONFORMANT child-side (OBSERVED first-person), parent-side INFERRED

This report was produced by a Claude `implement-worker` child, so the child side is a
first-person observation: the body of `~/.claude/agents/implement-worker.md` (7 469 B) was
injected at **this agent's system boundary**, verbatim below the frontmatter —

```
$ head -8 ~/.claude/agents/implement-worker.md
---
name: implement-worker
description: Implement-flow worker. Implements EXACTLY ONE task end-to-end inside an isolated …
# Claude host capabilities for implement-worker
isolation: worktree
disallowedTools: Agent
---
```

— and the dispatch prompt received as the user turn contained the structured input
(`taskId`, `headline`, `description`, `acceptance`, worktree path, branch, `baseCommit`) and
**not** the role prompt. `disallowedTools: Agent` is the claude analogue of pi's
`excludedTools` re-dispatch guard.

**Honest limit — this is the one place I could not close the loop.** I cannot instrument the
Claude parent orchestrator's context from inside its child, so **"the role prompt did not
enter the claude parent's context" is INFERRED**, from (i) the transport sentence, which has no
prompt-body parameter, and (ii) the prompt-content guards (T975's canonical scan plus this
task's rendered scan, §7). It is not backed by a captured parent transcript, as pi's and
codex's verdicts are. Closing it needs a parent-side transcript capture that this probe did
not have.

---

## 6. Abstentions — named, with cause

Neither of these blocks checks 1–3 on any surface; both are narrower.

1. **`spawn_agent` availability by direct interrogation — ABSTAINED (unreliable instrument).**
   Asked in a plain `codex exec -p probe --json` turn whether it had a `spawn_agent` tool, the
   model answered **`NO`** and listed `apply_patch, exec_command, image_gen__imagegen,
   list_mcp_resource_templates, mcp__codex_apps__…` — yet RUN C/D show it **calling
   `spawn_agent`** via authoritative `collab_tool_call` events. A model's self-report of its own
   tool set is **not evidence**; only the event stream is. No conclusion is drawn from the `NO`.
   Related, OBSERVED via `codex features list`: `collaboration_modes  removed  true` and
   `multi_agent  stable  true` — the transport is enabled but its feature flag is at stage
   `removed`, which is worth a look before building on it.
2. **The codex probe used a 613-byte stub entry workflow, not the real 52 718-byte
   `implement/advance` body.** The load-bearing texts were verbatim (the `mkSkillSpec` SKILL.md
   wording, and `fragments/codex/subagent-dispatch.md`), and the instruction that causes the
   materialization was **also read directly from the live-deployed
   `~/.codex/skills/cq-implement-advance/SKILL.md`** — so D-1 is not an artifact of the stub.
   But **I did not drive a real flow**, deliberately: doing so would mutate the live ledger and
   create worktrees. Whether the *full* 52 718-byte body changes the parent's reading behaviour
   is **unobserved**.

**No silent narrowing.** Two things I dropped and am naming: I did not probe the `claude`
surface's parent context (§5.3), and I did not re-derive any T713 finding (§2 aside).

---

## 7. Explicitly OUT OF SCOPE — T695 owns the live lifecycle

This probe covered **checks 1–3 only**, on the three surfaces, as tabulated in §1. It says
**NOTHING** about, and must not be read as covering:

- pre-launch input validation **failing closed against a live tool**;
- **no-allocation-on-rejection**;
- **handle-based child retrieval**;
- **capability-theft rejection**.

Those need the live prepare/store/confirm/fetch lifecycle over MCP, which **T695** owns and
which does not exist yet — `DISPATCH_ATTESTATION_MCP_DEFERRED_TO = "T695"`
(`packages/cq-config/src/dispatchAttestation.ts`). T713 established the in-process shapes for
them; two of its findings have since landed as **D173** (confirm is handle-only,
`ConfirmedDispatchResultView`) and **D174** (`fetch_dispatch_result` requires namespace +
actor). **This probe re-verified none of that** and makes no claim about it.

---

## 8. Divergences, with recommended disposition

The orchestrator files these; this worker does not touch the ledger.

**D-1 — codex materializes a dispatched role's prompt in the PARENT. → `defects`, HIGH.**
`nix/lib/codex-command-skills.nix:186-189` emits, into every command skill:

> Every `CQ_SUBAGENT` role in the workflow names the corresponding Codex collaboration-role
> reference below. **Read that role reference completely before dispatching it** through the
> collaboration transport described by the workflow.

OBSERVED live-deployed in `~/.codex/skills/cq-implement-advance/SKILL.md`, and OBSERVED being
obeyed in §5.2. This is a **fault, not a preference**: it reintroduces exactly the leg T975
removed, it makes the "compact" dispatch non-compact on one of three surfaces, and it costs
**7 431 B of parent context per implement-worker dispatch** (110 553 B across the 9 roles)
that claude and pi do not pay. The instruction is also the *only* thing that gets the prompt to
a codex child, so it cannot simply be deleted — codex needs a child-boundary injection
mechanism (the natural shape: have the launcher put the role prompt into `spawn_agent`'s prompt
from **code**, as pi's extension does, and stop instructing the parent to read it).
Grep-checked: the string exists **only** in the codex projection — neither
`fragments/claude/subagent-dispatch.md` nor `fragments/pi/subagent-dispatch.md` has an
equivalent.

**D-2 — inline `CQ::<path>` recursion resolves three different ways. → `questions`.**
claude invokes the mapped slash command; codex reads the mapped `$cq-<path>` skill; pi does
`fetch_prompt("<path>")` and executes its `promptTemplate` (+8 `fetch_prompt` and +8
`promptTemplate` in pi's rendered commands, §4). All three are *in-session by design*, so none
violates check 1 — but only pi pays an MCP round-trip, and only claude avoids materializing the
command body. Whether that asymmetry is acceptable (each surface using its most native
mechanism) or should be unified is a **requirements preference**, not a fault: there is no
stated invariant to violate. **User decision.**

**D-3 — a pi extension crash corrupts the exit code of a SUCCESSFUL `-p` turn. → `defects`, MEDIUM.**
`ledger-status/index.ts:186` (`setStatus`) ← `:205` (`refresh`) throws
`This extension ctx is stale after session replacement or reload`, taking the process to
**EXIT=1 after the model turn has already succeeded**; `--no-extensions` → EXIT=0 (§2).
Reproduced on **every** pi `-p` invocation in this probe (4/4), including the dispatch probe in
§5.1. Any caller that treats pi's exit code as the success signal — the `pi:*` shellout path —
will read a successful dispatch as a failure. T713 saw the same stack after a provider *error*;
the new fact is that it also fires after **success**.

**D-4 — `$CQ_AGENTS_DIR` is advertised as overridable but the wrapper makes it un-overridable. → `defects`, LOW.**
`cq-subagent-dispatch.ts:676` tells the caller `set CQ_AGENTS_DIR to override`, but
`nix/hm/pi.nix:96` `export`s it unconditionally from `$PI_CODING_AGENT_DIR`, so an
externally-set `CQ_AGENTS_DIR` is silently discarded (OBSERVED — §5.1's first, wrong run). The
error message names a lever that does not work; only `$PI_CODING_AGENT_DIR` does.

---

## 9. What is test-pinned, and what is report-only

**Test added: `packages/cq-config/test/crossSurfaceDispatchConformance.test.ts`** (18 tests).

**Test-pinned** (deterministic, static):

- **Check 2** — `validate_input` is an exact **0** in every rendered orchestrator command *and*
  every rendered dispatched-role prompt, on all three surfaces, plus a negative control that
  the scanner is not a no-op.
- **Check 3** — every dispatch edge's verbatim input-field literal survives the render on all
  three surfaces; and the surviving `validate_output` (g) leg is intact for all 9 edges × 3
  surfaces.
- The (a)-leg **exact counts** of §4 as characterization numbers, with provenance in comments,
  so a genuinely reintroduced call site moves a number and forces review.
- **Check 1's static substrate** — the identical 9-role dispatched set per surface; pi's
  child-boundary mechanism (`dispatch_agent` has `agent`/`task`/`model`/`isolation` and **no**
  `prompt`/`systemPrompt`/`body` parameter, and the body travels via
  `--append-system-prompt`); and each surface's transport sentence naming a role-id-addressed
  transport.
- **D-1 as a CHARACTERIZATION of a known non-conformance** — the codex projection's
  "Read that role reference completely" instruction is asserted present, and claude's/pi's
  dispatch fragments asserted to have no equivalent, so the divergence cannot change silently.
  The test says in prose: **when D-1 is fixed, INVERT this assertion, do not delete it.**

**Report-only** (runtime, or needing a real model turn — a test would be flaky, costly, or
would mutate live state):

- Every §5 sentinel count and `-p` transcript (needs authenticated model turns).
- §2 availability, and D-3's exit-code corruption (needs a live provider).
- The claude parent-side inference of §5.3 (needs parent-context instrumentation that does not
  exist).
- D-2's and D-4's dispositions, which are judgements, not invariants.

### Mutation testing of the new guard (OBSERVED)

The guard was verified to FAIL on a real reintroduction, not merely to pass:

| mutation | new T979 test | pre-existing T975 test |
|---|---|---|
| `validate_input(…)` appended to the **canonical** `commands/cq/implement/advance.md` | **3 fail** (all 3 surfaces) | *(not run)* |
| `validate_input` line appended to **`fragments/codex/operational-tool-vocabulary.md`** | **1 fail — codex only** | **42 pass — MISSES IT** |

The second row is the reason this file exists: T975's scan reads canonical sources, so a
forbidden token reintroduced through a per-surface **fragment** passes it and reaches the
installed artifact. Both mutations were reverted (`git status` clean before the commit).

---

## 10. Reproduction, and redaction

### Shell probes

```bash
# §2 availability
codex --version; pi --version; codex login status
timeout 180 codex exec --json --skip-git-repo-check --ephemeral \
  'Reply with exactly the word PONG and nothing else.' </dev/null
env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session \
  --provider openai-codex --model gpt-5.6-sol:xhigh 'Reply with exactly the word PONG.' </dev/null
#   ^ EXIT=1 with a succeeding turn (D-3); add --no-extensions for EXIT=0
codex features list | grep -iE 'agent|collab'

# §3 deployed-vs-rendered byte identity
wc -c ~/.claude/agents/implement-worker.md \
      ~/.codex/skills/cq-implement-advance/references/role-implement-worker.md \
      ~/.pi/agent/cq-agents/implement-worker.md

# §4 rendered-surface measurements. The measurement probes were THROWAWAY and are NOT
# committed; the snippet below is the whole of what they did that the committed test does
# not. Save as nix/pkg/cq-ledgers/packages/cq-config/t979-probe.ts (it must live inside a
# package that resolves @cq/config) and run from nix/pkg/cq-ledgers/.
cd nix/pkg/cq-ledgers && bun run packages/cq-config/t979-probe.ts

# §5.1 pi — shadow $PI_CODING_AGENT_DIR (NEVER write ~/.pi/agent); $CQ_AGENTS_DIR alone
#      does NOT work (D-4)
# §5.2 codex — throwaway $CODEX_HOME with auth.json SYMLINKED; run RUN D without
#      --ephemeral to persist the child thread under $CODEX_HOME/sessions

# the new guard
cd nix/pkg/cq-ledgers && bun test packages/cq-config/test/crossSurfaceDispatchConformance.test.ts
```

### The §4 byte-table probe (throwaway — not committed)

```ts
// nix/pkg/cq-ledgers/packages/cq-config/t979-probe.ts
import * as path from "node:path";
import { DISPATCHED_ROLE_VERSIONS } from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const SURFACES = ["claude", "codex", "pi"] as const;

const nixEvalRaw = (attribute: string): string => {
  const r = Bun.spawnSync(["nix", "eval", "--raw", `.#llmAssets.${attribute}`], {
    cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trimEnd();
};

interface Role { roleId: string; roleKind: string; canonicalSource: string }
const catalogJson = nixEvalRaw("catalogJson");
const catalog = JSON.parse(catalogJson) as readonly Role[];
const fragmentSources = JSON.parse(nixEvalRaw("promptFragmentSourcesJson")) as readonly {
  surface: string; roleId: string; fragment: string; source: string;
}[];
const sourcePaths: PromptCatalogFileInput[] = catalog.map((r) => ({
  canonicalSource: r.canonicalSource, path: path.join(ASSETS_ROOT, r.canonicalSource),
}));
const bytes = (t: string): number => new TextEncoder().encode(t).length;

for (const surface of SURFACES) {
  const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
    .filter((f) => f.surface === surface)
    .map(({ roleId, fragment, source }) => ({
      roleId, fragment, path: path.join(ASSETS_ROOT, source),
    }));
  const tree = renderPromptSurfaceTree({
    surface, catalogJson, sourcePaths, fragmentPaths, roleVersions: DISPATCHED_ROLE_VERSIONS,
  });
  const byRoleId = new Map<string, string>();
  for (const a of tree.artifacts) {
    if (a.path.startsWith("roles/")) {
      byRoleId.set(a.path.slice(6).replace(/\.md$/, ""), a.content);
    }
  }
  let total = 0;
  console.log(`\n== ${surface} ==`);
  for (const role of catalog.filter((r) => r.roleKind === "dispatched-subagent")) {
    const n = bytes(byRoleId.get(role.roleId)!);
    total += n;
    console.log(`  ${role.roleId.padEnd(30)} ${String(n).padStart(7)}`);
  }
  console.log(`  ${"TOTAL (9 dispatched roles)".padEnd(30)} ${String(total).padStart(7)}`);
}
```

### Redaction — checked before committing

The user authenticated both routes immediately before this probe, so credentials were the first
thing looked for.

- `~/.codex/auth.json` (mode `600`) and `~/.pi/agent/auth.json` were **never read and never
  copied**. The codex probe reached auth by **symlinking** `auth.json` into the throwaway
  `CODEX_HOME`; the pi probe symlinked the real agent-dir entries. No credential file content
  appears in this note, in the committed test, or in any captured transcript quoted here.
- No API key, bearer token, `Authorization` header, or `installation_id` is reproduced.
- The captured `-p` transcripts live only under the session scratchpad and are **not
  committed**; only the excerpts above are, and each was inspected first.
- Thread ids (`019fa77…`) and codex `thread_id`/`session_id` values are non-secret run
  correlation ids from this probe's own runs, retained because the event shapes are the
  evidence. The `encrypted_content` reasoning blobs visible in the child transcript are **not**
  quoted.
- The only config quoted is `cq.toml:25-31` (model aliases and a comment) and
  `~/.codex/skills/…/SKILL.md`; T713 already established `~/.codex/config.toml` carries no
  credential, and this probe did not need to read it.
- **Throwaway state only**: `XDG_STATE_HOME` was never repointed and `~/.local/state/cq` was
  never touched — this probe created no ledger store and made no ledger mutation.
