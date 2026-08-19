---
description: File or recheck one ordinary GitHub upstream item, or batch-recheck at most 10.
argument-hint: "[U<n>]"
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:ledger-response-contract}}

## Catalogue
```yaml
inputs:
  - "optional upstream id U<n>; empty means batch-recheck"
outputs:
  - "at most one authorized filing claim, or a bounded recheck plan, then token-validated bookkeeping"
ioSchema:
  - "explicit U<n> may file or recheck; no-id batch never files"
```

This is a single-shot non-flow command. There is no `:advance`, no `pUpstream`,
and no sequencer stage.

Read `get_config` section `all` and honor `[upstream]` kill-switches
(default enabled). `filing` gates only explicit-id prepare-to-file.
`recheck` gates recheck. Credentials never come from cq.toml.

## Modes

### `CQ::upstream U<n>`

Fetch `upstream:U<n>`.

- `open` + filing enabled → prepare a filing claim (`filingOperationId`,
  `filingState=claimed`, `filingClaimedAt`) via `update_item`. Only the
  winner of that compare-and-set may submit. If already claimed, stop and
  reconcile; do not file.
- `reported` / `accepted` / `fixed-upstream` + recheck enabled → recheck.
- `released` / `wontfix` → no-op.

### `CQ::upstream` (no id)

Batch-recheck only. Select at most 10 items: never-checked first, then
oldest `lastCheckedAt`, then id. Never file. If recheck is disabled, stop.

## Fail-closed before observation

Do not observe or mutate when:

- `reportingClassification` is missing, uncertain, or not exactly `ordinary`
- `trackerKind` is not exactly `github`

Print manual instructions and leave every item byte unchanged.

## Observations

Host tools gather evidence. Then apply only these mutations:

- attempted auth / private / rate / offline / 5xx / ambiguous →
  `lastCheckedAt` + `lastCheckOutcome` only
- confirmed report URL → may add `reportUrls` / `trackingUrl` and
  `open`→`reported` when the claim token matches
- confirmed upstream release → `fixed-upstream`/`accepted`/`reported`→`released`
- unknown submission outcome → `filingState=reconciliation-required`;
  keep the claim; search open+closed reports before any retry
- never apply a generic unguarded status rewrite that skips the claim token

Log the session with `cq log put`. Sanitize evidence. Do not store tokens.
