import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CODEX_EFFORTS, CqConfigError, parseReviewerToken } from "../src/index.js";

interface PackagedModelCatalog {
  readonly models: readonly {
    readonly slug: string;
    readonly supported_reasoning_levels: readonly { readonly effort: string }[];
  }[];
}

describe("T1630: Codex reasoning efforts", () => {
  test("match the packaged gpt-5.6-sol probe and reject values outside it", () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), "cq-codex-effort-probe-"));
    try {
      const probe = Bun.spawnSync(
        [
          process.env["CQ_CODEX_EXECUTABLE"] ?? "codex",
          "debug",
          "models",
          "--bundled",
        ],
        {
          env: { ...process.env, CODEX_HOME: codexHome },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(probe.exitCode).toBe(0);

      const catalog = JSON.parse(probe.stdout.toString()) as PackagedModelCatalog;
      const sol = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
      expect(sol).toBeDefined();
      expect(CODEX_EFFORTS.join("|")).toBe(
        sol!.supported_reasoning_levels.map(({ effort }) => effort).join("|"),
      );

      for (const effort of ["none", "minimal", "unknown"]) {
        expect(() => parseReviewerToken(`codex:gpt-5.6-sol:${effort}`)).toThrow(CqConfigError);
      }
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
