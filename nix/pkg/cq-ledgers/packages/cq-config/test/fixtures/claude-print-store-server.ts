import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const handle = JSON.parse(process.env["T688_HANDLE"] ?? "{}") as {
  readonly attestationId: string;
  readonly generation: number;
};
const capturePath = process.env["T688_CAPTURE_PATH"];

function reply(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as {
    readonly id?: string | number;
    readonly method: string;
    readonly params?: {
      readonly name?: string;
      readonly arguments?: unknown;
    };
  };
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "t688-scoped-store", version: "1" },
    });
    return;
  }
  if (request.method === "tools/list") {
    reply(request.id, {
      tools: [
        {
          name: "store_result",
          description: "Store this dispatch result once.",
          inputSchema: {
            type: "object",
            properties: { output: {} },
            required: ["output"],
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }
  if (request.method === "tools/call" && request.params?.name === "store_result") {
    if (capturePath === undefined) throw new Error("T688_CAPTURE_PATH missing");
    writeFileSync(capturePath, JSON.stringify(request.params.arguments));
    reply(request.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            state: "result-stored",
            ...handle,
            storedAt: new Date().toISOString(),
            outputDigest: "a".repeat(64),
          }),
        },
      ],
    });
    return;
  }
  reply(request.id, { tools: [] });
});
