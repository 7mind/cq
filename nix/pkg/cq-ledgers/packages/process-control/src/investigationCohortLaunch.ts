export interface InvestigationCohortLaunchBindingV1 {
  readonly kind: "cq-investigation-cohort-launch";
  readonly version: 1;
  readonly handle: { readonly attestationId: string; readonly generation: number };
  readonly roleId: "investigate-explorer" | "investigate-prober";
  readonly memberRef: string;
  readonly planDigest: string;
  readonly preparedDigest: string;
  readonly executionEpoch: string;
  readonly members: readonly {
    readonly defectRef: string;
    readonly defectRevision: string;
    readonly hypothesisRef: string;
    readonly hypothesisRevision: string;
  }[];
  readonly expectedChild: { readonly childId: string; readonly runId: string };
}

export type InvestigationNativeDispatchIdentityV1 = Pick<InvestigationCohortLaunchBindingV1, "roleId" | "handle">;

export function assertInvestigationNativeDispatchIdentityV1(value: unknown): asserts value is InvestigationNativeDispatchIdentityV1 {
  if (!exact(value, ["roleId", "handle"]) || !["investigate-explorer", "investigate-prober"].includes(value["roleId"] as string) ||
      !exact(value["handle"], ["attestationId", "generation"]) || !nonempty(value["handle"]["attestationId"]) ||
      !Number.isSafeInteger(value["handle"]["generation"]) || (value["handle"]["generation"] as number) < 1) {
    throw new Error("invalid investigation native dispatch identity");
  }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }

export function assertInvestigationCohortLaunchBindingV1(value: unknown): asserts value is InvestigationCohortLaunchBindingV1 {
  if (!exact(value, ["kind", "version", "handle", "roleId", "memberRef", "planDigest", "preparedDigest", "executionEpoch", "members", "expectedChild"]) ||
      value["kind"] !== "cq-investigation-cohort-launch" || value["version"] !== 1 ||
      !exact(value["handle"], ["attestationId", "generation"]) || !nonempty(value["handle"]["attestationId"]) ||
      !Number.isSafeInteger(value["handle"]["generation"]) || (value["handle"]["generation"] as number) < 1 ||
      !["investigate-explorer", "investigate-prober"].includes(value["roleId"] as string) ||
      !nonempty(value["memberRef"]) || !digest(value["planDigest"]) || !digest(value["preparedDigest"]) || !nonempty(value["executionEpoch"]) ||
      !exact(value["expectedChild"], ["childId", "runId"]) || !nonempty(value["expectedChild"]["childId"]) ||
      !nonempty(value["expectedChild"]["runId"]) ||
      !Array.isArray(value["members"]) || value["members"].length < 1 || value["members"].length > 256 ||
      !value["members"].every((member: unknown) => exact(member, ["defectRef", "defectRevision", "hypothesisRef", "hypothesisRevision"]) &&
        typeof member["defectRef"] === "string" && /^defects:D\d+$/u.test(member["defectRef"]) && digest(member["defectRevision"]) &&
        typeof member["hypothesisRef"] === "string" && /^hypothesis:H\d+$/u.test(member["hypothesisRef"]) && digest(member["hypothesisRevision"]))) {
    throw new Error("invalid complete investigation cohort launch binding");
  }
  const members = value["members"] as InvestigationCohortLaunchBindingV1["members"];
  if (new Set(members.map((member) => member.defectRef)).size !== members.length ||
      !members.some((member) => member.defectRef === value["memberRef"])) throw new Error("investigation launch member set is incomplete or duplicated");
}

export function investigationCohortEffectTargetRefV1(binding: InvestigationCohortLaunchBindingV1): string {
  assertInvestigationCohortLaunchBindingV1(binding);
  return `cq-cohort-effect:v1:${binding.planDigest}`;
}

export function assertInvestigationCohortLaunchInvocationV1(binding: InvestigationCohortLaunchBindingV1, invocation: {
  readonly roleId: string;
  readonly handle: { readonly attestationId: string; readonly generation: number };
}): void {
  assertInvestigationCohortLaunchBindingV1(binding);
  if (binding.roleId !== invocation.roleId || binding.handle.attestationId !== invocation.handle.attestationId ||
      binding.handle.generation !== invocation.handle.generation) throw new Error("investigation launch differs from its exact native role and dispatch handle");
}
