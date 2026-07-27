/**
 * Deterministic typed-overlay and prompt-mutation policy (T684, goal G94).
 *
 * Prompt customization is EITHER a G91-declared build-time fragment (rendered
 * by {@link ./promptRenderer} into the attested packaged surface, T683) OR an
 * explicitly registered typed RUNTIME overlay from this module. Ordinary
 * dispatch accepts neither arbitrary prompt text nor unconstrained
 * suffix/prefix fields: an overlay application is only `{ overlayId, data }`
 * against a registry entry with a closed id, a JSON-Schema input contract, a
 * deterministic renderer, and an allowed role/surface set.
 *
 * The production registry {@link DISPATCH_OVERLAY_REGISTRY} intentionally
 * ships EMPTY — no concrete runtime-overlay use case exists. The mechanism is
 * exercised by test fixture registries built with
 * {@link createDispatchOverlayRegistry}.
 *
 * {@link materializeDispatchPrompt} is the single injection path from the
 * T683-attested role artifact bytes to the bytes handed to a launched
 * subagent. With no overlay the returned bytes are byte-identical to the
 * packaged artifact and `finalDigest === promptDigest`; every applied overlay
 * contributes to `finalDigest` through a mechanism-owned frame appended after
 * the artifact bytes, so the digest binds the exact injected bytes.
 *
 * This module calls {@link validateAgainstSchema} (Ajv) and is therefore NOT
 * browser-bundleable, like {@link ./validation}.
 */

import { DISPATCHED_ROLE_SIDECARS } from "./promptCatalogStore.js";
import { PROMPT_SURFACES, type JSONSchema, type PromptSurface } from "./promptCatalog.js";
import { validateAgainstSchema } from "./validation.js";
import type {
  DispatchJSONValue,
  DispatchOverlayApplication,
  DispatchedRoleId,
} from "./compactDispatchProtocol.js";

const SAFE_OVERLAY_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const OVERLAY_FRAME_PREFIX = "<!-- cq:overlay:";
const APPLICATION_FIELDS = ["overlayId", "data"] as const;

/** Deterministic overlay-policy violation, rejected before any launch. */
export class DispatchOverlayError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "DispatchOverlayError";
  }
}

/**
 * One explicitly registered typed runtime overlay: a closed id, the JSON
 * Schema its `data` must satisfy, the dispatched roles and prompt surfaces it
 * may be applied to, and a deterministic renderer — a pure function of the
 * validated `data` (determinism is operationally enforced by
 * {@link materializeDispatchPrompt}, which renders twice and rejects any
 * divergence).
 */
export interface DispatchOverlayDefinition {
  readonly overlayId: string;
  readonly inputSchema: JSONSchema;
  readonly allowedRoles: readonly DispatchedRoleId[];
  readonly allowedSurfaces: readonly PromptSurface[];
  readonly render: (data: DispatchJSONValue) => string;
}

/** Overlay definitions keyed by overlay id, in declaration order. */
export type DispatchOverlayRegistry = Readonly<Record<string, DispatchOverlayDefinition>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lowercase hex SHA-256 of raw bytes. */
function sha256Bytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function assertClosedList<T extends string>(
  values: readonly T[],
  universe: readonly string[],
  path: string,
  memberLabel: string,
): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new DispatchOverlayError(path, `expected a non-empty array of ${memberLabel}s`);
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !universe.includes(value)) {
      throw new DispatchOverlayError(`${path}[${index}]`, `unknown ${memberLabel} "${String(value)}"`);
    }
    if (values.indexOf(value) !== index) {
      throw new DispatchOverlayError(`${path}[${index}]`, `duplicate ${memberLabel} "${value}"`);
    }
  }
}

/**
 * Build a typed overlay registry from explicit definitions, failing closed on
 * an unsafe or duplicate overlay id, an unknown or duplicate role/surface, an
 * empty allow-list, a non-function renderer, or an input schema Ajv cannot
 * compile. Registration is the ONLY way an overlay id becomes acceptable to
 * dispatch; the production registry is {@link DISPATCH_OVERLAY_REGISTRY}.
 */
export function createDispatchOverlayRegistry(
  definitions: readonly DispatchOverlayDefinition[],
): DispatchOverlayRegistry {
  // Null-prototype: overlay ids are caller-chosen keys, so no Object.prototype
  // property may masquerade as a registry entry.
  const registry: Record<string, DispatchOverlayDefinition> = Object.create(null) as Record<
    string,
    DispatchOverlayDefinition
  >;
  for (const [index, definition] of definitions.entries()) {
    const path = `overlays[${index}]`;
    if (!isRecord(definition)) {
      throw new DispatchOverlayError(path, "expected an overlay definition object");
    }
    const overlayId = definition.overlayId;
    if (typeof overlayId !== "string" || !SAFE_OVERLAY_ID_PATTERN.test(overlayId)) {
      throw new DispatchOverlayError(`${path}.overlayId`, "expected a safe overlay identifier");
    }
    if (Object.hasOwn(registry, overlayId)) {
      throw new DispatchOverlayError(`${path}.overlayId`, `duplicate overlay "${overlayId}"`);
    }
    assertClosedList(
      definition.allowedRoles,
      Object.keys(DISPATCHED_ROLE_SIDECARS),
      `${path}.allowedRoles`,
      "dispatched role",
    );
    assertClosedList(
      definition.allowedSurfaces,
      PROMPT_SURFACES,
      `${path}.allowedSurfaces`,
      "prompt surface",
    );
    if (typeof definition.render !== "function") {
      throw new DispatchOverlayError(`${path}.render`, "expected a deterministic renderer function");
    }
    if (!isRecord(definition.inputSchema)) {
      throw new DispatchOverlayError(`${path}.inputSchema`, "expected a JSON Schema object");
    }
    try {
      // Compile once at registration (the validated value is irrelevant) so an
      // invalid authored schema fails the registry, not a later launch.
      validateAgainstSchema(definition.inputSchema, null);
    } catch {
      throw new DispatchOverlayError(`${path}.inputSchema`, "schema does not compile");
    }
    registry[overlayId] = Object.freeze({
      overlayId,
      inputSchema: definition.inputSchema,
      allowedRoles: Object.freeze([...definition.allowedRoles]),
      allowedSurfaces: Object.freeze([...definition.allowedSurfaces]),
      render: definition.render,
    });
  }
  return Object.freeze(registry);
}

/**
 * The authoritative production runtime-overlay registry. It ships EMPTY by
 * decision (T684): no concrete runtime-overlay use case exists, so ordinary
 * dispatch accepts only an absent or empty `overlays` list. Adding a
 * production overlay means adding an explicit declaration HERE — never a free
 * prompt field at the launch boundary.
 */
export const DISPATCH_OVERLAY_REGISTRY: DispatchOverlayRegistry = createDispatchOverlayRegistry(
  [],
);

/**
 * The launch-schema fragment for one role's `overlays` list, derived from the
 * registry: each declared overlay allowed for `roleId` contributes exactly one
 * `{ overlayId, data }` branch embedding its input schema, so an undeclared
 * overlay id, another role's overlay, invalid data, or any extra field fails
 * schema validation before launch. With no overlay declared for the role only
 * an empty list can pass. Duplicate application is enforced at
 * materialization ({@link materializeDispatchPrompt}); `maxItems` bounds the
 * list at the declared overlay count.
 */
export function dispatchOverlayListSchema(
  roleId: string,
  registry: DispatchOverlayRegistry,
): JSONSchema {
  const declared = Object.values(registry).filter((definition) =>
    (definition.allowedRoles as readonly string[]).includes(roleId),
  );
  if (declared.length === 0) {
    return {
      type: "array",
      items: {
        type: "object",
        properties: {
          overlayId: { type: "string", minLength: 1 },
          data: {},
        },
        required: ["overlayId", "data"],
        additionalProperties: false,
      },
      maxItems: 0,
    };
  }
  return {
    type: "array",
    items: {
      oneOf: declared.map((definition) => ({
        type: "object",
        properties: {
          overlayId: { type: "string", enum: [definition.overlayId] },
          data: definition.inputSchema,
        },
        required: ["overlayId", "data"],
        additionalProperties: false,
      })),
    },
    maxItems: declared.length,
  };
}

export interface DispatchPromptMaterializationInput {
  /** Kept as string so untyped boundary callers get a deterministic error. */
  readonly roleId: string;
  /** Kept as string so untyped boundary callers get a deterministic error. */
  readonly surface: string;
  /** The exact installed role artifact bytes (T683 attested). */
  readonly artifactBytes: Uint8Array;
  /** The attested digest of `artifactBytes` from the packaged surface manifest. */
  readonly promptDigest: string;
  readonly overlays: readonly DispatchOverlayApplication[];
  readonly registry: DispatchOverlayRegistry;
}

export interface DispatchPromptMaterialization {
  /** The exact bytes injected into the launched subagent. */
  readonly bytes: Uint8Array;
  /** The attested base-artifact digest (unchanged from the input). */
  readonly promptDigest: string;
  /**
   * Lowercase hex SHA-256 of `bytes`: equal to `promptDigest` with no overlay,
   * and changed by every applied overlay (the digest contribution).
   */
  readonly finalDigest: string;
  /** Applied overlay ids in canonical registry order. */
  readonly appliedOverlayIds: readonly string[];
}

interface ParsedApplication {
  readonly overlayId: string;
  readonly data: DispatchJSONValue;
}

function parseApplications(
  overlays: readonly DispatchOverlayApplication[],
  roleId: string,
  surface: PromptSurface,
  registry: DispatchOverlayRegistry,
): ReadonlyMap<string, ParsedApplication> {
  if (!Array.isArray(overlays)) {
    throw new DispatchOverlayError("overlays", "expected an array of overlay applications");
  }
  const applications = new Map<string, ParsedApplication>();
  for (const [index, candidate] of overlays.entries()) {
    const path = `overlays[${index}]`;
    if (!isRecord(candidate)) {
      throw new DispatchOverlayError(path, "expected an overlay application object");
    }
    const unexpectedField = Object.keys(candidate).find(
      (field) => !(APPLICATION_FIELDS as readonly string[]).includes(field),
    );
    if (unexpectedField !== undefined) {
      throw new DispatchOverlayError(
        `${path}.${unexpectedField}`,
        "arbitrary prompt fields are not accepted at dispatch",
      );
    }
    for (const field of APPLICATION_FIELDS) {
      // Object.hasOwn: a prototype-inherited field must not satisfy presence.
      if (!Object.hasOwn(candidate, field)) {
        throw new DispatchOverlayError(`${path}.${field}`, "missing overlay application field");
      }
    }
    const overlayId = candidate.overlayId;
    if (typeof overlayId !== "string" || !SAFE_OVERLAY_ID_PATTERN.test(overlayId)) {
      throw new DispatchOverlayError(`${path}.overlayId`, "expected a safe overlay identifier");
    }
    // Object.hasOwn: an Object.prototype property name (e.g. "constructor")
    // must fail as undeclared, not resolve through the prototype chain.
    if (!Object.hasOwn(registry, overlayId)) {
      throw new DispatchOverlayError(`${path}.overlayId`, `undeclared overlay "${overlayId}"`);
    }
    const definition = registry[overlayId];
    if (definition === undefined) {
      throw new DispatchOverlayError(`${path}.overlayId`, `undeclared overlay "${overlayId}"`);
    }
    if (applications.has(overlayId)) {
      throw new DispatchOverlayError(
        `${path}.overlayId`,
        `duplicate application of overlay "${overlayId}"`,
      );
    }
    if (!(definition.allowedRoles as readonly string[]).includes(roleId)) {
      throw new DispatchOverlayError(
        `${path}.overlayId`,
        `overlay "${overlayId}" is not declared for role "${roleId}"`,
      );
    }
    if (!definition.allowedSurfaces.includes(surface)) {
      throw new DispatchOverlayError(
        `${path}.overlayId`,
        `overlay "${overlayId}" is not declared for surface "${surface}"`,
      );
    }
    const result = validateAgainstSchema(definition.inputSchema, candidate.data);
    if (!result.ok) {
      const detail = result.errors
        .map((error) => `${error.path === "" ? "/" : error.path} ${error.message}`)
        .join("; ");
      throw new DispatchOverlayError(`${path}.data`, `invalid overlay input: ${detail}`);
    }
    applications.set(overlayId, { overlayId, data: candidate.data as DispatchJSONValue });
  }
  return applications;
}

function renderOverlay(definition: DispatchOverlayDefinition, data: DispatchJSONValue): string {
  const path = `overlays.${definition.overlayId}`;
  let first: unknown;
  let second: unknown;
  try {
    first = definition.render(data);
    second = definition.render(data);
  } catch {
    throw new DispatchOverlayError(path, "overlay renderer threw");
  }
  if (typeof first !== "string" || typeof second !== "string") {
    throw new DispatchOverlayError(path, "expected the renderer to return a string");
  }
  if (first !== second) {
    throw new DispatchOverlayError(path, "nondeterministic renderer output");
  }
  if (first.includes(OVERLAY_FRAME_PREFIX)) {
    throw new DispatchOverlayError(path, "rendered output contains an overlay frame marker");
  }
  return first;
}

/**
 * Materialize the exact prompt bytes injected into a launched subagent from
 * the T683-attested role artifact plus the declared overlay applications.
 *
 * Every check fails closed BEFORE launch: an unknown role or surface, a base
 * artifact whose bytes no longer match the attested `promptDigest`, an
 * undeclared or duplicate overlay id, an overlay applied to a role or surface
 * it is not declared for, overlay data failing its input schema, any field
 * beyond `{ overlayId, data }` (no free suffix/prefix/text), and a renderer
 * that throws, returns a non-string, emits a frame marker, or renders
 * nondeterministically (it runs twice; divergence rejects the dispatch).
 *
 * Applied overlays render in canonical registry declaration order — the
 * injected bytes never depend on the caller's application order. Each overlay
 * appends one mechanism-owned frame after the artifact bytes:
 *
 * ```
 * \n\n<!-- cq:overlay:<overlayId> -->\n<rendered>\n<!-- cq:overlay:<overlayId>:end -->\n
 * ```
 *
 * With no overlay the returned bytes are byte-identical to the packaged
 * artifact and `finalDigest === promptDigest`.
 */
export function materializeDispatchPrompt(
  input: DispatchPromptMaterializationInput,
): DispatchPromptMaterialization {
  const roleId = input.roleId;
  // Object.hasOwn: `in` would accept Object.prototype names ("constructor",
  // "toString", ...) as dispatched roles and materialize bytes for them.
  if (!Object.hasOwn(DISPATCHED_ROLE_SIDECARS, roleId)) {
    throw new DispatchOverlayError("roleId", `unknown dispatched role "${roleId}"`);
  }
  if (!(PROMPT_SURFACES as readonly string[]).includes(input.surface)) {
    throw new DispatchOverlayError("surface", `unsupported prompt surface "${input.surface}"`);
  }
  const surface = input.surface as PromptSurface;
  if (!(input.artifactBytes instanceof Uint8Array)) {
    throw new DispatchOverlayError("artifactBytes", "expected the installed artifact bytes");
  }
  if (sha256Bytes(input.artifactBytes) !== input.promptDigest) {
    throw new DispatchOverlayError(
      "promptDigest",
      "artifact bytes do not match the attested digest",
    );
  }

  const applications = parseApplications(input.overlays, roleId, surface, input.registry);
  const appliedDefinitions = Object.values(input.registry).filter((definition) =>
    applications.has(definition.overlayId),
  );

  let framedOverlays = "";
  for (const definition of appliedDefinitions) {
    const rendered = renderOverlay(definition, applications.get(definition.overlayId)!.data);
    framedOverlays +=
      `\n\n${OVERLAY_FRAME_PREFIX}${definition.overlayId} -->\n` +
      `${rendered}\n` +
      `${OVERLAY_FRAME_PREFIX}${definition.overlayId}:end -->\n`;
  }

  let bytes: Uint8Array;
  if (framedOverlays === "") {
    bytes = Uint8Array.from(input.artifactBytes);
  } else {
    const overlayBytes = new TextEncoder().encode(framedOverlays);
    bytes = new Uint8Array(input.artifactBytes.length + overlayBytes.length);
    bytes.set(input.artifactBytes, 0);
    bytes.set(overlayBytes, input.artifactBytes.length);
  }
  return Object.freeze({
    bytes,
    promptDigest: input.promptDigest,
    finalDigest: sha256Bytes(bytes),
    appliedOverlayIds: Object.freeze(
      appliedDefinitions.map((definition) => definition.overlayId),
    ),
  });
}
