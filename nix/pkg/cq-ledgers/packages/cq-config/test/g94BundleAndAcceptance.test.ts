/**
 * T705 / T706 / T716–T719 / G94 — bundle wiring, acceptance matrix, prompt-authority audit.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  DISPATCH_EDGE_INVENTORY,
  implementDispatchEdges,
  investigateResearchDispatchEdges,
  planReviewDispatchEdges,
} from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const CONFIG_SRC = path.join(REPO_ROOT, "nix", "pkg", "cq-ledgers", "packages", "cq-config", "src");
const PI_EXT = path.join(REPO_ROOT, "nix", "pkg", "pi-extensions", "cq-subagent-dispatch", "index.ts");
const FLAKE = readFileSync(path.join(REPO_ROOT, "flake.nix"), "utf8");
const SURFACES = ["claude", "codex", "pi"] as const;

function fragment(surface: string, name: string): string {
  return readFileSync(path.join(ASSETS, "fragments", surface, name), "utf8");
}

describe("T716/T717/T718/T719 G91 bundle wiring", () => {
  test("one prompt authority and one protocol module per surface [BA]", () => {
    expect(existsSync(path.join(ASSETS, "agents", "implement-worker.md"))).toBe(true);
    expect(existsSync(path.join(CONFIG_SRC, "claudeDispatchBridge.ts"))).toBe(true);
    expect(existsSync(path.join(CONFIG_SRC, "codexDispatchProtocol.ts"))).toBe(true);
    expect(existsSync(PI_EXT)).toBe(true);
    const workerAgents = readdirSync(path.join(ASSETS, "agents")).filter((name) =>
      name.startsWith("implement-worker"),
    );
    expect(workerAgents).toEqual(["implement-worker.md"]);
  });

  test("each surface fragment is handle-only prepare/fetch [BA]", () => {
    for (const surface of SURFACES) {
      const body = `${fragment(surface, "subagent-dispatch.md")}\n${fragment(surface, "implement-dispatch-workflow.md")}`;
      expect(body).toContain("prepare_dispatch");
      expect(body).toContain("fetch_dispatch_result");
      expect(body).not.toContain("validate_output");
      expect(body).not.toContain('task: "<complete prompt>"');
      expect(body).not.toContain("held freeform");
    }
  });

  test("flake still exposes the three prompt-root packages [BA]", () => {
    expect(FLAKE).toContain("claude-prompt-root");
    expect(FLAKE).toContain("codex-prompt-root");
    expect(FLAKE).toContain("pi-prompt-root");
  });
});

describe("T705/T706 deployed acceptance and authority audit", () => {
  test("every dispatched edge is owned by exactly one family [BA]", () => {
    const ids = DISPATCH_EDGE_INVENTORY.edges
      .filter((edge) => edge.kind === "dispatch")
      .map((edge) => edge.id);
    const families = [
      ...planReviewDispatchEdges(),
      ...investigateResearchDispatchEdges(),
      ...implementDispatchEdges(),
    ].map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(families.sort()).toEqual(ids.sort());
  });

  test("G94 protocol files do not copy role prompt templates [BA]", () => {
    for (const file of ["claudeDispatchBridge.ts", "codexDispatchProtocol.ts", "dispatchAttestation.ts"]) {
      const body = readFileSync(path.join(CONFIG_SRC, file), "utf8");
      expect(body).not.toContain("promptTemplate:");
    }
  });
});
