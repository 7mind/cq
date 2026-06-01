#!/usr/bin/env bun
/**
 * Regenerate `docs/ledgers.yaml` from the canonical schemas in
 * `packages/ledger/src/constants.ts`.
 *
 * `docs/ledgers.yaml` is a PURE schema registry (version + ledgers[].schema);
 * item data lives in `docs/*.md` and is NOT touched here. The on-disk registry
 * must match canon exactly — `FsLedgerStore.init` runs a strict, order-
 * significant divergence guard (`schemasEqual`) and refuses to start if any
 * on-disk schema differs from its canonical bootstrap schema.
 *
 * We write through the same `serializeRegistry` the store uses, so the emitted
 * YAML is byte-compatible with what the store would write itself (key order,
 * to-status array order, etc.). Re-run this whenever a canonical schema changes
 * (e.g. when PR-03 adds the `reviews` ledger).
 *
 *   bun run regen-bootstrap
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import {
  CANONICAL_LEDGERS,
  serializeRegistry,
  type LedgerRegistry,
} from "../packages/ledger/src/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = path.join(REPO_ROOT, "docs", "ledgers.yaml");

const registry: LedgerRegistry = {
  version: 1,
  ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
};

await writeFile(REGISTRY_PATH, serializeRegistry(registry), "utf8");
console.log(`wrote ${REGISTRY_PATH} (${registry.ledgers.length} ledgers)`);
