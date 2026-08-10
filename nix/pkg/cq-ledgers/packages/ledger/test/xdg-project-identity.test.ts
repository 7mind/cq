import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  PROJECT_DISPLAY_NAME_META_KEY,
  PROJECT_REPOSITORY_PATH_META_KEY,
  SqliteXdgProjectIdentityAccess,
  XdgProjectIdentityMetadataError,
  type XdgProjectIdentity,
  type XdgProjectIdentityAccess,
} from "../src/store/sqlite/projectIdentity.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema, SCHEMA_VERSION } from "../src/store/sqlite/schema.js";

interface ProjectIdentityFixture {
  access: XdgProjectIdentityAccess;
  setRaw(key: string, value: string | number): void;
  deleteRaw(key: string): void;
  getRaw(key: string): unknown;
  close(): void;
}

interface ProjectIdentityFixtureFactory {
  name: string;
  build(): Promise<ProjectIdentityFixture>;
}

class InMemoryProjectIdentityAccess implements XdgProjectIdentityAccess {
  constructor(private readonly rows: Map<string, unknown>) {}

  readProjectIdentity(): XdgProjectIdentity | null {
    const repositoryPath = this.rows.get(PROJECT_REPOSITORY_PATH_META_KEY);
    const displayName = this.rows.get(PROJECT_DISPLAY_NAME_META_KEY);
    if (repositoryPath === undefined && displayName === undefined) return null;
    const identity = { repositoryPath, displayName };
    this.validate(identity);
    return identity;
  }

  upsertProjectIdentity(identity: XdgProjectIdentity): boolean {
    this.validate(identity);
    const changed =
      this.rows.get(PROJECT_REPOSITORY_PATH_META_KEY) !== identity.repositoryPath ||
      this.rows.get(PROJECT_DISPLAY_NAME_META_KEY) !== identity.displayName;
    this.rows.set(PROJECT_REPOSITORY_PATH_META_KEY, identity.repositoryPath);
    this.rows.set(PROJECT_DISPLAY_NAME_META_KEY, identity.displayName);
    return changed;
  }

  private validate(identity: {
    repositoryPath: unknown;
    displayName: unknown;
  }): asserts identity is XdgProjectIdentity {
    if (
      typeof identity.repositoryPath !== "string" ||
      identity.repositoryPath.trim() === "" ||
      !path.isAbsolute(identity.repositoryPath)
    ) {
      throw new XdgProjectIdentityMetadataError("invalid repository path");
    }
    if (typeof identity.displayName !== "string" || identity.displayName.trim() === "") {
      throw new XdgProjectIdentityMetadataError("invalid display name");
    }
  }
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const inMemoryFactory: ProjectIdentityFixtureFactory = {
  name: "hand-written in-memory dummy",
  async build() {
    const rows = new Map<string, unknown>([["schema_version", SCHEMA_VERSION]]);
    return {
      access: new InMemoryProjectIdentityAccess(rows),
      setRaw(key, value) {
        rows.set(key, value);
      },
      deleteRaw(key) {
        rows.delete(key);
      },
      getRaw(key) {
        return rows.get(key);
      },
      close() {},
    };
  },
};

const sqliteFactory: ProjectIdentityFixtureFactory = {
  name: "real temporary SQLite",
  async build() {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-project-identity-"));
    dirs.push(dir);
    const db = openLedgerDb(path.join(dir, "ledger.db"));
    ensureSchema(db);
    return {
      access: new SqliteXdgProjectIdentityAccess(db),
      setRaw(key, value) {
        db.query(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(key, value);
      },
      deleteRaw(key) {
        db.query("DELETE FROM meta WHERE key = ?").run(key);
      },
      getRaw(key) {
        return (
          db.query<{ value: unknown }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
            ?.value
        );
      },
      close() {
        db.close();
      },
    };
  },
};

function runProjectIdentityContract(factory: ProjectIdentityFixtureFactory): void {
  describe(`XDG project identity contract (${factory.name})`, () => {
    test("absent identity reads as null; blank metadata fails fast", async () => {
      const fixture = await factory.build();
      try {
        expect(fixture.access.readProjectIdentity()).toBeNull();

        fixture.setRaw(PROJECT_REPOSITORY_PATH_META_KEY, "");
        fixture.setRaw(PROJECT_DISPLAY_NAME_META_KEY, "Project");
        expect(() => fixture.access.readProjectIdentity()).toThrow(
          XdgProjectIdentityMetadataError,
        );

        fixture.setRaw(PROJECT_REPOSITORY_PATH_META_KEY, "/repos/project");
        fixture.setRaw(PROJECT_DISPLAY_NAME_META_KEY, "   ");
        expect(() => fixture.access.readProjectIdentity()).toThrow(
          XdgProjectIdentityMetadataError,
        );
      } finally {
        fixture.close();
      }
    });

    test("both keys round-trip and identical upserts are idempotent", async () => {
      const fixture = await factory.build();
      const identity = {
        repositoryPath: "/repos/alpha",
        displayName: "Alpha",
      };
      try {
        expect(fixture.access.upsertProjectIdentity(identity)).toBe(true);
        expect(fixture.access.readProjectIdentity()).toEqual(identity);
        expect(fixture.access.upsertProjectIdentity(identity)).toBe(false);
        expect(fixture.access.readProjectIdentity()).toEqual(identity);
      } finally {
        fixture.close();
      }
    });

    test("repository path and display name replace independently", async () => {
      const fixture = await factory.build();
      try {
        fixture.access.upsertProjectIdentity({
          repositoryPath: "/repos/alpha",
          displayName: "Alpha",
        });
        expect(
          fixture.access.upsertProjectIdentity({
            repositoryPath: "/repos/alpha",
            displayName: "Renamed Alpha",
          }),
        ).toBe(true);
        expect(fixture.access.readProjectIdentity()).toEqual({
          repositoryPath: "/repos/alpha",
          displayName: "Renamed Alpha",
        });

        expect(
          fixture.access.upsertProjectIdentity({
            repositoryPath: "/moved/alpha",
            displayName: "Renamed Alpha",
          }),
        ).toBe(true);
        expect(fixture.access.readProjectIdentity()).toEqual({
          repositoryPath: "/moved/alpha",
          displayName: "Renamed Alpha",
        });
      } finally {
        fixture.close();
      }
    });

    test("upsert preserves unrelated metadata", async () => {
      const fixture = await factory.build();
      try {
        fixture.setRaw("unrelated", "keep-me");
        fixture.access.upsertProjectIdentity({
          repositoryPath: "/repos/alpha",
          displayName: "Alpha",
        });
        expect(fixture.getRaw("unrelated")).toBe("keep-me");
        expect(fixture.getRaw("schema_version")).toBe(SCHEMA_VERSION);
      } finally {
        fixture.close();
      }
    });

    test("malformed writes and stored values fail fast", async () => {
      const fixture = await factory.build();
      try {
        for (const identity of [
          { repositoryPath: "", displayName: "Alpha" },
          { repositoryPath: "relative/alpha", displayName: "Alpha" },
          { repositoryPath: "/repos/alpha", displayName: "" },
        ]) {
          expect(() => fixture.access.upsertProjectIdentity(identity)).toThrow(
            XdgProjectIdentityMetadataError,
          );
        }

        fixture.setRaw(PROJECT_REPOSITORY_PATH_META_KEY, 42);
        fixture.setRaw(PROJECT_DISPLAY_NAME_META_KEY, "Alpha");
        expect(() => fixture.access.readProjectIdentity()).toThrow(
          XdgProjectIdentityMetadataError,
        );

        fixture.setRaw(PROJECT_REPOSITORY_PATH_META_KEY, "/repos/alpha");
        fixture.deleteRaw(PROJECT_DISPLAY_NAME_META_KEY);
        expect(() => fixture.access.readProjectIdentity()).toThrow(
          XdgProjectIdentityMetadataError,
        );
      } finally {
        fixture.close();
      }
    });
  });
}

runProjectIdentityContract(inMemoryFactory);
runProjectIdentityContract(sqliteFactory);

describe("XDG project identity storage shape", () => {
  test("uses the existing meta(key,value) shape alongside lifecycle and workset tables", async () => {
    const fixture = await sqliteFactory.build();
    try {
      fixture.access.upsertProjectIdentity({
        repositoryPath: "/repos/alpha",
        displayName: "Alpha",
      });
      const db = openLedgerDb(path.join(dirs[dirs.length - 1]!, "ledger.db"));
      try {
        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => row.name);
        expect(tables).toEqual([
          "archive_pointers",
          "archived_items",
          "coherence_state",
          "groups",
          "items",
          "ledgers",
          "mcp_usage_stats",
          "meta",
          "plan_claims",
          "plan_operations",
          "workset_admissions",
          "workset_exclusive",
          "workset_state",
        ]);
        const metaColumns = db
          .query<{ name: string }, []>("PRAGMA table_info(meta)")
          .all()
          .map((row) => row.name);
        expect(metaColumns).toEqual(["key", "value"]);
        expect(SCHEMA_VERSION).toBe(5);
      } finally {
        db.close();
      }
    } finally {
      fixture.close();
    }
  });
});
