---
description: Portable adversarial implementation-review rubric and structured verdict contract.
---

{{cq:fragment:cq-command-invocation}}

## Catalogue
```yaml
inputs:
  - "task specification, worktree/branch/base, worker result, round, and prior criticism"
outputs:
  - "one fenced structured verdict"
ioSchema:
  - "{taskId,verdict,criticism[],questions[],defects[],rationale,gateReRan,resultCommitVerified,gateDurationMs?,gateReRanReason?,summary?}"
```

Review one implementation against the actual diff and task acceptance. Verify:

- acceptance through its named command, output, or invariant;
- `resultCommit` exists as a commit and equals the worker branch tip;
- gate evidence: either re-run `bun run check` with the foreground process's
  real status and measured duration, or — when the dispatch carries
  `parentGateAttestation` on the sandbox-denied path — verify that attestation
  (`resultCommit` match, `gateExitCode === 0`, `failCount === 0`,
  `passCount > 0`) and set `gateReRan=false` with
  `gateReRanReason=sandbox-denied-primitives` instead of invoking `cq gate`;
- correctness, boundary handling, type safety, and surgical scope;
- defect-fix reproduction and regression coverage.

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
  "gateDurationMs": 12345,
  "summary": "<optional one-line verdict>"
}
```

Always state `gateReRan` and `resultCommitVerified`. Include
`gateDurationMs` only when the gate ran; otherwise include an optional
`gateReRanReason` (exactly `sandbox-denied-primitives` on the parent-attested
path). Approval requires empty criticism/questions, a green gate (child re-run
or verified parent attestation), and verified result commit. Disapproval
requires criticism or questions. Defects do not control the verdict.

Write nothing. Give a brief session summary, then end with the fenced object.
