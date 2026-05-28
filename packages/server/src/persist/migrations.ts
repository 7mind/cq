import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS session (
  id                    TEXT    PRIMARY KEY,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  cwd                   TEXT    NOT NULL,
  model                 TEXT    NOT NULL,
  permission_mode       TEXT    NOT NULL,
  total_input_tokens    INTEGER NOT NULL DEFAULT 0,
  total_output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_cache_read      INTEGER NOT NULL DEFAULT 0,
  total_cache_create    INTEGER NOT NULL DEFAULT 0,
  total_cost_usd        REAL    NOT NULL DEFAULT 0,
  ended_reason          TEXT,
  title                 TEXT    NOT NULL DEFAULT '',
  last_server_seq       INTEGER NOT NULL DEFAULT 0,
  sdk_session_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_started_at ON session(started_at DESC);

CREATE TABLE IF NOT EXISTS invocation (
  id                    TEXT    PRIMARY KEY,
  session_id            TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  parent_invocation_id  TEXT             REFERENCES invocation(id) ON DELETE CASCADE,
  agent_name            TEXT    NOT NULL,
  agent_id              TEXT,
  task_id               TEXT,
  tool_use_id           TEXT,
  model                 TEXT    NOT NULL,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  duration_ms           INTEGER,
  status                TEXT    NOT NULL,
  tool_call_count       INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL    NOT NULL DEFAULT 0,
  prompt_excerpt        TEXT    NOT NULL DEFAULT '',
  event_log_path        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invocation_session   ON invocation(session_id);
CREATE INDEX IF NOT EXISTS idx_invocation_parent    ON invocation(parent_invocation_id);
CREATE INDEX IF NOT EXISTS idx_invocation_started   ON invocation(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_invocation_agent     ON invocation(agent_name);

CREATE VIRTUAL TABLE IF NOT EXISTS invocation_fts USING fts5(
  prompt_excerpt,
  agent_name,
  content='invocation',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS invocation_fts_insert
AFTER INSERT ON invocation BEGIN
  INSERT INTO invocation_fts(rowid, prompt_excerpt, agent_name)
  VALUES (new.rowid, new.prompt_excerpt, new.agent_name);
END;

CREATE TRIGGER IF NOT EXISTS invocation_fts_update
AFTER UPDATE ON invocation BEGIN
  INSERT INTO invocation_fts(invocation_fts, rowid, prompt_excerpt, agent_name)
  VALUES ('delete', old.rowid, old.prompt_excerpt, old.agent_name);
  INSERT INTO invocation_fts(rowid, prompt_excerpt, agent_name)
  VALUES (new.rowid, new.prompt_excerpt, new.agent_name);
END;

CREATE TRIGGER IF NOT EXISTS invocation_fts_delete
AFTER DELETE ON invocation BEGIN
  INSERT INTO invocation_fts(invocation_fts, rowid, prompt_excerpt, agent_name)
  VALUES ('delete', old.rowid, old.prompt_excerpt, old.agent_name);
END;
`,
  },
  {
    version: 2,
    up: `
ALTER TABLE invocation ADD COLUMN resumed_from_invocation_id TEXT NULL REFERENCES invocation(id);
CREATE INDEX IF NOT EXISTS idx_invocation_resumed_from ON invocation(resumed_from_invocation_id);
`,
  },
  {
    // D21: a brief window (D05 → D13) had the orphan reaper write status='errored',
    // a value that D13 later removed from the InvocationRow.status union and the
    // protocol Zod schema. Existing DBs may still carry those rows; the client
    // would then drop history.list_result frames at Zod validation and the
    // History tab would stay on "loading" forever. Rewrite them in place.
    version: 3,
    up: `
UPDATE invocation SET status='failed' WHERE status='errored';
`,
  },
  {
    // D41: persist the three top-bar UI settings server-side (model, permission
    // mode, hide-sdk-events toggle). A single global row (id=1) is sufficient
    // because cq is single-user. NULL in model/permission_mode means "not yet
    // set — client uses its own default".
    version: 4,
    up: `
CREATE TABLE IF NOT EXISTS ui_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT,
  permission_mode TEXT,
  hide_sdk_events INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO ui_settings (id, model, permission_mode, hide_sdk_events) VALUES (1, NULL, NULL, 0);
`,
  },
  {
    // D42: per-row owner PID so the reaper can distinguish orphaned rows from
    // rows belonging to a live process. NULL means unknown owner — never reaped.
    // Existing 'running' rows from before this migration keep NULL and are left
    // alone (safest).
    version: 5,
    up: `
ALTER TABLE invocation ADD COLUMN owner_pid INTEGER;
`,
  },
  {
    // gear-2 + codex-2 (outer-7): per-session platform routing label and
    // reasoning-effort tier sent in ChatStart. Both columns are bundled in
    // a single migration because they target the same table in the same
    // cycle and are shipped together.
    //
    // platform — "claude" | "codex". Existing rows default-fill to "claude"
    //   so the historical UI Resume button continues to work without backfill.
    // effort   — "none" | "low" | "medium" | "high" | "max". Existing rows
    //   default-fill to "none" preserving prior no-thinking behaviour.
    version: 6,
    up: `
ALTER TABLE session ADD COLUMN platform TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE session ADD COLUMN effort   TEXT NOT NULL DEFAULT 'none';
`,
  },
  {
    // gcn1-1 (outer-9): per-session Codex approvalPolicy. Nullable because
    // (a) Claude sessions have no approval policy and (b) Codex sessions
    // started before this migration default to the codex-sdk default
    // ("on-request") — leaving the column NULL preserves that meaning
    // without overwriting historical intent.
    //
    // The column is plain TEXT rather than a CHECK-constrained enum so the
    // single-source-of-truth for valid values stays in the protocol Zod
    // schema (z.enum(["never","on-request","on-failure","untrusted"])).
    version: 7,
    up: `
ALTER TABLE session ADD COLUMN approval_policy TEXT;
`,
  },
];

export function runMigrations(db: Database, migrations: Migration[]): void {
  // Ensure schema_version table exists before querying it.
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL PRIMARY KEY
  )`);

  const currentRow = db
    .query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version")
    .get();
  const current = currentRow?.version ?? 0;

  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    // Wrap each migration's DDL + version bump in a single transaction.
    // This guarantees atomicity: either both the schema change and the version
    // record are committed, or neither is — so a mid-migration crash cannot
    // leave the DB in a partially-applied state that would re-run on the next start.
    db.transaction(() => {
      db.exec(migration.up);
      db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (?)", [migration.version]);
    })();
  }
}
