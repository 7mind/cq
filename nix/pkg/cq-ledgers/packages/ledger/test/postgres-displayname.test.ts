/**
 * resolveDisplayName tests (T574, G81/M248) — the pure RECONCILED
 * display-name chain for the Postgres backend's `projects.display_name`.
 * No Postgres server needed: every candidate is a plain in-memory value the
 * test constructs directly.
 *
 * Covers every fallback rung (cq.toml [project].name > [ledger].projectId >
 * repo basename > projectKey) plus blank-string treated as absent, mirroring
 * postgres-dsn.test.ts's conventions for resolvePostgresDsn.
 */

import { describe, expect, test } from "bun:test";
import { resolveDisplayName } from "../src/store/postgres/displayName.js";

describe("resolveDisplayName (T574)", () => {
  test("rung 1: [project].name alone wins when set", () => {
    const result = resolveDisplayName({
      projectName: "My Project",
      projectId: null,
      repoBasename: null,
      projectKey: "proj-key",
    });
    expect(result).toBe("My Project");
  });

  test("rung 2: [ledger].projectId wins when [project].name is absent", () => {
    const result = resolveDisplayName({
      projectName: null,
      projectId: "committed-project-id",
      repoBasename: "repo-dir",
      projectKey: "proj-key",
    });
    expect(result).toBe("committed-project-id");
  });

  test("rung 3: repo basename wins when [project].name and [ledger].projectId are both absent", () => {
    const result = resolveDisplayName({
      projectName: null,
      projectId: null,
      repoBasename: "repo-dir",
      projectKey: "proj-key",
    });
    expect(result).toBe("repo-dir");
  });

  test("rung 4: projectKey is the always-available final fallback", () => {
    const result = resolveDisplayName({
      projectName: null,
      projectId: null,
      repoBasename: null,
      projectKey: "proj-key",
    });
    expect(result).toBe("proj-key");
  });

  test("full precedence order: [project].name > [ledger].projectId > repo basename > projectKey, all four set", () => {
    const result = resolveDisplayName({
      projectName: "My Project",
      projectId: "committed-project-id",
      repoBasename: "repo-dir",
      projectKey: "proj-key",
    });
    expect(result).toBe("My Project");
  });

  test("[ledger].projectId wins over repo basename + projectKey when both set", () => {
    const result = resolveDisplayName({
      projectName: undefined,
      projectId: "committed-project-id",
      repoBasename: "repo-dir",
      projectKey: "proj-key",
    });
    expect(result).toBe("committed-project-id");
  });

  test("blank [project].name is treated as unset, falls through to [ledger].projectId", () => {
    const result = resolveDisplayName({
      projectName: "   ",
      projectId: "committed-project-id",
      repoBasename: null,
      projectKey: "proj-key",
    });
    expect(result).toBe("committed-project-id");
  });

  test("blank [ledger].projectId is treated as unset, falls through to repo basename", () => {
    const result = resolveDisplayName({
      projectName: undefined,
      projectId: "   ",
      repoBasename: "repo-dir",
      projectKey: "proj-key",
    });
    expect(result).toBe("repo-dir");
  });

  test("blank repo basename is treated as unset, falls through to projectKey", () => {
    const result = resolveDisplayName({
      projectName: undefined,
      projectId: undefined,
      repoBasename: "   ",
      projectKey: "proj-key",
    });
    expect(result).toBe("proj-key");
  });

  test("every candidate absent (undefined) resolves to projectKey — never throws", () => {
    const result = resolveDisplayName({
      projectName: undefined,
      projectId: undefined,
      repoBasename: undefined,
      projectKey: "proj-key",
    });
    expect(result).toBe("proj-key");
  });
});
