#!/usr/bin/env bash
set -euo pipefail

# D579: the shared helper provisions the cluster and rejects any skipped,
# todo, pass-less, or file-count-short run, which a bare `bun test` accepts.
exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/postgres-required-bun-test.sh" \
  packages/cq-config/test/attestation-queue-upgrade.test.ts \
  packages/cq-config/test/attestationStore-postgres.test.ts \
  packages/ledger-mcp/test/implementation-candidate-coordinator-race-postgres.test.ts \
  packages/ledger/test/attestationConstruction-postgresHub.test.ts \
  packages/ledger/test/work-cohort-postgres.test.ts \
  packages/ledger/test/work-cohort-completion-postgres.test.ts
