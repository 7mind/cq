# dev/ — throwaway PostgreSQL for `cq serve` and hub-internal suites

PostgreSQL is private `cq serve` state. Project checkouts use
`backend = "remote"`; they do not set `backend = "postgres"`. The DSN below
is for the hub process and for env-gated hub-internal tests.

Operator commands: [`docs/drafts/20260819-2230-g81-remote-owner.md`](../../../../docs/drafts/20260819-2230-g81-remote-owner.md).

Hub-internal suites (`packages/ledger/test/postgres-*.test.ts`,
`store-postgres.test.ts`, `attestationStore-postgres.test.ts`, the
`cq serve` live boot/routing tests) gate on `CQ_TEST_PG_URL` (Q286). Public
CLI `*-postgres.test.ts` files now assert retirement, not a public backend.

## Bring one up with docker/podman compose

```sh
docker compose -f dev/docker-compose.postgres.yml up -d
export CQ_TEST_PG_URL=postgres://cq:cq@localhost:5432/cq_test
bun test   # run from nix/pkg/cq-ledgers/
```

(`podman compose -f dev/docker-compose.postgres.yml up -d` works the same
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
