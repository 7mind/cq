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
- any rerun `bun run check` uses the foreground process's real status and
  measured duration;
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
`gateReRanReason`. Approval requires empty criticism/questions, a green gate,
and verified result commit. Disapproval requires criticism or questions.
Defects do not control the verdict.

Write nothing. Give a brief session summary, then end with the fenced object.
