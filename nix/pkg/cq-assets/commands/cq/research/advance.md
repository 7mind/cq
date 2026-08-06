---
description: "Advance one research round: extend the hypothesis tree, gather and validate evidence, adjudicate nodes, and conclude or park the research."
argument-hint: <researchId>
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}
{{cq:fragment:ledger-response-contract}}

## Catalogue
```yaml
inputs:
  - "research id ($ARGUMENTS first token)"
  - "full research item, linked questions, and hypothesis tree"
outputs:
  - "hypothesis nodes and validated evidence"
  - "research status and, when concluded, findings/conclusion/recommendation plus a cited synthesis log"
  - "standalone handoff"
ioSchema:
  - "one idempotent, resumable research round per invocation"
  - "explorer result: {hypothesisId, evidence[], lean, notes?, probeRequest?}"
  - "experimenter result: {hypothesisId, evidence[], lean, notes?}"
```

You orchestrate one research round for the research id in `$ARGUMENTS`. You own
the hypothesis tree, citation validation, adjudication, and ledger writes.
Children only gather evidence; they never adjudicate or mutate the ledger.

{{cq:fragment:subagent-dispatch}}

## Invariants

- Re-derive state from the ledger. Each round must dispatch a child or make a
  state-changing write. Stop after two consecutive read-only passes.
- Move `researches` from `open` to `wip` before doing research. Only `wip` may
  transition to `concluded` or `inconclusive`. Never set `abandoned`.
- Hypotheses use `open | uncertain | confirmed | wrong`,
  `parentHypothesis` for ancestry, and `ledgerRefs:
  ["researches:<researchId>"]`. Store only revalidated evidence, prefixed
  `[correct]` or `[incorrect]`.
- Dispatch disjoint root hypotheses in parallel. Drill a branch serially
  because each child depends on validated parent evidence.
- Resolve `tiers.frontier` once with
  `ledger::get_config("tiers")`. Pass its model token verbatim.
  If unavailable, inherit the current model; never invent one.
- Persist each child summary and available raw transcript through `cq log put`,
  attach their logical paths in the same item update as the evidence, and never
  expose capabilities or secrets. Before piping a transcript, require `test -s
  <transcript>` so empty or whitespace-only captures are skipped rather than
  written. Do not write research artifacts into the working tree.

## Round

### 1. Read and gate

Fetch the research with full projection. Find its hypothesis nodes and linked
questions by exact `ledgerRefs` membership. Reconstruct ancestry from
`parentHypothesis`.

If a linked question remains `open`, stop: the round waits for the user. Fold
answers from `answered` questions into later framing. If a confirmed node
already answers the research but synthesis was interrupted, resume at
Conclusion.

Otherwise set an `open` research to `wip` before continuing.

### 2. Extend the tree

Create one root hypothesis for each distinct candidate answer not already
represented. When an `uncertain` node needs decomposition, create narrower
children. Prefer the most promising uncertain branch; seed several roots
together only when they are independent. Use the research item's milestone.

### 3. Gather evidence

Dispatch `research-explorer` for each frontier node with:

```json
{
  "hypothesisId": "<id>",
  "statement": "<verbatim hypothesis>",
  "branchContext": "<research question, ancestry, validated sibling evidence, and adjudication target>",
  "leads": ["<optional file, symbol, query, or URL>"]
}
```

Explorers read repository and external authoritative sources. They return
evidence with citations and may request a probe when observation alone cannot
settle the hypothesis.

For a warranted `probeRequest`, dispatch `research-experimenter` in a
throwaway worktree with the request, hypothesis, branch context, and base
commit. Network access and worktree-local dependency installation are allowed.
The experimenter may execute probes but must not persist changes outside the
worktree or request another probe. Harvest its evidence, then remove the
worktree.

Treat malformed child output as a contract breach. Do not accept partial data.

### 4. Validate and adjudicate

Independently reopen every cited repository location, retrieve every cited
external source, or rerun every cited command. Mark an item `[correct]` only
when the source matches the excerpt, carries adequate authority, and bears on
the hypothesis; otherwise mark it `[incorrect]`.

Update each hypothesis once with accumulated evidence, child log paths, and:

- `confirmed` when correct evidence establishes it;
- `wrong` when correct evidence rules it out;
- `uncertain` when further decomposition can decide it;
- `open` when no usable evidence returned.

Adjudicate from `[correct]` evidence only. Then:

- if confirmed nodes answer the research, conclude;
- if no branch remains adjudicable, set the research `inconclusive` and ask
  the user only when a genuine user-controlled input could unblock it;
- otherwise leave the research `wip` for another round.

### 5. Conclusion

When the question has an evidence-supported answer, update the research to
`concluded` with:

- `findings`: the validated evidence narrative and citations;
- `conclusion`: the direct answer;
- `recommendation`: the resulting action, if any;
- all round `sessionLogs` and available `rawLogs`.

Compose the full cited synthesis—question, adjudicated tree, evidence, and
excerpts—and route it through `cq log put` to
`logs/<timestamp>-research-<researchId>.md`. Record the returned logical path in
`sessionLogs`. Never create this artifact in the repository.

### 6. User input

Create an `open` question linked to the research only for:

- a requirements or preference choice that changes the question's meaning;
- unavailable data, hardware, credentials, or external access required for a
  decisive probe.

Do not ask whether research should continue, whether scope feels large, or
whether the user wants to abandon it. Narrow broad questions to an answerable
core. Leave the tree intact and stop after filing the question.

## Report and handoff

Report nodes created or adjudicated, experiments run, citation validation
counts, research status, conclusion and synthesis path, and any blocking
question. Say another round is warranted when open or uncertain nodes remain.

When invoked standalone, write exactly one append-only `handoffs` item:

- `drained`: concluded or no branch remains;
- `answers-required`: blocked by open questions;
- `user-action-required`: a named item requires a specific external action
  only the user can perform;
- `mixed`: more than one of the above;
- `illness-detected`: a protocol or invariant failure prevents progress.

Set `flow: "research"`, relevant `ledgerRefs`, required
`blockingQuestions`/`handoffReasons`, and this round's log paths. Do not write a
handoff for an ordinary context-window interruption; durable ledger state is
the resume point. Never use effort, elapsed time, or remaining work size as a
stop condition.

When invoked inline by another flow, suppress this handoff; the outermost
command owns it.
