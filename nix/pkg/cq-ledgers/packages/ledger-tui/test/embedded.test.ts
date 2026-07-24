/**
 * McpLedgerClient.embedded round-trip test.
 *
 * Runs the ledger MCP server IN-PROCESS over an in-memory transport (no
 * subprocess, no socket) against a seeded temp xdg store (T505), and exercises
 * every client method — the embedded counterpart to mcpClient.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLedgerStore } from "@cq/ledger";
import { McpLedgerClient, LedgerToolError } from "../src/mcpClient.js";

let tmpRoot: string;
let xdgHome: string;
let prevXdgStateHome: string | undefined;
let prevPromptRoot: string | undefined;
let prevPromptSurface: string | undefined;
let promptRoot: string;
let client: McpLedgerClient;
const PROMPT_BYTES = "tui codex {{cq:literal}} and $ARGUMENTS\n";

beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir and pin the backend with a projectId.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  prevPromptRoot = process.env["CQ_PROMPT_ROOT"];
  prevPromptSurface = process.env["CQ_PROMPT_SURFACE"];
  xdgHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-embedded-xdg-"));
  process.env["XDG_STATE_HOME"] = xdgHome;
  promptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-prompts-"));
  await fs.mkdir(path.join(promptRoot, "roles"));
  await fs.writeFile(
    path.join(promptRoot, "catalog.json"),
    JSON.stringify([
      {
        roleId: "plan-advance",
        roleKind: "dispatched-subagent",
        canonicalSource: "agents/plan-advance.md",
        surfaces: ["claude", "codex", "pi"],
        sharedSourceBlock: {
          classification: "shared-prose",
          sourceBlock: "all prose outside the classified surface-sensitive blocks",
          targetFragment: null,
        },
        fragmentBindings: [],
        dispatchRelations: [],
        intentionalDifferences: [],
        sidecar: { schemaRoleId: "plan-advance" },
      },
    ]),
  );
  await fs.writeFile(path.join(promptRoot, "roles", "plan-advance.md"), PROMPT_BYTES);
  process.env["CQ_PROMPT_ROOT"] = promptRoot;
  process.env["CQ_PROMPT_SURFACE"] = "codex";

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-tui-embedded-"));
  await fs.writeFile(
    path.join(tmpRoot, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(tmpRoot)}"\n`,
    "utf8",
  );
  const { store: seed } = await createLedgerStore(tmpRoot);
  await seed.createLedger("bugs", {
    statusValues: ["open", "wip", "closed"],
    terminalStatuses: ["closed"],
    fields: { headline: { type: "string", required: true }, note: { type: "string", required: false } },
  });
  await seed.dispose();

  client = await McpLedgerClient.embedded(tmpRoot);
});

afterAll(async () => {
  await client.close(); // disposes the in-process store
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  if (prevPromptRoot === undefined) delete process.env["CQ_PROMPT_ROOT"];
  else process.env["CQ_PROMPT_ROOT"] = prevPromptRoot;
  if (prevPromptSurface === undefined) delete process.env["CQ_PROMPT_SURFACE"];
  else process.env["CQ_PROMPT_SURFACE"] = prevPromptSurface;
  await fs.rm(xdgHome, { recursive: true, force: true });
  await fs.rm(promptRoot, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("McpLedgerClient.embedded (in-process, in-memory transport)", () => {
  it("exposes the embedded context (store + cwd + resolved backend descriptor)", () => {
    expect(client.embedded).not.toBeNull();
    expect(client.embedded?.cwd).toBe(tmpRoot);
    // D51: the resolved backend descriptor is exposed so main.tsx can select
    // the matching coherence watcher. cq.toml pins the xdg backend (T505).
    expect(client.embedded?.resolved.backend).toBe("xdg");
    expect(client.embedded?.resolved.store).toBe(client.embedded?.store);
  });

  it("enumerates ledgers", async () => {
    const names = (await client.enumerateLedgers()).map((l) => l.name);
    expect(names).toContain("bugs");
    expect(names).toContain("milestones");
  });

  it("fetches exact bytes from the selected prompt root over the embedded transport", async () => {
    expect(await client.fetchPrompt("plan-advance")).toBe(PROMPT_BYTES);
    const result = await client.fetchPromptResult("plan-advance");
    expect(result.promptSurface).toBe("codex");
    expect(result.sourcePath).toBe("agents/plan-advance.md");
    expect(result.requiredCapabilities).toEqual([]);
  });

  it("creates, updates, fetches and searches an item — no subprocess", async () => {
    await client.createMilestone({ id: "M30", title: "embedded coverage" });
    const created = await client.createItem("bugs", "M30", {
      status: "open",
      fields: { headline: "tachyon leak", note: "in-process" },
    });
    expect(created.fields["headline"]).toBe("tachyon leak");

    const updated = await client.updateItem("bugs", created.id, { status: "wip" });
    expect(updated.status).toBe("wip");

    const fetched = await client.fetchItem("bugs", created.id);
    expect(fetched.status).toBe("wip");

    const hits = await client.ftsSearch("tachyon");
    expect(hits.some((h) => h.item.id === created.id)).toBe(true);
  });

  it("surfaces server validation errors as LedgerToolError", async () => {
    let caught: unknown;
    try {
      await client.createItem("bugs", "M30", { status: "not-a-status", fields: { headline: "x" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LedgerToolError);
  });
});
