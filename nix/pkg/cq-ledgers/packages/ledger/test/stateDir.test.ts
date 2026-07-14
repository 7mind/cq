/**
 * Unit tests for XDG state-dir resolution module.
 *
 * Tests verify:
 *   - With XDG_STATE_HOME set, base resolves under it
 *   - Unset falls back to ~/.local/state
 *   - Layout constants/paths are exported correctly
 *   - Lazy bootstrap helper creates directories with mkdir -p semantics
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import { rmSync, mkdirSync, existsSync } from "fs";
import { mkdtemp } from "fs/promises";
import {
  resolveStateDirBase,
  resolveStateDir,
  resolveLogsDir,
  STORE_LAYOUT,
  ensureStateDir,
} from "../src/stateDir.js";

// Test fixtures
const TEST_PROJECT_KEY = "test-project-abc123";

describe("resolveStateDirBase", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(() => {
    originalXdgStateHome = process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (originalXdgStateHome !== undefined) {
      process.env.XDG_STATE_HOME = originalXdgStateHome;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
  });

  it("resolves under $XDG_STATE_HOME when set", () => {
    const xdgPath = "/custom/xdg/state";
    process.env.XDG_STATE_HOME = xdgPath;

    const result = resolveStateDirBase(TEST_PROJECT_KEY);

    expect(result).toBe(join(xdgPath, "cq", "projects", TEST_PROJECT_KEY));
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    delete process.env.XDG_STATE_HOME;

    const result = resolveStateDirBase(TEST_PROJECT_KEY);
    const expected = join(homedir(), ".local", "state", "cq", "projects", TEST_PROJECT_KEY);

    expect(result).toBe(expected);
  });

  it("treats empty XDG_STATE_HOME as unset", () => {
    process.env.XDG_STATE_HOME = "";

    const result = resolveStateDirBase(TEST_PROJECT_KEY);
    const expected = join(homedir(), ".local", "state", "cq", "projects", TEST_PROJECT_KEY);

    expect(result).toBe(expected);
  });

  it("treats whitespace-only XDG_STATE_HOME as unset", () => {
    process.env.XDG_STATE_HOME = "   ";

    const result = resolveStateDirBase(TEST_PROJECT_KEY);
    const expected = join(homedir(), ".local", "state", "cq", "projects", TEST_PROJECT_KEY);

    expect(result).toBe(expected);
  });

  it("uses consistent layout across different project keys", () => {
    const key1 = "project-one";
    const key2 = "project-two";
    process.env.XDG_STATE_HOME = "/state";

    const result1 = resolveStateDirBase(key1);
    const result2 = resolveStateDirBase(key2);

    expect(result1).toBe("/state/cq/projects/project-one");
    expect(result2).toBe("/state/cq/projects/project-two");
  });
});

describe("STORE_LAYOUT constants", () => {
  it("exports state and logs sub-directory names", () => {
    expect(STORE_LAYOUT.state).toBe("state");
    expect(STORE_LAYOUT.logs).toBe("logs");
  });

  it("is a const object with readonly properties", () => {
    // The type is const, so this test verifies the shape.
    expect(typeof STORE_LAYOUT.state).toBe("string");
    expect(typeof STORE_LAYOUT.logs).toBe("string");
  });
});

describe("resolveStateDir", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(() => {
    originalXdgStateHome = process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (originalXdgStateHome !== undefined) {
      process.env.XDG_STATE_HOME = originalXdgStateHome;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
  });

  it("appends state sub-directory to the base", () => {
    process.env.XDG_STATE_HOME = "/xdg";

    const result = resolveStateDir(TEST_PROJECT_KEY);

    expect(result).toBe(join("/xdg", "cq", "projects", TEST_PROJECT_KEY, "state"));
  });

  it("uses the fallback base when XDG_STATE_HOME is unset", () => {
    delete process.env.XDG_STATE_HOME;

    const result = resolveStateDir(TEST_PROJECT_KEY);
    const expectedBase = join(homedir(), ".local", "state", "cq", "projects", TEST_PROJECT_KEY);

    expect(result).toBe(join(expectedBase, "state"));
  });
});

describe("resolveLogsDir", () => {
  let originalXdgStateHome: string | undefined;

  beforeEach(() => {
    originalXdgStateHome = process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (originalXdgStateHome !== undefined) {
      process.env.XDG_STATE_HOME = originalXdgStateHome;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
  });

  it("appends logs sub-directory to the base", () => {
    process.env.XDG_STATE_HOME = "/xdg";

    const result = resolveLogsDir(TEST_PROJECT_KEY);

    expect(result).toBe(join("/xdg", "cq", "projects", TEST_PROJECT_KEY, "logs"));
  });

  it("uses the fallback base when XDG_STATE_HOME is unset", () => {
    delete process.env.XDG_STATE_HOME;

    const result = resolveLogsDir(TEST_PROJECT_KEY);
    const expectedBase = join(homedir(), ".local", "state", "cq", "projects", TEST_PROJECT_KEY);

    expect(result).toBe(join(expectedBase, "logs"));
  });
});

describe("ensureStateDir (lazy bootstrap)", () => {
  let tempDirRoot: string;

  beforeEach(async () => {
    tempDirRoot = await mkdtemp(join("/tmp", "stateDir-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDirRoot)) {
      rmSync(tempDirRoot, { recursive: true, force: true });
    }
  });

  it("creates a directory that does not exist", async () => {
    const dirPath = join(tempDirRoot, "new", "dir");

    expect(existsSync(dirPath)).toBe(false);

    await ensureStateDir(dirPath);

    expect(existsSync(dirPath)).toBe(true);
  });

  it("creates all parent directories (mkdir -p semantics)", async () => {
    const dirPath = join(tempDirRoot, "a", "b", "c", "d");

    expect(existsSync(dirPath)).toBe(false);

    await ensureStateDir(dirPath);

    expect(existsSync(dirPath)).toBe(true);
    expect(existsSync(join(tempDirRoot, "a", "b", "c"))).toBe(true);
  });

  it("is idempotent (succeeds if directory already exists)", async () => {
    const dirPath = join(tempDirRoot, "existing");
    mkdirSync(dirPath);

    // Should not throw
    await ensureStateDir(dirPath);

    expect(existsSync(dirPath)).toBe(true);
  });

  it("handles nested calls correctly", async () => {
    const parentDir = join(tempDirRoot, "parent");
    const childDir = join(parentDir, "child");

    // Create parent
    await ensureStateDir(parentDir);
    expect(existsSync(parentDir)).toBe(true);

    // Then create child (should not fail even though parent exists)
    await ensureStateDir(childDir);
    expect(existsSync(childDir)).toBe(true);
  });
});

describe("module exports", () => {
  it("exports all required functions and constants", () => {
    expect(typeof resolveStateDirBase).toBe("function");
    expect(typeof resolveStateDir).toBe("function");
    expect(typeof resolveLogsDir).toBe("function");
    expect(typeof ensureStateDir).toBe("function");
    expect(typeof STORE_LAYOUT).toBe("object");
  });
});
