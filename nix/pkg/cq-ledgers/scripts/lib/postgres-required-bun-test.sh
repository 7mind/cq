#!/usr/bin/env bash
# Required-PostgreSQL Bun test runner (G192/T6627).
#
#   postgres-required-bun-test.sh <file>...
#     Check every listed path, provision an ephemeral cluster, run
#     `bun test <file>...`, and accept only a transcript the classifier admits.
#   postgres-required-bun-test.sh --classify <transcript-path> <expected-file-count>
#     Classify a saved transcript only; never provisions PostgreSQL or runs Bun.
#
# Both modes share classify_bun_transcript, so the admission policy cannot
# diverge between the live run and its offline fixtures.
set -euo pipefail

# Rejects a skipped or todo test, a missing pass line, and a missing or
# mismatched `Ran N tests across M files.` summary. Bun prints no skip line
# for zero skips, so absence of the line is the zero-skip signal.
classify_bun_transcript() {
  local transcript="$1"
  local expected_files="$2"
  if grep -Eq '^ *[1-9][0-9]* (skip|todo)$' "$transcript"; then
    echo "required-PostgreSQL run skipped or deferred tests:" >&2
    grep -E '^ *[1-9][0-9]* (skip|todo)$' "$transcript" >&2
    return 1
  fi
  if ! grep -Eq '^ *[1-9][0-9]* pass$' "$transcript"; then
    echo "required-PostgreSQL run reported no passing tests" >&2
    return 1
  fi
  local summary
  summary="$(grep -E '^Ran [0-9]+ tests? across [0-9]+ files?\.' "$transcript" | tail -n 1 || true)"
  if [[ -z "$summary" ]]; then
    echo "required-PostgreSQL run printed no 'Ran ... across ...' summary" >&2
    return 1
  fi
  local actual_files
  actual_files="$(sed -E 's/^Ran [0-9]+ tests? across ([0-9]+) files?\..*$/\1/' <<<"$summary")"
  if [[ "$actual_files" != "$expected_files" ]]; then
    echo "required-PostgreSQL run covered $actual_files files; expected $expected_files" >&2
    return 1
  fi
  return 0
}

if [[ "${1:-}" == "--classify" ]]; then
  if [[ $# -ne 3 ]]; then
    echo "usage: $0 --classify <transcript-path> <expected-file-count>" >&2
    exit 2
  fi
  classify_bun_transcript "$2" "$3"
  exit $?
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <file>... | --classify <transcript-path> <expected-file-count>" >&2
  exit 2
fi

ledger_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ledger_root"

# Bun silently drops a missing path filter when another path matches
# (D564 / oven-sh/bun#44002), so every path is checked before provisioning.
for test_file in "$@"; do
  if [[ ! -f "$test_file" ]]; then
    echo "missing test file: $test_file" >&2
    exit 1
  fi
done

repository_root="$(git -C "$ledger_root" rev-parse --show-toplevel)"
postgres_bin="${CQ_TEST_POSTGRES_BIN:-}"

if [[ -z "$postgres_bin" ]] && command -v initdb >/dev/null && command -v pg_ctl >/dev/null; then
  postgres_bin="$(dirname "$(command -v initdb)")"
fi

if [[ -z "$postgres_bin" ]]; then
  postgres_root="$(
    nix build --no-link --print-out-paths --inputs-from "$repository_root" 'nixpkgs#postgresql^out'
  )"
  postgres_bin="$postgres_root/bin"
fi

for executable in initdb pg_ctl pg_isready; do
  if [[ ! -x "$postgres_bin/$executable" ]]; then
    echo "PostgreSQL executable is unavailable: $postgres_bin/$executable" >&2
    exit 1
  fi
done

postgres_tmp="$(mktemp -d /tmp/cq-required-pg.XXXXXX)"
postgres_data="$postgres_tmp/data"
postgres_socket="$postgres_tmp/socket"
postgres_log="$postgres_tmp/postgres.log"
transcript="$postgres_tmp/bun-test.log"
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
    /tmp/cq-required-pg.*) rm -rf -- "$postgres_tmp" ;;
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

set +e
bun test "$@" 2>&1 | tee "$transcript"
bun_exit="${PIPESTATUS[0]}"
set -e
if [[ "$bun_exit" -ne 0 ]]; then
  exit "$bun_exit"
fi
classify_bun_transcript "$transcript" "$#"
