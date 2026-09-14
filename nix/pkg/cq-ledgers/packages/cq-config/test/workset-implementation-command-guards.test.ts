import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const COMMAND_ROOT = join(REPOSITORY_ROOT, "nix", "pkg", "cq-assets", "commands", "cq");

function command(relativePath: string): string {
  return readFileSync(join(COMMAND_ROOT, relativePath), "utf8");
}

describe("T1987 implementation command workset guards", () => {
  test("start and advance bind the shared boundary and scope implicit selection to manifests", () => {
    const start = command("implement/start.md");
    const advance = command("implement/advance.md");
    for (const [name, source] of [
      ["implement/start", start],
      ["implement/advance", advance],
    ] as const) {
      expect(source, name).toContain("{{cq:fragment:workset-effect-discipline}}");
    }
    expect(start).toContain("eligible finalized-manifest work");
    expect(advance).toContain("eligible finalized-manifest work");
  });

  test("implement advance uses managed parent-lost recovery for an advanced tip", () => {
    const advance = command("implement/advance.md");
    const prose = advance.replace(/\s+/g, " ");
    expect(prose).toContain('operation: "resolve-dispatch-recovery"');
    expect(prose).toContain("persist that literal reference");
    expect(prose).toContain("recovery: <recoveryReference>");
    expect(prose).toContain("`missing-result` or `parent-lost`");
    expect(prose).toContain('`preparation.kind === "current"`');
    expect(prose).toContain("recoveryPreparation: <preparation.recoveryPreparation>");
    expect(prose).toContain('`preparation.kind === "legacy"`');
    expect(prose).toContain("without `reprepareOf`");
    expect(prose).toContain("injects only its verified durable Git receipt lineage");
    expect(prose).toContain("Never retry an advanced tip as a fresh lineage-free dispatch");
    expect(prose).not.toContain(
      "manager-bound implement-worker, retry once with a fresh prepared dispatch",
    );
  });

  test("deterministic gate rejection never enters automatic recovery or unchanged-tip redispatch [Blackbox-Atomic]", () => {
    const prose = command("implement/advance.md").replace(/\s+/g, " ");
    expect(prose).toContain("`gate-rejected` is a completed deterministic gate failure");
    expect(prose).toContain("Do not resolve recovery, reclassify it as `parent-lost`, or redispatch the unchanged tip");
    expect(prose).toContain("retain its bounded command/exit/count/output diagnostics");
  });

  test("implement advance uses single-use consumed continuation authority for ordinary redispatch", () => {
    const prose = command("implement/advance.md").replace(/\s+/g, " ");
    expect(prose).toContain('operation: "resolve-dispatch-continuation"');
    expect(prose).toContain("continuation: <continuationReference>");
    expect(prose).toContain("without `reprepareOf`, `recovery`, or `guardedRebase`");
    expect(prose).toContain("atomically claims the association while allocating its successor");
    expect(prose).toContain("never pass the consumed attestation handle as `reprepareOf`");
    expect(prose).toContain(
      "resolve and persist its continuation reference before ending the pass",
    );
  });
});
