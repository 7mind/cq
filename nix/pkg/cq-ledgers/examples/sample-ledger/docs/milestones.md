---
ledger: milestones
counters:
  milestone: 0
  item: 5
archives: []
---

# milestones

## active

### M-AMBIENT — open

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- title: ambient

### M1 — open

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- title: Project Foundations

### M2 — open

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- title: Core Ledger Engine
- dependsOn: ["milestones:M1"]

### M3 — open

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- title: Web Console
- dependsOn: ["milestones:M2"]

### M4 — blocked

- createdAt: 2026-06-01T12:00:00.000Z
- updatedAt: 2026-06-01T12:00:00.000Z
- title: Public Launch
- blockedBy: ["milestones:M3"]
- dependsOn: ["milestones:M2"]
