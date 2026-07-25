import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { immediateWriteTransaction } from "./connection.js";

export const PROJECT_REPOSITORY_PATH_META_KEY = "project_repository_path";
export const PROJECT_DISPLAY_NAME_META_KEY = "project_display_name";

export interface XdgProjectIdentity {
  readonly repositoryPath: string;
  readonly displayName: string;
}

export interface XdgProjectIdentityAccess {
  readProjectIdentity(): XdgProjectIdentity | null;
  upsertProjectIdentity(identity: XdgProjectIdentity): boolean;
}

export class XdgProjectIdentityMetadataError extends Error {
  override readonly name = "XdgProjectIdentityMetadataError";
}

function validateProjectIdentity(identity: {
  repositoryPath: unknown;
  displayName: unknown;
}): asserts identity is XdgProjectIdentity {
  if (
    typeof identity.repositoryPath !== "string" ||
    identity.repositoryPath.trim() === "" ||
    !path.isAbsolute(identity.repositoryPath)
  ) {
    throw new XdgProjectIdentityMetadataError(
      "XDG project identity repositoryPath must be a non-blank absolute path",
    );
  }
  if (typeof identity.displayName !== "string" || identity.displayName.trim() === "") {
    throw new XdgProjectIdentityMetadataError(
      "XDG project identity displayName must be a non-blank string",
    );
  }
}

export class SqliteXdgProjectIdentityAccess implements XdgProjectIdentityAccess {
  constructor(private readonly db: Database) {}

  readProjectIdentity(): XdgProjectIdentity | null {
    const rows = this.db
      .query<{ key: string; value: unknown }, [string, string]>(
        "SELECT key, value FROM meta WHERE key IN (?, ?)",
      )
      .all(PROJECT_REPOSITORY_PATH_META_KEY, PROJECT_DISPLAY_NAME_META_KEY);
    if (rows.length === 0) return null;
    if (rows.length !== 2) {
      throw new XdgProjectIdentityMetadataError(
        "XDG project identity metadata must contain both repository path and display name",
      );
    }

    const values = new Map(rows.map((row) => [row.key, row.value]));
    const identity = {
      repositoryPath: values.get(PROJECT_REPOSITORY_PATH_META_KEY),
      displayName: values.get(PROJECT_DISPLAY_NAME_META_KEY),
    };
    validateProjectIdentity(identity);
    return identity;
  }

  upsertProjectIdentity(identity: XdgProjectIdentity): boolean {
    validateProjectIdentity(identity);
    return immediateWriteTransaction(this.db, () => {
      const upsert = this.db.query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE meta.value IS NOT excluded.value`,
      );
      const repositoryPathResult = upsert.run(
        PROJECT_REPOSITORY_PATH_META_KEY,
        identity.repositoryPath,
      );
      const displayNameResult = upsert.run(PROJECT_DISPLAY_NAME_META_KEY, identity.displayName);
      return repositoryPathResult.changes + displayNameResult.changes > 0;
    });
  }
}
