/**
 * Integration test for McpLedgerClient.fetchLedgerArchive (T29).
 *
 * Seeds an archive via a standalone xdg store instance (write path, T505),
 * then exercises the read path through the MCP client's fetchLedgerArchive
 * method. Uses the TUI's McpLedgerClient.embedded so no subprocess or socket
 * is needed.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLedgerStore } from "@cq/ledger";
import { McpLedgerClient } from "../src/mcpClient.js";

let tmpRoot: string;
let xdgHome: string;
let prevXdgStateHome: string | undefined;
let client: McpLedgerClient;

beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir and pin the backend with a projectId.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  xdgHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-archive-test-xdg-"));
  process.env["XDG_STATE_HOME"] = xdgHome;

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-archive-test-"));
  await fs.writeFile(
    path.join(tmpRoot, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(tmpRoot)}"\n`,
    "utf8",
  );

  // Seed via a standalone store instance (write path outside the client).
  const { store: seed } = await createLedgerStore(tmpRoot);
  await seed.createLedger("jobs", {
    statusValues: ["planned", "done"],
    terminalStatuses: ["done"],
    fields: { headline: { type: "string", required: true } },
    idPrefix: "J",
  });
  const ms = await seed.createMilestone({ id: "M50", title: "archive-test-milestone" });
  const created = await seed.createItem("jobs", ms.id, {
    status: "planned",
    fields: { headline: "first task" },
  });
  // Transition to terminal so the milestone can be archived.
  await seed.updateItem("jobs", created.id, { status: "done" });
  await seed.updateMilestone("M50", { status: "done" });
  await seed.archiveMilestone("M50", "archived for T29 test");
  await seed.dispose();

  client = await McpLedgerClient.embedded(tmpRoot);
});

afterAll(async () => {
  await client.close();
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  await fs.rm(xdgHome, { recursive: true, force: true });
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("McpLedgerClient.fetchLedgerArchive (T29)", () => {
  it("fetchLedger returns an archivePointer for the archived milestone", async () => {
    const ledger = await client.fetchLedger("jobs");
    expect(ledger.archivePointers).toHaveLength(1);
    expect(ledger.archivePointers[0]!.id).toBe("M50");
  });

  it("fetchLedgerArchive returns a group archive for a non-milestones ledger", async () => {
    const archive = await client.fetchLedgerArchive("jobs", "M50");
    expect(archive.kind).toBe("group");
    if (archive.kind === "group") {
      expect(archive.milestone.id).toBe("M50");
      expect(archive.milestone.items).toHaveLength(1);
      expect(archive.milestone.items[0]!.fields["headline"]).toBe("first task");
    }
  });

  it("fetchLedgerArchive returns an item archive for the milestones ledger", async () => {
    const archive = await client.fetchLedgerArchive("milestones", "M50");
    expect(archive.kind).toBe("item");
    if (archive.kind === "item") {
      expect(archive.item.id).toBe("M50");
      expect(archive.item.fields["title"]).toBe("archive-test-milestone");
    }
  });
});
