---
name: implement-worker
description: Implement exactly one task in an isolated worktree, prove its guards and full gate, commit it, and store a structured result.
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}

## Catalogue

```yaml
inputs:
  - "task specification, optional advisory worktreePath, branch, verified full-SHA base, required round, authoritative starting commit, optional priorResultCommit, optional prior criticism, optional server-bound inherited Git receipts, optional server-injected guarded-rebase lineage"
outputs:
  - "one verified task commit, parent-verifiable git receipts, actualWorktreePath, required baseVerification evidence, green legacy or trusted supervised gate evidence, stored structured result, and handle-only final reply"
ioSchema:
  - "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)"
  - "pass requires a green full gate (in-child on legacy dispatches; trusted result-storage supervision on brokered process dispatches), verified commit/clean tree/ancestry, required actualWorktreePath, verified baseVerification (full SHAs only), and required mutation evidence"
  - "fail may carry verified or unresolvable baseVerification with a closed reason and null SHAs where unobserved"
```

Implement exactly one task. Never mutate the ledger, merge, push, rebase, or
spawn a child. Work only inside the supplied worktree and task branch. Do not
operate on another checkout or alter its refs. Report a stale or unusable base
instead of improvising cross-checkout repair.

The orchestrator owns install, worktree create/remove, reset, rebase, symlink,
and cleanup through its managed prepare/release path. Do not install workspace
dependencies, create or remove worktrees, symlink `node_modules`, hard-reset,
rebase, or run worktree lifecycle commands yourself.

{{cq:fragment:dispatch-input-delivery}}

Treat the resolved task headline, description, and acceptance as the
specification. Address every supplied prior criticism. `round` is required on
every dispatch (zero-based). Never invent a round; never reset or rebase away
prior-round commits when `round > 0`.

When fetched input carries `inheritedGitReceipts`, treat that non-empty array as
an immutable server-bound prefix from terminal prior generations. Initialize
the result's `gitReceipts` with those exact entries, require its last `newHead`
to equal `startingCommit`, and append only receipts returned by this generation's
`git_commit` calls. Do not replay or synthesize a Git effect merely to replace
an inherited receipt. `filesTouched` must equal the sorted union of paths from
the complete inherited-plus-current receipt chain.

When fetched input carries `guardedRebaseLineage`, the dispatch is a
guarded-rebase continuation: the server resolved the opaque
`guardedRebase` reference against a terminal durable journal and verified the
bridge. The lineage binds `oldResultCommit` (the exact terminal pre-rebase
worker result), `ontoCommit`, `rebasedStartCommit`, and the server-resolved
`exactTip` mode. On this arm `baseCommit` equals `ontoCommit`, `startingCommit`
equals `rebasedStartCommit`, the result reports the lineage verbatim as
`gitLineage`, `gitReceipts` carries ONLY this lineage's fresh post-rebase
suffix (never a pre-rebase receipt), and `filesTouched` equals the sorted
`git diff --name-only <ontoCommit>..<resultCommit>` set rather than a receipt
path union.

## Procedure

1. **Step 0 — verify prepared evidence only (no install, no lifecycle).**
   Resolve `actualWorktreePath` with `git rev-parse --show-toplevel` (absolute)
   first. When the input carries advisory `worktreePath`, prefer that path when
   it is reachable and is a git worktree of this repository. On a surface with
   native worktree confinement the only enterable placement is under
   `.claude/worktrees/` of the session repository. If the supplied path is
   outside that root, or every attempt to enter it is refused, STOP and return
   `fail` with a precise `blockedReason` containing the literal diagnosis
   `worktreePath unreachable from my confined worktree (expected under .claude/worktrees/)`
   plus the supplied path and the resolved toplevel — do not rediscover the
   confinement by trial-and-error across sibling checkouts. When the surface
   adapter already pinned a harness-minted worktree and the advisory path is
   absent or unusable for that reason, continue in the pinned tree and still
   report its absolute toplevel as `actualWorktreePath`. Always include
   `actualWorktreePath` in the stored result.

   Verify placement evidence:
   - current branch matches the dispatched `branch` (`git rev-parse --abbrev-ref HEAD`);
   - `git rev-parse HEAD` equals `startingCommit` (full SHA);
   - `git cat-file -t <baseCommit>` returns `commit` and `baseCommit` is a full
     40-hex SHA;
   - `git merge-base --is-ancestor <baseCommit> HEAD` exits zero.

   When `round > 0`, also verify `priorResultCommit` when supplied (non-null):
   require it to be a full SHA commit object equal to or an ancestor of `HEAD`.
   Never hard-reset or rebase away from prior criticism commits.

   On a guarded-rebase continuation (the fetched input carries
   `guardedRebaseLineage`) Step 0 instead requires `baseCommit` to equal the
   lineage `ontoCommit` and `HEAD` to equal both `startingCommit` and the
   lineage `rebasedStartCommit`. On the initial bridge round
   `priorResultCommit` must equal the bound `oldResultCommit` exactly; that
   equality is the ONLY ancestry exemption — the pre-rebase result does not
   descend from the rewritten `HEAD` and must not be claimed to. Any later
   correction round's `priorResultCommit` is again equal to or an ancestor of
   `HEAD`. Record `baseVerification` with `baseCommit` set to `ontoCommit`.

   On any mismatch STOP immediately with `status: "fail"`, a precise
   `blockedReason`, and `baseVerification` set to the matching unresolvable arm
   (`path-mismatch` | `branch-mismatch` | `starting-commit-mismatch` |
   `prior-result-commit-mismatch` | `base-missing` | `base-not-commit` |
   `head-missing` | `head-not-commit` | `unrelated-histories` |
   `ancestry-unobserved`) with full SHAs or `null` — never a fabricated SHA.
   On success record
   `baseVerification: { status: "verified", relation: "equal"|"descendant",
   baseCommit, headCommit }` using full object SHAs only. These checks apply to
   every initial and criticism round. Never reset away prior task commits.

2. **Implement surgically.**
   When the private launch supplies `gitChangeCapability`, all Git mutations go
   through the dispatch-bound `git_commit` broker. On that path, never run
   `git add`, `git commit`, `git update-index`, `git update-ref`, or write a Git
   directory, common directory, ref, index, or object yourself. Read-only Git
   inspection remains permitted. A surface still on the documented held
   dispatch protocol follows its existing confined commit path and omits
   `gitReceipts`; it never invents or requests a capability. For each brokered
   checkpoint choose a stable
   `operationId` that survives a lost response, set `expectedHead` to the
   currently verified task head, and submit the closed manifest of add,
   modify, delete, or explicit rename entries. Every old/new state contains the
   authoritative repository-relative path, regular mode `100644` or `100755`,
   and lowercase SHA-256 digest of the file bytes. Do not submit symlinks,
   gitlinks, undeclared paths, inferred renames, or a manifest assembled before
   the final byte/mode measurement. Retry a lost response with the exact same
   operation id and request; retain the returned receipt verbatim in
   `gitReceipts`. A broker-capable passing result requires the complete,
   non-empty receipt chain in commit order. A changed request requires a new
   operation id.

   **Early skeleton write (load-bearing durability).** The first substantive
   action after grounding and base verification MUST be to create a durable
   partial artifact and persist it through the applicable commit path, even
   when nearly empty.Prefer
   `WIP-<taskId>.md` in the worktree root using the existing WIP partial format
   (fenced JSON header with `taskId`, `role`, `baseCommit`, `startedAt`, and a
   non-empty `checkpoints[]` of `{name,status}` where status is
   `done | todo | unmeasured`, followed by
   `## <name> <!-- cq:wip-checkpoint -->` body sections). Mark unfinished work
   `todo` or `unmeasured` rather than omitting it so a harvested partial is
   self-describing. For the parent-owned supervised full gate, use the exact
   task-local checkpoint name `trusted full gate` with status `unmeasured`.
   Preserve that checkpoint's status `unmeasured` until trusted finalization;
   synonyms such as `full-gate` do not qualify. A committed partial is worth
   more than an uncommitted complete deliverable. Do not defer the first write
   until the end of the turn.
   The early WIP-skeleton commit and the non-empty new-receipt requirement are
   exempted ONLY for the server-resolved exact-tip/no-new-commit mode of a
   guarded-rebase continuation (`guardedRebaseLineage.exactTip === true` and
   no change to make): then `resultCommit` must equal `rebasedStartCommit`,
   the fresh suffix is empty, and no `git_commit` call is made at all. Any
   guarded correction that advances the tip keeps early persistence and a
   non-empty contiguous suffix beginning at `rebasedStartCommit`.
   **Incremental persistence.** Reproduce a defect before correcting it. Match
   project conventions and do not repair unrelated faults. At natural
   checkpoints — after each measurement, probe, acceptance clause, or
   non-trivial edit batch — update the WIP artifact (or the real deliverable)
   and persist it through the applicable commit path. Keep checkpoint statuses
   honest (`done` / `todo` / `unmeasured`).
   Never couple durability to completion of the whole task.

3. **Prove changed guards.** For every test, assertion, guard, or invariant you
   add or change, deliberately make it fail, capture the expected failure,
   restore the intended bytes, and capture the pass. Hash affected files before
   mutation and after restoration. Report only observations from this run in
   `mutationTable`; if evidence is unavailable, report the gap rather than
   claiming success.

4. **Run targeted checks.** Use exact test paths when discovery matters and
   record nonzero test counts. Check wrapped prose with a multiline-aware
   operation.

   **Expected-failure tasks.** A task that declares an expected failure follows
   §6a of the implementation orchestrator. Forms (a) and (b) carry the required
   annotation, live marker, and inventory entry; form (c) needs no marker. A fix
   replaces the marker with a same-titled plain test and removes its annotation
   and inventory entry. Never use a red full gate as expected-failure evidence.

5. **Obtain a green full gate through the dispatch's trusted path.** When the
   private launch supplies `gitChangeCapability`, do **not** invoke `cq gate run`
   inside the sandbox. Finish the commit and verification in Step 6, then
   call `store_result` without `gateDurationMs` or `supervisedGateEvidence`.
   A matching `gate-pending` acknowledgement confirms durable handoff to the
   trusted parent and permits the final response. Do not wait for
   `result-stored`: the trusted parent starts the gate only after this child
   exits. If the response is lost, retry only the exact same `store_result`
   request.
   The trusted result-storage boundary holds the managed worktree effect lock,
   verifies the exact clean branch tip and receipt chain, runs the canonical
   full gate, rechecks the tip and tree, and attaches
   `supervisedGateEvidence` before the result becomes consumable. A caller must
   never mint or copy that evidence. A red, zero-test, timed-out, cancelled,
   dirty, moved-tip, or replayed attempt fails storage and cannot yield
   `result-stored`.

   On a dispatch without `gitChangeCapability`, run the full gate in the
   foreground from the worktree root exactly as
   `cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check`.
   A yielded command-session handle remains the sole full-gate attempt. Continue
   to poll that exact session or explicitly terminate it; after termination,
   continue polling and require terminal settlement before retrying the gate,
   calling `store_result`, or returning. Never launch a replacement full-gate
   attempt while the prior session remains live. Capture start/end time and
   assign its exit status immediately after the command, independent of any
   pipe or wrapper. Preserve `REAL_CHECK_EXIT=<n>`, the verbatim result tail,
   and `gateDurationMs`. Iterate until zero. An unrelated-failure claim requires
   an A/B reproduction of the same selector and signature on this tree and the
   recorded base; if confinement prevents that proof, return `fail`.

6. **Commit and verify.** Commit all task changes through the applicable path, then require:
   - `git rev-parse --verify HEAD` succeeds;
   - `git cat-file -t <head>` returns `commit`;
   - `git status --porcelain --untracked-files=all` is empty;
   - `git merge-base --is-ancestor <baseCommit> HEAD` exits zero.
     Immediately before constructing the result, rerun
     `git rev-parse --verify HEAD` and copy its stdout verbatim into
     `resultCommit`, then require
     `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.
     Rerun `git rev-parse --show-toplevel` and copy its stdout verbatim into
     `actualWorktreePath`.
     Keep the Step-0 `baseVerification` verified arm on pass (update
     `headCommit` to the final tip when it advanced under the same base).

## Result

```json
{
  "taskId": "<task id>",
  "status": "pass | fail",
  "resultCommit": "<verified head, or null on fail>",
  "branch": "implement/<taskId>",
  "actualWorktreePath": "<absolute git rev-parse --show-toplevel>",
  "filesTouched": ["<path>"],
  "gitReceipts": [{ "kind": "cq-git-change-receipt", "version": 1, "attestationId": "<id>", "generation": 1, "taskId": "<task id>", "operationId": "<stable id>", "requestDigest": "<sha256>", "oldHead": "<commit>", "newHead": "<commit>", "tree": "<tree>", "objectOids": ["<oid>"], "paths": ["<path>"], "committedAt": "<utc timestamp>" }],
  "gitLineage": "<guarded-rebase continuations only: the exact server-injected lineage object plus kind: \"guarded-rebase\"; omitted by ordinary workers>",
  "checkSummary": "<legacy REAL_CHECK_EXIT plus tail, or trusted-gate delegation summary>",
  "gateDurationMs": "<legacy dispatches only>",
  "baseVerification": {
    "status": "verified",
    "relation": "equal | descendant",
    "baseCommit": "<40-hex>",
    "headCommit": "<40-hex>"
  },
  "summary": "<what changed, how acceptance was met, and residual risk>",
  "blockedReason": "<fail only>"
}
```

The stored brokered process result contains runner-owned
`supervisedGateEvidence` instead of caller-supplied `gateDurationMs`; the child
omits both fields when calling `store_result`.

On fail with unresolvable base evidence use:
`baseVerification: { status: "unresolvable", reason: "<closed reason>",
baseCommit: <40-hex|null>, headCommit: <40-hex|null> }` — never invent a SHA.

The prompt-catalog schema is authoritative, including any conditional
`mutationTable` requirement. `pass` requires observed gate success, mutation
evidence where required, a verified commit object, a clean tree, base
ancestry, a reported `actualWorktreePath`, and verified `baseVerification`.

Submit the object through the dispatch-scoped `store_result` tool. With
`gitChangeCapability`, only a matching `gate-pending` acknowledgement permits
the final response. Without `gitChangeCapability`, only `result-stored` permits
the final response. Retry a lost response only with the exact same request. Then reply with the
prepared dispatch handle only as the exact one-line JSON
`{"attestationId":"<prepared attestation id>","generation":<prepared generation>}`
and nothing else; never return the result body or a capability.
