---
description: "Advance implementation: dispatch DAG-ready tasks in isolated worktrees, review and correct them, then merge verified commits in dependency order."
argument-hint: [milestoneId ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}

Effect-boundary authority follows this shared contract:

{{cq:fragment:workset-effect-discipline}}

## Catalogue

```yaml
inputs:
  - "optional milestone ids; empty resumes eligible finalized-manifest work"
  - "full task state, dependencies, linked questions, worktrees, and reviewer configuration"
outputs:
  - "task transitions, one terminal review per task, verified fast-forward merges, defect closure, and milestone archival"
  - "standalone handoff"
ioSchema:
  - "worker: {taskId,status,resultCommit,branch,actualWorktreePath,baseVerification,filesTouched,checkSummary,gateDurationMs?|supervisedGateEvidence?,summary,blockedReason?}"
  - "reviewer: {taskId,verdict,criticism[],questions[],defects[],rationale,resultCommitEvidence,baseAncestry,summary?}"
  - "resolver: {taskId,status,resultCommit?,summary,blockedReason?}"
```

You orchestrate implementation. Children never mutate the ledger or merge.
Re-derive state on every invocation. A pass must dispatch a child, mutate the
ledger, or merge; stop after two consecutive read-only passes.

Canonicalize and validate an explicit milestone batch before its first effect.
With configured roots, select only active graph members belonging to each
milestone's exact finalized manifest; without explicit ids, resume only
eligible finalized-manifest work. Empty roots retain unrestricted historical
selection. Preserve the selected finalized manifest exactly through dispatch,
review, correction, rebase, merge, and terminal writes; re-read the workset at
the effect boundaries required by the shared contract.

{{cq:fragment:subagent-dispatch}}
{{cq:fragment:implement-dispatch-workflow}}

## Shared rules

- Resolve `tiers` and `reviewers` once per pass with
  `ledger::get_config("tiers")` and `ledger::get_config("reviewers")`.
  Workers use their task's `suggestedModel`; reviewers and conflict resolvers
  use `tiers.frontier`. Pass configured model aliases verbatim. If a tier is
  absent, inherit the current model and report the missing configuration.
- Run at most eight workers concurrently. Each task uses an isolated worktree
  and branch `implement/<taskId>`.
- **Managed worktrees.** ALL worktree lifecycle goes through
  `ledger::worktree_manage` — never raw git worktree lifecycle commands
  (add/remove/prune) on any active implement/advance surface. Before changing a
  task to `wip` or launching a worker, call
  `worktree_manage({ operation: "prepare", taskId, baseCommit: <full main tip> })`
  (or resume-by-handle with the retained opaque handle). Accept only a prepare
  result whose dependency-base evidence is verified. Pass the returned absolute
  path as advisory `worktreePath` on the child input. Retain the opaque handle
  across criticism rounds; on orchestrator restart, recover via prepare's
  resume-required response for that taskId and resume the same tree. Never
  discard worker partial/WIP state. Consume the worker's required
  `actualWorktreePath` on output as the authoritative location; merge by
  `resultCommit` SHA.
- **Parent-lost dispatch recovery.** After a manager-bound implement-worker is
  terminally aborted `parent-lost`, retain its exact worktree handle and call
  `worktree_manage({ operation: "resolve-dispatch-recovery", handle })`. Accept
  only the server-returned opaque `recoveryReference`; persist that literal
  reference with the task's recovery metadata and `cq log put` record. Re-read
  the worktree `HEAD` and require it to equal the returned live tip, then call
  `prepare_dispatch` with `recovery: <recoveryReference>` and without
  `reprepareOf`. The server resolves the exact terminal generation and injects
  only its verified durable Git receipt lineage. Never retry an advanced tip as
  a fresh lineage-free dispatch, never reconstruct a prior dispatch handle or
  recovery association from registry files, and never substitute raw
  attestation, repository, worktree, branch, base, tip, terminal, or receipt
  coordinates for the opaque reference.
- **Consumed-worker continuation.** A consumed manager-bound implement-worker
  whose worktree remains live is continued only through its single-use opaque
  association. Before an ordinary criticism redispatch, or before parking a
  consumed worker for later resumption, call
  `worktree_manage({ operation: "resolve-dispatch-continuation", handle })` and
  accept exactly one server-returned `continuationReference`. Persist that
  literal reference with the task metadata and `cq log put` record. Re-read
  `HEAD`, require it to equal the returned live tip, then call
  `prepare_dispatch` with `continuation: <continuationReference>` and without
  `reprepareOf`, `recovery`, or `guardedRebase`. The server resolves the consumed
  generation, complete receipt closure, manager identity, repository binding,
  and authorized caller lineage, and atomically claims the association while
  allocating its successor. A missing, ambiguous, expired, stale, foreign, or
  already-claimed reference blocks redispatch; never reconstruct terminal
  handles, receipts, or capabilities. Guarded-rebase redispatch remains the
  explicit `reprepareOf` + `guardedRebase` exception described below.
- **Exact pre-registry adoption.** When, and only when, a task already has a
  pre-registry tree at the canonical
  `<repositoryRoot>/.claude/worktrees/implement-<taskId>` path on branch
  `implement/<taskId>`, observe its full `HEAD` and use handle-free prepare:
  `worktree_manage({ operation: "prepare", taskId, baseCommit, adoptWorktreePath: <exact canonical path>, expectedHead: <observed full HEAD> })`.
  Supply `adoptWorktreePath` and `expectedHead` only as a pair and never with
  a handle. Supply no activity fence, registry, reconciliation, Git, or install
  authority; the production server constructs those internally. A mismatch or
  refusal blocks the `wip` transition and launch. Retain the returned opaque
  handle for all later resume, criticism, conflict, and release operations.
- Persist every child summary and available raw transcript with `cq log put`,
  attach their logical paths to the affected ledger item, and never expose
  capabilities or secrets. Before piping a transcript, require `test -s
  <transcript>` so empty or whitespace-only captures are skipped rather than
  written.
- The surface-specific fragment defines dispatch input delivery and result
  materialization. Retain the parent-prepared handle. Interpret a native
  result only after the exact retained handle yields `state: "consumed"`.
  Never inspect a body-returning completion or trust a child-reported handle.
- A missing or non-consumed native result is a LOST REPORT. Log it. For a
  manager-bound implement-worker, use the parent-lost recovery procedure above;
  other roles retry the same role once with a fresh prepared dispatch. A second
  loss fails that task path closed, leaves the task non-terminal and its worktree
  intact, and cannot become a worker failure, reviewer abstention, or resolver
  verdict.

## 1. Derive the ready set

Before selecting or dispatching work, recover every active implementation
completion journal by calling `record_implementation_completion` for its task
with the exact observed integration head and a stable recovery operation id.
`merge-required` resumes only the journal-bound merge below;
`reprepare-required` closes no authority and requires rebase plus a fresh
authenticated panel before a new prepare naming `supersedes_completion_ref`;
`recorded|existing` resumes defect reconciliation and release. A
`merge-started` or merged-but-unrecorded journal blocks every other repository
merge until this recovery records it. Never fall back to generic task/review
writes or an unjournaled merge.

Read each target milestone and its full task items, linked questions, milestone
dependencies, and referenced dependency items.

Before dispatch, prune stale worktree metadata and inspect all implementation
and runtime-created worktrees via prepare/resume semantics. Never touch the
main checkout, the ledger backup branch, a worktree for a `wip`/`blocked` task,
or an unmerged worktree without a terminal task association. Release a worktree
only through guarded
`worktree_manage({ operation: "release", handle, terminalDisposition, … })`
when the associated task is terminal (`done`/`abandoned`) and release guards
pass. Never infer safety from a branch name alone. Never raw-remove or prune.

Change a `blocked` task back to `planned` after all linked questions become
`answered`; include the answers in its next dispatch.

A task is ready when:

- its status is `planned`;
- it has no open linked question;
- every resolvable `dependsOn` item has a satisfying status declared by its
  ledger (`tasks:done`, `defects:resolved`, `questions:answered`, and analogous
  configured sets);
- every prerequisite milestone has all tasks terminal.

A description beginning exactly
`CQ-OPERATOR-ACTION v1 <action-key>.` selects the closed operator-action
arm below. The key contains ASCII alphanumeric segments separated by single
hyphens, for example `deployed-recovery`. The store rejects a misplaced,
malformed, or duplicate envelope.
Such tasks appear only in `pOperatorAction`, never `pImplement`, and MUST NOT
enter worktree preparation, `wip`, worker dispatch, review, rebase, merge, or
release logic.

Terminal-but-unsatisfying statuses such as `abandoned` and `wontfix` do not
satisfy dependencies. Advisory or unresolvable free-text references do.

If no task is ready and no task awaits review or merge, report and stop.

## 2. Operator-action tasks (parent only)

For each DAG-ready strict-envelope task, keep the actor split explicit:
the user performs deployment and acknowledges its observed identity; this
parent runs bounded shell probes after acknowledgement. A child, worktree,
merge, push, deploy, switch, or implicit acknowledgement is forbidden.

1. Resolve one exact expected output identity and a non-empty, closed list of
   exact probe commands from the task description and acceptance. Build/package
   output observation may establish the identity; do not deploy it. If the task
   does not specify enough information to make either exact, stop
   `illness-detected` rather than inventing acceptance.
2. Call
   `ledger::materialize_operator_action({ task_id, expected_output_identity,
   expected_evidence, author, session })` before any ordinary readiness action.
   Accept only `created` or exact `existing`. This deterministically creates or
   restart-reuses one pending revision-1 action and one `user-action-required`
   handoff; conflicting identity/evidence fails closed.
3. While pending, park without changing the task to `wip`. Report the action id,
   current revision, exact identity, handoff id, and the user instruction to
   deploy then call `ledger::acknowledge_operator_action` with that
   `expected_revision`. A mismatching acknowledgement leaves the action pending
   and authorizes no probe. A replay against an already `verified` action returns
   `verified`; skip directly to typed completion.
   If the persisted identity or evidence contract proves incorrect before any
   evidence exists, or a pending action's current acknowledgement epoch ended
   in recorded failure, this parent may call
   `ledger::revise_operator_action({ action_id, expected_revision,
   expected_output_identity, expected_evidence, revised_at, author, session })`
   with the exact current revision and complete replacement contract. For the
   evidence-bearing exception, require the terminal evidence entry and
   `lastFailure` to identify the same failed probe in the current revision and
   acknowledgement epoch; fail closed on malformed, stale, or inconsistent audit
   state. The revision CAS preserves the exact prior action/task/handoff snapshot,
   advances to the next revision, clears acknowledgement and evidence state,
   refreshes the handoff, and returns an abandoned linked strict task to
   `planned`. Reject successful partial evidence, acknowledged evidence without a
   terminal failure, verified or completed actions, stale revisions, and unsafe
   task/handoff states. Never use generic reopening as a substitute.
4. After the exact user acknowledgement returns `acknowledged`, run only the
   persisted commands, sequentially and with bounded stdout/stderr capture.
   After each command call `ledger::record_operator_action_evidence` with the
   current `expected_revision`, literal command, stdout, stderr, exit code,
   observed output identity, and timestamp. Evidence is append-only and bound
   to that revision. A nonzero exit or identity mismatch returns the action to
   pending; do not erase earlier observations or finish the task. After the next
   exact acknowledgement, rerun every persisted probe; successes from an earlier
   acknowledgement/failure epoch do not count toward verification.
5. Only a `verified` action authorizes
   `ledger::complete_operator_action({ action_id, expected_revision, completion,
   author, session })`. Re-read the action and pass its current revision before
   every acknowledgement, evidence, revision, or completion call. This typed
   transition marks the linked task `done`. Re-derive predicates; never use
   generic `update_item` or another resurrection operation to bypass verification.

## 3. Dispatch workers

**Prepare BEFORE wip and BEFORE launch.** For each selected task:

1. Resolve the intended base as the current full main tip with
   `git rev-parse --verify` and require `git cat-file -t` to return `commit`.
2. Call `worktree_manage({ operation: "prepare", taskId, baseCommit })` (or
   the exact pre-registry handle-free prepare above, or resume-by-handle with
   the retained handle / allowResumeRequired recovery). On adoption or
   resume-required, retain the returned handle and path and continue on that
   tree — do not mint a second tree for the same task. Never use adoption for
   any non-canonical path, branch, task identity, or changed `HEAD`.
3. Accept only verified dependency-base evidence from prepare. Missing or
   unresolvable dependency `resultCommit` evidence blocks dispatch without a
   `wip` write; it becomes actionable after the ledger object is corrected.
4. Resolve the authoritative tip with
   `git -C <worktree> rev-parse --verify HEAD`, retain it as `startingCommit`,
   and require `git -C <worktree> cat-file -t <startingCommit>` to return
   `commit` plus
   `git merge-base --is-ancestor <verifiedBaseCommit> <startingCommit>` to exit
   zero. Immediately before launch, require the current worktree `HEAD` to equal
   that retained `startingCommit`. Retain the exact `baseCommit`, `round`,
   `startingCommit`, and opaque worktree handle; never reconstruct them from a
   child report.
5. Only after prepare succeeds: if the linked owning goal is `planned`, move it
   once to `building` (never terminal). Set the task `wip`.
6. Dispatch `implement-worker` with the exact task specification, advisory
   `worktreePath` from prepare, branch, verified full-SHA base, required
   `round` (0 on first dispatch; increment on each criticism re-dispatch),
   authoritative `startingCommit`, optional `priorResultCommit` on round>0, and
   any prior criticism.
7. Materialize only a consumed, schema-valid result through the dispatch
   protocol. Before accepting a passing result, require its `resultCommit` to be
   a commit, the worker branch tip to equal it,
   `actualWorktreePath` to be a non-empty absolute path,
   `baseVerification.status === "verified"` with full SHAs, and
   `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.
   When the dispatch carried `gitChangeCapability`, also require a non-empty
   `gitReceipts` chain: every receipt old/new edge and tree must match Git, the
   chain head must equal `resultCommit`, and its path union must equal
   `filesTouched`. The trusted server validates the same invariants before
   storing a broker-capable passing result.

**Harvest then prefer RESUME.** Before every (re)dispatch, inspect the task
worktree for a partial artifact — a `WIP-<taskId>.md` (or equivalent
deliverable) in the existing WIP partial format with open checkpoints, plus any
uncommitted or committed-but-incomplete work. When a self-describing partial
exists, RESUME the same worker in the same managed worktree (same handle) onto
that partial rather than preparing a fresh empty tree. Re-running an expensive
probe to recover work already done is the expensive failure mode; resumption is
preferred when there is durable state to resume onto. When the prior return is a
LOST REPORT or an incomplete turn, harvest first, then resume.

A base-only repair / reprepare / rebase maintenance round does **not** count as
criticism, no-files output, or an ill-loop counter increment.

## 4. Review

Before any review dispatch, require
`git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.
Review each passing worker result against the actual `baseCommit..resultCommit`
diff, acceptance criteria, and gate evidence. A worker failure enters the
criticism loop using `blockedReason`.

For a brokered Codex worker, accept only runner-owned
`supervisedGateEvidence` attached by the trusted result-storage boundary.
Require exact task/result commit/branch/worktree bindings, canonical command,
clean tree, `gateExitCode === 0`, `failCount === 0`, and `passCount > 0` before
review dispatch. Never accept caller-minted evidence or a passing result that
still contains caller-supplied `gateDurationMs`.

Before launching any reviewer, call
`prepare_implementation_review_panel({ task_ref, result_commit,
worker_dispatch, operation_id, author, session })`. Retain its exact
`panelRef`, `rosterDigest`, and ordered opaque `attemptRefs`; never derive,
reorder, omit, duplicate, or append a ref. The server snapshots the configured
roster and binds every attempt to the task, result commit, configured position,
identity, and consumed worker dispatch.

For every returned ref in order call
`prepare_implementation_review_attempt({ panel_ref, attempt_ref, operation_id,
author, session })`. A `launch: native` response carries the only
`DispatchPrepared` that may launch that reviewer; consume it through the native
dispatch protocol. A `launch: adapter` response authorizes no caller shellout:
call `execute_external_implementation_review_attempt({ attempt_ref,
operation_id, author, session })`, which resolves and executes the configured
adapter and prepare-bound input inside the trusted parent. Call
`finalize_implementation_review_attempt({ attempt_ref, operation_id, author,
session })` for every attempt. The finalizer derives its receipt only from the
bound consumed native dispatch or trusted adapter execution. Callers never
submit a verdict, abstention, stdout, stderr, exit code, or adapter identity to
an evidence operation.

**Sandboxed reviewer gate evidence.** Pass a consumed worker's verified
`supervisedGateEvidence` through to a sandboxed `implement-reviewer` and require
the reviewer to validate its exact bindings and green counts without rerunning
the gate. For a legacy result without this evidence, when a surface's dispatch
workflow requires parent-attested gate evidence (gate primitives denied), the
parent MUST attach `parentGateAttestation` built from a just-run or freshly run
full gate on the worker tip:
`{ resultCommit, gateExitCode, passCount, failCount, gateDurationMs?, command,
capturedAt }` with exact tip match, `gateExitCode === 0`, `failCount === 0`, and
`passCount > 0`. Do not escalate the child sandbox to gain gate primitives.
Non-sandboxed reviewers omit the attestation and still re-run the gate
themselves; their approve path still requires child `gateReRan=true`.

The trusted adapter executor fence-strips and fully validates stdout before
classifying the process observation. A complete valid verdict remains a vote
despite nonzero exit. Empty, malformed, failed, or unavailable execution becomes
an authenticated `operational-abstention`, never caller-authored JSON. Do not
impose a caller timeout. If and only if every configured attempt has finalized
as `operational-abstention`, call
`prepare_implementation_review_fallback({ panel_ref, operation_id, author,
session })` once and run/finalize its returned native attempt. The fallback
receipt binds the trigger and exact excluded adapter identities. Zero approved
attempts can never approve a task.

Reconcile the complete finalized receipt set in configured order:

- any `disapprove` wins; all must approve and the gate must be green for
  `approve`;
- union and source-tag `criticism`, `questions`, and `defects`, deduplicating
  equivalent entries;
- `approve` requires empty criticism/questions and verified
  `resultCommitEvidence` + `baseAncestry` on every surviving native reviewer;
- `disapprove` requires at least one criticism or question.

File each out-of-scope or pre-existing `defects[]` entry once as an open defect
linked to the task and owning goal. Under restrictive roots, create it through
the task owner using `owner_ref: "tasks:<T>"` and
`creation_kind: "implementation-defect"`. Such defects do not block the
current task and never become user disposition questions.

## 5. Correct or park

When the reconciled verdict disapproves with criticism and no questions,
redispatch the same worker in the **same managed worktree** (retained handle;
`round` incremented; `priorResultCommit` = prior pass tip when present), then
review again. Resolve and claim the consumed-worker continuation authority above
for this ordinary redispatch; never pass the consumed attestation handle as
`reprepareOf`. Round N+1 must retain round N commits. There is no fixed round cap
while evidence shows convergence.

Park the task when:

- the review asks a genuine user-only requirements question;
- a correction round makes no file change;
- the same criticism repeats without shrinking across consecutive rounds;
- the same gate failure signature repeats.

Create linked open questions with the round history. Under restrictive roots,
create each through `owner_ref: "tasks:<T>"` and
`creation_kind: "exact-gate-question"`. Then set the task `blocked` and
preserve its worktree + handle. Do not ask the user to decide whether a
confirmed fault deserves a fix. When a consumed worker is the parked tip,
resolve and persist its continuation reference before ending the pass.

## 6. Success authority

A task may merge only when all of these hold:

- its latest worker and required native-reviewer results were consumed through
  parent-retained handles;
- the worker carries either trusted green `supervisedGateEvidence` or a
  legacy in-child `REAL_CHECK_EXIT=0` gate result;
- all surviving reviewers approved with empty criticism/questions and verified
  commit/ancestry evidence;
- the orchestrator independently verified the exact commit and ancestry.

Treat `gateDurationMs` below `50`, absent/zero, or below one quarter of the
median for earlier rounds of this same task as implausible. Apply this check
only to the legacy in-child arm. Re-run `bun run check` in the foreground and
use its real exit status. If that cannot be done, fail closed. Runner-owned
`supervisedGateEvidence` carries its measured duration and does not use this
caller-plausibility heuristic.

Before rebase and immediately before merge, the orchestrator independently:

1. require `git cat-file -t <resultCommit>` to return `commit` (full SHA);
2. require the worker branch tip to equal `resultCommit`;
3. require a clean claimed file set vs `filesTouched` / the actual diff;
4. for a broker-capable result, revalidate the receipt chain heads, trees, and
   path union against `resultCommit` and `filesTouched`;
5. require `git merge-base --is-ancestor <verifiedBaseCommit> <resultCommit>`
   to exit zero;
6. require `git merge-base --is-ancestor <startingCommit> <resultCommit>` to
   exit zero;
7. require every dependency task `resultCommit` to be an ancestor of the tip
   (or equal) when resolvable — missing/unresolvable dependency evidence forbids
   merge.

Fabricated, missing, non-tip, stale-base, or non-ancestor result commits never
merge. Any failure is a contract breach and forbids merge-back.

## 6a. Expected-failure tasks

§6a governs only a task that declares an expected failure.

Form (a), inversion marker: use the runner's test.failing or it.failing for an in-suite assertion.

Form (b), subprocess exit-code assertion: spawn the failing tool as a child and assert its non-zero exit code and output.

Form (c), green-on-arrival discriminating control: exercise the same detector with paired inputs or a pure mutation while the task's gate stays green.

Forms (a) and (b) express the expected failure inside a green full gate. Form
(c) carries no marker. A red full gate remains unmergeable. Capturing failure
against a parent commit may supplement, but never replace, these controls.

## 7. Merge in DAG order

Process successful tasks sequentially after their dependencies have landed.
If main has advanced past the dispatch base, rebase onto current main and rerun
gates + review before ff-only merge; that ancestry-only maintenance does not
increment criticism/no-files counters. If the tip changes under rebase, the old
worker result loses authority: redispatch the worker on the rebased tree (same
handle), rerun its gate and review, and repeat the success checks.

**Guarded rebase authority.** Run the rebase only through the task-bound
broker under one stable operation id, using the exact current main commit
already verified above:

```sh
cq gate git-effect --operation rebase --cwd <repositoryRoot> --task-id <taskId> --commit <currentMainCommit> --operation-id <stableRebaseOperationId>
```

Choose `<stableRebaseOperationId>` once per rebase maintenance round — for
example `implement-<taskId>-rebase-r<round>` — and reuse it verbatim when a
response is lost or ambiguous: an exact replay returns the same authority
without re-running the effect. A changed payload under a reused id is
rejected; when main advances again, select a fresh operation id. Never run a
rebase maintenance round without an operation id.

A finalized guarded rebase prints exactly one machine-readable stdout line
`CQ_GUARDED_REBASE_REFERENCE=cq-guarded-rebase:v1:<64 lowercase hex>`.
Capture that exact reference and retain it as the sole rebase authority.
Missing, malformed, duplicated, or mismatched handoff output stops the flow
closed: never fall back to raw Git, never read or reconstruct the rebase
journal, and never mint coordinates or lineage yourself.

Redispatch the worker on the rebased managed tree (same retained handle)
supplying only that parent-only reference with the exact terminal prior worker
generation: the prepare carries `reprepareOf` naming the consumed pre-rebase
worker handle and `guardedRebase` carrying the exact retained reference —
nothing else from the rebase. The server, never the flow or the child,
resolves the reference against its terminal durable journal and materializes
`guardedRebaseLineage` into the worker input; a caller-supplied
`guardedRebaseLineage` is always rejected. On this initial bridge round set
`baseCommit` to the verified onto commit, `startingCommit` to the observed
rebased worktree tip, and `priorResultCommit` to the exact pre-rebase worker
`resultCommit`; the server verifies every coordinate against the journal and
rejects any substitution. Never claim the rewritten pre-rebase commit is an
ancestor of the rebased tip — the exact-equality binding is the only ancestry
exemption. The server-resolved lineage selects the mode: under `exactTip` the
worker reports the exact rebased tip with an empty fresh receipt suffix and no
early WIP commit; any guarded correction that advances the tip keeps early
persistence and a non-empty contiguous suffix beginning at the rebased head,
and any later criticism round follows the ordinary persistence procedure.

Consume the redispatched result only through the retained handle after the
parent-owned gate attaches fresh green evidence bound to the exact rebased
tip, then rerun every required reviewer against the rebased result and repeat
the success checks: pre-rebase worker, reviewer, and gate authority never
authorizes the rebased result. A prepare rejection, an unresolvable or stale
reference, or a lineage mismatch stops the flow closed rather than falling
back to raw Git, broadening the worker sandbox, or accepting caller-minted
lineage or gate evidence. Only after the fresh gate and reviews pass does the
existing ff-only guarded merge below run.

On conflict, call `worktree_manage` with `operation: "observe-conflict"` and the
manager handle. Supply its exact `conflictState` (original tip, onto, dispatch
base, current HEAD and ancestry, sequencer identity/todo/current command, and
every unmerged stage OID/mode) to `implement-conflict-resolver`. Continue only
from a consumed `pass` result whose
durable continuation receipts form one chain ending at its terminal
`resultCommit`; then replay the identical guarded rebase command — same
operation id, same commit — to reconcile the journal to its verified terminal
tip and mint the reference before the redispatch above (a conflicted journal
never selects the exact-tip mode). A consumed `fail` must still carry the bound
branch, absolute
worktree path, and the complete durable receipt chain; after any continuation
its last receipt must end at the exact live nonterminal conflict state. Then
create a linked question, set the task `blocked`, keep the worktree/handle, and
skip its dependants.

After the final checks and fresh approved panel, call
`prepare_implementation_completion({ task_ref, expected_repository_head,
result_commit, worker_dispatch, review_attempt_refs, completion, log_paths,
merge_operation_id, supersedes_completion_ref?, operation_id, author, session })`.
Retain its exact `{ completionRef, taskRef, resultCommit, repositoryHead,
evidenceFingerprint }`. This prepare must precede the merge and must bind the
exact finalized manifest, owner goal, worker result and receipt chain, gate and
acceptance observations, clean diff, ancestry, immutable roster, complete
ordered finalized attempts, and intended ff-only merge. Any evidence mismatch
fails closed without partial mutation.

Merge the exact object only through the prepared journal, using the same stable
`merge_operation_id` supplied to prepare:

```sh
cq gate git-effect --operation merge --cwd <repositoryRoot> --task-id <taskId> --commit <resultCommit> --completion-ref <completionRef> --operation-id <merge_operation_id>
```

Capture stdout and require exactly one
`CQ_IMPLEMENTATION_COMPLETION_MERGE=<canonical JSON>` line. Parse and validate
that its status is `merged|existing` and that `completionRef`, `taskRef`,
`resultCommit`, `repositoryHead`, `mergeOperationId`, and
`evidenceFingerprint` exactly equal the retained prepare. Missing, malformed,
duplicate, mismatched, or lost acknowledgement enters journal recovery; never
retry with raw Git or the legacy commit-only command.

Immediately call
`record_implementation_completion({ task_ref, expected_repository_head,
operation_id, author, session })`. Accept only `recorded|existing` with the
same completion/task/result/head/fingerprint. This protected transaction, not
`update_item` or `create_item`, marks the task done with its result, completion,
and log paths and creates exactly one terminal go-ahead review carrying strict
versioned `implementationEvidence`. `merge-required` or `reprepare-required`
returns to recovery and forbids release or defect reconciliation.

Cleanup uses guarded release only:

```
worktree_manage({
  operation: "release",
  handle: <retained opaque handle>,
  terminalDisposition: "done",
  resultCommit: <merged tip>,
  deleteBranch: true
})
```

A failed harvest or release guard preserves the tree and any side recovery ref.
Never raw-remove or prune outside guarded release. Successful terminal flow
releases once: Remove its worktree, delete its
derived branch, and prune worktree metadata through that single guarded release.

For each linked defect, collect all fix tasks from the defect's task
dependencies and reverse task links. When all are `done`, set the defect
`resolved` with a concise fix summary. A discovered task in `planned`, `wip`,
or `blocked` prevents resolution; never treat task discovery as task completion.

Disapproved review rounds remain protected attempt receipts; file their
questions/defects through the existing typed owner-scoped paths. Only
`record_implementation_completion` creates the terminal go-ahead review for a
merged implementation. Generic writes cannot terminalize a Git-producing task
or create, attach, alter, supersede, or terminalize `implementationEvidence`.

Re-derive the ready set after every merge and continue until drained.

## 8. Milestones and goals

For each touched milestone, close and archive it only when every contained item
is terminal and, for a coordination milestone, its goal is also terminal.
Perform `update_item(ledger_id: "milestones", ..., status: "done")` before
`archive_milestone(...)`.

Never auto-close a goal. When all of a goal's work milestones are archived,
report that the user may set the goal to `done`; a later sweep may then archive
its coordination milestone.

## Report and handoff

Report merged tasks and commits, blocked tasks and question ids, failed paths,
archived milestones, and goals ready for user closure.

When invoked standalone, write exactly one append-only `handoffs` item:

- `drained`: no reachable task remains;
- `answers-required`: tasks are blocked on open questions;
- `user-action-required`: a named task needs a specific external action only
  the user can perform;
- `mixed`: several stop causes coexist;
- `illness-detected`: a protocol, merge, or invariant failure prevents
  progress.

Set `flow: "implement"`, relevant `ledgerRefs`, required
`blockingQuestions`/`handoffReasons`, and pass log paths. Do not write a
handoff for an ordinary context-window interruption. Never stop because of
elapsed effort, task count, or remaining work size.

When invoked inline by another flow, suppress this handoff; the outermost
command owns it.
