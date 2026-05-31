---
ledger: defects
counters:
  milestone: 0
  item: 3
archives: []
---

# defects

## M2

### D1 — open

- createdAt: 2026-05-31T23:23:37.880Z
- updatedAt: 2026-05-31T23:23:37.880Z
- headline: Parser drops a trailing newline on serialize
- description: Round-tripping a ledger removes the final newline, producing a noisy git diff.
- severity: minor

### D3 — resolved

- createdAt: 2026-05-31T23:23:37.902Z
- updatedAt: 2026-05-31T23:23:37.902Z
- headline: FTS ignores hyphenated ids
- description: Searching for an id like D-12 returned no results.
- severity: minor
- fix: tokenizer keeps id-shaped tokens whole

## M3

### D2 — wip

- createdAt: 2026-05-31T23:23:37.891Z
- updatedAt: 2026-05-31T23:23:37.891Z
- headline: Status filter resets on page reload
- description: The selected status filter is not persisted, so a reload shows all items again.
- severity: major
- rootCause: filter state not persisted to the URL
