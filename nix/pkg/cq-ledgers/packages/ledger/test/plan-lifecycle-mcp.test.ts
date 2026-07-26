/**
 * T852 — the four guarded plan mutations over MCP.
 *
 * Classification: Behavioral-Active Blackbox-GoodCommunication. Every
 * assertion goes through a real tool invocation (direct `tool()` handler or a
 * linked-pair stdio `McpServer`), never a direct `PlanLifecycleStore` call, so
 * what is under test is the MCP surface: its schemas, its authority
 * discipline, and what it lets out onto the wire.
 *
 * Covered:
 *  - a lost initial claim response, its exact retry, an exact retry after a
 *    process restart, and the ordering-independence of the original and the
 *    retry — on BOTH transports, against independent stores;
 *  - the owner token is echoed by the winning/exactly-retried claim ONLY, and
 *    never by a conflict, an owner-operation acknowledgement, or a public read;
 *  - the public claimId/generation pair authorizes nothing but exact recovery
 *    abandonment, and that abandonment loses once ownership moves on;
 *  - operation-scoped idempotency;
 *  - persisted transcripts / exports / backups are redacted while the live
 *    response is untouched;
 *  - raw CRUD cannot bypass the guarded surface.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertPlanLifecycleTokenExposure,
  buildBackupDump,
  createLedgerMcpTools,
  GOALS_LEDGER,
  PLAN_GENERATION_FIELD,
  redactSecrets,
  registerLedgerStdioTools,
  TASKS_LEDGER,
  type LedgerStore,
  type LedgerToolName,
} from "../src/index.js";
import { InMemoryPlanLifecycleFixture } from "./planLifecycleInMemoryAdapter.js";

const GOAL_ID = "G1";
const OWNER_A = "owner_a_fence_token_00000";
const OWNER_B = "owner_b_fence_token_00000";
const PROVENANCE = { author: "t852", session: "t852-session" } as const;
const MANIFEST = {
  milestones: [{ key: "delivery", title: "Delivery" }],
  tasks: [
    { key: "implementation", milestoneKey: "delivery", headline: "Implementation" },
  ],
} as const;

type ToolArgs = Record<string, unknown>;

type Outcome =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly message: string };

interface TextToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Transport harnesses
// ---------------------------------------------------------------------------

type DirectTools = ReturnType<typeof createLedgerMcpTools>;

async function invokeDirect(
  tools: DirectTools,
  name: LedgerToolName,
  args: ToolArgs,
): Promise<Outcome> {
  const target = tools.find((candidate) => candidate.name === name);
  if (target === undefined) throw new Error(`direct tool not found: ${name}`);
  const parsed = z
    .object(target.inputSchema as Record<string, z.ZodType>)
    .safeParse(args);
  if (!parsed.success) return { ok: false, message: parsed.error.message };
  try {
    const result = (await target.handler(
      parsed.data as never,
      null,
    )) as TextToolResult;
    const text = result.content[0]?.text;
    if (text === undefined) throw new Error("expected one text content block");
    return { ok: true, payload: JSON.parse(text) };
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, message: error.message };
  }
}

async function invokeStdio(
  client: Client,
  name: LedgerToolName,
  args: ToolArgs,
): Promise<Outcome> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as TextToolResult;
  const text = result.content[0]?.text ?? "";
  if (result.isError === true) return { ok: false, message: text };
  return { ok: true, payload: JSON.parse(text) };
}

interface StdioSurface {
  client: Client;
  close(): Promise<void>;
}

async function connectStdio(store: LedgerStore): Promise<StdioSurface> {
  const server = new McpServer(
    { name: "plan-lifecycle-mcp-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(server, store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "plan-lifecycle-mcp-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * ONE fixture behind the direct `tool()` factory. Used for the scenarios whose
 * subject is authority/idempotency rather than transport symmetry — the
 * shared spec makes the stdio behaviour identical by construction, and
 * `stdio-tool-parity.test.ts` verifies that differentially.
 */
async function buildSingle(): Promise<{
  fixture: InMemoryPlanLifecycleFixture;
  call(name: LedgerToolName, args: ToolArgs): Promise<unknown>;
  outcome(name: LedgerToolName, args: ToolArgs): Promise<Outcome>;
  dispose(): Promise<void>;
}> {
  const fixture = await InMemoryPlanLifecycleFixture.create();
  await fixture.seedGoal({ goalId: GOAL_ID, phase: "clarifying", generation: null });
  const tools = createLedgerMcpTools(fixture.store);
  return {
    fixture,
    outcome: (name, args) => invokeDirect(tools, name, args),
    call: async (name, args) => {
      const result = await invokeDirect(tools, name, args);
      if (!result.ok) throw new Error(`${name} failed: ${result.message}`);
      return result.payload;
    },
    dispose: () => fixture.dispose(),
  };
}

/**
 * TWO independent stores, one per transport: every call is issued through the
 * direct factory against store A and through a stdio client against store B,
 * and the two payloads must be byte-equal.
 */
class PlanDuo {
  private constructor(
    private directFixture: InMemoryPlanLifecycleFixture,
    private stdioFixture: InMemoryPlanLifecycleFixture,
    private tools: DirectTools,
    private stdio: StdioSurface,
  ) {}

  static async create(): Promise<PlanDuo> {
    const directFixture = await InMemoryPlanLifecycleFixture.create();
    const stdioFixture = await InMemoryPlanLifecycleFixture.create();
    for (const fixture of [directFixture, stdioFixture]) {
      await fixture.seedGoal({
        goalId: GOAL_ID,
        phase: "clarifying",
        generation: null,
      });
    }
    return new PlanDuo(
      directFixture,
      stdioFixture,
      createLedgerMcpTools(directFixture.store),
      await connectStdio(stdioFixture.store),
    );
  }

  async call(name: LedgerToolName, args: ToolArgs): Promise<unknown> {
    const direct = await invokeDirect(this.tools, name, args);
    const stdio = await invokeStdio(this.stdio.client, name, args);
    expect(stdio, name).toEqual(direct);
    if (!direct.ok) throw new Error(`${name} failed: ${direct.message}`);
    return direct.payload;
  }

  /** Restart BOTH processes, preserving only durable (redacted) state. */
  async restart(): Promise<void> {
    await this.stdio.close();
    const nextDirect = (await this.directFixture.restart()) as InMemoryPlanLifecycleFixture;
    const nextStdio = (await this.stdioFixture.restart()) as InMemoryPlanLifecycleFixture;
    await this.directFixture.dispose();
    await this.stdioFixture.dispose();
    this.directFixture = nextDirect;
    this.stdioFixture = nextStdio;
    this.tools = createLedgerMcpTools(nextDirect.store);
    this.stdio = await connectStdio(nextStdio.store);
  }

  async dispose(): Promise<void> {
    await this.stdio.close();
    await this.directFixture.dispose();
    await this.stdioFixture.dispose();
  }
}

function claimArgs(
  claimRequestId: string,
  token: string,
  expectedGeneration: number | null,
  overrides: ToolArgs = {},
): ToolArgs {
  return {
    goalId: GOAL_ID,
    purpose: "initial",
    claimRequestId,
    ownerFenceToken: token,
    expectedGeneration,
    ...PROVENANCE,
    ...overrides,
  };
}

function ownerArgs(claim: ClaimAcknowledgement, operationId: string): ToolArgs {
  return {
    goalId: GOAL_ID,
    claimId: claim.claimId,
    generation: claim.generation,
    operationId,
    ownerFenceToken: claim.ownerFenceToken,
    ...PROVENANCE,
  };
}

interface ClaimAcknowledgement {
  claimId: string;
  generation: number;
  ownerFenceToken: string;
}

function winningClaim(payload: unknown): ClaimAcknowledgement {
  const result = payload as {
    ok: boolean;
    acknowledgement?: ClaimAcknowledgement;
  };
  if (!result.ok || result.acknowledgement === undefined) {
    throw new Error(`claim did not win: ${JSON.stringify(payload)}`);
  }
  return result.acknowledgement;
}

function carriesNoToken(payload: unknown, token: string, label: string): void {
  const serialized = JSON.stringify(payload);
  expect(serialized, label).not.toContain("ownerFenceToken");
  expect(serialized, label).not.toContain(token);
}

// ---------------------------------------------------------------------------

describe("T852 guarded plan lifecycle over MCP", () => {
  it("recovers a lost claim response across retry, restart, and ordering on both transports", async () => {
    const duo = await PlanDuo.create();
    try {
      // 1. The initial claim wins and echoes the caller's own token.
      const first = await duo.call(
        "claim_plan",
        claimArgs("request_1", OWNER_A, null),
      );
      expect(first).toMatchObject({
        ok: true,
        replayed: false,
        acknowledgement: {
          goalId: GOAL_ID,
          purpose: "initial",
          claimRequestId: "request_1",
          ownerFenceToken: OWNER_A,
          previousGoalPhase: "clarifying",
          goalPhase: "planning",
          generation: 1,
        },
      });
      const claim = winningClaim(first);

      // 2. The response was lost in transit: the SAME request replays.
      const retried = await duo.call(
        "claim_plan",
        claimArgs("request_1", OWNER_A, null),
      );
      expect(retried).toEqual({
        ...(first as object),
        replayed: true,
      });

      // 3. …and still replays after both processes restart, reconstructed
      //    from durable state that holds only the SHA-256 verifier.
      await duo.restart();
      const afterRestart = await duo.call(
        "claim_plan",
        claimArgs("request_1", OWNER_A, null),
      );
      expect(afterRestart).toEqual(retried);

      // 4. Ordering is immaterial: a LATE arrival of the original request is
      //    indistinguishable from the retry, and a second claimant loses
      //    against the still-active claim with public metadata only.
      expect(
        await duo.call("claim_plan", claimArgs("request_1", OWNER_A, null)),
      ).toEqual(retried);
      const contender = await duo.call(
        "claim_plan",
        claimArgs("request_2", OWNER_B, 1),
      );
      expect(contender).toEqual({
        ok: false,
        conflict: {
          code: "claim-active",
          goalId: GOAL_ID,
          claimId: claim.claimId,
          generation: 1,
        },
      });

      // 5. A retry that CHANGES the request is not a retry.
      const changed = await duo.call(
        "claim_plan",
        claimArgs("request_1", OWNER_A, 1),
      );
      expect(changed).toEqual({
        ok: false,
        conflict: {
          code: "claim-request-reused",
          goalId: GOAL_ID,
          claimId: claim.claimId,
          generation: 1,
          claimRequestId: "request_1",
        },
      });

      for (const [label, payload] of [
        ["claim-active", contender],
        ["claim-request-reused", changed],
      ] as const) {
        carriesNoToken(payload, OWNER_A, label);
        carriesNoToken(payload, OWNER_B, label);
      }
    } finally {
      await duo.dispose();
    }
  });

  it("drives publish and finalize with the private token and never echoes it", async () => {
    const single = await buildSingle();
    try {
      const claim = winningClaim(
        await single.call("claim_plan", claimArgs("request_1", OWNER_A, null)),
      );

      const published = await single.call("publish_plan_draft", {
        ...ownerArgs(claim, "publish_1"),
        manifest: MANIFEST,
      });
      expect(published).toMatchObject({
        ok: true,
        replayed: false,
        acknowledgement: {
          manifest: { revision: 1 },
          replacedManifest: null,
          reviewDefects: [],
        },
      });
      carriesNoToken(published, OWNER_A, "publish_plan_draft");
      const revision = (
        published as { acknowledgement: { manifest: { revision: number } } }
      ).acknowledgement.manifest.revision;

      await single.fixture.seedReview({
        reviewId: "R1",
        goalId: GOAL_ID,
        status: "go-ahead",
        draft: {
          goalId: GOAL_ID,
          claimId: claim.claimId,
          generation: claim.generation,
          revision,
        },
        provenance: PROVENANCE,
      });

      const finalized = await single.call("finalize_plan", {
        ...ownerArgs(claim, "finalize_1"),
        reviewId: "R1",
        draftRevision: revision,
        decision: { headline: "Approve the delivery plan" },
      });
      expect(finalized).toMatchObject({
        ok: true,
        acknowledgement: { reviewId: "R1", goalPhase: "planned" },
      });
      carriesNoToken(finalized, OWNER_A, "finalize_plan");
      expect((await single.fixture.observe(GOAL_ID)).phase).toBe("planned");
    } finally {
      await single.dispose();
    }
  });

  it("pauses on researches with the owner token and replaces the wait set", async () => {
    const single = await buildSingle();
    try {
      const claim = winningClaim(
        await single.call("claim_plan", claimArgs("request_1", OWNER_A, null)),
      );
      const paused = await single.call("release_plan_claim", {
        kind: "pause",
        ...ownerArgs(claim, "pause_1"),
        effect: {
          kind: "researches",
          researches: [{ key: "probe", question: "Which backend wins?" }],
        },
      });
      expect(paused).toMatchObject({
        ok: true,
        acknowledgement: { kind: "researches", goalPhase: "planning" },
      });
      carriesNoToken(paused, OWNER_A, "release_plan_claim");
      const waiting = (paused as { acknowledgement: { waitingResearches: string[] } })
        .acknowledgement.waitingResearches;
      expect(waiting).toHaveLength(1);
      expect((await single.fixture.observe(GOAL_ID)).waitingResearches).toEqual(
        waiting,
      );
    } finally {
      await single.dispose();
    }
  });

  it("refuses owner operations to a caller holding only the public claim id", async () => {
    const single = await buildSingle();
    try {
      const claim = winningClaim(
        await single.call("claim_plan", claimArgs("request_1", OWNER_A, null)),
      );
      const publicOnly = {
        goalId: GOAL_ID,
        claimId: claim.claimId,
        generation: claim.generation,
        ...PROVENANCE,
      };

      // A wrong token is a runtime conflict, not an accepted write.
      const wrongToken = await single.call("publish_plan_draft", {
        ...publicOnly,
        operationId: "publish_wrong_token",
        ownerFenceToken: OWNER_B,
        manifest: MANIFEST,
      });
      expect(wrongToken).toEqual({
        ok: false,
        conflict: {
          code: "owner-fence-mismatch",
          goalId: GOAL_ID,
          claimId: claim.claimId,
          generation: claim.generation,
        },
      });
      carriesNoToken(wrongToken, OWNER_B, "owner-fence-mismatch");

      // No token at all does not even satisfy the schema.
      const noToken = await single.outcome("publish_plan_draft", {
        ...publicOnly,
        operationId: "publish_no_token",
        manifest: MANIFEST,
      });
      expect(noToken.ok).toBe(false);

      const pauseNoToken = await single.outcome("release_plan_claim", {
        kind: "pause",
        ...publicOnly,
        operationId: "pause_no_token",
        effect: {
          kind: "questions",
          questions: [{ key: "scope", question: "How wide is the scope?" }],
        },
      });
      expect(pauseNoToken.ok).toBe(false);

      // Abandonment is deliberately tokenless: supplying one is rejected
      // rather than silently ignored.
      const abandonWithToken = await single.outcome("release_plan_claim", {
        kind: "abandon",
        ...publicOnly,
        operationId: "abandon_with_token",
        reason: "recover the claim",
        ownerFenceToken: OWNER_A,
      });
      expect(abandonWithToken.ok).toBe(false);
      // The rejection diagnostic names the offending KEY, never its value —
      // an error string is a persisted-transcript channel too.
      for (const rejected of [noToken, pauseNoToken, abandonWithToken]) {
        if (rejected.ok) throw new Error("expected a rejected owner operation");
        expect(rejected.message).not.toContain(OWNER_A);
      }

      // None of the rejected attempts moved the goal off the live claim.
      const state = await single.fixture.observe(GOAL_ID);
      expect(state.activeClaim).toMatchObject({ claimId: claim.claimId });
      expect(state.currentDraft).toBeNull();
    } finally {
      await single.dispose();
    }
  });

  it("replays a scoped operation retry and rejects a changed one", async () => {
    const single = await buildSingle();
    try {
      const claim = winningClaim(
        await single.call("claim_plan", claimArgs("request_1", OWNER_A, null)),
      );
      const publish = {
        ...ownerArgs(claim, "publish_1"),
        manifest: MANIFEST,
      };
      const first = await single.call("publish_plan_draft", publish);
      const replay = await single.call("publish_plan_draft", publish);
      expect(replay).toEqual({ ...(first as object), replayed: true });

      const changed = await single.call("publish_plan_draft", {
        ...publish,
        manifest: {
          milestones: [{ key: "delivery", title: "Delivery" }],
          tasks: [
            {
              key: "implementation",
              milestoneKey: "delivery",
              headline: "A different implementation",
            },
          ],
        },
      });
      expect(changed).toEqual({
        ok: false,
        conflict: {
          code: "idempotency-key-reused",
          goalId: GOAL_ID,
          claimId: claim.claimId,
          generation: claim.generation,
          operation: "publish-draft",
          operationId: "publish_1",
        },
      });
      // Exactly one draft survived the retry storm.
      expect((await single.fixture.observe(GOAL_ID)).tasks).toHaveLength(1);
    } finally {
      await single.dispose();
    }
  });

  it("loses an exact abandonment once ownership has moved on", async () => {
    const single = await buildSingle();
    try {
      const stranded = winningClaim(
        await single.call("claim_plan", claimArgs("request_1", OWNER_A, null)),
      );
      const recovery = {
        kind: "abandon",
        goalId: GOAL_ID,
        claimId: stranded.claimId,
        generation: stranded.generation,
        reason: "the owner is gone",
        ...PROVENANCE,
      };

      // The tokenless recovery wins against the exact stranded claim.
      expect(
        await single.call("release_plan_claim", {
          ...recovery,
          operationId: "abandon_1",
        }),
      ).toMatchObject({ ok: true, acknowledgement: { kind: "abandon" } });

      // Ownership moves on.
      const successor = winningClaim(
        await single.call("claim_plan", claimArgs("request_2", OWNER_B, 1)),
      );
      expect(successor.generation).toBe(2);

      // A late duplicate of the recovery, aimed at the OLD claim, loses.
      const late = await single.call("release_plan_claim", {
        ...recovery,
        operationId: "abandon_2",
      });
      expect(late).toEqual({
        ok: false,
        conflict: {
          code: "stale-claim",
          goalId: GOAL_ID,
          suppliedClaimId: stranded.claimId,
          currentClaimId: successor.claimId,
          currentGeneration: 2,
        },
      });
      carriesNoToken(late, OWNER_A, "late abandonment");

      // The successor still owns the goal.
      expect((await single.fixture.observe(GOAL_ID)).activeClaim).toMatchObject({
        claimId: successor.claimId,
        generation: 2,
      });
    } finally {
      await single.dispose();
    }
  });

  it("keeps the owner token out of every public read", async () => {
    const single = await buildSingle();
    try {
      await single.call("claim_plan", claimArgs("request_1", OWNER_A, null));
      const reads: Array<[LedgerToolName, ToolArgs]> = [
        ["fetch_item", { ledger_id: GOALS_LEDGER, item_id: GOAL_ID, projection: "full" }],
        ["fetch_ledger", { ledger_id: GOALS_LEDGER, projection: "full" }],
        ["snapshot", {}],
        ["enumerate_ledgers", {}],
        ["fts_search", { query: GOAL_ID, projection: "full" }],
        ["derive_predicates", {}],
      ];
      for (const [name, args] of reads) {
        carriesNoToken(await single.call(name, args), OWNER_A, name);
      }
    } finally {
      await single.dispose();
    }
  });

  it("redacts the token in persisted logs, exports, and backups while the live response keeps it", async () => {
    const single = await buildSingle();
    const logsDir = await mkdtemp(path.join(tmpdir(), "t852-logs-"));
    try {
      const live = await single.call(
        "claim_plan",
        claimArgs("request_1", OWNER_A, null),
      );
      const liveTranscript = JSON.stringify({ type: "tool_result", result: live });

      // The LIVE response is untouched — the owner needs the token to act.
      expect(liveTranscript).toContain(OWNER_A);

      // Every persisted copy goes through the log-write redaction choke point.
      const stored = redactSecrets(liveTranscript);
      expect(stored).not.toContain(OWNER_A);
      expect(stored).toContain("[REDACTED:plan-owner-fence-token]");
      expect(JSON.parse(stored)).toMatchObject({
        result: {
          acknowledgement: { ownerFenceToken: "[REDACTED:plan-owner-fence-token]" },
        },
      });
      // Redacting did not mutate the live payload object.
      expect(JSON.stringify(live)).toContain(OWNER_A);

      await mkdir(path.join(logsDir, "raw"), { recursive: true });
      await writeFile(path.join(logsDir, "raw", "session.jsonl"), `${stored}\n`, "utf8");

      const dump = await buildBackupDump(single.fixture.store, logsDir);
      const dumped = JSON.stringify(dump);
      expect(dumped).not.toContain(OWNER_A);
      expect(dumped).not.toContain("ownerFenceTokenVerifier");
      expect(dump.map(({ path: rel }) => rel)).toContain("logs/raw/session.jsonl");
      // …and the log really is IN that dump, so the assertion above is about
      // redaction rather than about an absent file.
      expect(dumped).toContain("[REDACTED:plan-owner-fence-token]");

      // POSITIVE CONTROL. `buildBackupDump` mirrors the logs area
      // byte-for-byte — it does NOT redact — so the token is absent above
      // ONLY because the write path redacted it. Dumping the same transcript
      // UNREDACTED must therefore surface the secret. This is what makes the
      // `cq log put` choke point load-bearing instead of decorative, and it
      // is what stops the assertion above from passing vacuously.
      const unredactedDir = await mkdtemp(path.join(tmpdir(), "t852-raw-"));
      try {
        await mkdir(path.join(unredactedDir, "raw"), { recursive: true });
        await writeFile(
          path.join(unredactedDir, "raw", "session.jsonl"),
          `${liveTranscript}\n`,
          "utf8",
        );
        const leaked = JSON.stringify(
          await buildBackupDump(single.fixture.store, unredactedDir),
        );
        expect(leaked).toContain(OWNER_A);
      } finally {
        await rm(unredactedDir, { recursive: true, force: true });
      }
    } finally {
      await rm(logsDir, { recursive: true, force: true });
      await single.dispose();
    }
  });

  it("rejects raw CRUD attempts to bypass the guarded surface", async () => {
    const single = await buildSingle();
    try {
      const claim = winningClaim(
        await single.call("claim_plan", claimArgs("request_1", OWNER_A, null)),
      );
      await single.call("publish_plan_draft", {
        ...ownerArgs(claim, "publish_1"),
        manifest: MANIFEST,
      });
      const taskId = (await single.fixture.observe(GOAL_ID)).tasks[0]?.id;
      if (taskId === undefined) throw new Error("draft task allocation missing");

      const bypasses: Array<[string, LedgerToolName, ToolArgs]> = [
        [
          "managed goal field",
          "update_item",
          {
            ledger_id: GOALS_LEDGER,
            item_id: GOAL_ID,
            fields: { [PLAN_GENERATION_FIELD]: "99" },
          },
        ],
        [
          "managed goal transition",
          "update_item",
          { ledger_id: GOALS_LEDGER, item_id: GOAL_ID, status: "planned" },
        ],
        [
          "draft task start",
          "update_item",
          { ledger_id: TASKS_LEDGER, item_id: taskId, status: "wip" },
        ],
      ];
      for (const [label, name, args] of bypasses) {
        const outcome = await single.outcome(name, args);
        expect(outcome.ok, label).toBe(false);
      }

      const state = await single.fixture.observe(GOAL_ID);
      expect(state.generation).toBe(1);
      expect(state.phase).toBe("planning");
      expect(state.tasks[0]?.status).toBe("planned");
    } finally {
      await single.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The exposure guard itself
// ---------------------------------------------------------------------------

describe("assertPlanLifecycleTokenExposure", () => {
  const acknowledgement = { claimId: "claim_G1_1", ownerFenceToken: OWNER_A };

  it("accepts exactly the winning-claim echo", () => {
    expect(() =>
      assertPlanLifecycleTokenExposure("claim_plan", {
        ok: true,
        replayed: false,
        acknowledgement,
      }),
    ).not.toThrow();
    expect(() =>
      assertPlanLifecycleTokenExposure("publish_plan_draft", {
        ok: true,
        replayed: false,
        acknowledgement: { claimId: "claim_G1_1" },
      }),
    ).not.toThrow();
  });

  it("rejects a claim conflict that leaks the token", () => {
    expect(() =>
      assertPlanLifecycleTokenExposure("claim_plan", {
        ok: false,
        conflict: { code: "claim-active", ownerFenceToken: OWNER_A },
      }),
    ).toThrow(/ownerFenceToken at \[conflict\.ownerFenceToken\]/);
  });

  it("rejects an owner-operation acknowledgement that leaks the token", () => {
    for (const toolName of [
      "publish_plan_draft",
      "release_plan_claim",
      "finalize_plan",
    ] as const) {
      expect(() =>
        assertPlanLifecycleTokenExposure(toolName, {
          ok: true,
          replayed: false,
          acknowledgement,
        }),
      ).toThrow(/allow exactly \[\]/);
    }
  });

  it("rejects a leak nested inside an array", () => {
    expect(() =>
      assertPlanLifecycleTokenExposure("release_plan_claim", {
        ok: true,
        acknowledgement: { reviewDefects: [{ id: "D1", ownerFenceToken: OWNER_A }] },
      }),
    ).toThrow(/acknowledgement\.reviewDefects\[0\]\.ownerFenceToken/);
  });

  it("rejects a winning claim that fails to echo the token", () => {
    expect(() =>
      assertPlanLifecycleTokenExposure("claim_plan", {
        ok: true,
        replayed: false,
        acknowledgement: { claimId: "claim_G1_1" },
      }),
    ).toThrow(/allow exactly \[acknowledgement\.ownerFenceToken\]/);
  });
});

// ---------------------------------------------------------------------------
// …and the guard is WIRED, not merely present
// ---------------------------------------------------------------------------

/**
 * The unit tests above invoke `assertPlanLifecycleTokenExposure` DIRECTLY, so
 * none of them can observe the call site going missing: deleting the single
 * `assertPlanLifecycleTokenExposure(...)` in `planResult` leaves the whole
 * suite green while every guarded tool starts emitting the token onto the
 * wire. These tests close that hole. They drive a STUB store whose guarded
 * mutations RETURN a leaking payload and push it through the real tool
 * handlers on BOTH transports, so the subject is the wire boundary itself —
 * remove the guard call and they fail.
 */
describe("the owner-token guard is enforced at the wire boundary", () => {
  /** Guarded-mutation stubs, keyed by `PlanLifecycleStore` method name. */
  type LifecycleStub = Readonly<Record<string, () => Promise<unknown>>>;

  /**
   * `base` with the named guarded mutations replaced by leaking stubs. Every
   * other member still resolves to the real store (bound to it, so private
   * state keeps working), which is what lets both transport factories accept
   * this as an ordinary `LedgerStore` and what keeps `isPlanLifecycleStore`
   * satisfied.
   */
  function withLeakingLifecycle(
    base: LedgerStore,
    stub: LifecycleStub,
  ): LedgerStore {
    return new Proxy(base, {
      get(target, prop, receiver): unknown {
        if (typeof prop === "string" && prop in stub) return stub[prop];
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  /** Invoke one tool over a leaking store on the direct AND stdio surfaces. */
  async function bothTransports(
    stub: LifecycleStub,
    name: LedgerToolName,
    args: ToolArgs,
  ): Promise<ReadonlyArray<readonly [string, Outcome]>> {
    const fixture = await InMemoryPlanLifecycleFixture.create();
    const store = withLeakingLifecycle(fixture.store, stub);
    const stdio = await connectStdio(store);
    try {
      return [
        ["direct", await invokeDirect(createLedgerMcpTools(store), name, args)],
        ["stdio", await invokeStdio(stdio.client, name, args)],
      ];
    } finally {
      await stdio.close();
      await fixture.dispose();
    }
  }

  /**
   * Every transport must have refused, naming the path but never the value.
   * Leaks are collected across ALL transports before throwing, so removing the
   * guard reports each surface that let the token through rather than
   * short-circuiting on the first.
   */
  function expectRefused(
    outcomes: ReadonlyArray<readonly [string, Outcome]>,
    expected: RegExp,
  ): void {
    const leaked = outcomes.filter(([, outcome]) => outcome.ok);
    if (leaked.length > 0) {
      throw new Error(
        "the leaking payload reached the caller unguarded on " +
          leaked
            .map(
              ([label, outcome]) =>
                `${label}: ${JSON.stringify(outcome.ok ? outcome.payload : null)}`,
            )
            .join(" | "),
      );
    }
    for (const [label, outcome] of outcomes) {
      if (outcome.ok) continue;
      expect(outcome.message, label).toMatch(expected);
      // The diagnostic names the offending PATH; it must not quote the secret.
      expect(outcome.message, label).not.toContain(OWNER_A);
    }
  }

  it("refuses a claim CONFLICT that leaks the token, on both transports", async () => {
    expectRefused(
      await bothTransports(
        {
          claimPlan: () =>
            Promise.resolve({
              ok: false,
              conflict: { code: "claim-active", ownerFenceToken: OWNER_A },
            }),
        },
        "claim_plan",
        claimArgs("request_1", OWNER_A, null),
      ),
      /ownerFenceToken at \[conflict\.ownerFenceToken\]/,
    );
  });

  it("refuses an owner-operation acknowledgement that leaks the token, on both transports", async () => {
    // The token is a legitimate INPUT here — owner authority for publish — so
    // what is under test is strictly what comes BACK.
    const claim = { claimId: "claim_G1_1", generation: 1, ownerFenceToken: OWNER_A };
    expectRefused(
      await bothTransports(
        {
          publishPlanDraft: () =>
            Promise.resolve({ ok: true, replayed: false, acknowledgement: claim }),
        },
        "publish_plan_draft",
        { ...ownerArgs(claim, "publish_1"), manifest: MANIFEST },
      ),
      /ownerFenceToken at \[acknowledgement\.ownerFenceToken\]/,
    );
  });

  it("refuses a claim that wins but withholds the echo, on both transports", async () => {
    // The guard fails closed in BOTH directions: a winning claim with no
    // token would leave the owner unable to exercise the authority it just won.
    expectRefused(
      await bothTransports(
        {
          claimPlan: () =>
            Promise.resolve({
              ok: true,
              replayed: false,
              acknowledgement: { claimId: "claim_G1_1", generation: 1 },
            }),
        },
        "claim_plan",
        claimArgs("request_1", OWNER_A, null),
      ),
      /allow exactly \[acknowledgement\.ownerFenceToken\]/,
    );
  });
});
