import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import {
  createSingleProjectDispatchRuntime,
  refuseDispatchRuntime,
} from "../src/dispatchCapability.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inMemoryStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

describe("production dispatch runtime construction", () => {
  test("refuses unsupported construction and backend cells before registration", async () => {
    const store = await inMemoryStore();
    const unsupportedBackend: ResolvedLedgerStore = {
      store,
      configRoot: "/must-not-be-resolved",
      backend: "git-object",
      branch: "cq-ledger",
    };
    const backendVerdict = await createSingleProjectDispatchRuntime({
      construction: "direct",
      resolved: unsupportedBackend,
    });
    expect(backendVerdict.kind).toBe("unavailable");
    if (backendVerdict.kind === "available") throw new Error("expected refusal");
    expect(backendVerdict.reason).toContain("git-object");

    const constructionVerdict = refuseDispatchRuntime("xdg-catalog-hub", "xdg");
    expect(constructionVerdict.kind).toBe("unavailable");
    if (constructionVerdict.kind === "available") throw new Error("expected refusal");
    expect(constructionVerdict.reason).toContain("xdg");
    await store.dispose();
  });

  test("owns and closes the durable xdg attestation backend", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-mcp-dispatch-runtime-"));
    const stateHome = await mkdtemp(path.join(tmpdir(), "ledger-mcp-dispatch-state-"));
    roots.push(root, stateHome);
    await writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nprojectId = "runtime-close-test"\n',
      "utf8",
    );
    const store = await inMemoryStore();
    const resolved: ResolvedLedgerStore = {
      store,
      configRoot: root,
      backend: "xdg",
      branch: "cq-ledger",
      projectKey: "runtime-close-test",
    };
    const runtime = await createSingleProjectDispatchRuntime({
      construction: "direct",
      resolved,
      promptArtifactStore: {
        readManifest: () => {
          throw new Error("fetch does not read the prompt manifest");
        },
        readRole: () => {
          throw new Error("fetch does not read a prompt role");
        },
      },
      environment: { XDG_STATE_HOME: stateHome },
    });
    expect(runtime.kind).toBe("available");
    if (runtime.kind === "unavailable") throw new Error(runtime.reason);
    const handle = { attestationId: `att_${"a".repeat(32)}`, generation: 1 };
    expect(await runtime.capability.fetch(handle)).toMatchObject({
      state: "attestation-not-found",
      ...handle,
    });
    await runtime.close();
    await expect(runtime.capability.fetch(handle)).rejects.toThrow(/closed/i);
    await store.dispose();
  });
});
