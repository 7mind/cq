import { canonicalCohortValueV1 as canonical, cohortValueDigestV1 as digest,
  assertCohortCandidateIntentV1, assertCohortEffectEnvelopeV1 } from "@cq/process-control";
export { assertCohortCandidateIntentV1, assertCohortEffectEnvelopeV1, createCohortCandidateIntentV1,
  cohortValueDigestV1 } from "@cq/process-control";
import { posix } from "node:path";

import type {
  AttestationEnvelope, AttestationStore, ImplementationQueueControl, DispatchGitChangeReceipt,
  DispatchCohortRebaseTransition, DispatchGuardedRebaseBridge,
  CohortRepositoryIdentityV1, CohortEnvironmentIdentityV1, CohortDefinitionIdentityV1,
  CohortCandidateIntentV1, CohortEvidenceSubjectV1, CohortMemberTaskAuthorityV1, CohortEffectEnvelopeV1, CohortWorktreeIdentityV1,
} from "@cq/config";
import { implementationQueueSubjectsMatch, implementationQueueAuthoritiesMatch, cohortRebaseTransitionMatches,
  assertDispatchGuardedRebaseBridge } from "@cq/config";
export type {
  CohortRepositoryIdentityV1, CohortEnvironmentIdentityV1, CohortDefinitionIdentityV1,
  CohortCandidateIntentV1, CohortEvidenceSubjectV1, CohortMemberTaskAuthorityV1, CohortEffectEnvelopeV1, CohortWorktreeIdentityV1,
} from "@cq/config";
import ts from "typescript";

import {
  nodeDispatchBaseGitRunner,
  type DispatchBaseGitRunner,
} from "./dispatchBase.js";
import { DEFECTS_LEDGER, GOALS_LEDGER, HYPOTHESIS_LEDGER, TASKS_LEDGER } from "./constants.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import type { Item } from "./types.js";
import {
  buildWorksetActiveState,
  closeWorkset,
  parseGoalFinalizedManifest,
  type WorksetGraph,
} from "./worksetGraph.js";
import {
  readCanonicalOwnership,
  resolveOwnerEdgePolicy,
  type WorksetOwnerEdgeKind,
} from "./worksetOwnerEdges.js";
import type { WorksetStore } from "./worksetStore.js";

export const COHORT_PHASE_ORDER_V1 = ["investigation", "implementation"] as const;

export type CohortPhaseV1 = (typeof COHORT_PHASE_ORDER_V1)[number];

export const COHORT_EXCLUSION_PRIORITY_V1 = [
  "stale-binding",
  "phase-mismatch",
  "ownership-or-manifest",
  "dependency",
  "authority",
  "repository-or-environment",
  "cohort-witness-empty",
  "validation-boundary-empty",
  "reviewer-boundary-empty",
  "deployment-boundary-empty",
  "finalization-boundary-empty",
  "eligibility-tuple-empty",
] as const;

export type CohortExclusionReasonV1 = (typeof COHORT_EXCLUSION_PRIORITY_V1)[number];

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;


function immutableSnapshot<T>(value: T): T {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((member) => immutableSnapshot(member))) as T;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("cohort snapshot contains a non-plain object");
    }
    const snapshot: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      snapshot[key] = immutableSnapshot(member);
    }
    return Object.freeze(snapshot) as T;
  }
  throw new Error("cohort snapshot contains a non-data value");
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must be non-empty`);
}

function assertDigest(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256 digest`);
}

function assertCommit(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be one full lowercase commit SHA`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function normalizedRepositoryPath(value: string, label: string): string {
  assertNonEmpty(value, label);
  if (value.startsWith("/") || value.split("/").some((part) => part === "" || part === "..")) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return value.startsWith("./") ? value.slice(2) : value;
}

export interface CohortWorksetSnapshotV1 {
  readonly worksetRef: string;
  readonly worksetRevision: string;
  readonly orderedMemberRefs: readonly string[];
}

export interface CohortManifestSnapshotV1 {
  readonly manifestRef: string;
  readonly manifestRevision: string;
  readonly memberRefs: readonly string[];
}

export interface CohortUnavailableFactV1 {
  readonly memberRef: string | null;
  readonly fact: string;
  readonly reason: string;
}

export type CohortSourceReferenceV1 =
  | {
      readonly kind: "repository-path";
      readonly ref: string;
    }
  | {
      readonly kind: "primary-ledger";
      readonly ref: string;
      readonly revision: string;
    }
  | {
      readonly kind: "opaque-authority";
      readonly ref: string;
    }
  | {
      readonly kind: "primary-log";
      readonly ref: string;
      readonly field: "sessionLogs" | "rawLogs";
    };

export type CohortSourceRelationshipV1 = "package" | "import" | "test";

export interface CohortSourceGraphNodeV1 {
  readonly path: string;
  readonly blobDigest: string;
  readonly referencedBy: readonly string[];
}

export interface CohortSourceGraphEdgeV1 {
  readonly from: string;
  readonly to: string;
  readonly relationship: CohortSourceRelationshipV1;
}

export interface CohortSourceGraphV1 {
  readonly nodes: readonly CohortSourceGraphNodeV1[];
  readonly edges: readonly CohortSourceGraphEdgeV1[];
}

export type CohortWitnessInputV1 =
  | {
      readonly kind: "confirmed-cause";
      readonly causeDigest: string;
      readonly receiptDigest: string;
    }
  | {
      readonly kind: "repository-node";
      readonly nodeKind: "production-symbol" | "versioned-contract" | "generated-source";
      readonly nodeIdentity: string;
      readonly sourcePath: string;
      readonly memberPath: readonly string[];
    };

export interface CohortBoundaryIdentityV1 {
  readonly identity: string;
  readonly digest: string;
}

export interface CohortFocusedCommandInputV1 {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly provenance: {
    readonly sourceRef: string;
    readonly sourceRevision: string;
  };
}

export interface CohortBoundaryCandidateInputV1 {
  readonly witness: CohortWitnessInputV1;
  readonly sharedRegression: CohortBoundaryIdentityV1;
  readonly canonicalFullGate: CohortBoundaryIdentityV1;
  readonly reviewerClass: CohortBoundaryIdentityV1;
  readonly deploymentClass: CohortBoundaryIdentityV1;
  readonly finalizationClass: CohortBoundaryIdentityV1;
  readonly splitConditions: readonly string[];
  readonly focusedCommand: CohortFocusedCommandInputV1;
}

interface ResolvedCohortMemberBaseV1 {
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly phase: CohortPhaseV1;
  readonly ownershipBoundaryDigest: string;
  readonly authorityRef: string;
  readonly authorityRevision: string;
  readonly authorityBoundaryDigest: string;
  readonly dependencyClosure: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly sourceReferences: readonly CohortSourceReferenceV1[];
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly boundaryCandidates: readonly CohortBoundaryCandidateInputV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
}

export interface ResolvedInvestigationCohortMemberV1 extends ResolvedCohortMemberBaseV1 {
  readonly phase: "investigation";
  readonly defectRef: string;
  readonly defectRevision: string;
  readonly hypothesisRef: string;
  readonly hypothesisRevision: string;
  readonly hypothesisState: string;
  readonly causeState: "confirmed" | "unconfirmed" | "unavailable";
  readonly confirmedCauseReceiptDigests: readonly string[];
  readonly investigationAuthority: string;
}

export interface ResolvedImplementationCohortMemberV1 extends ResolvedCohortMemberBaseV1 {
  readonly phase: "implementation";
  readonly taskRevision: string;
  readonly goalRef: string;
  readonly finalizedManifestRevision: string;
  readonly implementationAuthority: string;
}

export type ResolvedCohortMemberV1 =
  | ResolvedInvestigationCohortMemberV1
  | ResolvedImplementationCohortMemberV1;

export interface CohortAuthenticatedBenefitReceiptV1 {
  readonly receiptDigest: string;
  readonly boundaryDigest: string;
  readonly durationMs: number | null;
  readonly outcome: string;
}

export interface CohortAdmissionSnapshotV1 {
  readonly producer: string;
  readonly producerRevision: string;
  readonly workset: CohortWorksetSnapshotV1;
  readonly manifest: CohortManifestSnapshotV1 | null;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly sourceGraph: CohortSourceGraphV1;
  readonly members: readonly ResolvedCohortMemberV1[];
  readonly authenticatedBenefitReceipts: readonly CohortAuthenticatedBenefitReceiptV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
}

export interface CohortAdmissionObservationRequestV1 {
  readonly memberRefs: readonly string[];
}

export interface CohortAdmissionObservationSourceV1 {
  resolveExactSnapshot(
    request: CohortAdmissionObservationRequestV1,
  ): Promise<CohortAdmissionSnapshotV1>;
}

export interface CohortAdmissionMemberPlanV1 {
  readonly memberRef: string;
  readonly investigationHypothesisRef?: string;
  readonly boundaryCandidates: readonly CohortBoundaryCandidateInputV1[];
}

export interface CohortAdmissionPlanV1 {
  readonly kind: "cq-cohort-admission-plan";
  readonly version: 1;
  readonly members: readonly CohortAdmissionMemberPlanV1[];
}

export type CohortPrimaryLedgerReaderV1 = Pick<
  LedgerStore,
  "enumerate" | "fetch" | "fetchArchive"
>;

export interface CohortLocalRepositoryV1 {
  resolveIdentity(): Promise<CohortRepositoryIdentityV1>;
  readFile(identity: CohortRepositoryIdentityV1, path: string): Promise<string | null>;
  resolveRelationship(
    identity: CohortRepositoryIdentityV1,
    from: string,
    to: string,
  ): Promise<CohortSourceRelationshipV1 | null>;
}

const LOCAL_COHORT_GRAPH_LIMIT = 256;

function modulePathCandidates(unresolved: string): readonly string[] {
  const extension = posix.extname(unresolved);
  const withoutExtension = extension === "" ? unresolved : unresolved.slice(0, -extension.length);
  const typeScriptSubstitutions =
    extension === ".js"
      ? [`${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${withoutExtension}.d.ts`]
      : extension === ".jsx"
        ? [`${withoutExtension}.tsx`, `${withoutExtension}.ts`]
        : extension === ".mjs"
          ? [`${withoutExtension}.mts`, `${withoutExtension}.d.mts`]
          : extension === ".cjs"
            ? [`${withoutExtension}.cts`, `${withoutExtension}.d.cts`]
            : [];
  return Object.freeze(
    sortedUnique([
      unresolved,
      ...typeScriptSubstitutions,
      `${unresolved}.ts`,
      `${unresolved}.tsx`,
      `${unresolved}.js`,
      `${unresolved}.mjs`,
      `${unresolved}.cjs`,
      `${unresolved}.json`,
      `${unresolved}/index.ts`,
      `${unresolved}/index.tsx`,
      `${unresolved}/index.js`,
    ]),
  );
}

function relativeImportCandidates(from: string, specifier: string): readonly string[] {
  if (!specifier.startsWith(".")) return Object.freeze([]);
  return modulePathCandidates(posix.normalize(posix.join(posix.dirname(from), specifier)));
}

function importedSpecifiers(source: string): readonly string[] {
  const imports = ts.preProcessFile(source, true, true).importedFiles;
  return sortedUnique(imports.map(({ fileName }) => fileName));
}

function packageTargetStrings(value: unknown, wildcard: string | null): readonly string[] {
  if (typeof value === "string") {
    return Object.freeze([wildcard === null ? value : value.replaceAll("*", wildcard)]);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Object.values(value as Record<string, unknown>).flatMap((entry) =>
      packageTargetStrings(entry, wildcard),
    ),
  );
}

function packageExportTargets(packageJson: Record<string, unknown>, subpath: string): readonly string[] {
  const exports = packageJson["exports"];
  if (typeof exports === "string") {
    return subpath === "." ? Object.freeze([exports]) : Object.freeze([]);
  }
  if (typeof exports === "object" && exports !== null && !Array.isArray(exports)) {
    const entries = Object.entries(exports as Record<string, unknown>);
    const subpathEntries = entries.filter(([key]) => key.startsWith("."));
    if (subpathEntries.length === 0) {
      return subpath === "." ? packageTargetStrings(exports, null) : Object.freeze([]);
    }
    const exact = subpathEntries.find(([key]) => key === subpath);
    if (exact !== undefined) return packageTargetStrings(exact[1], null);
    for (const [key, value] of subpathEntries) {
      const wildcardIndex = key.indexOf("*");
      if (wildcardIndex === -1) continue;
      const prefix = key.slice(0, wildcardIndex);
      const suffix = key.slice(wildcardIndex + 1);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      return packageTargetStrings(value, subpath.slice(prefix.length, subpath.length - suffix.length));
    }
    return Object.freeze([]);
  }
  if (subpath !== ".") return Object.freeze([subpath.slice(2)]);
  return Object.freeze(
    [packageJson["types"], packageJson["module"], packageJson["main"]].filter(
      (value): value is string => typeof value === "string",
    ),
  );
}

/** Read one exact committed repository snapshot without scanning beyond named paths. */
export class GitCohortLocalRepositoryV1 implements CohortLocalRepositoryV1 {
  readonly #repositoryRoot: string;
  readonly #repositoryId: string;
  readonly #git: DispatchBaseGitRunner;

  constructor(input: {
    readonly repositoryRoot: string;
    readonly repositoryId: string;
    readonly git?: DispatchBaseGitRunner;
  }) {
    assertNonEmpty(input.repositoryRoot, "cohort repository root");
    assertNonEmpty(input.repositoryId, "cohort repository id");
    this.#repositoryRoot = input.repositoryRoot;
    this.#repositoryId = input.repositoryId;
    this.#git = input.git ?? nodeDispatchBaseGitRunner;
  }

  async #required(args: readonly string[], label: string): Promise<string> {
    const result = await this.#git(this.#repositoryRoot, args);
    if (result.code !== 0) {
      throw new Error(`${label} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  async resolveIdentity(): Promise<CohortRepositoryIdentityV1> {
    const [headCommit, treeOid] = await Promise.all([
      this.#required(["rev-parse", "--verify", "HEAD^{commit}"], "cohort repository HEAD"),
      this.#required(["rev-parse", "--verify", "HEAD^{tree}"], "cohort repository tree"),
    ]);
    const identity = Object.freeze({
      repositoryId: this.#repositoryId,
      headCommit: headCommit.trim(),
      treeOid: treeOid.trim(),
    });
    assertRepositoryIdentity(identity);
    return identity;
  }

  async readFile(identity: CohortRepositoryIdentityV1, rawPath: string): Promise<string | null> {
    if (identity.repositoryId !== this.#repositoryId) {
      throw new Error("cohort repository read used another repository identity");
    }
    assertRepositoryIdentity(identity);
    const path = normalizedRepositoryPath(rawPath, "cohort repository file");
    const object = `${identity.headCommit}:${path}`;
    const type = await this.#git(this.#repositoryRoot, ["cat-file", "-t", object]);
    if (type.code !== 0) return null;
    if (type.stdout.trim() !== "blob") {
      throw new Error(`${path} is not a committed regular file`);
    }
    return await this.#required(["show", object], `${path} read`);
  }

  async #workspaceImportResolves(
    identity: CohortRepositoryIdentityV1,
    specifier: string,
    targetPath: string,
  ): Promise<boolean> {
    let directory = posix.dirname(targetPath);
    while (true) {
      const manifestPath = directory === "." ? "package.json" : `${directory}/package.json`;
      const bytes = await this.readFile(identity, manifestPath);
      if (bytes !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(bytes);
        } catch {
          throw new Error(`${manifestPath} is not valid JSON`);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(`${manifestPath} is not one package object`);
        }
        const packageJson = parsed as Record<string, unknown>;
        const packageName = packageJson["name"];
        if (
          typeof packageName === "string" &&
          (specifier === packageName || specifier.startsWith(`${packageName}/`))
        ) {
          const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
          return packageExportTargets(packageJson, subpath).some((target) => {
            if (!target.startsWith("./")) return false;
            const unresolved = posix.normalize(posix.join(directory, target));
            return modulePathCandidates(unresolved).includes(targetPath);
          });
        }
      }
      if (directory === ".") return false;
      directory = posix.dirname(directory);
    }
  }

  async resolveRelationship(
    identity: CohortRepositoryIdentityV1,
    rawFrom: string,
    rawTo: string,
  ): Promise<CohortSourceRelationshipV1 | null> {
    const from = normalizedRepositoryPath(rawFrom, "cohort relationship source");
    const to = normalizedRepositoryPath(rawTo, "cohort relationship target");
    const source = await this.readFile(identity, from);
    if (source === null || (await this.readFile(identity, to)) === null) return null;
    const packageDirectory = posix.dirname(to);
    if (
      posix.basename(to) === "package.json" &&
      (packageDirectory === "." || from.startsWith(`${packageDirectory}/`))
    ) {
      return "package";
    }
    let related = false;
    for (const specifier of importedSpecifiers(source)) {
      if (
        relativeImportCandidates(from, specifier).includes(to) ||
        (await this.#workspaceImportResolves(identity, specifier, to))
      ) {
        related = true;
        break;
      }
    }
    if (!related) return null;
    return /(?:^|\/)(?:test|tests)\/|\.(?:test|spec)\.[^.]+$/u.test(from) ? "test" : "import";
  }
}

function repositoryNodeSymbol(candidate: Extract<CohortWitnessInputV1, { kind: "repository-node" }>): string {
  const symbol = candidate.nodeIdentity.split("#").at(-1) ?? "";
  assertNonEmpty(symbol, "repository witness symbol");
  return symbol;
}

function sourceExportsSymbol(source: string, symbol: string): boolean {
  const parsed = ts.createSourceFile(
    "cohort-witness.tsx",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ?? false);
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(({ name }) => name.text === symbol)
      ) {
        return true;
      }
      if (ts.isNamespaceExport(statement.exportClause) && statement.exportClause.name.text === symbol) {
        return true;
      }
      continue;
    }
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      if (
        statement.declarationList.declarations.some(
          ({ name }) => ts.isIdentifier(name) && name.text === symbol,
        )
      ) {
        return true;
      }
      continue;
    }
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      statement.name.text === symbol
    ) {
      return true;
    }
  }
  return false;
}

function canonicalRefParts(ref: string): { readonly ledgerId: string; readonly itemId: string } {
  const separator = ref.indexOf(":");
  if (separator <= 0 || separator === ref.length - 1 || ref.indexOf(":", separator + 1) !== -1) {
    throw new Error(`${ref} is not one canonical ledger:item reference`);
  }
  return { ledgerId: ref.slice(0, separator), itemId: ref.slice(separator + 1) };
}

function itemRevision(ref: string, item: Item): string {
  return digest({ ref, item });
}

function stringField(item: Item, field: string): string | null {
  const value = item.fields[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringArrayField(item: Item, field: string): readonly string[] {
  const value = item.fields[field];
  return Array.isArray(value)
    ? Object.freeze(value.filter((entry): entry is string => typeof entry === "string"))
    : Object.freeze([]);
}

function dependencyClosure(graph: WorksetGraph, memberRef: string): readonly string[] {
  const prerequisites = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "prerequisite") continue;
    const refs = prerequisites.get(edge.from) ?? [];
    refs.push(edge.to);
    prerequisites.set(edge.from, refs);
  }
  const closure = new Set<string>();
  const pending = [...(prerequisites.get(memberRef) ?? [])];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || closure.has(current)) continue;
    closure.add(current);
    pending.push(...(prerequisites.get(current) ?? []));
  }
  return sortedUnique(closure);
}

interface PrimaryOwnershipHop {
  readonly childRef: string;
  readonly childLedger: string;
  readonly ownerRef: string;
  readonly ownerLedger: string;
  readonly ownerStatus: string;
  readonly edgeKind: Exclude<WorksetOwnerEdgeKind, "prerequisite">;
}

function investigationOwnershipRef(
  activeItems: ReadonlyMap<string, Item>,
  memberRef: string,
): string {
  const visited = new Set<string>();
  const hops: PrimaryOwnershipHop[] = [];
  let current = memberRef;
  while (!current.startsWith(`${GOALS_LEDGER}:`)) {
    if (visited.has(current)) throw new Error(`${memberRef} has cyclic primary ownership`);
    visited.add(current);
    const item = activeItems.get(current);
    if (item === undefined) {
      throw new Error(`${memberRef} primary ownership boundary ${current} is unavailable`);
    }
    const ownership = readCanonicalOwnership(item);
    if (ownership === null) {
      // A defect filed directly — by a user, an observer session, or automated
      // ingestion — is ambient: the owner-edge policy only creates a defect
      // under a goal review, a task, or a review, so such a defect never has an
      // owner to walk to. Requiring one made it permanently uninvestigable,
      // while its own investigation is what would produce the owning fix goal
      // (D548). The defect is then its own ownership boundary; investigation
      // authority still comes from the workset, and every deeper broken chain
      // remains a fault.
      if (current === memberRef && current.startsWith(`${DEFECTS_LEDGER}:`)) return current;
      throw new Error(`${memberRef} has no primary ownership boundary from ${current}`);
    }
    if (visited.has(ownership.ownerRef)) {
      throw new Error(`${memberRef} has cyclic primary ownership`);
    }
    const owner = activeItems.get(ownership.ownerRef);
    if (owner === undefined) {
      throw new Error(
        `${memberRef} primary ownership boundary ${ownership.ownerRef} is unavailable`,
      );
    }
    if (ownership.edgeKind === "prerequisite") {
      throw new Error(`${memberRef} primary ownership cannot use a prerequisite edge`);
    }
    hops.push({
      childRef: current,
      childLedger: canonicalRefParts(current).ledgerId,
      ownerRef: ownership.ownerRef,
      ownerLedger: canonicalRefParts(ownership.ownerRef).ledgerId,
      ownerStatus: owner.status,
      edgeKind: ownership.edgeKind,
    });
    current = ownership.ownerRef;
  }
  for (const hop of hops) {
    const resolution = resolveOwnerEdgePolicy({
      ownerLedger: hop.ownerLedger,
      ownerStatus: hop.ownerStatus,
      creationKind: hop.edgeKind,
    });
    if (resolution.decision !== "allow") {
      throw new Error(
        `${memberRef} primary ownership edge ${hop.ownerRef} -> ${hop.childRef} is not live: ${resolution.reason}`,
      );
    }
    if (!resolution.childLedgers.includes(hop.childLedger)) {
      throw new Error(
        `${memberRef} primary ownership edge ${hop.ownerRef} -> ${hop.childRef} does not authorise ${hop.childLedger}`,
      );
    }
  }
  return current;
}

function sourceReferenceOrder(
  left: CohortSourceReferenceV1,
  right: CohortSourceReferenceV1,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.ref.localeCompare(right.ref) ||
    canonical(left).localeCompare(canonical(right))
  );
}

function opaqueAuthorityReference(value: string): boolean {
  return /^cq-[a-z0-9-]+:v[0-9]+:[0-9a-f]{64}$/u.test(value);
}

function readActivePrimaryItems(reader: CohortPrimaryLedgerReaderV1): ReadonlyMap<string, Item> {
  const ledgers = reader.enumerate().map((ledger) => {
    const fetched = reader.fetch(ledger);
    return {
      ledger,
      items: fetched.milestones.flatMap(({ items }) => items),
    };
  });
  return buildWorksetActiveState(ledgers).byRef;
}

async function readUniquePrimaryItem(
  reader: CohortPrimaryLedgerReaderV1,
  active: ReadonlyMap<string, Item>,
  ref: string,
): Promise<Item> {
  const { ledgerId, itemId } = canonicalRefParts(ref);
  const matches: Item[] = [];
  const activeItem = active.get(ref);
  if (activeItem !== undefined) matches.push(activeItem);
  const ledger = reader.fetch(ledgerId);
  for (const pointer of ledger.archivePointers) {
    const archive = await reader.fetchArchive(ledgerId, pointer.id);
    const items = archive.kind === "group" ? archive.milestone.items : [archive.item];
    matches.push(...items.filter(({ id }) => id === itemId));
  }
  if (matches.length !== 1) {
    throw new Error(`${ref} resolves to ${String(matches.length)} primary CQ records`);
  }
  return matches[0]!;
}

/** Bounded pre-admission producer over CQ's primary ledger/workset contracts and one Git tree. */
export class LedgerWorksetCohortAdmissionObservationSourceV1
  implements CohortAdmissionObservationSourceV1
{
  readonly #repository: CohortLocalRepositoryV1;
  readonly #ledger: CohortPrimaryLedgerReaderV1;
  readonly #workset: Pick<WorksetStore, "snapshot">;
  readonly #plan: CohortAdmissionPlanV1;
  readonly #environment: CohortEnvironmentIdentityV1;

  constructor(input: {
    readonly repository: CohortLocalRepositoryV1;
    readonly ledger: CohortPrimaryLedgerReaderV1;
    readonly workset: Pick<WorksetStore, "snapshot">;
    readonly plan: CohortAdmissionPlanV1;
    readonly environment: CohortEnvironmentIdentityV1;
  }) {
    this.#repository = input.repository;
    this.#ledger = input.ledger;
    this.#workset = input.workset;
    if (input.plan.kind !== "cq-cohort-admission-plan" || input.plan.version !== 1) {
      throw new Error("cohort admission plan is not version 1");
    }
    assertUnique(input.plan.members.map(({ memberRef }) => memberRef), "cohort admission plan refs");
    this.#plan = input.plan;
    assertDigest(input.environment.environmentDigest, "environment digest");
    this.#environment = Object.freeze({ ...input.environment });
  }

  async resolveExactSnapshot(
    request: CohortAdmissionObservationRequestV1,
  ): Promise<CohortAdmissionSnapshotV1> {
    const repository = await this.#repository.resolveIdentity();
    const worksetEpoch = await this.#workset.snapshot();
    const activeItems = readActivePrimaryItems(this.#ledger);
    // An empty persisted workset is the historical UNRESTRICTED mode, and it is
    // the mode `deriveWorksetPredicates` already reports readiness in. Refusing
    // it here made every predicate-actionable member unadmittable, so the whole
    // investigate/implement half of the flow had no legal operation (D547). The
    // unrestricted boundary is the whole active primary ledger.
    const admissionRoots =
      worksetEpoch.roots.length > 0 ? worksetEpoch.roots : [...activeItems.keys()];
    const graph = closeWorkset(
      admissionRoots,
      { byRef: activeItems },
      { validateLiveRoots: true },
    );
    if (!graph.restrictive) {
      throw new Error("cohort admission requires one active primary CQ member");
    }
    const orderedMemberRefs = Object.freeze(graph.nodes.map(({ ref }) => ref));
    for (const memberRef of request.memberRefs) {
      if (!orderedMemberRefs.includes(memberRef)) {
        throw new Error(`${memberRef} is absent from the exact primary CQ workset`);
      }
    }
    const workset: CohortWorksetSnapshotV1 = Object.freeze({
      worksetRef: `workset:${repository.repositoryId}`,
      worksetRevision: digest({
        roots: worksetEpoch.roots,
        epoch: worksetEpoch.epoch,
        nodes: graph.nodes.map(({ ref, item }) => ({ ref, revision: itemRevision(ref, item) })),
        edges: graph.edges,
      }),
      orderedMemberRefs,
    });
    const plans = new Map(this.#plan.members.map((plan) => [plan.memberRef, plan]));
    const primaryBindings = new Map<string, string>();
    const primaryLedgerIds = new Set(this.#ledger.enumerate());
    const resolveSourceReferences = async (
      memberRef: string,
      roots: readonly Item[],
    ): Promise<{
      readonly repositoryPaths: readonly string[];
      readonly references: readonly CohortSourceReferenceV1[];
    }> => {
      const repositoryPaths = new Set<string>();
      const references = new Map<string, CohortSourceReferenceV1>();
      const pending = [...roots];
      const resolvedPrimaryRefs = new Set<string>();
      while (pending.length > 0) {
        const current = pending.shift();
        if (current === undefined) continue;
        for (const field of ["sessionLogs", "rawLogs"] as const) {
          for (const ref of stringArrayField(current, field)) {
            const reference = Object.freeze({ kind: "primary-log" as const, ref, field });
            references.set(canonical(reference), reference);
          }
        }
        for (const rawRef of stringArrayField(current, "sourceRefs")) {
          const separator = rawRef.indexOf(":");
          const isPrimaryRef =
            separator > 0 &&
            rawRef.indexOf(":", separator + 1) === -1 &&
            primaryLedgerIds.has(rawRef.slice(0, separator));
          if (isPrimaryRef) {
            if (resolvedPrimaryRefs.has(rawRef)) continue;
            const item = await readUniquePrimaryItem(this.#ledger, activeItems, rawRef);
            const revision = itemRevision(rawRef, item);
            primaryBindings.set(rawRef, revision);
            const reference = Object.freeze({
              kind: "primary-ledger" as const,
              ref: rawRef,
              revision,
            });
            references.set(canonical(reference), reference);
            resolvedPrimaryRefs.add(rawRef);
            pending.push(item);
            continue;
          }
          if (opaqueAuthorityReference(rawRef)) {
            const reference = Object.freeze({ kind: "opaque-authority" as const, ref: rawRef });
            references.set(canonical(reference), reference);
            continue;
          }
          const path = normalizedRepositoryPath(rawRef, `${memberRef} repository source path`);
          repositoryPaths.add(path);
          const reference = Object.freeze({ kind: "repository-path" as const, ref: path });
          references.set(canonical(reference), reference);
        }
        if (references.size > LOCAL_COHORT_GRAPH_LIMIT) {
          throw new Error(
            `bounded cohort source provenance exceeds ${String(LOCAL_COHORT_GRAPH_LIMIT)} references`,
          );
        }
      }
      return Object.freeze({
        repositoryPaths: sortedUnique(repositoryPaths),
        references: Object.freeze([...references.values()].sort(sourceReferenceOrder)),
      });
    };
    const manifests: CohortManifestSnapshotV1[] = [];
    const members: ResolvedCohortMemberV1[] = [];
    for (const memberRef of request.memberRefs) {
      const plan = plans.get(memberRef);
      if (plan === undefined) throw new Error(`${memberRef} is absent from the trusted admission plan`);
      const item = activeItems.get(memberRef);
      if (item === undefined) throw new Error(`${memberRef} is not one active primary CQ member`);
      const revision = itemRevision(memberRef, item);
      primaryBindings.set(memberRef, revision);
      const dependencies = dependencyClosure(graph, memberRef);
      const { ledgerId } = canonicalRefParts(memberRef);
      if (ledgerId === TASKS_LEDGER) {
        const sourceReferences = await resolveSourceReferences(memberRef, [item]);
        const ownership = readCanonicalOwnership(item);
        if (ownership?.edgeKind !== "finalized-manifest" || !ownership.ownerRef.startsWith(`${GOALS_LEDGER}:`)) {
          throw new Error(`${memberRef} implementation authority is not derived from trusted CQ state`);
        }
        const goal = activeItems.get(ownership.ownerRef);
        if (goal === undefined) {
          throw new Error(`${memberRef} owning goal is absent from the exact primary CQ workset`);
        }
        const goalRevision = itemRevision(ownership.ownerRef, goal);
        primaryBindings.set(ownership.ownerRef, goalRevision);
        const finalizedManifest = parseGoalFinalizedManifest(goal);
        if (finalizedManifest === null) {
          throw new Error(`${memberRef} owning goal has no exact finalized manifest`);
        }
        const manifestRevision = digest({ goalRef: ownership.ownerRef, manifest: finalizedManifest });
        const manifestMemberRefs = Object.freeze(
          finalizedManifest.tasks.map(({ id }) => `${TASKS_LEDGER}:${id}`),
        );
        if (!manifestMemberRefs.includes(memberRef)) {
          throw new Error(`${memberRef} is absent from its owning goal's finalized manifest`);
        }
        manifests.push(
          Object.freeze({
            manifestRef: ownership.ownerRef,
            manifestRevision,
            memberRefs: manifestMemberRefs,
          }),
        );
        const authorityRevision = digest({
          goalRef: ownership.ownerRef,
          goalRevision,
          manifestRevision,
          worksetRevision: workset.worksetRevision,
        });
        members.push(
          Object.freeze({
            memberRef,
            memberRevision: revision,
            phase: "implementation",
            ownershipBoundaryDigest: digest({ ownership, manifestRevision }),
            authorityRef: ownership.ownerRef,
            authorityRevision,
            authorityBoundaryDigest: digest({
              phase: "implementation",
              authorityRef: ownership.ownerRef,
              authorityRevision,
            }),
            dependencyClosure: dependencies,
            sourceRefs: sourceReferences.repositoryPaths,
            sourceReferences: sourceReferences.references,
            repository,
            environment: this.#environment,
            boundaryCandidates: plan.boundaryCandidates,
            unavailableFacts: Object.freeze([]),
            taskRevision: revision,
            goalRef: ownership.ownerRef,
            finalizedManifestRevision: manifestRevision,
            implementationAuthority: `cq-finalized-manifest:${ownership.ownerRef}`,
          }),
        );
        continue;
      }
      if (ledgerId !== DEFECTS_LEDGER) {
        throw new Error(`${memberRef} is neither a defect investigation nor an implementation task`);
      }
      const hypothesisRef = plan.investigationHypothesisRef;
      if (hypothesisRef === undefined || !hypothesisRef.startsWith(`${HYPOTHESIS_LEDGER}:`)) {
        throw new Error(`${memberRef} admission plan has no canonical investigation hypothesis`);
      }
      const hypothesis = await readUniquePrimaryItem(this.#ledger, activeItems, hypothesisRef);
      const hypothesisOwnership = readCanonicalOwnership(hypothesis);
      if (hypothesisOwnership?.ownerRef !== memberRef || hypothesisOwnership.edgeKind !== "hypothesis") {
        throw new Error(`${memberRef} investigation authority is not derived from trusted CQ state`);
      }
      const hypothesisRevision = itemRevision(hypothesisRef, hypothesis);
      primaryBindings.set(hypothesisRef, hypothesisRevision);
      const sourceReferences = await resolveSourceReferences(memberRef, [item, hypothesis]);
      const rootCause = stringField(item, "rootCause");
      const causeConfirmed = hypothesis.status === "confirmed" && rootCause !== null;
      const causeDigest = digest({
        defectRef: memberRef,
        defectRevision: revision,
        hypothesisRef,
        hypothesisRevision,
        rootCause,
        evidence: stringArrayField(hypothesis, "evidence"),
      });
      const receiptDigest = digest({
        kind: "cq-primary-confirmed-cause-receipt",
        causeDigest,
        worksetRevision: workset.worksetRevision,
      });
      const boundaryCandidates = plan.boundaryCandidates.flatMap((candidate) => {
        if (candidate.witness.kind !== "confirmed-cause") return [candidate];
        if (!causeConfirmed) return [];
        return [
          Object.freeze({
            ...candidate,
            witness: Object.freeze({ kind: "confirmed-cause" as const, causeDigest, receiptDigest }),
          }),
        ];
      });
      const ownershipRef = investigationOwnershipRef(activeItems, memberRef);
      const ownershipItem = activeItems.get(ownershipRef);
      if (ownershipItem === undefined) {
        throw new Error(`${memberRef} primary ownership boundary ${ownershipRef} is unavailable`);
      }
      const ownershipRevision = itemRevision(ownershipRef, ownershipItem);
      primaryBindings.set(ownershipRef, ownershipRevision);
      const authorityRevision = digest({
        authorityRef: workset.worksetRef,
        worksetRevision: workset.worksetRevision,
      });
      members.push(
        Object.freeze({
          memberRef,
          memberRevision: revision,
          phase: "investigation",
          ownershipBoundaryDigest: digest({ ownershipRef, ownershipRevision }),
          authorityRef: workset.worksetRef,
          authorityRevision,
          authorityBoundaryDigest: digest({
            phase: "investigation",
            authorityRef: workset.worksetRef,
            authorityRevision,
          }),
          dependencyClosure: dependencies,
          sourceRefs: sourceReferences.repositoryPaths,
          sourceReferences: sourceReferences.references,
          repository,
          environment: this.#environment,
          boundaryCandidates: Object.freeze(boundaryCandidates),
          unavailableFacts: Object.freeze(
            causeConfirmed
              ? []
              : [{ memberRef, fact: "confirmed-cause", reason: "primary CQ cause is unconfirmed" }],
          ),
          defectRef: memberRef,
          defectRevision: revision,
          hypothesisRef,
          hypothesisRevision,
          hypothesisState: hypothesis.status,
          causeState: causeConfirmed ? "confirmed" : rootCause === null ? "unavailable" : "unconfirmed",
          confirmedCauseReceiptDigests: Object.freeze(causeConfirmed ? [receiptDigest] : []),
          investigationAuthority: `cq-workset-investigation:${workset.worksetRef}`,
        }),
      );
    }
    const manifestIdentities = new Set(manifests.map((manifest) => canonical(manifest)));
    if (manifestIdentities.size > 1) {
      throw new Error("implementation cohort spans multiple exact finalized manifests");
    }
    const manifest = manifests[0] ?? null;
    const pathMembers = new Map<string, Set<string>>();
    const edgeRequests = new Map<string, { readonly from: string; readonly to: string }>();
    const addPath = (rawPath: string, memberRef: string): string => {
      const path = normalizedRepositoryPath(rawPath, `${memberRef} bounded source path`);
      const refs = pathMembers.get(path) ?? new Set<string>();
      refs.add(memberRef);
      pathMembers.set(path, refs);
      if (pathMembers.size > LOCAL_COHORT_GRAPH_LIMIT) {
        throw new Error(`bounded cohort source graph exceeds ${String(LOCAL_COHORT_GRAPH_LIMIT)} files`);
      }
      return path;
    };
    for (const member of members) {
      for (const sourceRef of member.sourceRefs) {
        const sourcePath = addPath(sourceRef, member.memberRef);
        let directory = posix.dirname(sourcePath);
        while (true) {
          const manifestPath = directory === "." ? "package.json" : `${directory}/package.json`;
          if ((await this.#repository.readFile(repository, manifestPath)) !== null) {
            addPath(manifestPath, member.memberRef);
            edgeRequests.set(`${sourcePath}\u0000${manifestPath}`, {
              from: sourcePath,
              to: manifestPath,
            });
            break;
          }
          if (directory === ".") break;
          directory = posix.dirname(directory);
        }
      }
      for (const candidate of member.boundaryCandidates) {
        addPath(candidate.focusedCommand.provenance.sourceRef, member.memberRef);
        if (candidate.witness.kind !== "repository-node") continue;
        const memberPath = candidate.witness.memberPath.map((path) =>
          addPath(path, member.memberRef),
        );
        addPath(candidate.witness.sourcePath, member.memberRef);
        for (let index = 1; index < memberPath.length; index += 1) {
          const from = memberPath[index - 1]!;
          const to = memberPath[index]!;
          edgeRequests.set(`${from}\u0000${to}`, { from, to });
        }
      }
    }
    const fileBytes = new Map<string, string>();
    for (const path of pathMembers.keys()) {
      const bytes = await this.#repository.readFile(repository, path);
      if (bytes === null) throw new Error(`${path} does not exist in the exact repository tree`);
      fileBytes.set(path, bytes);
    }
    const edges: CohortSourceGraphEdgeV1[] = [];
    for (const requestEdge of edgeRequests.values()) {
      const relationship = await this.#repository.resolveRelationship(
        repository,
        requestEdge.from,
        requestEdge.to,
      );
      if (relationship === null) {
        throw new Error(
          `${requestEdge.from} -> ${requestEdge.to} is not a repository-derived relationship`,
        );
      }
      edges.push(Object.freeze({ ...requestEdge, relationship }));
    }
    const resolvedMembers: ResolvedCohortMemberV1[] = members.map((member) => {
      const boundaryCandidates = member.boundaryCandidates.map((candidate) => {
        if (candidate.witness.kind === "repository-node") {
          const sourcePath = normalizedRepositoryPath(
            candidate.witness.sourcePath,
            "repository witness source",
          );
          const bytes = fileBytes.get(sourcePath);
          if (bytes === undefined) throw new Error(`${sourcePath} was not inspected`);
          if (candidate.witness.nodeKind === "generated-source") {
            const expected = `generated:${digest(bytes)}`;
            if (!bytes.includes("@generated") || candidate.witness.nodeIdentity !== expected) {
              throw new Error(`${sourcePath} does not derive the named generated source node`);
            }
          } else if (!sourceExportsSymbol(bytes, repositoryNodeSymbol(candidate.witness))) {
            throw new Error(`${sourcePath} does not export the named repository witness`);
          }
        }
        const provenancePath = normalizedRepositoryPath(
          candidate.focusedCommand.provenance.sourceRef,
          `${member.memberRef} command provenance source`,
        );
        const provenanceBytes = fileBytes.get(provenancePath);
        if (provenanceBytes === undefined) {
          throw new Error(`${member.memberRef} command provenance was not inspected`);
        }
        return Object.freeze({
          ...candidate,
          focusedCommand: Object.freeze({
            ...candidate.focusedCommand,
            provenance: Object.freeze({
              sourceRef: provenancePath,
              sourceRevision: digest(provenanceBytes),
            }),
          }),
        });
      });
      return Object.freeze({ ...member, boundaryCandidates: Object.freeze(boundaryCandidates) });
    });
    const sourceGraph = Object.freeze({
      nodes: Object.freeze(
        [...fileBytes.entries()].map(([path, bytes]) =>
          Object.freeze({
            path,
            blobDigest: digest(bytes),
            referencedBy: Object.freeze([...(pathMembers.get(path) ?? [])].sort()),
          }),
        ),
      ),
      edges: Object.freeze(edges),
    });
    const worksetAfter = await this.#workset.snapshot();
    if (canonical(worksetAfter) !== canonical(worksetEpoch)) {
      throw new Error("primary CQ workset changed while producing the cohort observation");
    }
    const activeAfter = readActivePrimaryItems(this.#ledger);
    for (const [ref, expectedRevision] of primaryBindings) {
      const current = await readUniquePrimaryItem(this.#ledger, activeAfter, ref);
      if (itemRevision(ref, current) !== expectedRevision) {
        throw new Error(`${ref} changed while producing the cohort observation`);
      }
    }
    return Object.freeze({
      producer: "cq-primary-ledger-workset-cohort-producer",
      producerRevision: digest({
        version: 2,
        plan: this.#plan,
        workset,
        manifest,
      }),
      workset,
      manifest,
      repository,
      environment: this.#environment,
      sourceGraph,
      members: Object.freeze(resolvedMembers),
      authenticatedBenefitReceipts: Object.freeze([]),
      unavailableFacts: Object.freeze([
        {
          memberRef: null,
          fact: "authenticated-benefit-receipts",
          reason: "no authenticated prior duration/outcome receipt was present in primary CQ state",
        },
      ]),
    });
  }
}

export interface MemberAcceptancePlanV1 {
  readonly kind: "cq-cohort-member-acceptance-plan";
  readonly version: 1;
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly provenance: {
    readonly sourceRef: string;
    readonly sourceRevision: string;
  };
  readonly normalizedCommandDigest: string;
  readonly planDigest: string;
}

export interface CohortCommonBoundaryAtomV1 {
  readonly kind: "cq-cohort-common-boundary-atom";
  readonly version: 1;
  readonly phase: CohortPhaseV1;
  readonly witness: {
    readonly kind: "confirmed-cause" | "repository-node";
    readonly witnessDigest: string;
  };
  readonly sharedRegression: CohortBoundaryIdentityV1;
  readonly canonicalFullGate: CohortBoundaryIdentityV1;
  readonly reviewerClass: CohortBoundaryIdentityV1;
  readonly deploymentClass: CohortBoundaryIdentityV1;
  readonly finalizationClass: CohortBoundaryIdentityV1;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly splitConditions: readonly string[];
  readonly atomDigest: string;
}

export interface MemberCommonBoundaryAttestationV1 {
  readonly kind: "cq-member-common-boundary-attestation";
  readonly version: 1;
  readonly atomDigest: string;
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly applicability:
    | {
        readonly kind: "confirmed-cause";
        readonly receiptDigest: string;
        readonly causeDigest: string;
      }
    | {
        readonly kind: "repository-path";
        readonly nodeIdentity: string;
        readonly memberPath: readonly string[];
      };
  readonly acceptancePlan: MemberAcceptancePlanV1;
  readonly attestationDigest: string;
}

interface CohortMemberObservationBaseV1 {
  readonly memberRef: string;
  readonly memberRevision: string;
  readonly phase: CohortPhaseV1;
  readonly worksetOrder: number;
  readonly ownershipBoundaryDigest: string;
  readonly authorityRef: string;
  readonly authorityRevision: string;
  readonly authorityBoundaryDigest: string;
  readonly dependencyClosure: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly sourceReferences: readonly CohortSourceReferenceV1[];
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly attestations: readonly MemberCommonBoundaryAttestationV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
  readonly memberBindingDigest: string;
}

export interface InvestigationCohortMemberObservationV1 extends CohortMemberObservationBaseV1 {
  readonly phase: "investigation";
  readonly defectRef: string;
  readonly defectRevision: string;
  readonly hypothesisRef: string;
  readonly hypothesisRevision: string;
  readonly hypothesisState: string;
  readonly causeState: "confirmed" | "unconfirmed" | "unavailable";
  readonly confirmedCauseReceiptDigests: readonly string[];
  readonly investigationAuthority: string;
}

export interface ImplementationCohortMemberObservationV1 extends CohortMemberObservationBaseV1 {
  readonly phase: "implementation";
  readonly taskRevision: string;
  readonly goalRef: string;
  readonly finalizedManifestRevision: string;
  readonly implementationAuthority: string;
}

export type CohortMemberObservationV1 =
  | InvestigationCohortMemberObservationV1
  | ImplementationCohortMemberObservationV1;

export interface CohortAdmissionObservationV1 {
  readonly kind: "cq-cohort-admission-observation";
  readonly version: 1;
  readonly producer: string;
  readonly producerRevision: string;
  readonly inputDigest: string;
  readonly observationSetDigest: string;
  readonly workset: CohortWorksetSnapshotV1;
  readonly manifest: CohortManifestSnapshotV1 | null;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly sourceGraphDigest: string;
  readonly atoms: readonly CohortCommonBoundaryAtomV1[];
  readonly members: readonly CohortMemberObservationV1[];
  readonly authenticatedBenefitReceipts: readonly CohortAuthenticatedBenefitReceiptV1[];
  readonly unavailableFacts: readonly CohortUnavailableFactV1[];
  readonly observationDigest: string;
}

function assertBoundaryIdentity(boundary: CohortBoundaryIdentityV1, label: string): void {
  assertNonEmpty(boundary.identity, `${label} identity`);
  assertDigest(boundary.digest, `${label} digest`);
}

function assertRepositoryIdentity(repository: CohortRepositoryIdentityV1): void {
  assertNonEmpty(repository.repositoryId, "repository id");
  assertCommit(repository.headCommit, "repository HEAD");
  if (!/^[0-9a-f]{40,64}$/u.test(repository.treeOid)) {
    throw new Error("repository tree identity must be a lowercase object id");
  }
}

function makeAcceptancePlan(
  member: ResolvedCohortMemberV1,
  command: CohortFocusedCommandInputV1,
): MemberAcceptancePlanV1 {
  if (command.argv.length === 0 || command.argv.some((argument) => argument === "")) {
    throw new Error(`${member.memberRef} focused argv must be non-empty`);
  }
  const cwd = normalizedRepositoryPath(command.cwd, `${member.memberRef} focused cwd`);
  assertNonEmpty(command.provenance.sourceRef, `${member.memberRef} command provenance source`);
  assertNonEmpty(command.provenance.sourceRevision, `${member.memberRef} command provenance revision`);
  const environment = Object.freeze(
    Object.entries(command.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => Object.freeze({ name, value })),
  );
  const normalized = {
    argv: [...command.argv],
    cwd,
    environment,
  };
  const normalizedCommandDigest = digest(normalized);
  const payload = {
    kind: "cq-cohort-member-acceptance-plan" as const,
    version: 1 as const,
    memberRef: member.memberRef,
    memberRevision: member.memberRevision,
    ...normalized,
    provenance: command.provenance,
    normalizedCommandDigest,
  };
  return Object.freeze({ ...payload, planDigest: digest(payload) });
}

function validateSourceGraph(graph: CohortSourceGraphV1): {
  readonly nodeByPath: ReadonlyMap<string, CohortSourceGraphNodeV1>;
  readonly edgeKeys: ReadonlySet<string>;
  readonly edges: readonly CohortSourceGraphEdgeV1[];
  readonly digest: string;
} {
  const nodeByPath = new Map<string, CohortSourceGraphNodeV1>();
  for (const raw of graph.nodes) {
    const path = normalizedRepositoryPath(raw.path, "source graph node path");
    if (nodeByPath.has(path)) throw new Error(`source graph repeats ${path}`);
    assertDigest(raw.blobDigest, `${path} blob digest`);
    const referencedBy = sortedUnique(raw.referencedBy);
    nodeByPath.set(path, Object.freeze({ ...raw, path, referencedBy }));
  }
  const edgeKeys = new Set<string>();
  const edges: CohortSourceGraphEdgeV1[] = [];
  for (const edge of graph.edges) {
    const from = normalizedRepositoryPath(edge.from, "source graph edge source");
    const to = normalizedRepositoryPath(edge.to, "source graph edge target");
    if (!nodeByPath.has(from) || !nodeByPath.has(to)) {
      throw new Error(`source graph edge ${from} -> ${to} escapes the observed graph`);
    }
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) throw new Error(`source graph repeats edge ${from} -> ${to}`);
    edgeKeys.add(key);
    edges.push(Object.freeze({ from, to, relationship: edge.relationship }));
  }
  const boundedRoots = new Set(
    [...nodeByPath.values()].flatMap((node) => node.referencedBy),
  );
  for (const node of nodeByPath.values()) {
    if (node.referencedBy.some((root) => !boundedRoots.has(root))) {
      throw new Error(`${node.path} has an unbounded source reference`);
    }
  }
  const normalized = {
    nodes: [...nodeByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    edges: edges.sort((left, right) =>
      `${left.from}\u0000${left.to}\u0000${left.relationship}`.localeCompare(
        `${right.from}\u0000${right.to}\u0000${right.relationship}`,
      ),
    ),
  };
  return Object.freeze({ nodeByPath, edgeKeys, edges: normalized.edges, digest: digest(normalized) });
}

function witnessForMember(
  member: ResolvedCohortMemberV1,
  witness: CohortWitnessInputV1,
  graph: ReturnType<typeof validateSourceGraph>,
): {
  readonly atomWitness: CohortCommonBoundaryAtomV1["witness"];
  readonly applicability: MemberCommonBoundaryAttestationV1["applicability"];
} {
  if (witness.kind === "confirmed-cause") {
    assertDigest(witness.causeDigest, "confirmed cause digest");
    assertDigest(witness.receiptDigest, "confirmed cause receipt digest");
    if (
      member.phase !== "investigation" ||
      member.causeState !== "confirmed" ||
      !member.confirmedCauseReceiptDigests.includes(witness.receiptDigest)
    ) {
      throw new Error(`${member.memberRef} cannot attest the named confirmed-cause receipt`);
    }
    return Object.freeze({
      atomWitness: Object.freeze({
        kind: "confirmed-cause",
        witnessDigest: digest({
          kind: witness.kind,
          causeDigest: witness.causeDigest,
          receiptDigest: witness.receiptDigest,
        }),
      }),
      applicability: Object.freeze({
        kind: "confirmed-cause",
        receiptDigest: witness.receiptDigest,
        causeDigest: witness.causeDigest,
      }),
    });
  }

  const sourcePath = normalizedRepositoryPath(witness.sourcePath, "repository witness source");
  assertNonEmpty(witness.nodeIdentity, "repository witness node identity");
  if (witness.memberPath.length === 0) {
    throw new Error(`${member.memberRef} repository witness path must be non-empty`);
  }
  const memberPath = witness.memberPath.map((path) =>
    normalizedRepositoryPath(path, `${member.memberRef} repository witness path`),
  );
  if (!member.sourceRefs.includes(memberPath[0] ?? "")) {
    throw new Error(`${member.memberRef} repository witness path does not start at a source reference`);
  }
  if (memberPath.at(-1) !== sourcePath || !graph.nodeByPath.has(sourcePath)) {
    throw new Error(`${member.memberRef} repository witness path does not end at its source node`);
  }
  for (let index = 1; index < memberPath.length; index += 1) {
    const from = memberPath[index - 1];
    const to = memberPath[index];
    if (from === undefined || to === undefined || !graph.edgeKeys.has(`${from}\u0000${to}`)) {
      throw new Error(`${member.memberRef} repository witness path is not repository-derived`);
    }
  }
  const witnessDigest = digest({
    kind: witness.kind,
    nodeKind: witness.nodeKind,
    nodeIdentity: witness.nodeIdentity,
    sourcePath,
    blobDigest: graph.nodeByPath.get(sourcePath)?.blobDigest,
  });
  return Object.freeze({
    atomWitness: Object.freeze({ kind: "repository-node", witnessDigest }),
    applicability: Object.freeze({
      kind: "repository-path",
      nodeIdentity: witness.nodeIdentity,
      memberPath: Object.freeze(memberPath),
    }),
  });
}

function makeAtom(
  phase: CohortPhaseV1,
  candidate: CohortBoundaryCandidateInputV1,
  atomWitness: CohortCommonBoundaryAtomV1["witness"],
  repository: CohortRepositoryIdentityV1,
  environment: CohortEnvironmentIdentityV1,
): CohortCommonBoundaryAtomV1 {
  assertBoundaryIdentity(candidate.sharedRegression, "shared regression");
  assertBoundaryIdentity(candidate.canonicalFullGate, "canonical full gate");
  assertBoundaryIdentity(candidate.reviewerClass, "reviewer class");
  assertBoundaryIdentity(candidate.deploymentClass, "deployment class");
  assertBoundaryIdentity(candidate.finalizationClass, "finalization class");
  const payload = {
    kind: "cq-cohort-common-boundary-atom" as const,
    version: 1 as const,
    phase,
    witness: atomWitness,
    sharedRegression: candidate.sharedRegression,
    canonicalFullGate: candidate.canonicalFullGate,
    reviewerClass: candidate.reviewerClass,
    deploymentClass: candidate.deploymentClass,
    finalizationClass: candidate.finalizationClass,
    repository,
    environment,
    splitConditions: sortedUnique(candidate.splitConditions),
  };
  return Object.freeze({ ...payload, atomDigest: digest(payload) });
}

function makeAttestation(
  member: ResolvedCohortMemberV1,
  atom: CohortCommonBoundaryAtomV1,
  applicability: MemberCommonBoundaryAttestationV1["applicability"],
  acceptancePlan: MemberAcceptancePlanV1,
): MemberCommonBoundaryAttestationV1 {
  const payload = {
    kind: "cq-member-common-boundary-attestation" as const,
    version: 1 as const,
    atomDigest: atom.atomDigest,
    memberRef: member.memberRef,
    memberRevision: member.memberRevision,
    applicability,
    acceptancePlan,
  };
  return Object.freeze({ ...payload, attestationDigest: digest(payload) });
}

function orderedMembers(
  members: readonly ResolvedCohortMemberV1[],
  workset: CohortWorksetSnapshotV1,
): readonly ResolvedCohortMemberV1[] {
  assertUnique(workset.orderedMemberRefs, "workset member refs");
  const order = new Map(workset.orderedMemberRefs.map((memberRef, index) => [memberRef, index]));
  for (const member of members) {
    if (!order.has(member.memberRef)) {
      throw new Error("every cohort member must belong to the exact workset snapshot");
    }
  }
  return Object.freeze(
    [...members].sort((left, right) => {
      const phase = COHORT_PHASE_ORDER_V1.indexOf(left.phase) - COHORT_PHASE_ORDER_V1.indexOf(right.phase);
      if (phase !== 0) return phase;
      const leftOrder = order.get(left.memberRef);
      const rightOrder = order.get(right.memberRef);
      if (leftOrder === undefined || rightOrder === undefined) throw new Error("unreachable workset order");
      return leftOrder - rightOrder || left.memberRef.localeCompare(right.memberRef);
    }),
  );
}

/** Resolve and freeze one bounded, trusted pre-admission observation. */
export async function produceCohortAdmissionObservationV1(
  request: CohortAdmissionObservationRequestV1,
  source: CohortAdmissionObservationSourceV1,
): Promise<CohortAdmissionObservationV1> {
  if (request.memberRefs.length === 0) throw new Error("cohort observation requires members");
  assertUnique(request.memberRefs, "requested cohort member refs");
  const snapshot = await source.resolveExactSnapshot(request);
  assertNonEmpty(snapshot.producer, "cohort observation producer");
  assertNonEmpty(snapshot.producerRevision, "cohort observation producer revision");
  assertRepositoryIdentity(snapshot.repository);
  assertDigest(snapshot.environment.environmentDigest, "environment digest");
  const graph = validateSourceGraph(snapshot.sourceGraph);
  const members = orderedMembers(snapshot.members, snapshot.workset);
  if (canonical(sortedUnique(members.map((member) => member.memberRef))) !== canonical(sortedUnique(request.memberRefs))) {
    throw new Error("resolved cohort members do not exactly match the request");
  }
  if (
    members.some(
      (member) =>
        canonical(member.repository) !== canonical(snapshot.repository) ||
        canonical(member.environment) !== canonical(snapshot.environment),
    )
  ) {
    throw new Error("member repository/environment identity differs from the exact snapshot");
  }
  const memberRefs = new Set(members.map((member) => member.memberRef));
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  for (const node of graph.nodeByPath.values()) {
    if (node.referencedBy.length === 0 || node.referencedBy.some((ref) => !memberRefs.has(ref))) {
      throw new Error(`${node.path} is outside the requested members' bounded source graph`);
    }
  }
  for (const member of members) {
    const reachable = new Set(member.sourceRefs);
    const pending = [...member.sourceRefs];
    while (pending.length > 0) {
      const from = pending.shift()!;
      for (const to of adjacency.get(from) ?? []) {
        if (reachable.has(to)) continue;
        reachable.add(to);
        pending.push(to);
      }
    }
    for (const node of graph.nodeByPath.values()) {
      if (node.referencedBy.includes(member.memberRef) && !reachable.has(node.path)) {
        throw new Error(`${node.path} is not reachable from ${member.memberRef}'s referenced files`);
      }
    }
  }

  const atoms = new Map<string, CohortCommonBoundaryAtomV1>();
  const observedMembers: CohortMemberObservationV1[] = [];
  const worksetOrder = new Map(
    snapshot.workset.orderedMemberRefs.map((memberRef, index) => [memberRef, index]),
  );
  for (const member of members) {
    assertNonEmpty(member.memberRef, "cohort member ref");
    assertNonEmpty(member.memberRevision, `${member.memberRef} revision`);
    assertDigest(member.ownershipBoundaryDigest, `${member.memberRef} ownership boundary`);
    assertDigest(member.authorityBoundaryDigest, `${member.memberRef} authority boundary`);
    assertUnique(member.dependencyClosure, `${member.memberRef} dependency closure`);
    assertUnique(member.sourceRefs, `${member.memberRef} source refs`);
    for (const sourceRef of member.sourceRefs) {
      const path = normalizedRepositoryPath(sourceRef, `${member.memberRef} source ref`);
      if (!graph.nodeByPath.has(path)) throw new Error(`${member.memberRef} source ${path} was not inspected`);
    }
    if (
      member.phase === "implementation" &&
      (snapshot.manifest === null ||
        snapshot.manifest.manifestRevision !== member.finalizedManifestRevision ||
        !snapshot.manifest.memberRefs.includes(member.memberRef))
    ) {
      throw new Error(`${member.memberRef} is not in the exact finalized manifest snapshot`);
    }
    const attestations = member.boundaryCandidates.map((candidate) => {
      const witness = witnessForMember(member, candidate.witness, graph);
      const atom = makeAtom(
        member.phase,
        candidate,
        witness.atomWitness,
        snapshot.repository,
        snapshot.environment,
      );
      const prior = atoms.get(atom.atomDigest);
      if (prior !== undefined && canonical(prior) !== canonical(atom)) {
        throw new Error(`common atom digest collision for ${atom.atomDigest}`);
      }
      atoms.set(atom.atomDigest, atom);
      return makeAttestation(
        member,
        atom,
        witness.applicability,
        makeAcceptancePlan(member, candidate.focusedCommand),
      );
    });
    const common = {
      memberRef: member.memberRef,
      memberRevision: member.memberRevision,
      phase: member.phase,
      worksetOrder: worksetOrder.get(member.memberRef) ?? -1,
      ownershipBoundaryDigest: member.ownershipBoundaryDigest,
      authorityRef: member.authorityRef,
      authorityRevision: member.authorityRevision,
      authorityBoundaryDigest: member.authorityBoundaryDigest,
      dependencyClosure: Object.freeze([...member.dependencyClosure].sort()),
      sourceRefs: Object.freeze([...member.sourceRefs].sort()),
      sourceReferences: Object.freeze([...member.sourceReferences].sort(sourceReferenceOrder)),
      repository: member.repository,
      environment: member.environment,
      attestations: Object.freeze(
        [...attestations].sort((left, right) => left.atomDigest.localeCompare(right.atomDigest)),
      ),
      unavailableFacts: Object.freeze([...member.unavailableFacts]),
    };
    const memberPayload =
      member.phase === "investigation"
        ? {
            ...common,
            phase: "investigation" as const,
            defectRef: member.defectRef,
            defectRevision: member.defectRevision,
            hypothesisRef: member.hypothesisRef,
            hypothesisRevision: member.hypothesisRevision,
            hypothesisState: member.hypothesisState,
            causeState: member.causeState,
            confirmedCauseReceiptDigests: Object.freeze(
              [...member.confirmedCauseReceiptDigests].sort(),
            ),
            investigationAuthority: member.investigationAuthority,
          }
        : {
            ...common,
            phase: "implementation" as const,
            taskRevision: member.taskRevision,
            goalRef: member.goalRef,
            finalizedManifestRevision: member.finalizedManifestRevision,
            implementationAuthority: member.implementationAuthority,
          };
    observedMembers.push(
      Object.freeze({ ...memberPayload, memberBindingDigest: digest(memberPayload) }),
    );
  }

  const inputDigest = digest({ memberRefs: [...request.memberRefs].sort() });
  const observationSetDigest = digest(
    observedMembers.map((member) => ({
      memberRef: member.memberRef,
      memberRevision: member.memberRevision,
      memberBindingDigest: member.memberBindingDigest,
    })),
  );
  const payload = {
    kind: "cq-cohort-admission-observation" as const,
    version: 1 as const,
    producer: snapshot.producer,
    producerRevision: snapshot.producerRevision,
    inputDigest,
    observationSetDigest,
    workset: snapshot.workset,
    manifest: snapshot.manifest,
    repository: snapshot.repository,
    environment: snapshot.environment,
    sourceGraphDigest: graph.digest,
    atoms: Object.freeze([...atoms.values()].sort((left, right) => left.atomDigest.localeCompare(right.atomDigest))),
    members: Object.freeze(observedMembers),
    authenticatedBenefitReceipts: Object.freeze([...snapshot.authenticatedBenefitReceipts]),
    unavailableFacts: Object.freeze([...snapshot.unavailableFacts]),
  };
  return Object.freeze({ ...payload, observationDigest: digest(payload) });
}

export type CohortObservationInvalidationV1 =
  | "workset"
  | "phase"
  | "revision"
  | "manifest"
  | "ownership-or-manifest"
  | "source-or-tree"
  | "dependency-graph"
  | "command"
  | "environment"
  | "reviewer"
  | "deployment"
  | "finalization"
  | "cause-or-witness"
  | "authority"
  | "split-condition"
  | "availability";

/** Compare two freshly produced observations without treating their prose as authority. */
export function cohortObservationInvalidationsV1(
  prior: CohortAdmissionObservationV1,
  current: CohortAdmissionObservationV1,
): readonly CohortObservationInvalidationV1[] {
  if (prior.observationDigest === current.observationDigest) return Object.freeze([]);
  const reasons = new Set<CohortObservationInvalidationV1>();
  if (canonical(prior.workset) !== canonical(current.workset)) reasons.add("workset");
  if (canonical(prior.manifest) !== canonical(current.manifest)) reasons.add("manifest");
  if (
    canonical(prior.repository) !== canonical(current.repository) ||
    prior.sourceGraphDigest !== current.sourceGraphDigest
  ) {
    reasons.add("source-or-tree");
  }
  if (canonical(prior.environment) !== canonical(current.environment)) reasons.add("environment");
  if (
    prior.producer !== current.producer ||
    prior.producerRevision !== current.producerRevision
  ) {
    reasons.add("revision");
  }
  const priorMembers = new Map(prior.members.map((member) => [member.memberRef, member]));
  for (const member of current.members) {
    const old = priorMembers.get(member.memberRef);
    if (old === undefined || old.phase !== member.phase) reasons.add("phase");
    if (
      old === undefined ||
      old.memberRevision !== member.memberRevision ||
      (old.phase === "investigation" &&
        member.phase === "investigation" &&
        (old.defectRevision !== member.defectRevision ||
          old.hypothesisRevision !== member.hypothesisRevision)) ||
      (old.phase === "implementation" &&
        member.phase === "implementation" &&
        old.taskRevision !== member.taskRevision)
    ) {
      reasons.add("revision");
    }
    if (old === undefined || old.ownershipBoundaryDigest !== member.ownershipBoundaryDigest) {
      reasons.add("ownership-or-manifest");
    }
    if (old === undefined || canonical(old.dependencyClosure) !== canonical(member.dependencyClosure)) {
      reasons.add("dependency-graph");
    }
    if (
      old === undefined ||
      canonical(old.sourceReferences) !== canonical(member.sourceReferences)
    ) {
      reasons.add("source-or-tree");
    }
    if (
      old === undefined ||
      old.authorityRef !== member.authorityRef ||
      old.authorityRevision !== member.authorityRevision ||
      old.authorityBoundaryDigest !== member.authorityBoundaryDigest
    ) {
      reasons.add("authority");
    }
    const oldAttestations = old?.attestations ?? [];
    if (
      canonical(oldAttestations.map((attestation) => attestation.acceptancePlan)) !==
      canonical(member.attestations.map((attestation) => attestation.acceptancePlan))
    ) {
      reasons.add("command");
    }
    if (
      old === undefined ||
      canonical(old.unavailableFacts) !== canonical(member.unavailableFacts)
    ) {
      reasons.add("availability");
    }
    const oldAtoms = oldAttestations.map((attestation) =>
      prior.atoms.find((atom) => atom.atomDigest === attestation.atomDigest),
    );
    const currentAtoms = member.attestations.map((attestation) =>
      current.atoms.find((atom) => atom.atomDigest === attestation.atomDigest),
    );
    const projectionChanged = (
      project: (atom: CohortCommonBoundaryAtomV1) => unknown,
    ): boolean =>
      canonical(oldAtoms.filter((atom): atom is CohortCommonBoundaryAtomV1 => atom !== undefined).map(project)) !==
      canonical(currentAtoms.filter((atom): atom is CohortCommonBoundaryAtomV1 => atom !== undefined).map(project));
    if (projectionChanged((atom) => atom.reviewerClass)) reasons.add("reviewer");
    if (
      projectionChanged((atom) => ({
        sharedRegression: atom.sharedRegression,
        canonicalFullGate: atom.canonicalFullGate,
      }))
    ) {
      reasons.add("command");
    }
    if (projectionChanged((atom) => atom.deploymentClass)) reasons.add("deployment");
    if (projectionChanged((atom) => atom.finalizationClass)) reasons.add("finalization");
    if (projectionChanged((atom) => atom.witness)) reasons.add("cause-or-witness");
    if (projectionChanged((atom) => atom.splitConditions)) reasons.add("split-condition");
  }
  return Object.freeze(
    [...reasons].sort((left, right) => left.localeCompare(right)),
  );
}

export interface CohortAcceptanceMatrixV1 {
  readonly kind: "cq-cohort-acceptance-matrix";
  readonly version: 1;
  readonly atomDigest: string;
  readonly members: readonly {
    readonly memberRef: string;
    readonly memberRevision: string;
    readonly focusedPlanDigest: string;
  }[];
  readonly normalizedCommandClasses: readonly {
    readonly normalizedCommandDigest: string;
    readonly memberRefs: readonly string[];
  }[];
  readonly sharedRegression: CohortBoundaryIdentityV1;
  readonly canonicalFullGate: CohortBoundaryIdentityV1;
  readonly matrixDigest: string;
}

export interface CohortExclusionV1 {
  readonly memberRef: string;
  readonly reason: CohortExclusionReasonV1;
  readonly againstMemberRef: string;
}

export interface CohortDecisionV1 {
  readonly kind: "cq-cohort-decision";
  readonly version: 1;
  readonly producer: string;
  readonly producerRevision: string;
  readonly observationSetDigest: string;
  readonly worksetRevision: string;
  readonly manifestRevision: string | null;
  readonly repository: CohortRepositoryIdentityV1;
  readonly environment: CohortEnvironmentIdentityV1;
  readonly inputDigest: string;
  readonly selectedAtomDigest: string;
  readonly matrix: CohortAcceptanceMatrixV1;
  readonly includedMemberRefs: readonly string[];
  readonly excluded: readonly CohortExclusionV1[];
  readonly memberProofs: readonly {
    readonly memberRef: string;
    readonly attestationDigest: string;
    readonly applicability: MemberCommonBoundaryAttestationV1["applicability"];
    readonly acceptancePlanDigest: string;
  }[];
  readonly splitConditions: readonly string[];
  readonly benefit: {
    readonly basis: "eliminate-identical-gate-review-deployment";
    readonly receipts: readonly CohortAuthenticatedBenefitReceiptV1[];
    readonly unknownBoundaryDigests: readonly string[];
  };
  readonly decisionDigest: string;
}

function atomByDigest(
  observation: CohortAdmissionObservationV1,
): ReadonlyMap<string, CohortCommonBoundaryAtomV1> {
  return new Map(observation.atoms.map((atom) => [atom.atomDigest, atom]));
}

function atomSet(member: CohortMemberObservationV1): Set<string> {
  return new Set(member.attestations.map((attestation) => attestation.atomDigest));
}

type Projection =
  | "witness"
  | "validation"
  | "reviewer"
  | "deployment"
  | "finalization";

function projectionSet(
  member: CohortMemberObservationV1,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
  projection: Projection,
): Set<string> {
  return new Set(
    member.attestations.map((attestation) => {
      const atom = atoms.get(attestation.atomDigest);
      if (atom === undefined) throw new Error(`missing common atom ${attestation.atomDigest}`);
      switch (projection) {
        case "witness":
          return atom.witness.witnessDigest;
        case "validation":
          return digest({
            sharedRegression: atom.sharedRegression,
            canonicalFullGate: atom.canonicalFullGate,
          });
        case "reviewer":
          return atom.reviewerClass.digest;
        case "deployment":
          return atom.deploymentClass.digest;
        case "finalization":
          return atom.finalizationClass.digest;
      }
    }),
  );
}

const PROJECTION_EXCLUSION: Readonly<Record<Projection, CohortExclusionReasonV1>> = {
  witness: "cohort-witness-empty",
  validation: "validation-boundary-empty",
  reviewer: "reviewer-boundary-empty",
  deployment: "deployment-boundary-empty",
  finalization: "finalization-boundary-empty",
};

function pairExclusions(
  included: CohortMemberObservationV1,
  candidate: CohortMemberObservationV1,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
): readonly CohortExclusionReasonV1[] {
  const reasons: CohortExclusionReasonV1[] = [];
  const admissionBlockingUnavailableFact = (member: CohortMemberObservationV1): boolean => {
    const hasRepositoryAttestation = member.attestations.some(
      ({ applicability }) => applicability.kind === "repository-path",
    );
    return member.unavailableFacts.some(
      ({ fact }) => fact !== "confirmed-cause" || !hasRepositoryAttestation,
    );
  };
  if (
    admissionBlockingUnavailableFact(included) ||
    admissionBlockingUnavailableFact(candidate)
  ) {
    reasons.push("stale-binding");
  }
  if (included.phase !== candidate.phase) reasons.push("phase-mismatch");
  if (included.ownershipBoundaryDigest !== candidate.ownershipBoundaryDigest) {
    reasons.push("ownership-or-manifest");
  }
  if (
    included.dependencyClosure.includes(candidate.memberRef) ||
    candidate.dependencyClosure.includes(included.memberRef)
  ) {
    reasons.push("dependency");
  }
  if (included.authorityBoundaryDigest !== candidate.authorityBoundaryDigest) {
    reasons.push("authority");
  }
  if (
    canonical(included.repository) !== canonical(candidate.repository) ||
    canonical(included.environment) !== canonical(candidate.environment)
  ) {
    reasons.push("repository-or-environment");
  }
  for (const projection of [
    "witness",
    "validation",
    "reviewer",
    "deployment",
    "finalization",
  ] as const) {
    if (
      intersection(
        projectionSet(included, atoms, projection),
        projectionSet(candidate, atoms, projection),
      ).size === 0
    ) {
      reasons.push(PROJECTION_EXCLUSION[projection]);
    }
  }
  if (intersection(atomSet(included), atomSet(candidate)).size === 0) {
    reasons.push("eligibility-tuple-empty");
  }
  return Object.freeze(reasons);
}

function firstExclusion(
  included: readonly CohortMemberObservationV1[],
  candidate: CohortMemberObservationV1,
  cumulativeAtoms: ReadonlySet<string>,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
): CohortExclusionV1 | null {
  const failures: { reason: CohortExclusionReasonV1; against: CohortMemberObservationV1 }[] = [];
  for (const member of included) {
    for (const reason of pairExclusions(member, candidate, atoms)) {
      failures.push({ reason, against: member });
    }
  }
  const cumulativeProjectionEmpty = (projection: Projection): boolean => {
    let surviving: Set<string> | null = null;
    for (const member of [...included, candidate]) {
      const memberProjection = projectionSet(member, atoms, projection);
      surviving = surviving === null ? memberProjection : intersection(surviving, memberProjection);
    }
    return surviving?.size === 0;
  };
  for (const projection of [
    "witness",
    "validation",
    "reviewer",
    "deployment",
    "finalization",
  ] as const) {
    if (cumulativeProjectionEmpty(projection)) {
      failures.push({ reason: PROJECTION_EXCLUSION[projection], against: included[0]! });
    }
  }
  if (intersection(cumulativeAtoms, atomSet(candidate)).size === 0) {
    failures.push({ reason: "eligibility-tuple-empty", against: included[0]! });
  }
  if (failures.length === 0) return null;
  const includedOrder = new Map(included.map((member, index) => [member.memberRef, index]));
  failures.sort((left, right) => {
    const priority =
      COHORT_EXCLUSION_PRIORITY_V1.indexOf(left.reason) -
      COHORT_EXCLUSION_PRIORITY_V1.indexOf(right.reason);
    return (
      priority ||
      (includedOrder.get(left.against.memberRef) ?? Number.MAX_SAFE_INTEGER) -
        (includedOrder.get(right.against.memberRef) ?? Number.MAX_SAFE_INTEGER)
    );
  });
  const first = failures[0]!;
  return Object.freeze({
    memberRef: candidate.memberRef,
    reason: first.reason,
    againstMemberRef: first.against.memberRef,
  });
}

function freezeMatrix(
  members: readonly CohortMemberObservationV1[],
  atom: CohortCommonBoundaryAtomV1,
): CohortAcceptanceMatrixV1 {
  const selected = members.map((member) => {
    const matches = member.attestations.filter(
      (attestation) => attestation.atomDigest === atom.atomDigest,
    );
    if (matches.length !== 1) {
      throw new Error(`${member.memberRef} must have one attestation for the selected atom`);
    }
    return { member, attestation: matches[0]! };
  });
  const commandClasses = new Map<string, string[]>();
  for (const entry of selected) {
    const key = entry.attestation.acceptancePlan.normalizedCommandDigest;
    const refs = commandClasses.get(key) ?? [];
    refs.push(entry.member.memberRef);
    commandClasses.set(key, refs);
  }
  const payload = {
    kind: "cq-cohort-acceptance-matrix" as const,
    version: 1 as const,
    atomDigest: atom.atomDigest,
    members: Object.freeze(
      selected.map(({ member, attestation }) =>
        Object.freeze({
          memberRef: member.memberRef,
          memberRevision: member.memberRevision,
          focusedPlanDigest: attestation.acceptancePlan.planDigest,
        }),
      ),
    ),
    normalizedCommandClasses: Object.freeze(
      [...commandClasses.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([normalizedCommandDigest, memberRefs]) =>
          Object.freeze({
            normalizedCommandDigest,
            memberRefs: Object.freeze(memberRefs.sort((left, right) => left.localeCompare(right))),
          }),
        ),
    ),
    sharedRegression: atom.sharedRegression,
    canonicalFullGate: atom.canonicalFullGate,
  };
  return Object.freeze({ ...payload, matrixDigest: digest(payload) });
}

function makeDecision(
  observation: CohortAdmissionObservationV1,
  included: readonly CohortMemberObservationV1[],
  excluded: readonly CohortExclusionV1[],
  survivingAtoms: ReadonlySet<string>,
  atoms: ReadonlyMap<string, CohortCommonBoundaryAtomV1>,
): CohortDecisionV1 {
  const selectedAtomDigest = [...survivingAtoms].sort((left, right) => left.localeCompare(right))[0];
  if (selectedAtomDigest === undefined) throw new Error("cohort anchor has no complete common atom");
  const atom = atoms.get(selectedAtomDigest);
  if (atom === undefined) throw new Error(`missing selected common atom ${selectedAtomDigest}`);
  const matrix = freezeMatrix(included, atom);
  const memberProofs = included.map((member) => {
    const attestation = member.attestations.find(
      (candidate) => candidate.atomDigest === selectedAtomDigest,
    );
    if (attestation === undefined) throw new Error(`${member.memberRef} lacks selected atom proof`);
    return Object.freeze({
      memberRef: member.memberRef,
      attestationDigest: attestation.attestationDigest,
      applicability: attestation.applicability,
      acceptancePlanDigest: attestation.acceptancePlan.planDigest,
    });
  });
  const boundaryDigests = [
    atom.canonicalFullGate.digest,
    atom.reviewerClass.digest,
    atom.deploymentClass.digest,
  ];
  const receipts = observation.authenticatedBenefitReceipts.filter((receipt) =>
    boundaryDigests.includes(receipt.boundaryDigest),
  );
  const receiptBoundaries = new Set(receipts.map((receipt) => receipt.boundaryDigest));
  const payload = {
    kind: "cq-cohort-decision" as const,
    version: 1 as const,
    producer: observation.producer,
    producerRevision: observation.producerRevision,
    observationSetDigest: observation.observationSetDigest,
    worksetRevision: observation.workset.worksetRevision,
    manifestRevision: observation.manifest?.manifestRevision ?? null,
    repository: observation.repository,
    environment: observation.environment,
    inputDigest: observation.inputDigest,
    selectedAtomDigest,
    matrix,
    includedMemberRefs: Object.freeze(included.map((member) => member.memberRef)),
    excluded: Object.freeze([...excluded]),
    memberProofs: Object.freeze(memberProofs),
    splitConditions: atom.splitConditions,
    benefit: Object.freeze({
      basis: "eliminate-identical-gate-review-deployment" as const,
      receipts: Object.freeze(receipts),
      unknownBoundaryDigests: sortedUnique(
        boundaryDigests.filter((boundaryDigest) => !receiptBoundaries.has(boundaryDigest)),
      ),
    }),
  };
  return Object.freeze({ ...payload, decisionDigest: digest(payload) });
}

/** Deterministically assign every observed member to exactly one cohort. */
export function constructCohortDecisionsV1(
  observation: CohortAdmissionObservationV1,
): readonly CohortDecisionV1[] {
  const atoms = atomByDigest(observation);
  const remaining = [...observation.members];
  const decisions: CohortDecisionV1[] = [];
  while (remaining.length > 0) {
    const anchor = remaining.shift()!;
    const included = [anchor];
    let survivingAtoms = atomSet(anchor);
    const excluded: CohortExclusionV1[] = [];
    const admittedRefs = new Set([anchor.memberRef]);
    for (const candidate of remaining) {
      const failure = firstExclusion(included, candidate, survivingAtoms, atoms);
      if (failure !== null) {
        excluded.push(failure);
        continue;
      }
      survivingAtoms = intersection(survivingAtoms, atomSet(candidate));
      included.push(candidate);
      admittedRefs.add(candidate.memberRef);
    }
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (admittedRefs.has(remaining[index]!.memberRef)) remaining.splice(index, 1);
    }
    decisions.push(makeDecision(observation, included, excluded, survivingAtoms, atoms));
  }
  return Object.freeze(decisions);
}

function definitionSemanticPayload(
  cohortId: string,
  decision: CohortDecisionV1,
  observation: CohortAdmissionObservationV1,
): Omit<
  CohortDefinitionIdentityV1,
  "kind" | "version" | "definitionGeneration" | "semanticDigest" | "definitionDigest"
> {
  const byRef = new Map(observation.members.map((member) => [member.memberRef, member]));
  const members = decision.includedMemberRefs.map((memberRef) => {
    const member = byRef.get(memberRef);
    if (member === undefined) throw new Error(`definition member ${memberRef} was not observed`);
    return Object.freeze({
      memberRef,
      memberRevision: member.memberRevision,
      authorityRef: member.authorityRef,
      authorityRevision: member.authorityRevision,
    });
  });
  const first = byRef.get(decision.includedMemberRefs[0] ?? "");
  if (first === undefined) throw new Error("cohort definition requires members");
  return Object.freeze({
    cohortId,
    phase: first.phase,
    members: Object.freeze(members),
    selectedAtomDigest: decision.selectedAtomDigest,
    acceptanceMatrixDigest: decision.matrix.matrixDigest,
    repository: decision.repository,
    environment: decision.environment,
    splitConditions: decision.splitConditions,
  });
}

export function createCohortDefinitionIdentityV1(input: {
  readonly cohortId: string;
  readonly decision: CohortDecisionV1;
  readonly observation: CohortAdmissionObservationV1;
  readonly prior: CohortDefinitionIdentityV1 | null;
}): CohortDefinitionIdentityV1 {
  assertNonEmpty(input.cohortId, "cohort id");
  const semantic = definitionSemanticPayload(input.cohortId, input.decision, input.observation);
  const semanticDigest = digest(semantic);
  if (input.prior !== null && input.prior.semanticDigest === semanticDigest) return input.prior;
  const definitionGeneration = input.prior === null ? 1 : input.prior.definitionGeneration + 1;
  const payload = {
    kind: "cq-cohort-definition-identity" as const,
    version: 1 as const,
    definitionGeneration,
    ...semantic,
    semanticDigest,
  };
  return Object.freeze({ ...payload, definitionDigest: digest(payload) });
}

export type CohortPreparedDispatchIdentityV1 = {
  readonly attestationId: string;
  readonly generation: number;
  readonly branch: string;
  readonly startingCommit: string;
} & ({ readonly taskId: string; readonly cohort?: never } |
  { readonly cohort: CohortEffectEnvelopeV1; readonly taskId?: never });

export function resolveCohortDefinitionObservationV1(input: {
  readonly definition: CohortDefinitionIdentityV1;
  readonly decisions: readonly CohortDecisionV1[];
  readonly observations: readonly CohortAdmissionObservationV1[];
}): CohortAdmissionObservationV1 {
  for (const decision of input.decisions) {
    if (decision.matrix.matrixDigest !== input.definition.acceptanceMatrixDigest) continue;
    const observation = input.observations.find((value) => value.observationSetDigest === decision.observationSetDigest);
    if (observation === undefined) continue;
    const reconstructed = createCohortDefinitionIdentityV1({ cohortId: input.definition.cohortId,
      decision, observation, prior: null });
    if (reconstructed.semanticDigest === input.definition.semanticDigest) return observation;
  }
  throw new Error("cohort definition lacks its exact producing observation");
}

interface CohortCandidateAttemptBaseV1 {
  readonly kind: "cq-cohort-candidate-attempt";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly intent: CohortCandidateIntentV1;
  readonly preparedDispatch: CohortPreparedDispatchIdentityV1;
  readonly pendingAttemptDigest: string;
  readonly candidateAttemptDigest: string;
}

export interface PendingCohortCandidateAttemptV1 extends CohortCandidateAttemptBaseV1 {
  readonly state: "pending";
}

export interface StagedCohortCandidateAttemptV1 extends CohortCandidateAttemptBaseV1 {
  readonly state: "staged";
  readonly g213: {
    readonly partitionKey: string;
    readonly enrollmentId: string;
    readonly attemptId: string;
    readonly observedBaseCommit: string;
    readonly resultCommit: string;
    readonly resultTree: string;
    readonly gitReceiptLineageDigest: string;
    readonly repositoryDiffDigest: string;
    readonly qualificationDigest: string;
    readonly qualifiedOutputDigest: string;
    readonly guardedRebase?: CohortGuardedCandidateBridgeV1;
  };
}

export interface CohortGuardedCandidateBridgeV1 {
  readonly transition: DispatchCohortRebaseTransition;
  readonly bridge: Extract<DispatchGuardedRebaseBridge, { readonly version: 2 }>;
}

export function assertCohortGuardedCandidateBridgeV1(value: CohortGuardedCandidateBridgeV1,
  prepared: CohortPreparedDispatchIdentityV1, baseCommit: string): void {
  assertDispatchGuardedRebaseBridge(value.bridge);
  const { transition, bridge } = value;
  if (Object.keys(value).sort().join(",") !== "bridge,transition" || bridge.version !== 2 || bridge.cohort.state !== "sealed" ||
      !cohortRebaseTransitionMatches(transition.sourceBinding, { ...transition.successorBinding,
        guardedRebaseBridge: bridge, cohortRebaseTransition: transition }, transition.source) ||
      !implementationQueueSubjectsMatch(prepared, transition.successorBinding, true) ||
      prepared.attestationId !== transition.source.attestationId || prepared.generation !== transition.source.generation + 1 ||
      prepared.branch !== transition.successorBinding.branch || prepared.startingCommit !== bridge.rebasedStartCommit || baseCommit !== bridge.ontoCommit) {
    throw new Error("cohort guarded candidate bridge differs from the exact prepared successor");
  }
}

export type CohortCandidateAttemptV1 =
  | PendingCohortCandidateAttemptV1
  | StagedCohortCandidateAttemptV1;

class AuthenticatedG213CandidateAttemptV1 implements StagedCohortCandidateAttemptV1 {
  readonly kind: "cq-cohort-candidate-attempt";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly intent: CohortCandidateIntentV1;
  readonly preparedDispatch: CohortPreparedDispatchIdentityV1;
  readonly state: "staged";
  readonly pendingAttemptDigest: string;
  readonly candidateAttemptDigest: string;
  readonly g213: StagedCohortCandidateAttemptV1["g213"];
  readonly #registry: WeakSet<StagedCohortCandidateAttemptV1>;

  constructor(
    attempt: StagedCohortCandidateAttemptV1,
    registry: WeakSet<StagedCohortCandidateAttemptV1>,
  ) {
    this.kind = attempt.kind;
    this.version = attempt.version;
    this.definitionDigest = attempt.definitionDigest;
    this.intent = attempt.intent;
    this.preparedDispatch = attempt.preparedDispatch;
    this.state = attempt.state;
    this.pendingAttemptDigest = attempt.pendingAttemptDigest;
    this.candidateAttemptDigest = attempt.candidateAttemptDigest;
    this.g213 = attempt.g213;
    this.#registry = registry;
    registry.add(this);
    Object.freeze(this);
  }

  isAuthenticated(): boolean {
    return this.#registry.has(this);
  }
}

export function createPendingCohortCandidateAttemptV1(
  definition: CohortDefinitionIdentityV1,
  preparedDispatch: CohortPreparedDispatchIdentityV1,
  intent: CohortCandidateIntentV1,
): PendingCohortCandidateAttemptV1 {
  assertCohortCandidateIntentV1(intent, definition);
  if (!implementationQueueSubjectsMatch(preparedDispatch, preparedDispatch, false)) {
    throw new Error("prepared dispatch requires one closed task or cohort identity");
  }
  if (preparedDispatch.cohort !== undefined &&
      (preparedDispatch.cohort.state !== "pre-seal" ||
       canonical(preparedDispatch.cohort.definition) !== canonical(definition) ||
       canonical(preparedDispatch.cohort.intent) !== canonical(intent))) {
    throw new Error("prepared cohort dispatch differs from the exact definition or candidate intent");
  }
  assertCommit(preparedDispatch.startingCommit, "prepared dispatch starting commit");
  if (!Number.isInteger(preparedDispatch.generation) || preparedDispatch.generation < 1) {
    throw new Error("prepared dispatch generation must be a positive integer");
  }
  const base = {
    kind: "cq-cohort-candidate-attempt" as const,
    version: 1 as const,
    definitionDigest: definition.definitionDigest,
    intent,
    preparedDispatch,
  };
  const pendingAttemptDigest = digest(base);
  const payload = { ...base, state: "pending" as const, pendingAttemptDigest };
  return Object.freeze({ ...payload, candidateAttemptDigest: digest(payload) });
}

export interface G213QualifiedCandidateRowV1 {
  readonly preparedDispatch: CohortPreparedDispatchIdentityV1;
  readonly queue: ImplementationQueueControl;
  readonly repositoryDiff: readonly CohortWholeDiffEntryV1[];
  readonly guardedRebase?: CohortGuardedCandidateBridgeV1;
}

export interface G213CandidateAttemptBindingV1 {
  readonly row: G213QualifiedCandidateRowV1;
}

function stageAuthenticatedCohortCandidateAttemptV1(
  pending: PendingCohortCandidateAttemptV1,
  binding: G213CandidateAttemptBindingV1,
  registry: WeakSet<StagedCohortCandidateAttemptV1>,
): StagedCohortCandidateAttemptV1 {
  if (canonical(pending.preparedDispatch) !== canonical(binding.row.preparedDispatch)) {
    throw new Error("G213 candidate binding differs from the actual G213 row");
  }
  const queue = binding.row.queue;
  if (
    queue.state !== "qualified" ||
    queue.qualification === undefined ||
    !implementationQueueSubjectsMatch(queue.attempt, pending.preparedDispatch, false) ||
    !implementationQueueAuthoritiesMatch(queue.enrollment, queue.attempt, false) ||
    queue.partition.partitionKey !== queue.enrollment.partitionKey ||
    queue.partition.partitionKey !== queue.qualification.partitionKey ||
    queue.enrollment.enrollmentId !== queue.qualification.enrollmentId ||
    queue.attempt.attemptId !== queue.qualification.attemptId ||
    queue.partition.repositoryId !== queue.attempt.repositoryId
  ) {
    throw new Error("cohort binding requires G213's exact qualified candidate attempt");
  }
  const repositoryDiff = normalizeWholeDiff(binding.row.repositoryDiff);
  const g213 = Object.freeze({
    partitionKey: queue.partition.partitionKey,
    enrollmentId: queue.enrollment.enrollmentId,
    attemptId: queue.attempt.attemptId,
    observedBaseCommit: queue.attempt.observedBaseCommit,
    resultCommit: queue.attempt.resultCommit,
    resultTree: queue.attempt.resultTree,
    gitReceiptLineageDigest: queue.attempt.gitReceiptLineageDigest,
    repositoryDiffDigest: digest(repositoryDiff),
    qualificationDigest: queue.qualification.qualificationDigest,
    qualifiedOutputDigest: queue.qualification.outputDigest,
    ...(binding.row.guardedRebase === undefined ? {} : { guardedRebase: binding.row.guardedRebase }),
  });
  const payload = {
    kind: pending.kind,
    version: pending.version,
    definitionDigest: pending.definitionDigest,
    intent: pending.intent,
    preparedDispatch: pending.preparedDispatch,
    state: "staged" as const,
    pendingAttemptDigest: pending.pendingAttemptDigest,
    g213,
  };
  return new AuthenticatedG213CandidateAttemptV1(
    Object.freeze({ ...payload, candidateAttemptDigest: digest(payload) }),
    registry,
  );
}

export interface CohortWholeDiffEntryV1 {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly blobDigest: string;
}

function normalizeWholeDiff(
  entries: readonly CohortWholeDiffEntryV1[],
): readonly CohortWholeDiffEntryV1[] {
  const wholeDiff = entries
    .map((entry) => {
      const path = normalizedRepositoryPath(entry.path, "candidate whole-diff path");
      assertDigest(entry.blobDigest, `${path} whole-diff blob digest`);
      return Object.freeze({ ...entry, path });
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  assertUnique(wholeDiff.map((entry) => entry.path), "candidate whole-diff paths");
  return Object.freeze(wholeDiff);
}

export interface G213CandidateRepositoryV1 {
  resolveWholeDiff(input: {
    readonly repositoryId: string;
    readonly baseCommit: string;
    readonly resultCommit: string;
    readonly resultTree: string;
  }): Promise<readonly CohortWholeDiffEntryV1[]>;
}

/** Resolve the result-side identity of every changed path from one local Git object graph. */
export class GitG213CandidateRepositoryV1 implements G213CandidateRepositoryV1 {
  readonly #repositoryRoot: string;
  readonly #repositoryId: string;
  readonly #git: DispatchBaseGitRunner;

  constructor(input: {
    readonly repositoryRoot: string;
    readonly repositoryId: string;
    readonly git?: DispatchBaseGitRunner;
  }) {
    assertNonEmpty(input.repositoryRoot, "G213 repository root");
    assertNonEmpty(input.repositoryId, "G213 repository id");
    this.#repositoryRoot = input.repositoryRoot;
    this.#repositoryId = input.repositoryId;
    this.#git = input.git ?? nodeDispatchBaseGitRunner;
  }

  async #required(args: readonly string[], label: string): Promise<string> {
    const result = await this.#git(this.#repositoryRoot, args);
    if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async resolveWholeDiff(input: {
    readonly repositoryId: string;
    readonly baseCommit: string;
    readonly resultCommit: string;
    readonly resultTree: string;
  }): Promise<readonly CohortWholeDiffEntryV1[]> {
    if (input.repositoryId !== this.#repositoryId) {
      throw new Error("G213 candidate names another repository");
    }
    assertCommit(input.baseCommit, "G213 candidate base commit");
    assertCommit(input.resultCommit, "G213 candidate result commit");
    const [baseType, resultType, resultTree] = await Promise.all([
      this.#required(["cat-file", "-t", input.baseCommit], "G213 base lookup"),
      this.#required(["cat-file", "-t", input.resultCommit], "G213 result lookup"),
      this.#required(["rev-parse", "--verify", `${input.resultCommit}^{tree}`], "G213 tree lookup"),
    ]);
    if (baseType.trim() !== "commit" || resultType.trim() !== "commit") {
      throw new Error("G213 candidate base and result must be commits");
    }
    if (resultTree.trim() !== input.resultTree) {
      throw new Error("G213 candidate result tree differs from the repository");
    }
    const rawPaths = await this.#required(
      ["diff", "--name-only", "-z", "--no-renames", input.baseCommit, input.resultCommit],
      "G213 whole-diff lookup",
    );
    const paths = rawPaths
      .split("\u0000")
      .filter((path) => path !== "")
      .map((path) => normalizedRepositoryPath(path, "G213 whole-diff path"));
    assertUnique(paths, "G213 whole-diff paths");
    const entries: CohortWholeDiffEntryV1[] = [];
    for (const path of paths) {
      let revision = input.resultCommit;
      let treeEntry = await this.#git(this.#repositoryRoot, ["ls-tree", revision, "--", path]);
      if (treeEntry.code !== 0 || treeEntry.stdout.trim() === "") {
        revision = input.baseCommit;
        treeEntry = await this.#git(this.#repositoryRoot, ["ls-tree", revision, "--", path]);
      }
      if (treeEntry.code !== 0 || treeEntry.stdout.trim() === "") {
        throw new Error(`${path} is absent from both ends of the G213 whole diff`);
      }
      const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t/u.exec(treeEntry.stdout.trim());
      if (match === null) throw new Error(`${path} is not a regular file in the G213 whole diff`);
      entries.push(
        Object.freeze({
          path,
          mode: match[1] as "100644" | "100755",
          blobDigest: digest({ gitBlobOid: match[2], revision }),
        }),
      );
    }
    return normalizeWholeDiff(entries);
  }
}

async function resolveG213QualifiedCandidateRowSnapshotV1(input: {
  readonly row: AttestationEnvelope;
  readonly requestedHandle: {
    readonly attestationId: string;
    readonly generation: number;
  };
  readonly repository: G213CandidateRepositoryV1;
  readonly store: Pick<AttestationStore, "read">;
}): Promise<G213QualifiedCandidateRowV1> {
  const row = immutableSnapshot(input.row);
  const queue = row.implementationQueue;
  const binding = row.gitEffectBinding;
  if (
    row.attestationId !== input.requestedHandle.attestationId ||
    row.generation !== input.requestedHandle.generation
  ) {
    throw new Error("trusted attestation store returned a different G213 handle");
  }
  if (
    row.kind !== "envelope" ||
    row.promptProvenance.roleId !== "implement-worker" ||
    queue === undefined ||
    binding === undefined ||
    queue.state !== "qualified" ||
    queue.qualification === undefined
  ) {
    throw new Error("actual G213 row is not one qualified managed implement-worker");
  }
  if (typeof row.input !== "object" || row.input === null || Array.isArray(row.input)) {
    throw new Error("actual G213 row input is not an object");
  }
  const rowInput = row.input as Readonly<Record<string, unknown>>;
  const startingCommit = rowInput["startingCommit"];
  const baseCommit = rowInput["baseCommit"];
  if (typeof startingCommit !== "string" || typeof baseCommit !== "string") {
    throw new Error("actual G213 row lacks its prepared commit bindings");
  }
  assertCommit(startingCommit, "actual G213 row starting commit");
  assertCommit(baseCommit, "actual G213 row base commit");
  if (
    queue.attempt.managedWorktreeBindingDigest !== digest(binding) ||
    !implementationQueueSubjectsMatch(queue.attempt, binding, false) ||
    queue.attempt.repositoryId !== binding.repositoryId ||
    queue.attempt.worktreePath !== binding.worktreePath ||
    queue.attempt.observedBaseCommit !== baseCommit ||
    row.stagedCompletionQualification?.qualificationDigest !==
      queue.qualification.qualificationDigest ||
    row.gateSubmittedOutputDigest !== queue.qualification.outputDigest ||
    queue.qualification.expectedChild.childId !== row.expectedChild.childId ||
    queue.qualification.expectedChild.runId !== row.expectedChild.runId ||
    queue.qualification.expectedProvenance.roleId !== row.promptProvenance.roleId ||
    queue.qualification.expectedProvenance.version !== row.promptProvenance.version ||
    queue.qualification.expectedProvenance.promptDigest !== row.promptProvenance.promptDigest ||
    queue.qualification.expectedProvenance.inputDigest !== row.promptProvenance.inputDigest
  ) {
    throw new Error("actual G213 row identity or qualification is inconsistent");
  }
  if (typeof row.output !== "object" || row.output === null || Array.isArray(row.output)) {
    throw new Error("actual G213 row lacks its staged output");
  }
  const output = row.output as Readonly<Record<string, unknown>>;
  if (
    !implementationQueueSubjectsMatch(output, binding, false) ||
    output["branch"] !== binding.branch ||
    output["resultCommit"] !== queue.attempt.resultCommit ||
    digest(output["gitReceipts"] ?? []) !== queue.attempt.gitReceiptLineageDigest
  ) {
    throw new Error("actual G213 row staged output differs from its queue attempt");
  }
  if (binding.cohort !== undefined &&
      (!implementationQueueSubjectsMatch(rowInput, binding, false) ||
       !implementationQueueAuthoritiesMatch(queue.enrollment, queue.attempt, false) ||
       queue.attempt.version !== 2 || queue.enrollment.version !== 2 ||
       row.promptProvenance.inputDigest !== digest(row.input) ||
       queue.qualification.outputDigest !== digest(row.output))) {
    throw new Error("actual G213 cohort row lacks its exact full-member production identity");
  }
  const repositoryDiff = normalizeWholeDiff(
    await input.repository.resolveWholeDiff({
      repositoryId: binding.repositoryId,
      baseCommit: queue.attempt.observedBaseCommit,
      resultCommit: queue.attempt.resultCommit,
      resultTree: queue.attempt.resultTree,
    }),
  );
  let guardedRebase: CohortGuardedCandidateBridgeV1 | undefined;
  if (binding.cohortRebaseTransition !== undefined) {
    const transition = binding.cohortRebaseTransition;
    const bridge = binding.guardedRebaseBridge;
    const source = input.store.read(transition.source);
    const sourceCheckpoint = source?.kind === "envelope" ? source.implementationQueue?.stagedRebaseSource : undefined;
    if (bridge?.version !== 2 || source?.kind !== "envelope" || source.gitEffectBinding === undefined ||
        !cohortRebaseTransitionMatches(source.gitEffectBinding, binding, source) ||
        source.implementationQueue?.state !== "staged-rebase-retired" ||
        sourceCheckpoint?.sourceResultCommit !== bridge.oldResultCommit || sourceCheckpoint.guardedRebaseJournalDigest !== bridge.requestDigest ||
        sourceCheckpoint.successor?.attestationId !== row.attestationId || sourceCheckpoint.successor.generation !== row.generation) {
      throw new Error("actual G213 successor lost its authenticated retired source and rebase proof");
    }
    guardedRebase = Object.freeze({ transition, bridge });
    assertCohortGuardedCandidateBridgeV1(guardedRebase, { attestationId: row.attestationId, generation: row.generation,
      cohort: binding.cohort!, branch: binding.branch, startingCommit }, baseCommit);
  }
  if (
    !Array.isArray(output["filesTouched"]) ||
    canonical(sortedUnique(output["filesTouched"] as string[])) !==
      canonical(repositoryDiff.map((entry) => entry.path))
  ) {
    throw new Error("actual G213 row filesTouched differs from the repository diff");
  }
  return Object.freeze({
    preparedDispatch: Object.freeze({
      attestationId: row.attestationId,
      generation: row.generation,
      ...(binding.cohort === undefined ? { taskId: binding.taskId } : { cohort: binding.cohort }),
      branch: binding.branch,
      startingCommit,
    }),
    queue,
    repositoryDiff,
    ...(guardedRebase === undefined ? {} : { guardedRebase }),
  });
}

/** Own the non-copyable identity of rows authenticated from persisted G213 state. */
export class G213CandidateAuthenticatorV1 {
  readonly #authenticatedRows = new WeakSet<G213QualifiedCandidateRowV1>();
  readonly #authenticatedAttempts = new WeakSet<StagedCohortCandidateAttemptV1>();
  readonly #store: Pick<AttestationStore, "namespace" | "read">;
  readonly #repository: G213CandidateRepositoryV1;

  constructor(input: {
    readonly store: Pick<AttestationStore, "namespace" | "read">;
    readonly repository: G213CandidateRepositoryV1;
  }) {
    this.#store = input.store;
    this.#repository = input.repository;
  }

  async resolve(input: {
    readonly attestationId: string;
    readonly generation: number;
  }): Promise<G213QualifiedCandidateRowV1> {
    assertNonEmpty(input.attestationId, "G213 attestation id");
    if (!Number.isInteger(input.generation) || input.generation < 1) {
      throw new Error("G213 generation must be a positive integer");
    }
    const persisted = this.#store.read(input);
    if (persisted === undefined) {
      throw new Error("trusted attestation store has no matching G213 candidate");
    }
    if (persisted.kind !== "envelope" || persisted.state !== "gate-pending") {
      throw new Error("trusted attestation store returned a stale G213 candidate");
    }
    if (canonical(persisted.namespace) !== canonical(this.#store.namespace)) {
      throw new Error("trusted attestation store returned another namespace");
    }
    const row = await resolveG213QualifiedCandidateRowSnapshotV1({
      row: persisted,
      requestedHandle: input,
      repository: this.#repository,
      store: this.#store,
    });
    this.#authenticatedRows.add(row);
    return row;
  }

  /** Project, but never allocate, the candidate identity owned by G213. */
  stage(
    pending: PendingCohortCandidateAttemptV1,
    binding: G213CandidateAttemptBindingV1,
  ): StagedCohortCandidateAttemptV1 {
    if (!this.#authenticatedRows.has(binding.row)) {
      throw new Error("G213 candidate binding differs from the actual G213 row");
    }
    return stageAuthenticatedCohortCandidateAttemptV1(
      pending,
      binding,
      this.#authenticatedAttempts,
    );
  }
}

export type CohortGitChangeReceiptV1 = DispatchGitChangeReceipt;

export interface CohortCandidateSealV1 {
  readonly kind: "cq-cohort-candidate-seal";
  readonly version: 1;
  readonly definitionDigest: string;
  readonly candidateAttemptDigest: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly wholeDiff: readonly CohortWholeDiffEntryV1[];
  readonly wholeDiffDigest: string;
  readonly gitReceipts: readonly CohortGitChangeReceiptV1[];
  readonly gitReceiptBridgeDigest: string;
  readonly sealDigest: string;
}

export class CohortCandidateSealConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CohortCandidateSealConflictError";
  }
}

export interface CohortCandidateSealRequestV1 {
  readonly definition: CohortDefinitionIdentityV1;
  readonly attempt: StagedCohortCandidateAttemptV1;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly wholeDiff: readonly CohortWholeDiffEntryV1[];
  readonly gitReceipts: readonly CohortGitChangeReceiptV1[];
}

export interface CohortCandidateSealStoreV1 {
  seal(request: CohortCandidateSealRequestV1): {
    readonly state: "sealed" | "existing";
    readonly seal: CohortCandidateSealV1;
  };
  read(candidateAttemptDigest: string): CohortCandidateSealV1 | undefined;
}

export function materializeCohortCandidateSealV1(
  request: CohortCandidateSealRequestV1,
): CohortCandidateSealV1 {
  if (
    !(request.attempt instanceof AuthenticatedG213CandidateAttemptV1) ||
    !request.attempt.isAuthenticated()
  ) {
    throw new CohortCandidateSealConflictError(
      "candidate seal lacks the actual durable G213 qualified-attempt binding",
    );
  }
  if (request.definition.definitionDigest !== request.attempt.definitionDigest) {
    throw new CohortCandidateSealConflictError("candidate attempt belongs to another definition");
  }
  assertCommit(request.baseCommit, "candidate seal base commit");
  assertCommit(request.resultCommit, "candidate seal result commit");
  if (!/^[0-9a-f]{40,64}$/u.test(request.resultTree)) {
    throw new Error("candidate seal result tree must be a lowercase object id");
  }
  if (
    request.attempt.g213.observedBaseCommit !== request.baseCommit ||
    request.attempt.g213.resultCommit !== request.resultCommit ||
    request.attempt.g213.resultTree !== request.resultTree
  ) {
    throw new CohortCandidateSealConflictError("candidate seal substituted G213 result identity");
  }
  const wholeDiff = normalizeWholeDiff(request.wholeDiff);
  if (digest(wholeDiff) !== request.attempt.g213.repositoryDiffDigest) {
    throw new CohortCandidateSealConflictError("candidate whole diff differs from G213 repository diff");
  }
  const receipts = [...request.gitReceipts];
  const guarded = request.attempt.g213.guardedRebase;
  if (guarded !== undefined) assertCohortGuardedCandidateBridgeV1(guarded, request.attempt.preparedDispatch, request.baseCommit);
  if (receipts.length === 0 && request.baseCommit !== request.resultCommit && (guarded === undefined || !guarded.bridge.exactTip)) {
    throw new CohortCandidateSealConflictError("changed candidate lacks its Git receipt bridge");
  }
  let expected = guarded?.bridge.rebasedStartCommit ?? request.baseCommit;
  for (const receipt of receipts) {
    if (receipt.kind !== "cq-git-change-receipt" ||
        receipt.version !== (receipt.cohort === undefined ? 1 : 2) ||
        (request.attempt.preparedDispatch.cohort !== undefined &&
         !implementationQueueSubjectsMatch(receipt, request.attempt.preparedDispatch, true))) {
      throw new CohortCandidateSealConflictError("Git receipt bridge substituted its complete producing subject");
    }
    if (receipt.oldHead !== expected) {
      throw new CohortCandidateSealConflictError("Git receipt bridge is not contiguous from base");
    }
    expected = receipt.newHead;
  }
  if (expected !== request.resultCommit) {
    throw new CohortCandidateSealConflictError("Git receipt bridge does not end at result commit");
  }
  if (receipts.length > 0 && receipts.at(-1)?.tree !== request.resultTree) {
    throw new CohortCandidateSealConflictError("Git receipt bridge does not end at result tree");
  }
  const receiptDigest = digest(receipts);
  if (receiptDigest !== request.attempt.g213.gitReceiptLineageDigest) {
    throw new CohortCandidateSealConflictError("Git receipt bridge differs from G213 lineage");
  }
  const payload = {
    kind: "cq-cohort-candidate-seal" as const,
    version: 1 as const,
    definitionDigest: request.definition.definitionDigest,
    candidateAttemptDigest: request.attempt.candidateAttemptDigest,
    baseCommit: request.baseCommit,
    resultCommit: request.resultCommit,
    resultTree: request.resultTree,
    wholeDiff: Object.freeze(wholeDiff),
    wholeDiffDigest: digest(wholeDiff),
    gitReceipts: Object.freeze(receipts),
    gitReceiptBridgeDigest: receiptDigest,
  };
  return Object.freeze({ ...payload, sealDigest: digest(payload) });
}

export class InMemoryCohortCandidateSealStoreV1 implements CohortCandidateSealStoreV1 {
  readonly #seals = new Map<string, CohortCandidateSealV1>();

  seal(request: CohortCandidateSealRequestV1): {
    readonly state: "sealed" | "existing";
    readonly seal: CohortCandidateSealV1;
  } {
    const candidate = materializeCohortCandidateSealV1(request);
    const prior = this.#seals.get(request.attempt.candidateAttemptDigest);
    if (prior !== undefined) {
      if (canonical(prior) !== canonical(candidate)) {
        throw new CohortCandidateSealConflictError("altered candidate seal replay");
      }
      return Object.freeze({ state: "existing", seal: prior });
    }
    this.#seals.set(request.attempt.candidateAttemptDigest, candidate);
    return Object.freeze({ state: "sealed", seal: candidate });
  }

  read(candidateAttemptDigest: string): CohortCandidateSealV1 | undefined {
    return this.#seals.get(candidateAttemptDigest);
  }
}

export function createCohortEvidenceSubjectV1(
  definition: CohortDefinitionIdentityV1,
  seal: CohortCandidateSealV1,
): CohortEvidenceSubjectV1 {
  if (definition.definitionDigest !== seal.definitionDigest) {
    throw new Error("candidate seal belongs to another cohort definition");
  }
  const payload = {
    kind: "cq-cohort-evidence-subject" as const,
    version: 1 as const,
    definitionDigest: definition.definitionDigest,
    sealDigest: seal.sealDigest,
  };
  return Object.freeze({ ...payload, evidenceSubjectDigest: digest(payload) });
}


export function createCohortEffectEnvelopeV1(input: {
  readonly definition: CohortDefinitionIdentityV1;
  readonly observation: CohortAdmissionObservationV1;
  readonly intent: CohortCandidateIntentV1;
  readonly evidenceSubject: CohortEvidenceSubjectV1 | null;
  readonly executionEpoch: string;
}): CohortEffectEnvelopeV1 {
  const memberAuthorities: readonly CohortMemberTaskAuthorityV1[] = input.definition.members.map((member) => {
    const observed = input.observation.members.find((value) => value.memberRef === member.memberRef);
    if (observed === undefined || observed.phase !== "implementation" ||
        observed.memberRevision !== member.memberRevision || observed.authorityRevision !== member.authorityRevision) {
      throw new Error("cohort effect member lacks its exact implementation observation");
    }
    return { taskRef: observed.memberRef, taskRevision: observed.taskRevision, goalRef: observed.goalRef,
      finalizedManifestDigest: observed.finalizedManifestRevision, authorityRevision: observed.authorityRevision };
  });
  const memberSetDigest = digest(memberAuthorities);
  const semanticSubject =
    input.evidenceSubject === null
      ? digest({
          definitionDigest: input.definition.definitionDigest,
          intentDigest: input.intent.intentDigest,
          memberSetDigest,
        })
      : input.evidenceSubject.evidenceSubjectDigest;
  const payload = {
    kind: "cq-cohort-effect-envelope" as const,
    version: 1 as const,
    definition: input.definition,
    intent: input.intent,
    memberAuthorities,
    memberSetDigest,
    ...(input.evidenceSubject === null ? { state: "pre-seal" as const } :
      { state: "sealed" as const, evidenceSubject: input.evidenceSubject }),
    semanticSubject,
    executionEpoch: input.executionEpoch,
  };
  const envelope = immutableSnapshot({ ...payload, envelopeDigest: digest(payload) });
  assertCohortEffectEnvelopeV1(envelope);
  return envelope;
}

export interface CohortLiveEffectBindingV1 {
  readonly semanticSubject: string;
  readonly executionEpoch: string;
  readonly effectDigest: string;
}

export function cohortWorktreeIdentityFromEnvelopeV1(envelope: CohortEffectEnvelopeV1): CohortWorktreeIdentityV1 {
  assertCohortEffectEnvelopeV1(envelope);
  return immutableSnapshot({ kind: "cq-cohort-worktree-identity" as const, version: 1 as const,
    cohortId: envelope.definition.cohortId, definitionDigest: envelope.definition.definitionDigest,
    candidateIntentDigest: envelope.intent.intentDigest, memberSetDigest: envelope.memberSetDigest,
    memberAuthorities: envelope.memberAuthorities });
}

export function bindCohortLiveEffectV1(
  envelope: CohortEffectEnvelopeV1,
  effectIdentity: string,
): CohortLiveEffectBindingV1 {
  assertNonEmpty(effectIdentity, "cohort effect identity");
  return Object.freeze({
    semanticSubject: envelope.semanticSubject,
    executionEpoch: envelope.executionEpoch,
    effectDigest: digest({ envelopeDigest: envelope.envelopeDigest, effectIdentity }),
  });
}

export function assertCohortLiveEffectCurrentV1(
  envelope: CohortEffectEnvelopeV1,
  binding: CohortLiveEffectBindingV1,
): void {
  if (
    envelope.semanticSubject !== binding.semanticSubject ||
    envelope.executionEpoch !== binding.executionEpoch
  ) {
    throw new Error("cohort live effect is fenced by another semantic subject or execution epoch");
  }
}

export interface CohortEvidenceReceiptV1 {
  readonly evidenceSubjectDigest: string;
  readonly acceptanceMatrixDigest: string;
  readonly environmentDigest: string;
  readonly authorizingExecutionEpoch: string;
  readonly receiptDigest: string;
}

export function createCohortEvidenceReceiptV1(input: {
  readonly evidenceSubject: CohortEvidenceSubjectV1;
  readonly definition: CohortDefinitionIdentityV1;
  readonly authorizingExecutionEpoch: string;
}): CohortEvidenceReceiptV1 {
  assertNonEmpty(input.authorizingExecutionEpoch, "authorizing execution epoch");
  if (input.evidenceSubject.definitionDigest !== input.definition.definitionDigest) {
    throw new Error("evidence receipt definition mismatch");
  }
  const payload = {
    evidenceSubjectDigest: input.evidenceSubject.evidenceSubjectDigest,
    acceptanceMatrixDigest: input.definition.acceptanceMatrixDigest,
    environmentDigest: input.definition.environment.environmentDigest,
    authorizingExecutionEpoch: input.authorizingExecutionEpoch,
  };
  return Object.freeze({ ...payload, receiptDigest: digest(payload) });
}

export function isCohortEvidenceReceiptReusableV1(input: {
  readonly receipt: CohortEvidenceReceiptV1;
  readonly evidenceSubject: CohortEvidenceSubjectV1;
  readonly definition: CohortDefinitionIdentityV1;
}): boolean {
  return (
    input.receipt.evidenceSubjectDigest === input.evidenceSubject.evidenceSubjectDigest &&
    input.receipt.acceptanceMatrixDigest === input.definition.acceptanceMatrixDigest &&
    input.receipt.environmentDigest === input.definition.environment.environmentDigest &&
    input.receipt.receiptDigest ===
      digest({
        evidenceSubjectDigest: input.receipt.evidenceSubjectDigest,
        acceptanceMatrixDigest: input.receipt.acceptanceMatrixDigest,
        environmentDigest: input.receipt.environmentDigest,
        authorizingExecutionEpoch: input.receipt.authorizingExecutionEpoch,
      })
  );
}
