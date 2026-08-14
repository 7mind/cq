import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const configuredTranscript = process.env["CQ_TEST_PROVIDER_TRANSCRIPT"];
if (configuredTranscript === undefined) throw new Error("missing CQ_TEST_PROVIDER_TRANSCRIPT");
const transcript: string = configuredTranscript;

function record(value: unknown): void {
  appendFileSync(transcript, `${JSON.stringify(value)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line) as Record<string, unknown>;
  record(request);
  if (request["op"] === "acquire") {
    process.stdout.write(`${JSON.stringify({ ok: true, epoch: 7 })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  if (request["op"] === "release" || request["op"] === "abandon") process.exit(0);
});
lines.on("close", () => {
  record({ op: "eof" });
});
