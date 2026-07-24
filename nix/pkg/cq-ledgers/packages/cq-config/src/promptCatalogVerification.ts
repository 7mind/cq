import {
  PROMPT_SURFACES,
  type IntentionalDifferenceDeclaration,
  type PromptSurface,
} from "./promptCatalog.js";

const SLOT_MARKER_PREFIX = "{{cq:fragment:";
const RUNTIME_PLACEHOLDER_PATTERN =
  /\$[A-Z_][A-Z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{(?!cq:fragment:)[^{}\r\n]+\}\}/g;

export interface PromptVerificationRoot {
  readonly surface: PromptSurface;
  readonly artifacts: Readonly<Record<string, string>>;
}

export interface PromptFragmentObservation {
  readonly roleId: string;
  readonly fragment: string;
  readonly contents: Readonly<Record<PromptSurface, string>>;
}

export interface PromptCatalogVerificationInput {
  readonly authoritativeCatalogJson: string;
  readonly authoritativeProjection: Readonly<Record<string, unknown>>;
  readonly generatedProjection: Readonly<Record<string, unknown>>;
  readonly expectedRoots: Readonly<Record<PromptSurface, PromptVerificationRoot>>;
  readonly packagedRoots: Readonly<Record<PromptSurface, PromptVerificationRoot>>;
  readonly localClaudeRoot: PromptVerificationRoot;
  readonly fragmentObservations: readonly PromptFragmentObservation[];
  readonly sidecarRoleIds: readonly string[];
}

export class PromptCatalogVerificationError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PromptCatalogVerificationError";
  }
}

type DifferenceDeclaration = IntentionalDifferenceDeclaration;

interface FragmentBinding {
  readonly fragment: string;
  readonly supportedSurfaces: readonly PromptSurface[];
  readonly forbiddenVocabulary: Readonly<Record<PromptSurface, readonly string[]>>;
  readonly intentionalDifference: DifferenceDeclaration;
}

interface DispatchRelation {
  readonly kind: "dispatch" | "recursion";
  readonly targetRoleId: string;
}

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: "dispatched-subagent" | "orchestrator-command";
  readonly canonicalSource: string;
  readonly surfaces: readonly PromptSurface[];
  readonly fragmentBindings: readonly FragmentBinding[];
  readonly dispatchRelations: readonly DispatchRelation[];
  readonly intentionalDifferences: readonly DifferenceDeclaration[];
  readonly sidecar: { readonly schemaRoleId: string } | null;
}

interface CatalogProjection {
  readonly schemaVersion: number;
  readonly catalog: readonly CatalogRole[];
  readonly catalogMetadataHash: string;
  readonly fragmentContracts: readonly FragmentBinding[];
}

function fail(path: string, detail: string): never {
  throw new PromptCatalogVerificationError(path, detail);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProjection(
  value: Readonly<Record<string, unknown>>,
  path: string,
): CatalogProjection {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.catalog) ||
    typeof value.catalogMetadataHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.catalogMetadataHash) ||
    !Array.isArray(value.fragmentContracts)
  ) {
    fail(path, "unsupported prompt-catalog projection");
  }
  return value as unknown as CatalogProjection;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalArtifacts(artifacts: Readonly<Record<string, string>>): string {
  return canonicalJson(
    Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertSupportedSurfaces(
  value: readonly PromptSurface[],
  path: string,
): void {
  if (!sameOrderedValues(value, PROMPT_SURFACES)) {
    fail(path, `supported surfaces must equal ${PROMPT_SURFACES.join(", ")} in order`);
  }
}

function differenceKey(value: DifferenceDeclaration): string {
  return canonicalJson({
    kind: value.kind,
    reason: value.reason,
    surfaces: value.surfaces,
  });
}

function observationKey(roleId: string, fragment: string): string {
  return `${roleId}\0${fragment}`;
}

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(RUNTIME_PLACEHOLDER_PATTERN)].map((match) => match[0]);
}

function assertCatalogStructure(
  roles: readonly CatalogRole[],
  fragmentContracts: readonly FragmentBinding[],
  observations: readonly PromptFragmentObservation[],
  sidecarRoleIds: readonly string[],
): void {
  const rolesById = new Map<string, CatalogRole>();
  const canonicalSources = new Set<string>();
  for (const [index, role] of roles.entries()) {
    const path = `catalog[${index}]`;
    if (!isRecord(role) || typeof role.roleId !== "string") {
      fail(path, "expected a catalog role");
    }
    if (rolesById.has(role.roleId)) {
      fail(`${path}.roleId`, `duplicate role "${role.roleId}"`);
    }
    rolesById.set(role.roleId, role);
    if (canonicalSources.has(role.canonicalSource)) {
      fail(`${path}.canonicalSource`, `duplicate source "${role.canonicalSource}"`);
    }
    canonicalSources.add(role.canonicalSource);
    assertSupportedSurfaces(role.surfaces, `${path}.surfaces`);
    if (!Array.isArray(role.fragmentBindings)) {
      fail(`${path}.fragmentBindings`, "expected an array");
    }
    for (const binding of role.fragmentBindings) {
      assertSupportedSurfaces(
        binding.supportedSurfaces,
        `${path}.fragmentBindings.${binding.fragment}.supportedSurfaces`,
      );
      assertSupportedSurfaces(
        binding.intentionalDifference.surfaces,
        `${path}.fragmentBindings.${binding.fragment}.intentionalDifference.surfaces`,
      );
    }
  }

  const expectedSidecars = roles
    .filter((role) => role.roleKind === "dispatched-subagent")
    .map((role) => role.roleId)
    .sort();
  const actualSidecars = [...sidecarRoleIds].sort();
  if (!sameOrderedValues(actualSidecars, expectedSidecars)) {
    fail(
      "sidecars",
      `sidecar closure differs: expected ${expectedSidecars.join(", ")}, got ${actualSidecars.join(", ")}`,
    );
  }
  for (const role of roles) {
    if (role.roleKind === "dispatched-subagent") {
      if (role.sidecar?.schemaRoleId !== role.roleId) {
        fail(`catalog.${role.roleId}.sidecar`, "sidecar closure does not match the role");
      }
    } else if (role.sidecar !== null) {
      fail(`catalog.${role.roleId}.sidecar`, "orchestrator roles must not carry a sidecar");
    }
    for (const relation of role.dispatchRelations) {
      const target = rolesById.get(relation.targetRoleId);
      if (target === undefined) {
        fail(
          `catalog.${role.roleId}.dispatchRelations`,
          `unknown dispatch target "${relation.targetRoleId}"`,
        );
      }
      if (relation.kind === "dispatch" && target.roleKind !== "dispatched-subagent") {
        fail(
          `catalog.${role.roleId}.dispatchRelations`,
          `dispatch target "${relation.targetRoleId}" is not a dispatched subagent`,
        );
      }
      if (relation.kind === "recursion" && target.roleKind !== "orchestrator-command") {
        fail(
          `catalog.${role.roleId}.dispatchRelations`,
          `recursion target "${relation.targetRoleId}" is not an orchestrator command`,
        );
      }
    }
  }

  const contractsByFragment = new Map<string, FragmentBinding>();
  for (const contract of fragmentContracts) {
    if (contractsByFragment.has(contract.fragment)) {
      fail(
        "fragmentContracts",
        `duplicate fragment declaration "${contract.fragment}"`,
      );
    }
    contractsByFragment.set(contract.fragment, contract);
  }

  const observationsByKey = new Map<string, PromptFragmentObservation>();
  for (const observation of observations) {
    const key = observationKey(observation.roleId, observation.fragment);
    if (observationsByKey.has(key)) {
      fail(
        "fragmentObservations",
        `duplicate observation "${observation.roleId}:${observation.fragment}"`,
      );
    }
    observationsByKey.set(key, observation);
  }

  const consumedObservations = new Set<string>();
  for (const role of roles) {
    const declarations = new Map<string, number>();
    for (const declaration of role.intentionalDifferences) {
      const key = differenceKey(declaration);
      const count = (declarations.get(key) ?? 0) + 1;
      if (count > 1) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `duplicate difference declaration "${declaration.kind}"`,
        );
      }
      declarations.set(key, count);
    }

    const boundDeclarationKeys = new Set<string>();
    for (const binding of role.fragmentBindings) {
      const contract = contractsByFragment.get(binding.fragment);
      if (
        contract === undefined ||
        differenceKey(contract.intentionalDifference) !==
          differenceKey(binding.intentionalDifference)
      ) {
        fail(
          `catalog.${role.roleId}.fragmentBindings.${binding.fragment}`,
          "unknown fragment difference declaration",
        );
      }
      const declarationKey = differenceKey(binding.intentionalDifference);
      boundDeclarationKeys.add(declarationKey);
      const key = observationKey(role.roleId, binding.fragment);
      const observation = observationsByKey.get(key);
      if (observation === undefined) {
        fail(
          "fragmentObservations",
          `missing observation "${role.roleId}:${binding.fragment}"`,
        );
      }
      consumedObservations.add(key);
      const observedContents = PROMPT_SURFACES.map(
        (surface) => observation.contents[surface],
      );
      const observedDifference = new Set(observedContents).size > 1;
      const declarationCount = declarations.get(declarationKey) ?? 0;
      if (observedDifference && declarationCount !== 1) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `missing difference declaration for "${binding.fragment}"`,
        );
      }
      if (!observedDifference && declarationCount === 1) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `stale difference declaration for "${binding.fragment}"`,
        );
      }
    }
    for (const declaration of role.intentionalDifferences) {
      if (!boundDeclarationKeys.has(differenceKey(declaration))) {
        fail(
          `catalog.${role.roleId}.intentionalDifferences`,
          `unknown difference declaration "${declaration.kind}"`,
        );
      }
    }
  }
  const extraObservation = observations.find(
    (observation) =>
      !consumedObservations.has(observationKey(observation.roleId, observation.fragment)),
  );
  if (extraObservation !== undefined) {
    fail(
      "fragmentObservations",
      `unknown observation "${extraObservation.roleId}:${extraObservation.fragment}"`,
    );
  }
}

function assertRoot(
  root: PromptVerificationRoot,
  expected: PromptVerificationRoot,
  catalogJson: string,
  roles: readonly CatalogRole[],
  path: string,
): void {
  if (root.surface !== expected.surface) {
    fail(`${path}.surface`, `expected "${expected.surface}"`);
  }
  const expectedArtifactPaths = [
    "catalog.json",
    "surface.json",
    ...roles.map((role) => `roles/${role.roleId}.md`),
  ].sort();
  const actualArtifactPaths = Object.keys(root.artifacts).sort();
  const missingArtifact = expectedArtifactPaths.find(
    (artifactPath) => !actualArtifactPaths.includes(artifactPath),
  );
  if (missingArtifact !== undefined) {
    const detail = missingArtifact.startsWith("roles/")
      ? `missing role artifact "${missingArtifact}"`
      : `missing root artifact "${missingArtifact}"`;
    fail(path, detail);
  }
  const extraArtifact = actualArtifactPaths.find(
    (artifactPath) => !expectedArtifactPaths.includes(artifactPath),
  );
  if (extraArtifact !== undefined) {
    fail(path, `undeclared root artifact "${extraArtifact}"`);
  }
  if (root.artifacts["catalog.json"] !== catalogJson) {
    fail(`${path}.catalog.json`, "catalog bytes differ from the authoritative Nix JSON");
  }
  if (
    root.artifacts["surface.json"] !==
    JSON.stringify({ surface: root.surface })
  ) {
    fail(`${path}.surface.json`, "surface identity does not match the root");
  }

  for (const role of roles) {
    const artifactPath = `roles/${role.roleId}.md`;
    const actual = root.artifacts[artifactPath]!;
    const expectedContent = expected.artifacts[artifactPath];
    if (expectedContent === undefined) {
      fail(`${path}.${artifactPath}`, "expected renderer omitted the role artifact");
    }
    if (actual.includes("CQ_HARNESS")) {
      fail(`${path}.${artifactPath}`, "forbidden harness vocabulary CQ_HARNESS");
    }
    if (actual.includes(SLOT_MARKER_PREFIX)) {
      fail(`${path}.${artifactPath}`, "unresolved slot marker");
    }
    for (const token of new Set(
      role.fragmentBindings.flatMap(
        (binding) => binding.forbiddenVocabulary[root.surface],
      ),
    )) {
      if (actual.includes(token)) {
        fail(
          `${path}.${artifactPath}`,
          `forbidden vocabulary "${token}" for ${root.surface}`,
        );
      }
    }
    if (!sameOrderedValues(placeholders(actual), placeholders(expectedContent))) {
      fail(`${path}.${artifactPath}`, "runtime placeholder sequence changed");
    }
    if (actual !== expectedContent) {
      fail(`${path}.${artifactPath}`, "source drift from deterministic rendering");
    }
  }
}

export function verifyPromptCatalog(input: PromptCatalogVerificationInput): void {
  const authority = asProjection(input.authoritativeProjection, "authoritativeProjection");
  const generated = asProjection(input.generatedProjection, "generatedProjection");
  const authorityRoleIds = authority.catalog.map((role) => role.roleId);
  const generatedRoleIds = generated.catalog.map((role) => role.roleId);
  if (!sameOrderedValues(generatedRoleIds, authorityRoleIds)) {
    fail("generatedProjection.catalog", "different ordered role catalog");
  }
  assertCatalogStructure(
    authority.catalog,
    authority.fragmentContracts,
    input.fragmentObservations,
    input.sidecarRoleIds,
  );
  if (generated.schemaVersion !== authority.schemaVersion) {
    fail("generatedProjection.schemaVersion", "different schema version");
  }
  if (canonicalJson(generated.catalog) !== canonicalJson(authority.catalog)) {
    fail("generatedProjection.catalog", "catalog metadata drift");
  }
  if (
    canonicalJson(generated.fragmentContracts) !==
    canonicalJson(authority.fragmentContracts)
  ) {
    fail("generatedProjection.fragmentContracts", "fragment-contract drift");
  }
  if (generated.catalogMetadataHash !== authority.catalogMetadataHash) {
    fail("generatedProjection.catalogMetadataHash", "different metadata hash");
  }

  for (const surface of PROMPT_SURFACES) {
    assertRoot(
      input.packagedRoots[surface],
      input.expectedRoots[surface],
      input.authoritativeCatalogJson,
      authority.catalog,
      `packagedRoots.${surface}`,
    );
  }
  assertRoot(
    input.localClaudeRoot,
    input.expectedRoots.claude,
    input.authoritativeCatalogJson,
    authority.catalog,
    "localClaudeRoot",
  );
  if (
    canonicalArtifacts(input.localClaudeRoot.artifacts) !==
    canonicalArtifacts(input.packagedRoots.claude.artifacts)
  ) {
    fail("localClaudeRoot", "atomic local Claude root differs from the packaged root");
  }

  let catalogValue: unknown;
  try {
    catalogValue = JSON.parse(input.authoritativeCatalogJson) as unknown;
  } catch {
    fail("authoritativeCatalogJson", "expected valid JSON");
  }
  if (canonicalJson(catalogValue) !== canonicalJson(authority.catalog)) {
    fail("authoritativeCatalogJson", "catalog metadata drift from the projection");
  }
  const actualHash = sha256(input.authoritativeCatalogJson);
  if (authority.catalogMetadataHash !== actualHash) {
    fail(
      "authoritativeProjection.catalogMetadataHash",
      `expected SHA-256 ${actualHash}`,
    );
  }
}
