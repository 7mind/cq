import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { PROMPT_SURFACES, type PromptSurface } from "./promptCatalog.js";

const SLOT_MARKER_PREFIX = "{{cq:fragment:";
const SLOT_MARKER_PATTERN = /\{\{cq:fragment:([^{}\r\n]+)\}\}/g;
const SAFE_ROLE_ID_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const SAFE_FRAGMENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_HARNESS_BRANCH_PATTERN = /\bCQ_HARNESS\b/;

/** One explicit canonical-source input. No source root or ambient CWD is consulted. */
export interface PromptCatalogFileInput {
  readonly canonicalSource: string;
  readonly path: string;
}

/** One explicit surface-fragment input for a catalog role and declared typed slot. */
export interface PromptFragmentFileInput {
  readonly roleId: string;
  readonly fragment: string;
  readonly path: string;
}

export interface RenderPromptSurfaceTreeInput {
  /** Selected output surface. Kept as string so untyped boundary callers get a deterministic error. */
  readonly surface: string;
  /** The direct JSON serialization of `assets.nix.catalog`. */
  readonly catalogJson: string;
  readonly sourcePaths: readonly PromptCatalogFileInput[];
  readonly fragmentPaths: readonly PromptFragmentFileInput[];
}

export interface RenderedPromptArtifact {
  /** Relative path below a surface root. */
  readonly path: string;
  /** Exact UTF-8 bytes represented as a string. */
  readonly content: string;
}

export interface RenderedPromptSurfaceTree {
  readonly surface: PromptSurface;
  /** `catalog.json` first, followed by role artifacts in canonical catalog order. */
  readonly artifacts: readonly RenderedPromptArtifact[];
}

/** Deterministic boundary or rendering failure. */
export class PromptRendererError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PromptRendererError";
  }
}

interface CatalogFragmentBinding {
  readonly fragment: string;
  readonly supportedSurfaces: readonly PromptSurface[];
}

interface CatalogRole {
  readonly roleId: string;
  readonly canonicalSource: string;
  readonly surfaces: readonly PromptSurface[];
  readonly fragmentBindings: readonly CatalogFragmentBinding[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSurfaceList(value: unknown, path: string): readonly PromptSurface[] {
  if (!Array.isArray(value)) {
    throw new PromptRendererError(path, "expected an array");
  }
  const surfaces: PromptSurface[] = [];
  for (const [index, candidate] of value.entries()) {
    if (
      typeof candidate !== "string" ||
      !(PROMPT_SURFACES as readonly string[]).includes(candidate)
    ) {
      throw new PromptRendererError(
        `${path}[${index}]`,
        `expected one of ${PROMPT_SURFACES.join(", ")}`,
      );
    }
    const surface = candidate as PromptSurface;
    if (surfaces.includes(surface)) {
      throw new PromptRendererError(`${path}[${index}]`, `duplicate surface "${surface}"`);
    }
    surfaces.push(surface);
  }
  return surfaces;
}

function parseCatalog(catalogJson: string): readonly CatalogRole[] {
  let value: unknown;
  try {
    value = JSON.parse(catalogJson) as unknown;
  } catch {
    throw new PromptRendererError("catalogJson", "invalid JSON");
  }
  if (!Array.isArray(value)) {
    throw new PromptRendererError("catalogJson", "expected the assets.nix.catalog array");
  }

  const roles: CatalogRole[] = [];
  const roleIds = new Set<string>();
  const canonicalSources = new Set<string>();
  for (const [roleIndex, candidate] of value.entries()) {
    const rolePath = `catalog[${roleIndex}]`;
    if (!isRecord(candidate)) {
      throw new PromptRendererError(rolePath, "expected an object");
    }
    const roleId = candidate.roleId;
    if (typeof roleId !== "string" || !SAFE_ROLE_ID_PATTERN.test(roleId)) {
      throw new PromptRendererError(`${rolePath}.roleId`, "expected a safe role identifier");
    }
    if (roleIds.has(roleId)) {
      throw new PromptRendererError(`${rolePath}.roleId`, `duplicate role "${roleId}"`);
    }
    roleIds.add(roleId);

    const canonicalSource = candidate.canonicalSource;
    if (
      typeof canonicalSource !== "string" ||
      canonicalSource.length === 0 ||
      nodePath.posix.isAbsolute(canonicalSource) ||
      canonicalSource.split("/").includes("..")
    ) {
      throw new PromptRendererError(
        `${rolePath}.canonicalSource`,
        "expected a safe relative canonical source",
      );
    }
    if (canonicalSources.has(canonicalSource)) {
      throw new PromptRendererError(
        `${rolePath}.canonicalSource`,
        `duplicate canonical source "${canonicalSource}"`,
      );
    }
    canonicalSources.add(canonicalSource);

    const surfaces = parseSurfaceList(candidate.surfaces, `${rolePath}.surfaces`);
    if (!Array.isArray(candidate.fragmentBindings)) {
      throw new PromptRendererError(`${rolePath}.fragmentBindings`, "expected an array");
    }
    const bindings: CatalogFragmentBinding[] = [];
    const fragments = new Set<string>();
    for (const [bindingIndex, bindingCandidate] of candidate.fragmentBindings.entries()) {
      const bindingPath = `${rolePath}.fragmentBindings[${bindingIndex}]`;
      if (!isRecord(bindingCandidate)) {
        throw new PromptRendererError(bindingPath, "expected an object");
      }
      const fragment = bindingCandidate.fragment;
      if (typeof fragment !== "string" || !SAFE_FRAGMENT_ID_PATTERN.test(fragment)) {
        throw new PromptRendererError(
          `${bindingPath}.fragment`,
          "expected a typed fragment identifier",
        );
      }
      if (fragments.has(fragment)) {
        throw new PromptRendererError(
          `${bindingPath}.fragment`,
          `duplicate slot declaration "${fragment}"`,
        );
      }
      fragments.add(fragment);
      bindings.push({
        fragment,
        supportedSurfaces: parseSurfaceList(
          bindingCandidate.supportedSurfaces,
          `${bindingPath}.supportedSurfaces`,
        ),
      });
    }
    roles.push({ roleId, canonicalSource, surfaces, fragmentBindings: bindings });
  }
  return roles;
}

function parseSurface(value: string): PromptSurface {
  if (!(PROMPT_SURFACES as readonly string[]).includes(value)) {
    throw new PromptRendererError("surface", `unsupported prompt surface "${value}"`);
  }
  return value as PromptSurface;
}

function readExplicitFile(inputPath: string, label: string): string {
  if (!nodePath.isAbsolute(inputPath)) {
    throw new PromptRendererError(label, "expected an absolute explicit input path");
  }
  try {
    return readFileSync(inputPath, "utf8");
  } catch {
    throw new PromptRendererError(label, `cannot read "${inputPath}"`);
  }
}

function rejectHarnessBranch(content: string, label: string): void {
  if (FORBIDDEN_HARNESS_BRANCH_PATTERN.test(content)) {
    throw new PromptRendererError(label, "forbidden harness branch CQ_HARNESS");
  }
}

function indexSourcePaths(
  inputs: readonly PromptCatalogFileInput[],
  roles: readonly CatalogRole[],
): ReadonlyMap<string, string> {
  const declaredSources = new Set(roles.map((role) => role.canonicalSource));
  const paths = new Map<string, string>();
  for (const [index, input] of inputs.entries()) {
    if (!declaredSources.has(input.canonicalSource)) {
      throw new PromptRendererError(
        `sourcePaths[${index}]`,
        `undeclared canonical source "${input.canonicalSource}"`,
      );
    }
    if (paths.has(input.canonicalSource)) {
      throw new PromptRendererError(
        `sourcePaths[${index}]`,
        `duplicate canonical source input "${input.canonicalSource}"`,
      );
    }
    paths.set(input.canonicalSource, input.path);
  }
  for (const role of roles) {
    if (!paths.has(role.canonicalSource)) {
      throw new PromptRendererError(
        `sources.${role.roleId}`,
        `missing canonical source input "${role.canonicalSource}"`,
      );
    }
  }
  return paths;
}

function fragmentKey(roleId: string, fragment: string): string {
  return `${roleId}\0${fragment}`;
}

function indexFragmentPaths(
  inputs: readonly PromptFragmentFileInput[],
  roles: readonly CatalogRole[],
  surface: PromptSurface,
): ReadonlyMap<string, string> {
  const expected = new Map<string, { readonly roleId: string; readonly fragment: string }>();
  for (const role of roles) {
    if (!role.surfaces.includes(surface)) {
      throw new PromptRendererError(
        `catalog[${roles.indexOf(role)}].surfaces`,
        `surface "${surface}" is unsupported for role "${role.roleId}"`,
      );
    }
    for (const binding of role.fragmentBindings) {
      if (!binding.supportedSurfaces.includes(surface)) {
        throw new PromptRendererError(
          `catalog.${role.roleId}.${binding.fragment}.supportedSurfaces`,
          `surface "${surface}" is unsupported for slot`,
        );
      }
      expected.set(fragmentKey(role.roleId, binding.fragment), {
        roleId: role.roleId,
        fragment: binding.fragment,
      });
    }
  }

  const paths = new Map<string, string>();
  for (const [index, input] of inputs.entries()) {
    const key = fragmentKey(input.roleId, input.fragment);
    if (!expected.has(key)) {
      throw new PromptRendererError(
        `fragmentPaths[${index}]`,
        `undeclared fragment input "${input.roleId}:${input.fragment}"`,
      );
    }
    if (paths.has(key)) {
      throw new PromptRendererError(
        `fragmentPaths[${index}]`,
        `duplicate slot input "${input.roleId}:${input.fragment}"`,
      );
    }
    paths.set(key, input.path);
  }
  for (const { roleId, fragment } of expected.values()) {
    if (!paths.has(fragmentKey(roleId, fragment))) {
      throw new PromptRendererError(
        `fragments.${roleId}.${fragment}`,
        `missing slot input for surface "${surface}"`,
      );
    }
  }
  return paths;
}

function renderRole(
  role: CatalogRole,
  sourcePath: string,
  fragmentPaths: ReadonlyMap<string, string>,
): string {
  const sourceLabel = `sources.${role.roleId}`;
  let rendered = readExplicitFile(sourcePath, sourceLabel);
  rejectHarnessBranch(rendered, sourceLabel);

  const declaredFragments = new Set(role.fragmentBindings.map((binding) => binding.fragment));
  const catalogFragments = new Set<string>();
  for (const key of fragmentPaths.keys()) {
    catalogFragments.add(key.slice(key.indexOf("\0") + 1));
  }
  const markerCounts = new Map<string, number>();
  for (const match of rendered.matchAll(SLOT_MARKER_PATTERN)) {
    const fragment = match[1]!;
    if (!catalogFragments.has(fragment)) {
      throw new PromptRendererError(
        `${sourceLabel}.${fragment}`,
        "unknown slot marker",
      );
    }
    if (!declaredFragments.has(fragment)) {
      throw new PromptRendererError(
        `${sourceLabel}.${fragment}`,
        "slot marker is undeclared for this role",
      );
    }
    markerCounts.set(fragment, (markerCounts.get(fragment) ?? 0) + 1);
  }

  for (const binding of role.fragmentBindings) {
    const count = markerCounts.get(binding.fragment) ?? 0;
    if (count === 0) {
      throw new PromptRendererError(
        `fragments.${role.roleId}.${binding.fragment}`,
        "unconsumed slot input",
      );
    }
    if (count > 1) {
      throw new PromptRendererError(
        `${sourceLabel}.${binding.fragment}`,
        "duplicate slot marker",
      );
    }
    const fragmentLabel = `fragments.${role.roleId}.${binding.fragment}`;
    const fragmentPath = fragmentPaths.get(fragmentKey(role.roleId, binding.fragment));
    if (fragmentPath === undefined) {
      throw new PromptRendererError(fragmentLabel, "missing slot input");
    }
    const fragment = readExplicitFile(fragmentPath, fragmentLabel);
    rejectHarnessBranch(fragment, fragmentLabel);
    if (fragment.includes(SLOT_MARKER_PREFIX)) {
      throw new PromptRendererError(fragmentLabel, "fragment content contains a slot marker");
    }
    rendered = rendered.replace(`{{cq:fragment:${binding.fragment}}}`, fragment);
  }
  if (rendered.includes(SLOT_MARKER_PREFIX)) {
    throw new PromptRendererError(sourceLabel, "unresolved slot marker");
  }
  return rendered;
}

/**
 * Render one prompt surface from direct Nix catalog JSON and explicit files.
 *
 * The function performs no root discovery and reads no generated roster or
 * packaged prompt tree. Each canonical source contains exactly one
 * `{{cq:fragment:<fragment>}}` marker for each bound slot. Catalog order
 * determines artifact order.
 */
export function renderPromptSurfaceTree(
  input: RenderPromptSurfaceTreeInput,
): RenderedPromptSurfaceTree {
  const surface = parseSurface(input.surface);
  const roles = parseCatalog(input.catalogJson);
  const sourcePaths = indexSourcePaths(input.sourcePaths, roles);
  const fragmentPaths = indexFragmentPaths(input.fragmentPaths, roles, surface);
  const artifacts: RenderedPromptArtifact[] = [
    { path: "catalog.json", content: input.catalogJson },
  ];

  for (const role of roles) {
    const sourcePath = sourcePaths.get(role.canonicalSource);
    if (sourcePath === undefined) {
      throw new PromptRendererError(`sources.${role.roleId}`, "missing canonical source input");
    }
    artifacts.push({
      path: nodePath.posix.join("roles", `${role.roleId}.md`),
      content: renderRole(role, sourcePath, fragmentPaths),
    });
  }
  return { surface, artifacts };
}
