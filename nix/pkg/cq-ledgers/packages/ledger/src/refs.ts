/**
 * Cross-ledger ref grammar: `<ledger>:<id>` (e.g. "goals:G77"), the same
 * convention the `ledgerRefs` field already uses. This module is the single
 * place that parses, canonicalizes, and resolves refs used by `dependsOn` /
 * `blockedBy` / `ledgerRefs` across ledgers.
 *
 * Pure module: NO I/O, NO store imports — only `./types.js` for the
 * `LedgerError` base class and the `LedgerSchema` type. Callers (write-time
 * canonicalization, the predicates resolver, the v1→v2 store migration, UI
 * readers) build a prefix→ledger registry themselves via
 * `buildPrefixRegistry` and pass it in.
 *
 * Resolution model (live-data driven): a bare id such as "T523" is resolved
 * by exact alpha-prefix lookup against the REGISTRY, not by the caller's own
 * ledger — a defect's `dependsOn: ["T523"]` means `tasks:T523`, not
 * `defects:T523`. The full leading alpha run must equal a registered
 * `idPrefix` EXACTLY, so "R123" resolves to `reviews` and a hypothetical
 * "RS123" (a distinct two-letter prefix) would resolve to a different
 * ledger — they never collide, and "H5" / "HO5" resolve distinctly.
 */

import { LedgerError } from "./types.js";
import type { LedgerSchema } from "./types.js";

/**
 * Bare item-id shape: a leading run of uppercase letters (the ledger's
 * `idPrefix`) followed by digits — e.g. "T523", "D84", "HO4". No lowercase,
 * no separators.
 */
const BARE_ID_RE = /^([A-Z]+)(\d+)$/;

/** Ledger-name shape in the prefixed `<ledger>:<id>` form: a lowercase word. */
const LEDGER_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Id-part shape in the prefixed `<ledger>:<id>` form. Deliberately more
 * permissive than `BARE_ID_RE` — it must also accept ids that are NOT of the
 * `<prefix><digits>` shape (e.g. the milestones ledger's bootstrap id
 * `M-AMBIENT`), since a prefixed ref names its ledger explicitly and does not
 * rely on alpha-prefix resolution. Must start with a letter; no colons (the
 * separator) and no whitespace.
 */
const PREFIXED_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Thrown for any malformed or unresolvable ref: empty/malformed ledger or id
 * segments, a bare id that matches neither grammar, or (in
 * `canonicalizeRef`) an alpha prefix / ledger name absent from the supplied
 * registry. Fail-fast — no silent defaults.
 */
export class RefParseError extends LedgerError {
  constructor(raw: string, reason: string) {
    super(`Invalid ref "${raw}": ${reason}`);
    this.name = "RefParseError";
  }
}

/**
 * Result of `parseRef`: either a PREFIXED ref (raw contained a colon) or a
 * BARE ref (raw was a plain id). `kind` discriminates the union.
 */
export type ParsedRef =
  | { kind: "prefixed"; ledger: string; id: string }
  | { kind: "bare"; bare: string };

/**
 * Parse a raw ref string. Splits on the FIRST colon: anything before it is
 * the ledger name, everything after (including any further colons) is the
 * id. Throws `RefParseError` when:
 *   - it contains a colon but the ledger name or id part is empty/malformed;
 *   - it contains no colon and does not match the bare-id grammar
 *     `^[A-Z]+\d+$` (e.g. "", "t5" (lowercase), "123" (no alpha prefix)).
 */
export function parseRef(raw: string): ParsedRef {
  const colonIndex = raw.indexOf(":");
  if (colonIndex !== -1) {
    const ledger = raw.slice(0, colonIndex);
    const id = raw.slice(colonIndex + 1);
    if (!LEDGER_NAME_RE.test(ledger)) {
      throw new RefParseError(raw, `ledger name "${ledger}" is empty or malformed`);
    }
    if (!PREFIXED_ID_RE.test(id)) {
      throw new RefParseError(raw, `id part "${id}" is empty or malformed`);
    }
    return { kind: "prefixed", ledger, id };
  }
  if (!BARE_ID_RE.test(raw)) {
    throw new RefParseError(raw, `not a bare id (expected an alpha prefix + digits, e.g. "T523")`);
  }
  return { kind: "bare", bare: raw };
}

/**
 * Effective `idPrefix` for a ledger: explicit `schema.idPrefix` when present,
 * else the first uppercase letter of the ledger name. Mirrors
 * `effectiveIdPrefix` in `store/core.ts` — duplicated (not imported) because
 * this module must carry no store imports; keep the two in sync manually if
 * the store's defaulting rule ever changes.
 */
function effectivePrefix(name: string, schema: LedgerSchema): string {
  if (schema.idPrefix !== undefined && schema.idPrefix.length > 0) {
    return schema.idPrefix;
  }
  const first = name[0];
  if (first === undefined) {
    throw new RefParseError(name, "cannot derive idPrefix for empty ledger name");
  }
  return first.toUpperCase();
}

/**
 * Build the idPrefix → ledger-name registry `canonicalizeRef` resolves bare
 * refs against. Feed it either a store's registered ledgers/schemas (e.g.
 * `LedgerRegistryEntry[]`) or `CANONICAL_LEDGERS` directly — both share the
 * `{name, schema}` shape. Prefix uniqueness across the input is the caller's
 * responsibility (the store enforces it at `createLedger` time via
 * `assertPrefixUnique`); this function does not re-validate it and a later
 * entry silently overwrites an earlier one on collision.
 */
export function buildPrefixRegistry(
  ledgers: Iterable<{ name: string; schema: LedgerSchema }>,
): Map<string, string> {
  const registry = new Map<string, string>();
  for (const { name, schema } of ledgers) {
    registry.set(effectivePrefix(name, schema), name);
  }
  return registry;
}

/**
 * Canonicalize a raw ref to its `<ledger>:<id>` form.
 *
 * - Prefixed input passes through unchanged (idempotent) — EXCEPT that the
 *   named ledger must exist in `registry`; an unknown ledger name throws.
 *   (Decision: validate, rather than accept unresolvable-yet-well-formed
 *   refs — every canonical ref this function returns is resolvable against
 *   the same registry a bare ref resolves against.) Note this does NOT
 *   cross-check the id part against that ledger's own idPrefix (e.g.
 *   "tasks:D84" passes through as given) — only bare-ref resolution uses
 *   the alpha-prefix registry.
 * - Bare input is resolved by exact alpha-prefix lookup: the full leading
 *   alpha run of the id must equal a registered `idPrefix` exactly. An
 *   unregistered alpha prefix throws `RefParseError`.
 */
export function canonicalizeRef(raw: string, registry: ReadonlyMap<string, string>): string {
  const parsed = parseRef(raw);
  if (parsed.kind === "prefixed") {
    let known = false;
    for (const ledgerName of registry.values()) {
      if (ledgerName === parsed.ledger) {
        known = true;
        break;
      }
    }
    if (!known) {
      throw new RefParseError(raw, `unknown ledger "${parsed.ledger}"`);
    }
    return raw;
  }
  const match = BARE_ID_RE.exec(parsed.bare);
  if (match === null) {
    // Unreachable: parseRef already validated `parsed.bare` against
    // BARE_ID_RE to produce a "bare" result.
    throw new RefParseError(raw, "internal: bare id re-match failed");
  }
  const alphaPrefix = match[1];
  if (alphaPrefix === undefined) {
    // Unreachable: BARE_ID_RE's first capture group is not optional.
    throw new RefParseError(raw, "internal: missing alpha-prefix capture group");
  }
  const ledger = registry.get(alphaPrefix);
  if (ledger === undefined) {
    throw new RefParseError(raw, `unknown id prefix "${alphaPrefix}"`);
  }
  return `${ledger}:${parsed.bare}`;
}
