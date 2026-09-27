#!/usr/bin/env bash
set -euo pipefail

exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/postgres-required-bun-test.sh" \
  packages/ledger/test/store-postgres.test.ts
