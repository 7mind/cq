---
ledger: tasks
counters:
  milestone: 0
  item: 9
archives: []
---

# tasks

## M1

### T1 — done

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Bootstrap the repository
- description: Initialise the Bun workspace, eslint/prettier, and the flake dev shell.
- acceptance: bun install + bun test green

### T2 — done

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Define the ledger data model
- description: Milestones own typed items; ids are per-ledger monotonic with a prefix.

### T3 — wip

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: user
- session: seed-20260601
- headline: Wire up CI
- description: Run typecheck, lint and tests on every push.
- tags: ["infra"]

## M2

### T4 — wip

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Implement the markdown parser
- description: |
    Frontmatter plus grouped items must round-trip **losslessly**.
    
    Cases that must survive a read:
    
    - inline `code`, *emphasis*, and [links](https://example.test)
    - fenced code blocks
    - blank lines between paragraphs
    
    ```ts
    const back = parseLedger(serializeLedger(ledger));
    assert.deepEqual(back, ledger);
    ```
    
    > Field values are stored as YAML field lines under each item heading.

### T5 — planned

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Add the file-store mutex + lockfile
- description: Serialise concurrent writers on a per-ledger lockfile so two processes cannot corrupt a file.

### T6 — planned

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Build the full-text search index
- description: Cross-ledger ranked search over item fields, backed by minisearch.
- dependsOn: ["tasks:T4"]

## M3

### T7 — planned

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Item table + detail panel
- description: Browse a ledger's items in a table; click one to view and edit its fields.

### T8 — blocked

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Milestone DAG layout
- description: Lay out the milestone dependency graph (dependsOn/blockedBy) as a left-to-right DAG.
- blockedBy: ["tasks:T7"]

## M4

### T9 — planned

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- author: "opus-4.8[1m]"
- session: seed-20260601
- headline: Marketing landing page
- description: A static page describing the project with install instructions.
