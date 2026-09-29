#!/usr/bin/env bash
set -euo pipefail

# G192/T6628. Later memory tasks append their PostgreSQL arms in order
# (owned-write, then finalize); this list never shrinks.
exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/postgres-required-bun-test.sh" \
  packages/ledger/test/store-postgres.test.ts \
  packages/ledger/test/workset-generic-mutation-postgres.test.ts \
  packages/ledger/test/memory-authority-postgres.test.ts
