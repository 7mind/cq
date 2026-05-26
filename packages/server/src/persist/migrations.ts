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
    db.exec(migration.up);
    db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (?)", [migration.version]);
  }
}
