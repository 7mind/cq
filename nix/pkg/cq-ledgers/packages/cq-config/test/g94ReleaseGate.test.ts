/**
 * T708 / G94 — post-packaging closure pin. The production construction
 * matrix already lives in attestationStoreContract / dispatchAttestation tests.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { DISPATCH_EDGE_INVENTORY, inspectionSites } from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const DOC = path.join(REPO_ROOT, "docs", "drafts", "20260819-1912-g94-ref-first-cutover.md");
const CONTRACT = path.join(
  REPO_ROOT,
  "nix/pkg/cq-ledgers/packages/cq-config/test/attestationStoreContract.ts",
);

describe("T708 ref-first persistence and release pin", () => {
  test("cutover doc and store-contract suite are present [BA]", () => {
    expect(existsSync(DOC)).toBe(true);
    expect(existsSync(CONTRACT)).toBe(true);
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toContain("prepared");
    expect(doc).toContain("consumed");
    expect(doc).toContain("24h");
    expect(doc).toContain("30d");
    expect(doc).toContain("no old-client compatibility");
    expect(doc).not.toContain("aggregate token savings");
  });

  test("repository closure still has no ordinary workflow validators [BA]", () => {
    expect(
      DISPATCH_EDGE_INVENTORY.sites.some(
        (site) => site.kind === "validate_output" || site.kind === "validate_input",
      ),
    ).toBe(false);
    expect(inspectionSites().every((site) => site.kind === "fetch_prompt")).toBe(true);
  });

  test("store-contract suite still names envelope, tombstone, and abort [BA]", () => {
    const body = readFileSync(CONTRACT, "utf8");
    expect(body).toContain("tombstone");
    expect(body).toContain("abort");
    expect(body).toContain("consumed");
  });
});
