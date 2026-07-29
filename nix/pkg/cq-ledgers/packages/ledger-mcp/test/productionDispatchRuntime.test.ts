import { SQL } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ATTESTATION_TABLE, type PromptSurface } from "@cq/config";
import {
  attestationNamespaceForTrustedHubProject,
  createAttestationStoreForConstruction,
  InMemoryLedgerStore,
  type ResolvedLedgerStore,
} from "@cq/ledger";
import {
  createPostgresHubDispatchRuntime,
  createSingleProjectDispatchRuntime,
  refuseDispatchRuntime,
} from "../src/dispatchCapability.js";
import { createLedgerMcpServer } from "../src/main.js";
import type {
  PromptArtifactRoleMetadata,
  PromptArtifactStore,
} from "../src/promptArtifactStore.js";
import { assertDispatchConstructionConformance } from "./dispatchConstructionConformance.js";

const roots: string[] = [];
const PG_URL = process.env["CQ_TEST_PG_URL"];
const livePgTest = PG_URL === undefined ? test.skip : test;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inMemoryStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore();
  await store.init();
  return store;
}

function workerArtifactStore(surface: PromptSurface): PromptArtifactStore {
  const metadata: PromptArtifactRoleMetadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent",
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: surface,
    promptDigest: "a".repeat(64),
    schemaVersion: 1,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: surface,
      catalogHash: "b".repeat(64),
    }),
    readRole: (roleId) => {
      if (roleId !== metadata.roleId) throw new Error(`unexpected role "${roleId}"`);
      return { metadata, bytes: new Uint8Array([1]) };
    },
  };
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

  livePgTest("preserves the T977 dispatch contract through the PostgreSQL hub construction", async () => {
    const trustedProjectKey = `t977-hub-${crypto.randomUUID()}`;
    const pool = new SQL({ url: PG_URL!, max: 1 });
    const store = await inMemoryStore();
    const promptArtifactStore = workerArtifactStore("claude");
    const runtime = await createPostgresHubDispatchRuntime({
      pool,
      trustedProjectKey,
      store,
      promptArtifactStore,
    });
    expect(runtime.kind).toBe("available");
    if (runtime.kind === "unavailable") throw new Error(runtime.reason);
    const namespace = attestationNamespaceForTrustedHubProject(trustedProjectKey);
    const peer = await createAttestationStoreForConstruction({
      backend: "postgres",
      namespace,
      pool,
    });
    const server = createLedgerMcpServer({
      store,
      displayName: trustedProjectKey,
      projectKey: trustedProjectKey,
      promptArtifactStore,
      dispatchCapability: runtime.capability,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "postgres-hub-dispatch-contract-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      await assertDispatchConstructionConformance({
        cell: "postgres-hub",
        client,
        surface: "claude",
        rows: async () =>
          (await peer.transact({ kind: "namespace" }, (attestations) => attestations.rows())) ?? [],
      });
    } finally {
      await client.close();
      await server.close();
      await peer.close();
      await runtime.close();
      try {
        await pool`
          DELETE FROM ${pool(ATTESTATION_TABLE)}
           WHERE backend = 'postgres' AND project_key = ${trustedProjectKey}
        `;
      } finally {
        await pool.close();
        await store.dispose();
      }
    }
  });
});
