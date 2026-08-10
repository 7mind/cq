import { expect } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  attestationRowDigest,
  type AttestationRow,
  type PromptSurface,
} from "@cq/config";
import { LEDGER_TOOL_NAMES } from "@cq/ledger";

const VALID_INPUT = Object.freeze({
  goalId: "G977",
});

interface ToolResultLike {
  readonly isError?: boolean;
  readonly content?: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}

interface PreparedWireOutcome {
  readonly accepted: true;
  readonly handle: {
    readonly attestationId: string;
    readonly generation: number;
  };
  readonly prepared: {
    readonly inputCapability: {
      readonly scope: "fetch-input";
      readonly token: string;
    };
    readonly promptProvenance: {
      readonly surface: PromptSurface;
    };
  };
}

interface RejectedPrepareWireOutcome {
  readonly accepted: false;
  readonly allocated: false;
  readonly reason: string;
}

interface MaterializedInputWireOutcome {
  readonly input: unknown;
}

export interface DispatchConstructionConformanceFixture {
  readonly cell: string;
  readonly client: Client;
  readonly surface: PromptSurface;
  rows(): Promise<readonly AttestationRow[]>;
}

function textOf(result: ToolResultLike): string {
  const first = result.content?.[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected one MCP text content block");
  }
  return first.text ?? "";
}

function decode<T>(result: ToolResultLike): T {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(textOf(result)) as T;
}

async function call(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResultLike> {
  return (await client.callTool({ name, arguments: args })) as ToolResultLike;
}

function rowDigests(rows: readonly AttestationRow[]): readonly string[] {
  return rows.map(attestationRowDigest);
}

/**
 * Shared T977 contract for a client connected through one real production
 * construction and a peer handle to that construction's durable attestation
 * namespace.
 */
export async function assertDispatchConstructionConformance(
  fixture: DispatchConstructionConformanceFixture,
): Promise<void> {
  const names = (await fixture.client.listTools()).tools.map((tool) => tool.name).sort();
  expect(names, fixture.cell).toEqual([...LEDGER_TOOL_NAMES].sort());
  expect(names, fixture.cell).toContain("prepare_dispatch");
  expect(names, fixture.cell).toContain("fetch_dispatch_input");
  expect(names, fixture.cell).not.toContain("validate_input");

  const expectedChild = {
    childId: `child-${fixture.cell}`,
    runId: `run-${fixture.cell}`,
  };
  const baseRequest = {
    roleId: "plan-advance",
    input: VALID_INPUT,
    timeoutMs: 120_000,
    expectedChild,
  };
  const initialRows = rowDigests(await fixture.rows());

  const schemaInvalid = await call(fixture.client, "prepare_dispatch", {
    ...baseRequest,
    idempotencyKey: `${fixture.cell}-schema-invalid`,
    timeoutMs: 0,
  });
  expect(schemaInvalid.isError, fixture.cell).toBe(true);
  expect(rowDigests(await fixture.rows()), fixture.cell).toEqual(initialRows);

  const malformedOverlay = await call(fixture.client, "prepare_dispatch", {
    ...baseRequest,
    idempotencyKey: `${fixture.cell}-malformed-overlay`,
    overlays: [{ overlayId: "undeclared" }],
  });
  expect(malformedOverlay.isError, fixture.cell).toBe(true);
  expect(rowDigests(await fixture.rows()), fixture.cell).toEqual(initialRows);

  const invalidInput = decode<RejectedPrepareWireOutcome>(
    await call(fixture.client, "prepare_dispatch", {
      ...baseRequest,
      input: { taskId: "T977" },
      idempotencyKey: `${fixture.cell}-invalid-input`,
    }),
  );
  expect(invalidInput, fixture.cell).toMatchObject({
    accepted: false,
    allocated: false,
    reason: "invalid-role-input",
  });
  expect(rowDigests(await fixture.rows()), fixture.cell).toEqual(initialRows);

  const undeclaredOverlay = decode<RejectedPrepareWireOutcome>(
    await call(fixture.client, "prepare_dispatch", {
      ...baseRequest,
      idempotencyKey: `${fixture.cell}-undeclared-overlay`,
      overlays: [{ overlayId: "undeclared", data: {} }],
    }),
  );
  expect(undeclaredOverlay, fixture.cell).toMatchObject({
    accepted: false,
    allocated: false,
    reason: "invalid-overlay-data",
  });
  expect(rowDigests(await fixture.rows()), fixture.cell).toEqual(initialRows);

  const prepared = decode<PreparedWireOutcome>(
    await call(fixture.client, "prepare_dispatch", {
      ...baseRequest,
      idempotencyKey: `${fixture.cell}-valid`,
    }),
  );
  expect(prepared.accepted, fixture.cell).toBe(true);
  expect(prepared.prepared.promptProvenance.surface, fixture.cell).toBe(fixture.surface);
  expect(await fixture.rows(), fixture.cell).toHaveLength(initialRows.length + 1);

  const fetchArgs = {
    ...prepared.handle,
    inputCapability: prepared.prepared.inputCapability,
  };
  const materialized = decode<MaterializedInputWireOutcome>(
    await call(fixture.client, "fetch_dispatch_input", fetchArgs),
  );
  expect(materialized.input, fixture.cell).toEqual(VALID_INPUT);

  const secondFetch = await call(fixture.client, "fetch_dispatch_input", fetchArgs);
  expect(secondFetch.isError, fixture.cell).toBe(true);
  expect(textOf(secondFetch), fixture.cell).toContain("already");
}
