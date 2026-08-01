#!/usr/bin/env bun

import { validatePackagedPromptSurfaceRoot } from "../src/packagedPromptSurface.js";

const argumentsAfterScript = process.argv.slice(2);
if (argumentsAfterScript.length !== 2) {
  console.error("usage: validate-prompt-surface-attestation <surface> <absolute-root>");
  process.exit(1);
}

const [surface, root] = argumentsAfterScript as [string, string];
try {
  validatePackagedPromptSurfaceRoot(surface, root);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
