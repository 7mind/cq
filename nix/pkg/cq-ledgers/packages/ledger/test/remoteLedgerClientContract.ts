/**
 * The T727 RemoteLedgerClient DUAL contract — ONE abstract Behavioral-Active
 * Blackbox suite, parameterized over the MCP service the client talks to
 * (the dual-tests pattern):
 *
 *  1. the ALWAYS-ON hand-written in-memory MCP service
 *     (./remoteLedgerClientInMemoryAdapter.ts) — a second, independent
 *     implementation of the hub's observable wire behaviour over plain Maps,
 *     so the contract never ratios itself against the production server;
 *  2. the REAL `cq serve`/PostgreSQL hub
 *     (./remoteLedgerClientPostgresAdapter.ts), env-gated on CQ_TEST_PG_URL
 *     (Q286) — the production adapter. When the env var is absent the whole
 *     leg is an EXPLICIT `describe.skip`, never a silent pass.
 *
 * Coverage (per the T727 acceptance): initialize/version negotiation, every
 * routine read/write family, list_projects/read_log, auth failure, unknown
 * tool, remote error preservation, reconnect, and close. Cases the production
 * hub cannot be made to drive (an initialize answering an unsupported
 * protocol version, a malformed tool result) are capability-gated
 * (`factory.capabilities`) so the production leg skips them EXPLICITLY via
 * `it.skipIf`.
 *
 * The assertions are blackbox: they drive only `RemoteLedgerClient`'s public
 * API plus each fixture's out-of-band seed/knob hooks. Server-side tool
 * SEMANTICS (predicate meaning, schema validation, transition guards) are
 * pinned elsewhere (mcp-tools/predicates/store suites) — this contract pins
 * the CLIENT: endpoint derivation, authentication, negotiation, DTO envelope
 * unwrapping, the fail-loud boundary taxonomy, and session lifecycle.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  RemoteAuthError,
  RemoteDisplayNameError,
  RemoteLedgerClient,
  RemoteMalformedResponseError,
  RemoteProtocolError,
  RemoteToolError,
  RemoteUnavailableError,
  type FieldValue,
  type ItemDto,
} from "../src/index.js";

/** Read one field off an ItemDto regardless of its projection (full vs compact). */
function fieldOf(item: ItemDto, name: string): FieldValue | undefined {
  return (item.fields as Record<string, FieldValue | undefined>)[name];
}

/** One built service the contract drives a fresh client against. */
export interface RemoteContractService {
  /** The hub origin the client derives `/p/<encoded projectKey>/mcp` from. */
  readonly serverUrl: string;
  /** A bearer token the service accepts. */
  readonly validToken: string;
  /** A bearer token the service rejects (never equal to {@link validToken}). */
  readonly invalidToken: string;
  /** The tenant projectKey the contract's client connects to. */
  readonly projectKey: string;
  /** The display name the contract sends on the display-name header. */
  readonly displayName: string;
  /** Seed a log artifact the connected client's `read_log` can read back. */
  seedLog(relPath: string, content: string): Promise<void>;
  /**
   * In-memory leg ONLY: make the NEXT initialize answer a protocolVersion
   * outside the SDK's supported set. Absent on the production leg (the real
   * hub cannot be made to misnegotiate) — see `capabilities`.
   */
  respondBogusProtocolVersionOnce?(): void;
  /**
   * In-memory leg ONLY: make the NEXT tools/call answer a malformed result.
   * Absent on the production leg — see `capabilities`.
   */
  respondMalformedOnce?(kind: "non-text-block" | "invalid-json"): void;
  /** Release every resource this fixture owns. */
  dispose(): Promise<void>;
}

/** Factory the two legs implement; the contract runner is parameterized over it. */
export interface RemoteLedgerClientContractFactory {
  readonly name: string;
  readonly classification:
    "Behavioral-Active Blackbox-Group" | "Behavioral-Active Blackbox-GoodCommunication";
  /**
   * Environmental skip (the production leg without CQ_TEST_PG_URL) — the
   * runner turns it into an explicit `describe.skip`, never a silent pass.
   */
  readonly skip?: boolean;
  /**
   * Wire behaviours this leg can be made to exhibit. A `false` entry skips
   * the matching case(s) explicitly (`it.skipIf`) on that leg.
   */
  readonly capabilities: {
    readonly bogusProtocolVersion: boolean;
    readonly malformedResponses: boolean;
  };
  /** Once-per-leg setup (the production leg boots one shared hub subprocess). */
  sharedSetup?(): Promise<void>;
  /** Once-per-leg teardown. */
  sharedTeardown?(): Promise<void>;
  /** Build a fresh, isolated tenant/service view for ONE test case. */
  build(): Promise<RemoteContractService>;
}

const CONTRACT_TIMEOUT_MS = 15_000;

interface ConnectOverrides {
  readonly token?: string;
  /** Explicit null OMITS the display-name header (hub falls back to the key). */
  readonly displayName?: string | null;
}

function connect(
  service: RemoteContractService,
  overrides: ConnectOverrides = {},
): Promise<RemoteLedgerClient> {
  const base = {
    serverUrl: service.serverUrl,
    projectKey: service.projectKey,
    token: overrides.token ?? service.validToken,
  };
  const displayName =
    overrides.displayName === undefined
      ? service.displayName
      : (overrides.displayName ?? undefined);
  return RemoteLedgerClient.connect(
    displayName === undefined ? base : { ...base, displayName },
  );
}

/** Seed one milestone + one planned task with a distinctive headline. */
async function seedTask(
  client: RemoteLedgerClient,
  headline: string,
): Promise<{ milestoneId: string; taskId: string }> {
  const milestone = await client.createMilestone({
    title: "Remote contract milestone",
  });
  const task = await client.createItem("tasks", milestone.id, {
    status: "planned",
    fields: { headline },
  });
  return { milestoneId: milestone.id, taskId: task.id };
}

const PREDICATE_KEYS = [
  "pInvestigate",
  "pSeed",
  "pPlan",
  "pResearch",
  "pImplement",
  "pOperatorAction",
  "openQuestionGate",
  "belowFloor",
  "planBusy",
  "goalDrift",
] as const;

export function runRemoteLedgerClientContract(
  factory: RemoteLedgerClientContractFactory,
): void {
  const contractDescribe = factory.skip === true ? describe.skip : describe;
  contractDescribe(
    `RemoteLedgerClient contract — ${factory.name} (${factory.classification})`,
    () => {
      if (factory.sharedSetup !== undefined) {
        beforeAll(factory.sharedSetup, { timeout: 180_000 });
      }
      if (factory.sharedTeardown !== undefined) {
        afterAll(factory.sharedTeardown, { timeout: 30_000 });
      }

      it(
        "negotiates initialize/version and carries the bounded display-name header",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              expect(client.protocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
              expect(client.displayName()).toBe(service.displayName);
              expect(client.url).toContain(
                `/p/${encodeURIComponent(service.projectKey)}/mcp`,
              );
            } finally {
              await client.close();
            }
            // No display-name header → the service falls back to the
            // projectKey (the hub's authenticated-initialize rule).
            const anonymous = await connect(service, { displayName: null });
            try {
              expect(anonymous.displayName()).toBe(service.projectKey);
            } finally {
              await anonymous.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it.skipIf(!factory.capabilities.bogusProtocolVersion)(
        "fails loud with RemoteProtocolError when the service negotiates an unsupported protocol version",
        async () => {
          const service = await factory.build();
          try {
            service.respondBogusProtocolVersionOnce?.();
            await expect(connect(service)).rejects.toThrow(RemoteProtocolError);
            // The service recovers: the next connect negotiates normally.
            const client = await connect(service);
            try {
              expect(client.protocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "enforces the bounded display-name header client-side",
        async () => {
          const service = await factory.build();
          try {
            // 257 UTF-8 bytes (128 two-byte chars + 1) — rejected client-side
            // BEFORE any request is issued.
            await expect(
              connect(service, { displayName: `${"é".repeat(128)}x` }),
            ).rejects.toThrow(RemoteDisplayNameError);
            // Exactly 256 bytes — accepted and echoed verbatim. (ASCII on
            // purpose: header bytes are Latin-1 over the wire, so a multibyte
            // value would arrive as mojibake at ANY HTTP server — a transport
            // charset boundary, not this client's contract.)
            const atBound = "x".repeat(256);
            const client = await connect(service, { displayName: atBound });
            try {
              expect(client.displayName()).toBe(atBound);
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "round-trips the routine write family (items, milestones, archive)",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              const milestone = await client.createMilestone({
                title: "Archive contract milestone",
                description: "milestone description",
              });
              expect(milestone.id).toMatch(/^M\d+$/);
              expect(milestone.status).toBe("open");
              expect(milestone.createdAt).not.toBe("");

              const task = await client.createItem("tasks", milestone.id, {
                status: "planned",
                fields: {
                  headline: "Archive contract task",
                  description: "original description",
                },
                author: "t727-contract",
                session: "t727-session",
              });
              expect(task.id).toMatch(/^T\d+$/);
              expect(task.milestoneId).toBe(milestone.id);
              expect(task.status).toBe("planned");
              // The fixed ack carries reference fields only.
              expect(task.fields).toEqual({});
              expect(task.author).toBe("t727-contract");
              expect(task.session).toBe("t727-session");

              // update_item: status + a per-key field merge (headline kept).
              const updated = await client.updateItem("tasks", task.id, {
                status: "wip",
                fields: { description: "updated description" },
              });
              expect(updated.status).toBe("wip");
              const full = await client.fetchItem("tasks", task.id, "full");
              expect(full.status).toBe("wip");
              expect(full.fields["headline"]).toBe("Archive contract task");
              expect(fieldOf(full, "description")).toBe("updated description");

              // Generic root update acknowledgement.
              const renamed = await client.updateMilestone(milestone.id, {
                title: "Renamed milestone",
              });
              expect(renamed.id).toBe(milestone.id);
              const fetchedMilestone = await client.fetchMilestone(
                milestone.id,
                "compact",
              );
              expect(fetchedMilestone.milestone.id).toBe(milestone.id);
              expect(fetchedMilestone.resolved.title).toBe("Renamed milestone");
              expect(fetchedMilestone.references["tasks"]).toBe(1);

              // list_milestone_items groups the task under its ledger.
              const groups = await client.listMilestoneItems(
                milestone.id,
                "compact",
              );
              expect(groups["tasks"]?.map((item) => item.id)).toEqual([task.id]);

              // archive_milestone requires every item terminal first.
              await client.updateItem("tasks", task.id, { status: "done" });
              await client.updateMilestone(milestone.id, { status: "done" });
              const pointer = await client.archiveMilestone(
                milestone.id,
                "contract archive summary",
              );
              expect(pointer.id).toBe(milestone.id);
              expect(pointer.summary).toBe("contract archive summary");
              expect(pointer.status).toBe("done");

              // The group archive (tasks) and the milestone-item archive both read back.
              const group = await client.fetchLedgerArchive(
                "tasks",
                milestone.id,
              );
              expect(group.kind).toBe("group");
              if (group.kind === "group") {
                expect(group.milestone.id).toBe(milestone.id);
                expect(group.milestone.items.map((item) => item.id)).toEqual([
                  task.id,
                ]);
              }
              const archived = await client.fetchLedgerArchive(
                "milestones",
                milestone.id,
              );
              expect(archived.kind).toBe("item");
              if (archived.kind === "item") {
                expect(archived.item.id).toBe(milestone.id);
              }

              // fetch_ledger now surfaces the archive pointer and no active group.
              const after = await client.fetchLedger("tasks", "compact");
              expect(after.archivePointers.map((p) => p.id)).toContain(
                milestone.id,
              );
              expect(
                after.milestones.some((g) => g.id === milestone.id),
              ).toBe(false);
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "drives the typed operator-action acknowledgement and evidence lifecycle",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              const milestone = await client.createMilestone({ title: "Operator action" });
              const goal = await client.createItem("goals", milestone.id, {
                status: "planned",
                fields: { title: "Deploy", description: "Deploy" },
              });
              const task = await client.createItem("tasks", milestone.id, {
                status: "planned",
                fields: {
                  headline: "Deploy exact output",
                  description:
                    "CQ-OPERATOR-ACTION v1 remote-deployment. User deploys; parent measures.",
                  ledgerRefs: [`goals:${goal.id}`],
                },
              });
              const materialized = await client.materializeOperatorAction({
                taskId: task.id,
                expectedOutputIdentity: "/nix/store/remote-cq",
                expectedEvidence: ["cq --version"],
                author: "remote-parent",
              });
              expect(materialized.state).toBe("created");
              const acknowledged = await client.acknowledgeOperatorAction({
                actionId: materialized.action.id,
                outputIdentity: "/nix/store/remote-cq",
                acknowledgedAt: "2026-08-11T06:00:00.000Z",
              });
              expect(acknowledged.state).toBe("acknowledged");
              const evidence = await client.recordOperatorActionEvidence({
                actionId: materialized.action.id,
                evidence: {
                  command: "cq --version",
                  stdout: "cq remote",
                  stderr: "",
                  exitCode: 0,
                  outputIdentity: "/nix/store/remote-cq",
                  observedAt: "2026-08-11T06:01:00.000Z",
                },
                author: "remote-parent",
              });
              expect(evidence.state).toBe("verified");
              const completed = await client.completeOperatorAction({
                actionId: materialized.action.id,
                completion: "remote output verified",
                author: "remote-parent",
              });
              expect(completed.status).toBe("done");
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "round-trips the routine read family (enumerate/fetch/search/snapshot/predicates)",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              const headline = "Remote contract task quixotic";
              const { milestoneId, taskId } = await seedTask(client, headline);

              // enumerate_ledgers
              const enumerated = await client.enumerateLedgers();
              expect(enumerated.ledgers).toContain("tasks");
              expect(enumerated.counts["tasks"]).toBe(1);
              const summary = enumerated.ledgerSummaries.find(
                (s) => s.name === "tasks",
              );
              expect(summary?.itemCount).toBe(1);
              expect(summary?.statusCounts?.["planned"]).toBe(1);

              // fetch_ledger (grouped): the compact projection discipline holds
              // — headline retained, description dropped.
              const fetched = await client.fetchLedger("tasks", "compact");
              expect(fetched.id).toBe("tasks");
              expect(fetched.schema.idPrefix).toBe("T");
              const group = fetched.milestones.find((g) => g.id === milestoneId);
              expect(group).toBeDefined();
              expect(group?.items.map((item) => item.id)).toEqual([taskId]);
              expect(group?.items[0]?.fields["headline"]).toBe(headline);

              // fetch_item (full)
              const full = await client.fetchItem("tasks", taskId, "full");
              expect(full.milestoneId).toBe(milestoneId);
              expect(full.fields["headline"]).toBe(headline);

              // search_items: hit + miss.
              const hits = await client.searchItems("tasks", "quixotic", "compact");
              expect(hits.map((item) => item.id)).toEqual([taskId]);
              expect(
                await client.searchItems("tasks", "zzz-no-such-fragment", "compact"),
              ).toEqual([]);

              // fts_search: the task is the top (only) hit.
              const ftsHits = await client.ftsSearch("quixotic", "compact");
              expect(ftsHits.length).toBeGreaterThan(0);
              expect(ftsHits[0]?.item.id).toBe(taskId);
              expect(ftsHits[0]?.score).toBeGreaterThan(0);
              expect(ftsHits[0]?.matchedFields).toContain("headline");

              // snapshot: the task appears in the tasks/planned bucket.
              const snapshot = await client.snapshot();
              const bucket = snapshot["tasks"]?.["planned"];
              expect(bucket?.count).toBe(1);
              expect(bucket?.items).toEqual([
                { id: taskId, status: "planned", summary: headline },
              ]);

              // derive_predicates: a lone planned task with no owning goal is
              // actionable under NO predicate — every verdict is false/empty.
              const verdicts = await client.derivePredicates();
              for (const key of PREDICATE_KEYS) {
                expect(verdicts[key]).toEqual({ value: false, items: [] });
              }

              // get_usage_stats (T1513): the snapshot parses into
              // { endpoints, totals } — per-endpoint counters plus the
              // "totals" aggregate row consistent with them.
              const stats = await client.getUsageStats();
              expect(stats.totals.name).toBe("totals");
              expect(stats.endpoints.length).toBeGreaterThan(0);
              for (const endpoint of stats.endpoints) {
                expect(typeof endpoint.callCount).toBe("number");
                expect(typeof endpoint.bytesIn).toBe("number");
                expect(typeof endpoint.bytesOut).toBe("number");
              }
              expect(stats.totals.callCount).toBe(
                stats.endpoints.reduce((sum, e) => sum + e.callCount, 0),
              );

              // Paginated fetch_ledger follows nextOffset to the end.
              const second = await client.createItem("tasks", milestoneId, {
                status: "planned",
                fields: { headline: "Second task" },
              });
              const third = await client.createItem("tasks", milestoneId, {
                status: "planned",
                fields: { headline: "Third task" },
              });
              const page1 = await client.fetchLedgerPage("tasks", "compact", {
                limit: 2,
              });
              expect(page1.total).toBe(3);
              expect(page1.offset).toBe(0);
              expect(page1.limit).toBe(2);
              expect(page1.items.map((item) => item.id)).toEqual([
                taskId,
                second.id,
              ]);
              expect(page1.nextOffset).toBe(2);
              const page2 = await client.fetchLedgerPage("tasks", "compact", {
                offset: page1.nextOffset ?? 0,
                limit: 2,
              });
              expect(page2.items.map((item) => item.id)).toEqual([third.id]);
              expect(page2.nextOffset).toBeNull();
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "reports the connected tenant through list_projects",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              const projects = await client.listProjects();
              const self = projects.find((p) => p.key === service.projectKey);
              expect(self).toBeDefined();
              expect(self?.displayName).toBe(service.displayName);
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "round-trips a seeded log artifact through read_log",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              const content = "# Contract log\n\ncontent-⋮-✓\n";
              await service.seedLog("t727-contract.md", content);
              const result = await client.readLog("t727-contract.md");
              expect(result.path).toBe("t727-contract.md");
              expect(result.content).toBe(content);
              expect(result.truncated).toBeUndefined();
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "fails loud with RemoteAuthError on a rejected bearer token",
        async () => {
          const service = await factory.build();
          try {
            try {
              await connect(service, { token: service.invalidToken });
              expect.unreachable("connect with a bad token must reject");
            } catch (err) {
              expect(err).toBeInstanceOf(RemoteAuthError);
              // The presented credential is never echoed back.
              expect((err as Error).message).not.toContain(service.invalidToken);
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "fails loud on an unknown tool with the server's own message",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              try {
                await client.callToolRaw("no_such_tool", {});
                expect.unreachable("an unknown tool must reject");
              } catch (err) {
                // The production McpServer converts its unknown-tool McpError
                // into an isError tool result — the client surfaces it through
                // the tool-error channel with the message preserved verbatim.
                expect(err).toBeInstanceOf(RemoteToolError);
                const toolError = err as RemoteToolError;
                expect(toolError.tool).toBe("no_such_tool");
                expect(toolError.message).toContain("no_such_tool");
                expect(toolError.message).toContain("-32602");
              }
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "preserves the remote tool error message verbatim",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              try {
                await client.createItem("tasks", "M999", {
                  status: "planned",
                  fields: { headline: "orphaned task" },
                });
                expect.unreachable("creating under a missing milestone must reject");
              } catch (err) {
                expect(err).toBeInstanceOf(RemoteToolError);
                const toolError = err as RemoteToolError;
                expect(toolError.tool).toBe("create_item");
                // The remote message is preserved verbatim — production
                // backends word it differently (PostgresLedgerStore:
                // "Milestone M999 does not exist in the milestones ledger";
                // the in-memory/abstract stores: "milestone M999 not found"),
                // so the cross-backend invariant pinned here is that the
                // SERVER's message (not a client fallback) names the missing
                // milestone.
                expect(toolError.message).toMatch(/milestone/i);
                expect(toolError.message).toContain("M999");
              }
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it.skipIf(!factory.capabilities.malformedResponses)(
        "fails loud with RemoteMalformedResponseError on a malformed tool result, then recovers",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            try {
              service.respondMalformedOnce?.("non-text-block");
              await expect(client.enumerateLedgers()).rejects.toThrow(
                RemoteMalformedResponseError,
              );
              service.respondMalformedOnce?.("invalid-json");
              await expect(client.enumerateLedgers()).rejects.toThrow(
                RemoteMalformedResponseError,
              );
              // One-shot knobs: the very next call is well-formed again.
              expect((await client.enumerateLedgers()).ledgers).toContain("tasks");
            } finally {
              await client.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "fails loud with RemoteUnavailableError when the service is unreachable",
        async () => {
          // A freshly-closed ephemeral port is a reliably dead endpoint; this
          // case needs no fixture (the failure happens at connect).
          const probe = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response("ok"),
          });
          const port = probe.port;
          probe.stop(true);
          await expect(
            RemoteLedgerClient.connect({
              serverUrl: `http://127.0.0.1:${String(port)}/`,
              projectKey: "t727-unreachable",
              token: "t727-unreachable-token",
            }),
          ).rejects.toThrow(RemoteUnavailableError);
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "reconnects after close (a fresh session works)",
        async () => {
          const service = await factory.build();
          try {
            const first = await connect(service);
            await first.close();
            const second = await connect(service);
            try {
              expect(second.displayName()).toBe(service.displayName);
              expect(second.protocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
              const milestone = await second.createMilestone({
                title: "After reconnect",
              });
              expect(milestone.id).toMatch(/^M\d+$/);
              const enumerated = await second.enumerateLedgers();
              expect(enumerated.ledgers).toContain("tasks");
            } finally {
              await second.close();
            }
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );

      it(
        "close() ends the session; further calls reject and a second close is a no-op",
        async () => {
          const service = await factory.build();
          try {
            const client = await connect(service);
            await client.close();
            await expect(client.enumerateLedgers()).rejects.toThrow();
            await client.close();
          } finally {
            await service.dispose();
          }
        },
        CONTRACT_TIMEOUT_MS,
      );
    },
  );
}
