import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type AttestationBackend,
  type DispatchPrepared,
  type NativeCompletionProof,
} from "@cq/config";
import {
  InvestigationCohortRunnerV1,
  InvestigationBindingError,
  InvestigationDispatchAuthenticatorV1,
  cohortValueDigestV1 as digest,
  createInvestigationPreparedDispatchV1,
  produceCohortAdmissionObservationV1,
  resolveCohortDefinitionObservationV1,
  type AuthorizedInvestigationResultV1,
  type CohortAdmissionObservationSourceV1,
  type InvestigationCitationSourceV1,
  type InvestigationCohortHostV1,
  type InvestigationCohortPlanV1,
  type InvestigationDispatchBindingV1,
  type InvestigationEvidenceItemV1,
  type InvestigationPreparedDispatchV1,
  type InvestigationRoleContractV1,
  type InvestigationRoleV1,
  type WorkCohortStore,
} from "@cq/ledger";
import type { DispatchCapability } from "@cq/ledger";
import type { PromptArtifactStore } from "./promptArtifactStore.js";

export interface InvestigationNativeLauncherV1 {
  launch(input: {
    readonly prepared: DispatchPrepared;
    readonly binding: InvestigationDispatchBindingV1;
    readonly expectedChild: InvestigationPreparedDispatchV1["expectedChild"];
  }): Promise<NativeCompletionProof>;
}
export interface InvestigationCohortRuntimeOptionsV1 {
  readonly store: WorkCohortStore;
  readonly dispatch: DispatchCapability;
  readonly backend: AttestationBackend;
  readonly promptArtifacts: PromptArtifactStore;
  readonly observationSource: CohortAdmissionObservationSourceV1;
  readonly launcher: InvestigationNativeLauncherV1;
  readonly timeoutMs: number;
  readonly resolveCitation: InvestigationCohortHostV1["resolveCitation"];
  readonly adjudicate: InvestigationCohortHostV1["adjudicate"];
  readonly validateCorrectionBoundary: InvestigationCohortHostV1["validateCorrectionBoundary"];
}

export function readInvestigationRoleContractV1(artifacts: PromptArtifactStore, roleId: InvestigationRoleV1): InvestigationRoleContractV1 {
  const manifest = artifacts.readManifest();
  const metadata = artifacts.readRole(roleId).metadata;
  if (metadata.roleId !== roleId || metadata.schemaVersion === undefined || metadata.schemaVersion === null ||
    metadata.promptSurface === undefined || metadata.promptDigest === undefined || metadata.schemaDigest === undefined ||
    metadata.schemaDigest === null || manifest.catalogHash === undefined) {
    throw new Error("investigation requires an attested installed role and schema");
  }
  return { roleId, version: metadata.schemaVersion, surface: metadata.promptSurface,
    promptDigest: metadata.promptDigest, catalogHash: manifest.catalogHash, schemaDigest: metadata.schemaDigest };
}

export class DispatchInvestigationCohortHostV1 implements InvestigationCohortHostV1 {
  readonly #launches = new Map<
    string,
    {
      readonly prepared: DispatchPrepared;
      readonly expectedChild: InvestigationPreparedDispatchV1["expectedChild"];
    }
  >();
  constructor(private readonly options: InvestigationCohortRuntimeOptionsV1) {
    if (options.backend.namespace.backend !== "xdg")
      throw new Error("investigation cohort execution requires a local XDG dispatch backend");
  }
  roleContract(roleId: InvestigationRoleV1): InvestigationRoleContractV1 {
    return readInvestigationRoleContractV1(this.options.promptArtifacts, roleId);
  }
  async assertCurrent(plan: InvestigationCohortPlanV1): Promise<void> {
    const state = (await this.options.store.snapshot()).portable;
    const definition = state.definitions.findLast(
      (value) => value.cohortId === plan.definition.cohortId,
    );
    if (
      definition === undefined ||
      definition.definitionDigest !== plan.definition.definitionDigest ||
      digest(this.roleContract("investigate-explorer")) !== digest(plan.explorer) ||
      digest(this.roleContract("investigate-prober")) !== digest(plan.prober)
    ) {
      throw new InvestigationBindingError(
        "investigation definition or installed role binding changed",
      );
    }
    const prior = resolveCohortDefinitionObservationV1({
      definition,
      observations: state.observations,
      decisions: state.decisions,
    });
    const current = await produceCohortAdmissionObservationV1(
      { memberRefs: plan.members.map((member) => member.defectRef) },
      this.options.observationSource,
    );
    if (prior.observationDigest !== current.observationDigest)
      throw new InvestigationBindingError(
        "investigation current member or authority observation changed",
      );
  }
  async prepare(binding: InvestigationDispatchBindingV1): Promise<InvestigationPreparedDispatchV1> {
    if (digest(this.roleContract(binding.role.roleId)) !== digest(binding.role))
      throw new InvestigationBindingError("investigation installed role changed before prepare");
    const expectedChild = {
      childId: `cohort-investigation:${binding.bindingDigest}`,
      runId: `cohort-investigation-run:${binding.bindingDigest}`,
    };
    const outcome = await this.options.dispatch.prepare({
      roleId: binding.role.roleId,
      input: binding.input,
      idempotencyKey: `investigation:${binding.bindingDigest}`,
      timeoutMs: this.options.timeoutMs,
      expectedChild,
    });
    if (!outcome.accepted)
      throw new Error(`investigation dispatch prepare rejected: ${JSON.stringify(outcome)}`);
    const prepared = createInvestigationPreparedDispatchV1({
      binding,
      handle: outcome.handle,
      expectedChild,
      provenance: outcome.prepared.promptProvenance,
    });
    this.#launches.set(prepared.preparedDigest, { prepared: outcome.prepared, expectedChild });
    return prepared;
  }
  async execute(prepared: InvestigationPreparedDispatchV1): Promise<void> {
    const launch = this.#launches.get(prepared.preparedDigest);
    if (launch === undefined)
      throw new Error(
        "retained unconsumed investigation dispatch requires its native launch or completion bridge; it cannot be silently redispatched",
      );
    this.#launches.delete(prepared.preparedDigest);
    const nativeCompletion = await this.options.launcher.launch({
      ...launch,
      binding: prepared.binding,
    });
    await this.options.dispatch.confirmCompletion({
      ...prepared.handle,
      nativeCompletion,
      expectedProvenance: prepared.provenance,
    });
  }
  preparedLaunch(prepared: InvestigationPreparedDispatchV1): DispatchPrepared {
    const launch = this.#launches.get(prepared.preparedDigest);
    if (launch === undefined) throw new Error("investigation launch capabilities are unavailable");
    return structuredClone(launch.prepared);
  }
  authenticate(
    prepared: InvestigationPreparedDispatchV1,
  ): Promise<AuthorizedInvestigationResultV1 | null> {
    return this.options.backend.transact({ kind: "handle", handle: prepared.handle }, (store) => {
      const row = store.read(prepared.handle);
      if (
        row !== undefined &&
        row.kind === "envelope" &&
        ["prepared", "result-stored"].includes(row.state)
      )
        return null;
      return new InvestigationDispatchAuthenticatorV1(store).authenticate(prepared);
    });
  }
  resolveCitation(
    prepared: InvestigationPreparedDispatchV1,
    evidence: InvestigationEvidenceItemV1,
  ) {
    return this.options.resolveCitation(prepared, evidence);
  }
  adjudicate(...input: Parameters<InvestigationCohortHostV1["adjudicate"]>) {
    return this.options.adjudicate(...input);
  }
  validateCorrectionBoundary(
    ...input: Parameters<InvestigationCohortHostV1["validateCorrectionBoundary"]>
  ) {
    return this.options.validateCorrectionBoundary(...input);
  }
}

export function createInvestigationCohortRuntimeV1(options: InvestigationCohortRuntimeOptionsV1) {
  const host = new DispatchInvestigationCohortHostV1(options);
  return { host, runner: new InvestigationCohortRunnerV1(options.store, host) };
}

export interface InvestigationCommandEvidenceReaderV1 {
  read(
    prepared: InvestigationPreparedDispatchV1,
    exactCommand: string,
  ): Promise<InvestigationCitationSourceV1>;
}
export function createRepositoryInvestigationCitationResolverV1(
  repositoryRoot: string,
  commands: InvestigationCommandEvidenceReaderV1,
): InvestigationCohortHostV1["resolveCitation"] {
  return async (prepared, evidence) => {
    const match = /^(.*):(\d+)(?:-(\d+))?$/u.exec(evidence.citation);
    if (match === null) {
      if (prepared.binding.role.roleId !== "investigate-prober")
        throw new Error("explorer citation must identify a local source range");
      return commands.read(prepared, evidence.citation);
    }
    const path = match[1]!;
    const start = Number(match[2]);
    const end = match[3] === undefined ? start : Number(match[3]);
    const root = await realpath(repositoryRoot);
    const target = await realpath(resolve(root, path));
    const contained = relative(root, target);
    if (
      isAbsolute(path) ||
      contained === ".." ||
      contained.startsWith("../") ||
      isAbsolute(contained) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start
    ) {
      throw new Error("investigation citation escapes the repository or has an invalid range");
    }
    const source = await readFile(target, "utf8");
    const lines = source.split("\n");
    if (end > lines.length) throw new Error("investigation citation exceeds source length");
    return {
      citation: evidence.citation,
      text: lines.slice(start - 1, end).join("\n"),
      sourceDigest: digest(source),
    };
  };
}
