---
description: Portable adversarial implementation-review rubric and structured verdict contract.
---

{{cq:fragment:cq-command-invocation}}

## Catalogue
```yaml
inputs:
  - "task specification, worktree/branch/full-SHA base, worker result, round, and prior criticism"
outputs:
  - "one fenced structured verdict"
ioSchema:
  - "{taskId,verdict,criticism[],questions[],defects[],rationale,gateReRan,resultCommitVerified,resultCommitEvidence,baseAncestry,gateDurationMs?,gateReRanReason?,summary?}"
```

Review one implementation against the actual diff and task acceptance. Verify:

- acceptance through its named command, output, or invariant;
- **result-commit evidence:** `git cat-file -t <resultCommit>` is
  `commit`, and `git rev-parse --verify <branch>` full SHA equals
  `resultCommit`. On success
  `resultCommitEvidence: { status: "verified", resultCommit, branchTip }` with
  full SHAs and `resultCommitVerified: true`. On failure
  `resultCommitVerified: false` and unresolvable evidence with a closed reason
  and nullable observed SHAs — never invent a SHA;
- **base-ancestry evidence:** resolve dispatch `baseCommit`, compute
  `merge-base`, and require
  `git merge-base --is-ancestor <baseCommit> <resultCommit>`. On success
  `baseAncestry: { status: "verified", relation, baseCommit, resultCommit,
  mergeBase }` with full SHAs. On failure unresolvable evidence with a closed
  reason (`not-ancestor` vs missing/non-commit objects). Approval requires both
  verified arms;
- gate evidence: either re-run `bun run check` with the foreground process's
  real status and measured duration, or — when the dispatch carries
  `parentGateAttestation` on the sandbox-denied path — verify that attestation
  (`resultCommit` match, `gateExitCode === 0`, `failCount === 0`,
  `passCount > 0`) and set `gateReRan=false` with
  `gateReRanReason=sandbox-denied-primitives` instead of invoking `cq gate`;
- correctness, boundary handling, type safety, and surgical scope;
- defect-fix reproduction and regression coverage.

For a task that declares an expected failure, apply §6a of the implementation
orchestrator. Forms (a) and (b) require the annotation, live marker, and
inventory entry; form (c) needs no marker. A completed fix replaces the marker
with a same-titled plain test and removes the annotation and inventory entry.
Reject co-deletion of that triple when no same-titled plain test remains, and
never approve a red full gate.

Classify each finding once:

- `criticism`: objective defects the worker can fix;
- `questions`: unresolved user-only requirements or product choices;
- `defects`: out-of-scope or pre-existing faults for separate work.

Discoverable facts, scope magnitude, and whether to fix a confirmed fault are
not questions.

```json
{
  "taskId": "<task id>",
  "verdict": "approve | disapprove",
  "criticism": ["<worker-fixable defect>"],
  "questions": ["<user-only ambiguity>"],
  "defects": [
    {
      "headline": "<out-of-scope fault>",
      "description": "<evidence and scope boundary>",
      "severity": "low | medium | high | critical",
      "suggestedFix": "<optional>"
    }
  ],
  "rationale": "<decisive evidence>",
  "gateReRan": true,
  "resultCommitVerified": true,
  "resultCommitEvidence": {
    "status": "verified",
    "resultCommit": "<40-hex>",
    "branchTip": "<40-hex>"
  },
  "baseAncestry": {
    "status": "verified",
    "relation": "equal | descendant",
    "baseCommit": "<40-hex>",
    "resultCommit": "<40-hex>",
    "mergeBase": "<40-hex>"
  },
  "gateDurationMs": 12345,
  "summary": "<optional one-line verdict>"
}
```

Always state `gateReRan`, `resultCommitVerified`, `resultCommitEvidence`, and
`baseAncestry`. Include `gateDurationMs` only when the gate ran; otherwise
include an optional `gateReRanReason` (exactly `sandbox-denied-primitives` on
the parent-attested path). Approval requires empty criticism/questions, a green
gate (child re-run or verified parent attestation), verified result commit, and
verified base ancestry with full SHAs. Disapproval requires criticism or
questions and may carry unresolvable evidence. Defects do not control the
verdict.

Write nothing. Give a brief session summary, then end with the fenced object.
