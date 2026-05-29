#!/usr/bin/env -S bun run
/**
 * cq-mcp — standalone stdio MCP server exposing the 13 ledger tools
 * (`mcp__cq__*` family) so that Codex sessions can reach the same
 * `FsLedgerStore` the cq server reads from.
 *
 * Rationale (defects.md D-GC-1 / D-OUTER7-02). The Codex SDK
 * (`@openai/codex-sdk@0.134.0`) does not accept in-process MCP servers.
 * It forwards `CodexOptions.config.mcp_servers.<name>` to the underlying
 * CLI which spawns each entry as an external stdio binary. This entry
 * point is that binary: it speaks the `@modelcontextprotocol/sdk` stdio
 * protocol over stdin/stdout and shells the operations through to a
 * file-backed `FsLedgerStore` rooted at the supplied `--cwd` directory.
 *
 * CLI:
 *   cq-mcp --cwd <absolute path>
 *
 * Lifecycle:
 *   1. Parse CLI flags. `--cwd <abs>` is required.
 *   2. Construct `FsLedgerStore({ root: cwd })` and `init()` it
 *      (auto-bootstraps the milestones ledger on first run).
 *   3. Register the 13 ledger tools on an `McpServer`.
 *   4. Connect a `StdioServerTransport` and run until the parent closes
 *      stdin (which the MCP SDK signals via the transport's onclose).
 *
 * Output discipline. Stdout is reserved for MCP protocol traffic only.
 * All logs, warnings, and parse errors go to stderr — anything on
 * stdout that is not a JSON-RPC frame corrupts the protocol and the
 * Codex CLI's MCP client tears down the channel.
 *
 * `ask_user_question` (askproxy / outer-14). This tool IS registered —
 * but only when the internal WS channel to cq-server is up (env vars
 * present). The handler generates an `askId`, sends `ask.request` over
 * the channel, parks on the `CqMcpAskBroker` until cq-server proxies the
 * browser's answer back as `ask.reply`, then returns the answers in the
 * exact `CallToolResult` shape the Claude in-process tool returns
 * (`{content:[{type:"text",text:JSON.stringify({questions,answers})}]}`).
 * In standalone mode (no channel) the tool is NOT registered — a
 * standalone binary has no browser to ask — so `tools/list` stays at the
 * 13 ledger tools and the model never sees a tool it cannot fulfil.
 *
 * Schemas. The Zod shapes here mirror the Claude-facing factory in
 * `packages/ledger/src/mcp/ledgerTools.ts`. They are intentionally
 * duplicated rather than imported because the Claude-side factory
 * builds Claude-SDK-typed `SdkMcpToolDefinition` objects via
 * `@anthropic-ai/claude-agent-sdk`'s `tool()` helper, whereas the MCP
 * stdio server takes raw Zod shapes through `McpServer.registerTool`.
 * Both paths share the same operational semantics; if either is
 * changed without the other, the test suite at
 * `packages/cq-mcp/test/main.test.ts` will catch the drift on the
 * standalone path and the ledger-MCP tests on the Claude path.
 */

import * as path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  FsLedgerStore,
  type FsLedgerStoreOpts,
  type LedgerStore,
  type FieldValue,
  type LedgerSchema,
} from "@cq/ledger";
import { InternalWsChannel } from "./internalWs.js";
import { CqMcpAskBroker } from "./askBroker.js";

// ---------------------------------------------------------------------------
// Shared Zod fragments (mirror packages/ledger/src/mcp/ledgerTools.ts)
// ---------------------------------------------------------------------------

const FIELD_TYPE_VALUES = ["string", "string[]", "id", "id[]", "timestamp"] as const;

const fieldSpecSchema = z.object({
  type: z.enum(FIELD_TYPE_VALUES),
  required: z.boolean(),
});

const statusValueSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9 _-]+$/,
    "status value may only contain A-Za-z0-9, space, dash, underscore",
  );

const RESERVED_FIELD_NAMES_ZOD = ["createdAt", "updatedAt"];
const fieldNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "field name must match /^[A-Za-z_][A-Za-z0-9_]*$/",
  )
  .refine((n) => !RESERVED_FIELD_NAMES_ZOD.includes(n), {
    message: "field name is reserved (createdAt/updatedAt)",
  });

const schemaSchema = z
  .object({
    statusValues: z.array(statusValueSchema).min(1),
    terminalStatuses: z.array(z.string()),
    fields: z.record(fieldNameSchema, fieldSpecSchema),
  })
  .refine(
    (s) => s.terminalStatuses.every((t) => s.statusValues.includes(t)),
    {
      message: "every terminalStatuses entry must be in statusValues",
      path: ["terminalStatuses"],
    },
  );

const fieldValueSchema = z.union([z.string(), z.array(z.string())]);

const fieldsSchema = z.record(z.string(), fieldValueSchema);

const safeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "id may only contain A-Za-z0-9_-");

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function jsonResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

/**
 * Register the 13 ledger tools on the given MCP server. Identical
 * semantics to the Claude-side factory in `@cq/ledger`.
 */
export function registerLedgerTools(server: McpServer, store: LedgerStore): void {
  // ---- Item / ledger surface (8) -----------------------------------------

  server.registerTool(
    "enumerate_ledgers",
    {
      description: "List all known ledger names.",
      inputSchema: {},
    },
    async () => jsonResult({ ledgers: store.enumerate() }),
  );

  server.registerTool(
    "fetch_ledger",
    {
      description:
        "Fetch a ledger: schema, active milestone groups (each expanded with resolved milestone metadata { id, status, title, description }), and archive pointers.",
      inputSchema: { ledger_id: z.string() },
    },
    async (args) => jsonResult({ ledger: store.fetch(args.ledger_id) }),
  );

  server.registerTool(
    "fetch_ledger_archive",
    {
      description:
        "Fetch a specific archived item (when ledger_id=milestones) or a whole archived milestone-group (otherwise).",
      inputSchema: {
        ledger_id: z.string(),
        archive_id: z.string(),
      },
    },
    async (args) =>
      jsonResult({ archive: await store.fetchArchive(args.ledger_id, args.archive_id) }),
  );

  server.registerTool(
    "fetch_item",
    {
      description: "Fetch a single item by id from a specific ledger.",
      inputSchema: {
        ledger_id: z.string(),
        item_id: z.string(),
      },
    },
    async (args) => jsonResult({ item: store.fetchItem(args.ledger_id, args.item_id) }),
  );

  server.registerTool(
    "update_item",
    {
      description:
        "Update an item's status and/or fields. Provided fields replace existing values; omitted fields are preserved.",
      inputSchema: {
        ledger_id: z.string(),
        item_id: z.string(),
        status: z.string().optional(),
        fields: fieldsSchema.optional(),
      },
    },
    async (args) => {
      const patch: { status?: string; fields?: Record<string, FieldValue> } = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.fields !== undefined) patch.fields = args.fields as Record<string, FieldValue>;
      const item = await store.updateItem(args.ledger_id, args.item_id, patch);
      return jsonResult({ item });
    },
  );

  server.registerTool(
    "create_item",
    {
      description:
        "Create a new item under a milestone in a ledger. milestone_id must resolve to an active (non-archived, non-terminal) milestone in the milestones ledger. Status must be in the schema's statusValues. Fields must satisfy the schema (required fields present, types match). Auto-creates the depth-2 group on first reference.",
      inputSchema: {
        ledger_id: z.string(),
        milestone_id: safeIdSchema,
        status: z.string(),
        fields: fieldsSchema,
        id: safeIdSchema.optional(),
      },
    },
    async (args) => {
      const init: { id?: string; status: string; fields: Record<string, FieldValue> } = {
        status: args.status,
        fields: args.fields as Record<string, FieldValue>,
      };
      if (args.id !== undefined) init.id = args.id;
      const item = await store.createItem(args.ledger_id, args.milestone_id, init);
      return jsonResult({ item });
    },
  );

  server.registerTool(
    "create_ledger",
    {
      description:
        "Create a new ledger. Schema specifies allowed statuses, which subset is terminal, and the typed fields each item carries. The name `milestones` is reserved.",
      inputSchema: {
        name: z.string(),
        schema: schemaSchema,
      },
    },
    async (args) => {
      const ledger = await store.createLedger(args.name, args.schema as LedgerSchema);
      return jsonResult({ ledger });
    },
  );

  server.registerTool(
    "search_items",
    {
      description: "Substring search across status and field values within a single ledger.",
      inputSchema: {
        ledger_id: z.string(),
        query: z.string(),
      },
    },
    async (args) => jsonResult({ items: store.search(args.ledger_id, args.query) }),
  );

  // ---- Milestone surface (5) ---------------------------------------------

  server.registerTool(
    "create_milestone",
    {
      description:
        "Create a new milestone in the milestones ledger. Allocates an M<n> id from the milestones ledger's own item counter. The blocked/depends arrays are advisory cross-references (no FK enforcement).",
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        blocked: z.array(z.string()).optional(),
        depends: z.array(z.string()).optional(),
        id: safeIdSchema.optional(),
      },
    },
    async (args) => {
      const init: {
        id?: string;
        title: string;
        description?: string;
        blocked?: string[];
        depends?: string[];
      } = { title: args.title };
      if (args.description !== undefined) init.description = args.description;
      if (args.blocked !== undefined) init.blocked = args.blocked;
      if (args.depends !== undefined) init.depends = args.depends;
      if (args.id !== undefined) init.id = args.id;
      const milestone = await store.createMilestone(init);
      return jsonResult({ milestone });
    },
  );

  server.registerTool(
    "update_milestone",
    {
      description:
        "Update a milestone in the milestones ledger. status must be one of open/done/postponed/blocked.",
      inputSchema: {
        milestone_id: safeIdSchema,
        status: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        blocked: z.array(z.string()).optional(),
        depends: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const patch: {
        status?: string;
        title?: string;
        description?: string;
        blocked?: string[];
        depends?: string[];
      } = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.blocked !== undefined) patch.blocked = args.blocked;
      if (args.depends !== undefined) patch.depends = args.depends;
      const milestone = await store.updateMilestone(args.milestone_id, patch);
      return jsonResult({ milestone });
    },
  );

  server.registerTool(
    "fetch_milestone",
    {
      description:
        "Fetch a milestone from the milestones ledger; also returns a per-ledger count of active items referencing this milestone.",
      inputSchema: {
        milestone_id: safeIdSchema,
      },
    },
    async (args) => jsonResult(store.fetchMilestone(args.milestone_id)),
  );

  server.registerTool(
    "archive_milestone",
    {
      description:
        "Archive a milestone globally (2-level): sweeps every ledger's group with this id into ./archive/<ledger>/<id>.md, then moves the milestone-item itself to ./archive/milestones/<id>.md. Refused if any item in any ledger is non-terminal.",
      inputSchema: {
        milestone_id: safeIdSchema,
        summary: z.string(),
      },
    },
    async (args) => {
      const pointer = await store.archiveMilestone(args.milestone_id, args.summary);
      return jsonResult({ pointer });
    },
  );

  server.registerTool(
    "list_milestone_items",
    {
      description:
        "Return all active items grouped by ledger that reference this milestone. Convenience read for orchestration before archive.",
      inputSchema: {
        milestone_id: safeIdSchema,
      },
    },
    async (args) => jsonResult({ items: store.listMilestoneItems(args.milestone_id) }),
  );
}

// ---------------------------------------------------------------------------
// ask_user_question tool (askproxy / outer-14)
// ---------------------------------------------------------------------------

/**
 * Input schema for the proxied `ask_user_question` tool. Mirrors the
 * Claude in-process tool (`askUserQuestion.ts`): `z.array(z.any())` with
 * a 1..4 bound so the model sees an identical signature whether it talks
 * to Claude (in-process) or Codex (this binary).
 */
const askUserQuestionInputSchema = {
  questions: z.array(z.any()).min(1).max(4),
} as const;

/**
 * Dependencies the proxied ask tool needs. `sendAskRequest` ships the
 * `ask.request` envelope (the tool does not know about the channel);
 * `sessionId` is the cq chat session (from `CQ_SESSION_ID`). Injectable
 * so the integration test can drive the handler with a fake transport.
 */
export interface AskToolDeps {
  broker: CqMcpAskBroker;
  sessionId: string;
  /** Generates a unique-per-process askId. */
  nextAskId: () => string;
  /** Sends the ask.request envelope upstream over the channel. */
  sendAskRequest: (req: {
    askId: string;
    toolUseId: string;
    sessionId: string;
    questions: unknown[];
  }) => void;
}

/**
 * Register the proxied `ask_user_question` tool on the MCP server. Call
 * this ONLY when the internal WS channel is up — a standalone binary has
 * no browser to ask, so the tool must not appear in `tools/list`.
 */
export function registerAskUserQuestionTool(
  server: McpServer,
  deps: AskToolDeps,
): void {
  server.registerTool(
    "ask_user_question",
    {
      description:
        "Ask the user one or more multiple-choice questions and await their answers.",
      inputSchema: askUserQuestionInputSchema,
    },
    async (args) => {
      const askId = deps.nextAskId();
      // The MCP SDK does not expose a stable tool_use id to the handler,
      // so cq-mcp mints one. The cq server uses it only as the browser
      // ask-card render key + reply correlation; it need not match any
      // Codex-internal id.
      const toolUseId = `${askId}-tu`;
      const questions = args.questions as unknown[];
      deps.sendAskRequest({ askId, toolUseId, sessionId: deps.sessionId, questions });
      const output = await deps.broker.ask(askId, questions);
      return jsonResult(output);
    },
  );
}

/**
 * Create a unique-per-process askId generator: `<pid>-<counter>`. The pid
 * disambiguates across the multiple cq-mcp children a server may have
 * spawned (one per Codex session); the counter disambiguates within one
 * process.
 */
export function makeAskIdGenerator(pid: number): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `ask-${pid}-${counter}`;
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

interface ParsedArgs {
  cwd: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq-mcp: --cwd requires a value");
      }
      cwd = v;
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    }
  }
  if (cwd === undefined || cwd === "") {
    throw new Error("cq-mcp: --cwd <absolute path> is required");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cq-mcp: --cwd must be an absolute path; got: ${cwd}`);
  }
  return { cwd };
}

/**
 * Optional internal WS channel — established when the parent cq-server
 * passes the connection details via env. Returns null when:
 *   - both env vars are unset (standalone mode; cache invalidation
 *     silently disabled),
 * Throws an Error when:
 *   - URL is set but TOKEN is missing (configuration error),
 *   - the connect fails (timeout, refused, 401, malformed handshake).
 * The caller (`main`) translates a thrown error into a stderr line +
 * process.exit(2) per the brief's Decision 2.
 */
export async function maybeOpenInternalWs(): Promise<InternalWsChannel | null> {
  const url = process.env["CQ_INTERNAL_WS_URL"];
  const token = process.env["CQ_INTERNAL_WS_TOKEN"];
  if (url === undefined || url === "") {
    if (token !== undefined && token !== "") {
      // Token without URL — log a notice but treat as standalone mode
      // so the parent process can't accidentally enforce a half-config.
      process.stderr.write(
        "cq-mcp: CQ_INTERNAL_WS_TOKEN set but CQ_INTERNAL_WS_URL absent; running standalone\n",
      );
    }
    return null;
  }
  if (token === undefined || token === "") {
    throw new Error(
      "CQ_INTERNAL_WS_URL is set but CQ_INTERNAL_WS_TOKEN is missing",
    );
  }
  return await InternalWsChannel.connect({ url, token });
}

export async function main(argv: readonly string[]): Promise<void> {
  const { cwd } = parseArgs(argv);

  // Open the internal channel BEFORE constructing the store so we can
  // pass the broadcast hook into FsLedgerStore at construction time.
  // Connect failures here are fatal (Decision 2); the parent sees
  // exit(2) and surfaces the misconfiguration loudly.
  let channel: InternalWsChannel | null = null;
  try {
    channel = await maybeOpenInternalWs();
  } catch (err: unknown) {
    const url = process.env["CQ_INTERNAL_WS_URL"] ?? "(unset)";
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `cq-mcp: failed to connect to cq internal WS at ${url}: ${reason}\n`,
    );
    process.exit(2);
  }
  if (channel === null) {
    process.stderr.write(
      "cq-mcp: running without internal WS channel; ledger cache invalidation disabled\n",
    );
  }

  // Construct the store, init it, then register tools. If init fails we
  // surface the error to stderr and exit non-zero — the parent MCP client
  // sees the channel close and treats the server as unhealthy.
  const storeOpts: FsLedgerStoreOpts = { root: cwd };
  if (channel !== null) {
    const wsChannel = channel;
    storeOpts.onMutation = (ledgerId, op): void => {
      wsChannel.send({
        type: "ledger.changed",
        ledgerId,
        op,
        sourcePid: process.pid,
      });
    };
  }
  const store = new FsLedgerStore(storeOpts);
  await store.init();

  if (channel !== null) {
    // Inbound ledger.changed (from cq-server) → invalidate our cache.
    // Loop-detection (sourcePid === our pid) is enforced inside the
    // channel before this handler runs.
    channel.registerHandler("ledger.changed", async (msg) => {
      try {
        await store.invalidate(msg.ledgerId);
      } catch (err: unknown) {
        process.stderr.write(
          `cq-mcp: invalidate(${msg.ledgerId}) failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });
  }

  const server = new McpServer(
    { name: "cq-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerTools(server, store);

  // ask_user_question (askproxy / outer-14). Registered ONLY when the
  // internal WS channel is up AND CQ_SESSION_ID is supplied; otherwise a
  // Codex session has no browser to reach and the tool must not appear.
  if (channel !== null) {
    const sessionId = process.env["CQ_SESSION_ID"];
    if (sessionId === undefined || sessionId === "") {
      process.stderr.write(
        "cq-mcp: internal WS channel up but CQ_SESSION_ID unset; ask_user_question disabled\n",
      );
    } else {
      const wsChannel = channel;
      const askBroker = new CqMcpAskBroker();
      // Inbound ask.reply (from cq-server) → resolve the parked tool call.
      wsChannel.registerHandler("ask.reply", async (msg) => {
        askBroker.reply(msg.askId, msg.answers);
      });
      // On disconnect, reject every pending ask so the tool returns an
      // error result instead of hanging (no reconnection by design).
      wsChannel.registerOnClose(() => {
        askBroker.rejectAll("cq-mcp: internal WS channel closed");
      });
      registerAskUserQuestionTool(server, {
        broker: askBroker,
        sessionId,
        nextAskId: makeAskIdGenerator(process.pid),
        sendAskRequest: (req) => {
          wsChannel.send({
            type: "ask.request",
            askId: req.askId,
            toolUseId: req.toolUseId,
            sessionId: req.sessionId,
            questions: req.questions,
            sourcePid: process.pid,
          });
        },
      });
    }
  }

  // Graceful shutdown on SIGTERM / SIGINT. Closes the WS first so the
  // server sees a clean 1000 instead of a torn TCP.
  const shutdown = (): void => {
    channel?.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer holds the process open by virtue of the stdio listener;
  // exiting here would close stdin and tear the channel down immediately.
  process.stderr.write(`cq-mcp: serving stdio MCP on cwd=${cwd}\n`);
}

// Only run main() when executed directly (not when imported as a module
// by the test suite). `import.meta.main` is bun-specific but available
// in the bun runtime that hosts cq.
const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cq-mcp: fatal: ${msg}\n`);
    process.exit(1);
  });
}
