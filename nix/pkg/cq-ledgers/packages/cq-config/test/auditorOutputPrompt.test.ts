import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { implementationAuditorSidecar } from "../src/schemas/implementation-auditor.js";

// D581: the native auditor intermittently stored a verdict missing `rationale`
// with surplus keys; its prompt never named the closed output shape.
describe("implementation-auditor output contract", () => {
  it("names exactly the schema's required verdict and observation keys", () => {
    const schema = implementationAuditorSidecar.outputSchema as {
      readonly required: readonly string[]; readonly additionalProperties: boolean;
      readonly properties: { readonly observations: { readonly items: { readonly required: readonly string[] } } };
    };
    expect(schema.additionalProperties).toBe(false);
    const prompt = readFileSync(path.resolve(import.meta.dir, "../../../../cq-assets/agents/implementation-auditor.md"), "utf8")
      .replace(/\s+/gu, " ");
    const section = prompt.slice(prompt.indexOf("The stored verdict is exactly one object"), prompt.indexOf("Store the verdict exactly once"));
    for (const key of schema.required) expect(section).toContain(`\`${key}\``);
    const observationKeys = schema.properties.observations.items.required.map((key) => `"${key}"`).join(", ");
    expect(section).toContain(`\`{ ${observationKeys} }\``);
    expect(section).toContain("no other");
  });
});
