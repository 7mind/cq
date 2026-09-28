import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { implementWorkerSidecar } from "../src/schemas/implement-worker.js";

// D586: the worker prompt must state exactly the mutationTable row shape the
// closed output schema accepts, or a diligent worker's result is invalid-output.
function mutationRowSchema(schema: unknown): { readonly required: readonly string[]; readonly properties: Record<string, unknown> } {
  const found: unknown[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const properties = record["properties"] as Record<string, { items?: unknown }> | undefined;
    if (properties?.["mutationTable"]?.items !== undefined) found.push(properties["mutationTable"].items);
    for (const value of Object.values(record)) visit(value);
  };
  visit(schema);
  if (found.length === 0) throw new Error("output schema has no mutationTable row schema");
  const canonical = JSON.stringify(found[0]);
  if (!found.every((row) => JSON.stringify(row) === canonical)) throw new Error("mutationTable row schemas differ across arms");
  return found[0] as { readonly required: readonly string[]; readonly properties: Record<string, unknown> };
}

describe("implement-worker mutationTable contract", () => {
  it("states exactly the schema's closed row keys", () => {
    const row = mutationRowSchema(implementWorkerSidecar.outputSchema);
    expect(Object.keys(row.properties).sort()).toEqual([...row.required].sort());
    const prompt = readFileSync(path.resolve(import.meta.dir, "../../../../cq-assets/agents/implement-worker.md"), "utf8")
      .replace(/\s+/gu, " ");
    const keys = [...row.required].map((key) => `"${key}"`).join(", ");
    expect(prompt).toContain(`\`{ ${keys} }\` strings and no other key`);
  });
});
