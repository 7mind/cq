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

- createdAt: 2026-05-31T23:23:37.674Z
- updatedAt: 2026-05-31T23:23:37.674Z
- title: ambient

### M1 — open

- createdAt: 2026-05-31T23:23:37.721Z
- updatedAt: 2026-05-31T23:23:37.721Z
- title: Project Foundations

### M2 — open

- createdAt: 2026-05-31T23:23:37.730Z
- updatedAt: 2026-05-31T23:23:37.730Z
- title: Core Ledger Engine
- dependsOn: ["M1"]

### M3 — open

- createdAt: 2026-05-31T23:23:37.738Z
- updatedAt: 2026-05-31T23:23:37.738Z
- title: Web Console
- dependsOn: ["M2"]

### M4 — blocked

- createdAt: 2026-05-31T23:23:37.745Z
- updatedAt: 2026-05-31T23:23:37.754Z
- title: Public Launch
- blockedBy: ["M3"]
- dependsOn: ["M2"]
