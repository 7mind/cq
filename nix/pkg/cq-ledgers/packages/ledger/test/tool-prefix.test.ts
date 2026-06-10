/**
 * Unit tests for the tool-name prefix helpers: assertToolPrefix,
 * prefixToolName, prefixedToolNames (T373).
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
  assertToolPrefix,
  createLedgerMcpTools,
  prefixToolName,
  prefixedToolNames,
  type LedgerSchema,
} from "../src/index.js";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: {
    note: { type: "string", required: false },
  },
};

async function buildStore(): Promise<InMemoryLedgerStore> {
  const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
  await store.init();
  return store;
}

function decode<T>(result: {
  content: Array<{ type: string; text: string }>;
}): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

describe("assertToolPrefix", () => {
  it("accepts the empty string", () => {
    expect(() => assertToolPrefix("")).not.toThrow();
  });

  it("accepts a plain alphanumeric prefix", () => {
    expect(() => assertToolPrefix("myproj")).not.toThrow();
    expect(() => assertToolPrefix("myproj2")).not.toThrow();
    expect(() => assertToolPrefix("ABC")).not.toThrow();
    expect(() => assertToolPrefix("a")).not.toThrow();
  });

  it("throws for a prefix containing an underscore", () => {
    expect(() => assertToolPrefix("a_b")).toThrow();
  });

  it("throws for a prefix containing a hyphen", () => {
    expect(() => assertToolPrefix("a-b")).toThrow();
  });

  it("throws for a prefix containing a space", () => {
    expect(() => assertToolPrefix("a b")).toThrow();
  });

  it("throws for a prefix containing a dot", () => {
    expect(() => assertToolPrefix("a.b")).toThrow();
  });
});

describe("prefixedToolNames", () => {
  it("with '' returns a copy equal to LEDGER_TOOL_NAMES", () => {
    const result = prefixedToolNames("");
    expect(result).toEqual([...LEDGER_TOOL_NAMES]);
  });

  it("with '' returns a NEW array (not the same reference)", () => {
    const result = prefixedToolNames("");
    // Should be a different array object (a copy), not the original tuple
    expect(result).not.toBe(LEDGER_TOOL_NAMES);
  });

  it("with 'myproj' returns prefixed names", () => {
    const result = prefixedToolNames("myproj");
    const expected = LEDGER_TOOL_NAMES.map((n) => `myproj_${n}`);
    expect(result).toEqual(expected);
  });

  it("every element from prefixedToolNames('myproj') matches the safeId charset", () => {
    const result = prefixedToolNames("myproj");
    for (const name of result) {
      expect(name).toMatch(SAFE_ID_RE);
    }
  });

  it("throws for an invalid prefix", () => {
    expect(() => prefixedToolNames("a_b")).toThrow();
    expect(() => prefixedToolNames("a b")).toThrow();
  });
});

describe("prefixToolName", () => {
  it("with '' returns the name unchanged", () => {
    expect(prefixToolName("", "fetch_item")).toBe("fetch_item");
  });

  it("with a prefix returns '<prefix>_<name>'", () => {
    expect(prefixToolName("myproj", "fetch_item")).toBe("myproj_fetch_item");
  });

  it("throws for an invalid prefix", () => {
    expect(() => prefixToolName("a.b", "fetch_item")).toThrow();
  });
});

describe("import from @cq/ledger", () => {
  it("prefixedToolNames is importable from @cq/ledger", () => {
    expect(typeof prefixedToolNames).toBe("function");
  });
});

describe("createLedgerMcpTools toolPrefix (T374)", () => {
  it("with the default (no prefix arg) keeps every registered name byte-identical", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);
    expect(tools.map((t) => t.name).sort()).toEqual([...LEDGER_TOOL_NAMES].sort());
  });

  it("with a trailing prefix registers every tool under '<prefix>_<name>'", async () => {
    const store = await buildStore();
    // toolPrefix is the LAST param: all earlier optionals stay undefined.
    const tools = createLedgerMcpTools(store, undefined, undefined, undefined, "myproj");
    expect(tools.map((t) => t.name).sort()).toEqual(prefixedToolNames("myproj").sort());
  });

  it("a prefixed create_item handler still round-trips (handlers unchanged)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store, undefined, undefined, undefined, "myproj");

    const callTool = (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: string; text: string }> }> => {
      const t = tools.find((x) => x.name === name);
      if (t === undefined) throw new Error(`tool not found: ${name}`);
      return t.handler(args as never, null) as Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    };

    // A milestone must exist before create_item; the milestone tool is prefixed too.
    const m = decode<{ milestone: { id: string } }>(
      await callTool("myproj_create_milestone", { title: "first" }),
    );
    expect(m.milestone.id).toBe("M1");

    const created = decode<{ item: { id: string; status: string; milestoneId: string } }>(
      await callTool("myproj_create_item", {
        ledger_id: "xenos",
        milestone_id: "M1",
        status: "open",
        fields: { note: "buy milk" },
      }),
    );
    expect(created.item.id).toBe("X1");
    expect(created.item.status).toBe("open");
    expect(created.item.milestoneId).toBe("M1");
  });
});
