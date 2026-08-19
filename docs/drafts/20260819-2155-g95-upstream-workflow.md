# Upstream issues workflow (G95)

## Ledger

Canonical ledger `upstream`, prefix `U`. Required create fields: `headline`,
`package`. Only `released` satisfies `upstream:<U>` dependencies. Archiving a
non-satisfying target that still gates an active dependent is refused.

## Config

`[upstream]` kill-switches `filing` and `recheck` (`enabled`|`disabled`).
Absence or a missing key means enabled. Harness-invariant. No credentials.

## Intake

Flows record findings with `recordUpstreamIssues` (library) / `create_item` on
`upstream`. There is no extra MCP tool (T1326 surface budget).

## `/cq:upstream`

- `/cq:upstream U<n>` — explicit file or recheck
- `/cq:upstream` — batch recheck, max 10, never files

Filing requires `reportingClassification=ordinary` and `trackerKind=github`.
Other classifications stay byte-preserving and manual. Claim via
`filingOperationId`; a second prepare cannot authorize a submission.
Finalize is token-validated. Unknown submission stays claimed.

## Predicates / UI

`upstreamBlocked` is report-only. TUI lists the ledger generically. Web
renders http(s) report/prior-art links and an informational blocked-ids
indicator.

## Backfill

T820 found zero unmapped third-party faults in this store.
