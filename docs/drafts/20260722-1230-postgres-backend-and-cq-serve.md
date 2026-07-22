# Postgres Backend & cq serve Documentation (T591)

## Overview

The postgres backend is an opt-in, multi-tenant external storage layer for the cq ledger suite. Instead of storing ledger data in the filesystem (`fs`, legacy), git objects (`git-object`, legacy), or the out-of-tree xdg SQLite primary, it uses a shared PostgreSQL database where **ONE database holds every project's rows**, isolated by tenant key. This is groundwork for the `cq serve` multi-project hub server, which hosts every registered tenant in that shared database.

## Quick Start

### Prerequisites
- A PostgreSQL 12+ server (local dev or remote)
- The cq ledger suite (Bun workspace at `nix/pkg/cq-ledgers/`)

### Option 1: Docker Compose (recommended for local development)

Create `docker-compose.yaml` in your repo root:

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust  # local dev only; password-less
      POSTGRES_DB: cq_ledger
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
volumes:
  postgres_data:
```

Boot the stack:

```bash
docker-compose up -d
```

Export the DSN for testing:

```bash
export CQ_TEST_PG_URL="postgres://postgres:@localhost:5432/cq_ledger"
```

Run the test suite (env-gated postgres tests):

```bash
bun test
```

Tear down:

```bash
docker-compose down
docker volume rm <compose-dir>_postgres_data  # optional; clean up volumes
```

### Option 2: Nix (in-repo alternative, used in CI)

If you have nix + direnv:

```bash
# Enter an ephemeral shell with postgres on PATH; every command below runs
# INSIDE this shell (nix shell without -c drops you into an interactive
# subshell — a straight paste of this whole block therefore works only if
# you paste it AFTER this line has started the shell).
nix shell nixpkgs#postgresql

# Initialize a fresh cluster
initdb -D /tmp/cq_pg_test

# Start the server on a unix socket (short path avoids path-length limits)
postgres -D /tmp/cq_pg_test -k /tmp -F &
sleep 1

# Create the database
createdb -h /tmp cq_ledger

# Export the DSN
export CQ_TEST_PG_URL="postgres:///cq_ledger?host=/tmp"

# Run tests (from nix/pkg/cq-ledgers; the env-gated postgres suites
# activate whenever CQ_TEST_PG_URL is set)
bun test

# Shut down postgres
pkill postgres
rm -rf /tmp/cq_pg_test
```

## Opting In: Configuration

### File-Based Config (cq.toml)

Edit or create `cq.toml` in your repo root and set the backend:

```toml
[ledger]
  backend = "postgres"
  url     = "postgres://localhost:5432/cq_ledger"   # credential-less; see CQ_LEDGER_PG_URL below
  backup  = "none"
```

### DSN Resolution Precedence

The postgres backend resolves a connection string (DSN) in this order:

1. **`CQ_LEDGER_PG_URL`** — explicit ledger-specific override (highest precedence)
   - Example: `export CQ_LEDGER_PG_URL="postgres://user:password@remote.host:5432/cq_ledger"`

2. **`DATABASE_URL`** — conventional cross-tool env var (e.g., Heroku, Fly, Railway)
   - Example: `export DATABASE_URL="postgres://user:password@remote.host:5432/cq_ledger"`

3. **`[ledger].url` in cq.toml** — committed, credential-less default
   - Example: `url = "postgres://localhost:5432/cq_ledger"` (no password)

4. **Standard libpq env vars** — `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSERVICE`, `PGSSLMODE`, `PGOPTIONS`, `PGPASSFILE`, `PGAPPNAME`
   - The driver reads these directly; not concatenated into a DSN here

5. **Fail fast** — If none of the above is set, startup fails with `PostgresDsnResolutionError`

### Secret Hygiene

**Never commit plaintext passwords to the `[ledger].url` key.** It is version-controlled and visible to all repo collaborators.

- ✓ **Safe:** `[ledger].url = "postgres://localhost:5432/cq_ledger"` (no credentials)
- ✗ **Never:** `[ledger].url = "postgres://user:password@host:5432/cq_ledger"` (credentials exposed in git history)

Use environment variables for credentials:

```bash
# Development
export CQ_LEDGER_PG_URL="postgres://user:password@localhost:5432/cq_ledger"

# CI/production (injected by the platform)
export CQ_LEDGER_PG_URL="postgres://user:secret@production.host:5432/cq_ledger"
```

### Project Metadata

Optionally set a display name for your project in `cq.toml`:

```toml
[project]
  name = "My Project"
```

This name appears in the ledger-web/ledger-tui header and the `cq serve` project selector. If omitted, the display name defaults to:
1. `[ledger].projectId` (if set)
2. Repo root directory basename
3. The resolved `projectKey` itself

## Migration: Moving from xdg to Postgres

### Prerequisites
- An existing repo already using the xdg backend (check `[ledger] backend = "xdg"` in `cq.toml`)
- A target postgres database (local or remote)

### Steps

1. **Verify current backend:**
   ```bash
   grep "backend" cq.toml
   # Should show: backend = "xdg"
   ```

2. **Ensure postgres connectivity:**
   ```bash
   export CQ_LEDGER_PG_URL="postgres://user:password@host:5432/cq_ledger"
   # Test: psql (or bun) can connect
   ```

3. **Run the migration:**
   ```bash
   cq migrate --to postgres
   ```

   This command:
   - Reads the entire xdg primary (all ledgers, items, logs, timestamps, authors)
   - Validates the target postgres database (empty tenant required; no merge semantics)
   - Writes every row faithfully into one postgres tenant
   - Flips `[ledger] backend` to `"postgres"` in `cq.toml`
   - **Leaves the xdg primary untouched** (you delete it manually once confident)

4. **Verify migration:**
   ```bash
   # Check [ledger] backend is now postgres
   grep "backend" cq.toml
   
   # Verify ledgers are readable
   cq init  # (safe; just initializes canonical ledger set if missing)
   ```

5. **Clean up (optional):**
   ```bash
   # Remove the old xdg primary
   rm -rf ~/.local/state/cq/projects/<projectKey>/
   
   # Or list all xdg stores:
   ls -la ~/.local/state/cq/projects/
   ```

## Multi-Tenancy Model

The postgres backend stores **every project in ONE shared database**, using tenant isolation:

### Schema

All tables have a leading `project_key` column in their PRIMARY KEY:

```sql
-- The projects registry — one row per tenant
CREATE TABLE projects (
  project_key  TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger definitions (ledgers, groups, items, archives, etc.)
-- All keyed by (project_key, name) or (project_key, ledger, id), etc.
CREATE TABLE ledgers (
  project_key TEXT NOT NULL REFERENCES projects(project_key),
  name        TEXT NOT NULL,
  ...
  PRIMARY KEY (project_key, name)
);

-- Item storage
CREATE TABLE items (
  project_key TEXT NOT NULL,
  ledger      TEXT NOT NULL,
  id          TEXT NOT NULL,
  ...
  PRIMARY KEY (project_key, ledger, id),
  FOREIGN KEY (project_key, ledger) REFERENCES ledgers(project_key, name)
);

-- Log artifacts (stored as text, not BYTEA)
CREATE TABLE logs (
  project_key TEXT NOT NULL REFERENCES projects(project_key),
  path        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_key, path)
);

-- Per-database schema version (not per-tenant)
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Key Invariants

- **One database, many tenants:** Every project's rows live in the same database, keyed by `project_key`
- **Schema version is per-database:** The `meta` table's `schema_version` applies to the whole database, not per-tenant
- **Tenant registration:** The `projects` table lists every registered tenant with its display name
- **Self-registering migrations:** `cq migrate --to postgres` creates the tenant's `projects` row automatically
- **Concurrent bootstrap:** Schema creation runs under a `pg_advisory_lock` (key `847501001`) so multiple connecting instances never race CREATE TABLE statements

## Coherence & Change Detection (LISTEN/NOTIFY)

Unlike the xdg backend (which polls `PRAGMA data_version`), the postgres backend uses PostgreSQL's LISTEN/NOTIFY for **push-based change detection**:

### How It Works

1. Every ledger write triggers a `NOTIFY` on the `LEDGER_CHANGE_CHANNEL` with payload = `project_key`
2. A **dedicated LISTEN connection** (using the `porsager` `postgres` package) subscribes to that channel
   - *Note:* Bun.sql does not yet implement LISTEN, so `porsager` is a temporary seam (see research RS1 conclusion). Once Bun.sql ships LISTEN support, this can collapse onto Bun.sql.
3. The watcher **filters notifications to its own `project_key`** (shared channel, many tenants)
4. On notification: **bulk-invalidate every ledger**, then fire `onChange(null)`
5. **Auto-reconnection:** If the LISTEN connection drops, `porsager` auto-reconnects with backoff, then performs a full re-invalidate (missed-notification safety)

### Performance

- **Low latency:** Push-based, not poll-based
- **Efficient:** One LISTEN connection per store (not one per ledger)
- **Safe:** Missed notifications covered by full re-invalidate on reconnect (no scope needed — a write bump carries no per-ledger granularity)

## Backup & Restore (Project-Scoped)

Backup/restore is **project-scoped** — one project's dump, not the whole database.

### `cq backup` — Export

Export a human-readable `.cq` dump of the tenant's state + logs:

```bash
cq backup
```

Target location is determined by `[ledger].backup` mode:
- `"in-tree"` → `.cq/` directory (tracked by git, human-readable)
- `"orphan-branch"` → orphan git ref (default: `refs/heads/cq-ledger`)
- `"none"` (default) → no backup (write-only)

Backup is **write-only** — never read back as the primary. It is a human-readable snapshot for disaster recovery planning.

### `cq restore` — Disaster Recovery

Import a `.cq` dump back into the postgres tenant:

```bash
cq restore
```

**Fail-safe conditions:**
- The tenant must be **empty** (no existing rows); otherwise, the restore is refused without `--yes`
- **No merge semantics** — a restore is an all-or-nothing recovery path, not a merge
- Source is determined by `[ledger].backup` mode (same as backup)

### Whole-Database Backup

For whole-database backups (covering all tenants), use **`pg_dump`**:

```bash
pg_dump postgres://user:password@host:5432/cq_ledger > backup.sql
```

This is the operator's story for full database snapshots. The `cq` commands (backup/restore) handle only project scope.

## CLI Operations

### `cq init` (Initialize Ledgers)

Create the canonical ledger set for your project:

```bash
cq init
```

For postgres backend, this:
- Ensures the schema (idempotent)
- Creates the `projects` registry entry if missing
- Initializes the canonical ledgers (tasks, defects, hypotheses, etc.)

### `cq reset` (Tenant Wipe + Reinit)

Destructively reinitialize ledgers:

```bash
cq reset [--yes|-y]
```

- Non-interactive (`--yes`): proceed without prompting
- TTY (default): prompt for confirmation
- Non-TTY without `--yes`: refuse (no surprise wipes)

Unlike the fs backend's reset (which snapshots before reinit), the postgres
path takes NO pre-wipe backup of its own: with `[ledger].backup = "none"` it
wipes the tenant's rows with no snapshot (run `cq backup` first if you want a
pre-wipe dump), and with `backup != "none"` it fails fast with
`PostgresBackupNotWiredError` rather than silently skipping the snapshot.

### `cq erase` (Remove Tenant Rows)

Remove the tenant's entire state from postgres:

```bash
cq erase [--yes|-y]
```

Completely wipes the tenant's rows from the database (no recovery without a backup).

## cq serve: Multi-Tenant Hub Server

`cq serve` is a pure-CLI multi-tenant hub server that hosts **every registered project** in a shared postgres database, with no dependency on a ledger root or `cq.toml`. Instead, config is **pure CLI + environment**.

### Command Syntax

```bash
cq serve --pg-url <dsn> [--host <h>] [--port <n>] [--token <t>]
```

### Flags

- **`--pg-url <dsn>`** — explicit postgres DSN override (highest precedence)
- **`--host <h>`** — bind address (default: `127.0.0.1`, loopback)
- **`--port <n>`** — bind port (default: `5190`, distinct from `cq web`'s `5180`)
- **`--token <t>`** — optional API token for authentication

### Environment Fallbacks (if `--pg-url` absent)

1. `CQ_LEDGER_PG_URL` — highest-precedence env override
2. `DATABASE_URL` — conventional cross-tool var

Note: unlike the per-repo `resolvePostgresDsn` (mcp/tui/web modes), the hub
reads NEITHER `cq.toml [ledger].url` NOR the `PG*` driver defaults — with no
`--pg-url` and neither env var set, `cq serve` fails fast naming exactly
these three sources.

### Authentication (Q273)

**Loopback bind** (127.0.0.1 / localhost / ::1):
- `--token` is **optional**; open access by default

**Non-loopback bind** (0.0.0.0 / LAN IP / hostname):
- `--token` is **required** (startup fails without it)
- Clear, actionable error if missing

**Token enforcement (when set):**

| Endpoint                          | Auth Method                           | Details                                    |
|-----------------------------------|---------------------------------------|--------------------------------------------|
| `/api/projects`                   | `Authorization: Bearer <token>`       | Fetch the projects registry                |
| `/p/<projectKey>/mcp`             | `Authorization: Bearer <token>`       | HTTP MCP transport for the tenant          |
| `/p/<projectKey>/ws`              | `?token=<token>` query param          | WebSocket upgrade (browsers cannot set headers) |
| `GET /` + static assets           | (unauthenticated)                     | UI serves regardless of `--token`          |

**Token comparison:** Constant-time (SHA-256 hashed, `crypto.timingSafeEqual`) to prevent timing-based attacks.

### Endpoints

| Method | Path                  | Purpose                                                     |
|--------|----------------------|-------------------------------------------------------------|
| GET    | `/`                  | Serve the ledger-web static bundle (same React app as `cq web`) |
| GET    | `/api/projects`      | Fetch the projects registry (list of registered tenants)    |
| GET    | `/p/<key>/mcp`       | HTTP MCP transport for project `<key>`                      |
| GET    | `/p/<key>/ws`        | WebSocket upgrade for live updates on project `<key>`       |

### Project Addressing

Each project is addressed by URL path: `/p/<projectKey>/…`

- **URL-encoded keys:** If `projectKey` contains reserved characters (spaces, `/`, `?`, etc.), it is URL-encoded in the path
- **Always-visible selector:** The web UI has a project selector at the top left (T589/T590) that lists all registered tenants and allows switching without server restart
- **Dynamic rendering:** The UI fetches `/api/projects` when the selector is opened

### Example Invocation

```bash
# Start the hub on loopback (open access)
cq serve --pg-url "postgres://localhost:5432/cq_ledger"

# Or, with token protection (non-loopback bind)
cq serve --pg-url "postgres://user:password@0.0.0.0:5432/cq_ledger" \
         --host 0.0.0.0 \
         --port 5190 \
         --token "my-secret-token"
```

Open http://localhost:5190 (or http://0.0.0.0:5190?token=my-secret-token for authenticated access).

The project selector lists all registered tenants; click to switch between them without restart.

## Configuration Reference (cq.toml)

### `[ledger]` Backend Options

```toml
[ledger]
  # backend: storage backend
  #   "fs"         — in-tree .cq/ (LEGACY, don't use for new repos)
  #   "git-object" — orphan git ref (LEGACY, don't use for new repos)
  #   "xdg"        — out-of-tree bun:sqlite (DEFAULT for fresh inits)
  #   "postgres"   — shared multi-tenant Postgres database (OPT-IN, G81)
  backend   = "postgres"

  # url: DSN for postgres backend (CREDENTIAL-LESS)
  #   Example: "postgres://localhost:5432/cq_ledger" (no user/password)
  #   Resolution: env override (CQ_LEDGER_PG_URL / DATABASE_URL) > [ledger].url > PG* driver defaults
  #   SECRET HYGIENE: Never commit credentials here; use environment variables
  url       = "postgres://localhost:5432/cq_ledger"

  # backup: human-readable .cq dump mode (project-scoped)
  #   "none"            — no backup (default; OFF by default per Q244)
  #   "in-tree"         — .cq/ directory (tracked by git)
  #   "orphan-branch"   — orphan git ref (refs/heads/cq-ledger)
  backup    = "none"

  # projectId: optional committed project-identity key (Q246)
  #   Used for keying the out-of-tree primary (xdg) or postgres tenant registration
  #   Defaults to git repo root commit SHA if absent
  #   Only needed for shallow clones or repos with no stable root
  projectId = "my-project"

  # branch: git branch for git-object backend (LEGACY; meaningless for postgres/xdg)
  # branch    = "cq-ledger"

  # remote: git remote for git-object backend (LEGACY; meaningless for postgres/xdg)
  # remote    = "origin"
```

### `[project]` Table

```toml
[project]
  # name: cosmetic display name for the project
  #   Shown in ledger-web/ledger-tui header and cq serve project selector
  #   Defaults (if absent) to projectId > repo root basename > projectKey
  #   No credentials or secrets — display-only
  name = "My Project"
```

## Troubleshooting

### `PostgresDsnResolutionError`

**Problem:** Startup fails with "no Postgres connection info was found"

**Solution:** Set one of:
1. `CQ_LEDGER_PG_URL` environment variable
2. `DATABASE_URL` environment variable
3. `[ledger].url` in `cq.toml`
4. Standard `PG*` environment variables (`PGHOST`, `PGPORT`, `PGDATABASE`, etc.)

### `HubTokenRequiredError`

**Problem:** `cq serve` fails with "--token is REQUIRED when binding a non-loopback host"

**Solution:** Pass `--token <secret>` when binding a non-loopback address, or bind loopback (127.0.0.1/localhost) for open access.

### Connection Timeout

**Problem:** Connection hangs or times out

**Solution:**
- Verify postgres is running: `pg_isready -h <host> -p 5432`
- Check firewall: `telnet <host> 5432`
- Verify DSN format: `postgres://[user[:password]@]host[:port]/dbname`
- Check postgres logs: `docker logs <postgres-container>` or `/var/log/postgresql/` on native install

### Tenant Not Found

**Problem:** `cq serve` returns 404 for `/p/<projectKey>/`

**Causes:**
- `projectKey` not registered in the `projects` table
- `projectKey` is URL-encoded in the path but not decoded before lookup
- Tenant was deleted via `cq erase` or direct SQL

**Solution:**
- Check registered tenants: `GET /api/projects`
- Verify the tenant's `projects` row: `SELECT * FROM projects WHERE project_key = '...'`
- Re-register via `cq init` (self-registers the tenant on first write)

## Further Reading

- **T572:** Multi-tenant normalized-row schema design
- **T577:** Postgres backend store implementation
- **T578:** LISTEN/NOTIFY coherence watcher (push-based change detection)
- **T581:** Migration from xdg to postgres
- **T585:** Projects registry and cq serve routing
- **T586/T587:** Hub server skeleton and per-project routing
- **T588:** Token authentication (Q273)
- **T589/T590:** Project selector UI
- **G81:** Postgres backend epic (T570–T591)
- **Q271:** Advisory lock for schema bootstrap
- **Q272/Q278:** DSN resolution hybrid (env override + committed default)
- **Q273:** Token requirement for non-loopback binds
- **Q279:** Multi-tenancy keying (project_key column in shared tables + projects registry)
- **Q281:** LISTEN/NOTIFY design (push, not poll)
- **Q283:** URL path addressing (`/p/<projectKey>/…`)
- **Q285:** Backup semantics (pg_dump for whole-database, cq commands for project scope)
- **RS1:** Bun.sql LISTEN/NOTIFY feasibility (concluded: not yet implemented; porsager as temporary seam)
