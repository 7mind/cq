# dev/ — local dev/test Postgres

`@cq/ledger`'s Postgres backend (G81/M248) is exercised by a set of
env-gated suites that skip cleanly when no server is reachable:
`packages/ledger/test/postgres-*.test.ts`, `store-postgres.test.ts`,
`multi-writer-stress-postgres.test.ts`, the postgres block of
`backup-exporter.test.ts`, and the `packages/cq-cli/test/*-postgres.test.ts`
suites (log-put / reset-erase / backup-restore). All of them gate on the
same `CQ_TEST_PG_URL` environment variable (Q286) — a `postgres://` DSN
pointing at a throwaway database.

## Bring one up with docker/podman compose

```sh
docker compose -f dev/docker-compose.postgres.yml up -d
export CQ_TEST_PG_URL=postgres://cq:cq@localhost:5432/cq_test
bun test   # run from nix/pkg/cq-ledgers/
```

(`podman-compose -f dev/docker-compose.postgres.yml up -d` works the same
way if you use podman instead of docker.)

Tear down when done:

```sh
docker compose -f dev/docker-compose.postgres.yml down -v
```

Each suite registers its own tenant(s) (`projects` row, `project_key`) per
test/run, so the same server can be reused across runs without manual
cleanup — leftover tenants from prior runs never collide with a fresh one.

Without `CQ_TEST_PG_URL` set, every one of these suites skips offline and
`bun run check` stays green.
