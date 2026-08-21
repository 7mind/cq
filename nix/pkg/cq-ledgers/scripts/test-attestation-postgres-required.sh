#!/usr/bin/env bash
set -euo pipefail

ledger_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repository_root="$(git -C "$ledger_root" rev-parse --show-toplevel)"
postgres_bin="${CQ_TEST_POSTGRES_BIN:-}"

if [[ -z "$postgres_bin" ]] && command -v initdb >/dev/null && command -v pg_ctl >/dev/null; then
  postgres_bin="$(dirname "$(command -v initdb)")"
fi

if [[ -z "$postgres_bin" ]]; then
  postgres_root="$(
    nix build --no-link --print-out-paths --inputs-from "$repository_root" nixpkgs#postgresql
  )"
  postgres_bin="$postgres_root/bin"
fi

for executable in initdb pg_ctl pg_isready; do
  if [[ ! -x "$postgres_bin/$executable" ]]; then
    echo "PostgreSQL executable is unavailable: $postgres_bin/$executable" >&2
    exit 1
  fi
done

postgres_tmp="$(mktemp -d /tmp/cq-attestation-pg.XXXXXX)"
postgres_data="$postgres_tmp/data"
postgres_socket="$postgres_tmp/socket"
postgres_log="$postgres_tmp/postgres.log"
postgres_started=0

cleanup() {
  local exit_code=$?
  local cleanup_code=0
  trap - EXIT
  set +e
  if [[ "$postgres_started" -eq 1 ]]; then
    "$postgres_bin/pg_ctl" -D "$postgres_data" -m immediate -w stop
    cleanup_code=$?
  fi
  case "$postgres_tmp" in
    /tmp/cq-attestation-pg.*) rm -rf -- "$postgres_tmp" ;;
    *)
      echo "Refusing to remove unexpected PostgreSQL temporary path: $postgres_tmp" >&2
      cleanup_code=1
      ;;
  esac
  if [[ "$exit_code" -eq 0 && "$cleanup_code" -ne 0 ]]; then
    exit_code=$cleanup_code
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$postgres_socket"
postgres_port="$(bun -e 'console.log(20_000 + crypto.getRandomValues(new Uint16Array(1))[0] % 20_000)')"

"$postgres_bin/initdb" \
  --pgdata="$postgres_data" \
  --username=cq \
  --auth=trust \
  --encoding=UTF8 \
  --no-locale \
  >/dev/null
postgres_started=1
if ! "$postgres_bin/pg_ctl" \
  -D "$postgres_data" \
  -l "$postgres_log" \
  -o "-F -h 127.0.0.1 -p $postgres_port -k $postgres_socket" \
  -w start; then
  cat "$postgres_log" >&2
  exit 1
fi

"$postgres_bin/pg_isready" \
  --host=127.0.0.1 \
  --port="$postgres_port" \
  --username=cq \
  --dbname=postgres

export CQ_TEST_PG_URL="postgresql://cq@127.0.0.1:$postgres_port/postgres?sslmode=disable"
export CQ_TEST_REQUIRE_PG=1

cd "$ledger_root"
bun test packages/cq-config/test/attestationStore-postgres.test.ts
