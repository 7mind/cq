import { once } from "node:events";
import { createInterface } from "node:readline";
import { createInvestigationNativeProviderHostV1, assertInvestigationNativeSingletonDispatchV1, type InvestigationNativeProviderHostV1 } from "@cq/ledger-mcp";
import {
  WORKSET_EXTERNAL_EFFECT_KINDS,
  WorksetAdmissionError,
  createLedgerStore,
  requireWorksetStore,
  worksetEffectAdmissionProviderFromStore,
  resolveRetainedManagedCohortAuthority,
  createCohortWorksetEffectAdmissionProvider,
  observeManagedWorktreeConflictState,
  gitRebaseConflictStateDigest,
  resolveUniquePendingGuardedRebaseConflict,
  type WorksetExternalEffectKind,
} from "@cq/ledger";
import {
  isRegisteredProcessGroupAlive,
  readProcessIdentity,
  settleProcessGroups,
  assertCohortEffectEnvelopeV1,
  assertInvestigationCohortLaunchBindingV1,
  assertInvestigationNativeDispatchIdentityV1,
  investigationCohortEffectTargetRefV1,
  type CohortEffectEnvelopeV1,
  type WorksetBrokerAdmissionHandle,
  type WorksetEffectAdmissionProvider,
  type ProcessGroupRegistration,
} from "@cq/process-control";

export const WORKSET_EFFECT_PROVIDER_CONTROL_MODE = "__workset-effect-provider" as const;

export interface WorksetEffectProviderControlOptions {
  readonly cwd: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

const MAX_CONTROL_LINE_BYTES = 16_384;

function protocolError(message: string): Error {
  return new Error(`cq workset effect provider: ${message}`);
}

function publicError(error: unknown): string {
  if (error instanceof WorksetAdmissionError) {
    return `workset admission refused: ${error.code}`;
  }
  if (error instanceof Error && error.message.startsWith("cq workset effect provider:")) {
    return error.message;
  }
  return "workset provider operation failed";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const observed = Object.keys(record).sort();
  const expected = [...keys].sort();
  return observed.length === expected.length && observed.every((key, index) => key === expected[index]);
}

function processGroupRequest(
  request: Readonly<Record<string, unknown>>,
): { readonly pgid: number; readonly leaderPid: number } {
  if (
    !exactKeys(request, ["op", "pgid", "leaderPid"]) ||
    !Number.isSafeInteger(request["pgid"]) ||
    !Number.isSafeInteger(request["leaderPid"]) ||
    (request["pgid"] as number) <= 1 ||
    request["pgid"] !== request["leaderPid"]
  ) {
    throw protocolError("registration must name one safe process-group leader");
  }
  return {
    pgid: request["pgid"] as number,
    leaderPid: request["leaderPid"] as number,
  };
}

async function writeResponse(
  output: NodeJS.WritableStream,
  response: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!output.write(`${JSON.stringify(response)}\n`)) await once(output, "drain");
}

async function closeAfterControllerLoss(
  admission: WorksetBrokerAdmissionHandle | null,
  registration: ProcessGroupRegistration | null,
  settled: boolean,
): Promise<void> {
  if (admission === null) return;
  if (registration === null) {
    await admission.abandonBeforeRegistration();
    return;
  }
  if (!settled) {
    const result = await settleProcessGroups([registration]);
    if (result.survivors.length > 0) {
      throw protocolError(
        `controller loss left process-group survivors ${result.survivors.join(", ")}`,
      );
    }
    await Promise.resolve(admission.markSettled());
  }
  await admission.releaseAfterSettlement();
}

/**
 * Protocol-only trusted host for one external-effect admission. The durable
 * handle remains in this process; its controller sends only lifecycle stages.
 */
export async function runWorksetEffectProviderControl(
  options: WorksetEffectProviderControlOptions,
): Promise<void> {
  const resolved = await createLedgerStore(options.cwd);
  const provider: WorksetEffectAdmissionProvider = worksetEffectAdmissionProviderFromStore(requireWorksetStore(resolved.store));
  let admission: WorksetBrokerAdmissionHandle | null = null;
  let registration: ProcessGroupRegistration | null = null;
  let settled = false;
  let closed = false;
  let investigationHost: InvestigationNativeProviderHostV1 | null = null;
  try {
    const lines = createInterface({ input: options.input, crlfDelay: Infinity });
    for await (const line of lines) {
      let parsedOperation: unknown;
      try {
        if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) {
          throw protocolError("request exceeds the bounded line limit");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          throw protocolError("request must contain one JSON object");
        }
        if (!isRecord(parsed) || typeof parsed["op"] !== "string") {
          throw protocolError("request must contain one typed operation");
        }
        const op = parsed["op"];
        parsedOperation = op;
        if (op === "acquire") {
          if (
            admission !== null ||
            !exactKeys(parsed, ["op", "kind", "targetRef", ...(Object.hasOwn(parsed, "cohort") ? ["cohort"] : []),
              ...(Object.hasOwn(parsed, "investigationCohort") ? ["investigationCohort"] : []),
              ...(Object.hasOwn(parsed, "investigationDispatch") ? ["investigationDispatch"] : []),
              ...(Object.hasOwn(parsed, "cohortConflictStateDigest") ? ["cohortConflictStateDigest", "cohortRoleId"] : [])]) ||
            typeof parsed["kind"] !== "string" ||
            !WORKSET_EXTERNAL_EFFECT_KINDS.includes(
              parsed["kind"] as WorksetExternalEffectKind,
            ) ||
            typeof parsed["targetRef"] !== "string" ||
            parsed["targetRef"].trim() === ""
          ) {
            throw protocolError("acquire must be the first valid typed operation");
          }
          let exactProvider = provider;
          if (Object.hasOwn(parsed, "investigationDispatch")) {
            const identity = parsed["investigationDispatch"];
            assertInvestigationNativeDispatchIdentityV1(identity);
            if (Object.hasOwn(parsed, "cohort") || Object.hasOwn(parsed, "investigationCohort") || parsed["kind"] !== "child-dispatch") {
              throw protocolError("ordinary investigation dispatch requires its exclusive native role identity");
            }
            assertInvestigationNativeSingletonDispatchV1(resolved, identity);
          }
          if (Object.hasOwn(parsed, "investigationCohort")) {
            const binding = parsed["investigationCohort"];
            assertInvestigationCohortLaunchBindingV1(binding);
            if (Object.hasOwn(parsed, "cohort") || Object.hasOwn(parsed, "cohortConflictStateDigest") ||
                parsed["kind"] !== "child-dispatch" || parsed["targetRef"] !== investigationCohortEffectTargetRefV1(binding)) {
              throw protocolError("investigation admission requires its exclusive complete child-dispatch binding");
            }
            investigationHost = await createInvestigationNativeProviderHostV1({ resolved, environment: process.env });
            exactProvider = await investigationHost.resolve(binding);
          }
          const conflictDigest = parsed["cohortConflictStateDigest"];
          if (conflictDigest !== undefined && (!Object.hasOwn(parsed, "cohort") ||
              parsed["kind"] !== "child-dispatch" || parsed["cohortRoleId"] !== "implement-conflict-resolver" ||
              typeof conflictDigest !== "string" || !/^[0-9a-f]{64}$/u.test(conflictDigest))) {
            throw protocolError("detached admission requires the exact cohort conflict-resolver binding");
          }
          if (Object.hasOwn(parsed, "cohort")) {
            const envelope = parsed["cohort"] as CohortEffectEnvelopeV1;
            assertCohortEffectEnvelopeV1(envelope);
            if (resolved.backend !== "xdg" || resolved.store.workCohortStore === undefined) {
              throw protocolError("cohort process admission requires its local durable authority store");
            }
            const retained = await resolveRetainedManagedCohortAuthority(resolved.configRoot,
              resolved.store.workCohortStore(), envelope, {}, conflictDigest !== undefined);
            if (conflictDigest !== undefined) {
              const deps = { cohortAuthority: retained.authority };
              const observed = await observeManagedWorktreeConflictState(retained.binding, deps);
              if (gitRebaseConflictStateDigest(observed) !== conflictDigest) throw protocolError("cohort resolver conflict state differs from its bound digest");
              await resolveUniquePendingGuardedRebaseConflict(retained.binding, observed, deps);
            }
            exactProvider = createCohortWorksetEffectAdmissionProvider(retained.authority, requireWorksetStore(resolved.store));
          }
          admission = await exactProvider.acquire({
            kind: parsed["kind"] as WorksetExternalEffectKind,
            targetRef: parsed["targetRef"],
          });
          await writeResponse(options.output, { ok: true, epoch: admission.epoch });
          continue;
        }
        if (admission === null) throw protocolError("admission must be acquired first");
        if (op === "register") {
          if (registration !== null) throw protocolError("process group is already registered");
          const candidate = processGroupRequest(parsed);
          const leader = await readProcessIdentity(candidate.leaderPid);
          if (leader === null) throw protocolError("registered process-group leader is not alive");
          await Promise.resolve(admission.registerProcessGroup(candidate));
          registration = { pgid: candidate.pgid, leader };
          await writeResponse(options.output, { ok: true });
          continue;
        }
        if (op === "share") {
          const candidate = processGroupRequest(parsed);
          if (
            registration === null ||
            registration.pgid !== candidate.pgid ||
            registration.leader.pid !== candidate.leaderPid
          ) {
            throw protocolError("guardian differs from the registered process group");
          }
          await Promise.resolve(admission.shareWithGuardian(candidate));
          await writeResponse(options.output, { ok: true });
          continue;
        }
        if (op === "settle") {
          if (!exactKeys(parsed, ["op"]) || registration === null) {
            throw protocolError("settlement requires the registered process group");
          }
          if (await isRegisteredProcessGroupAlive(registration)) {
            throw protocolError("cannot mark a live process group settled");
          }
          await Promise.resolve(admission.markSettled());
          settled = true;
          await writeResponse(options.output, { ok: true });
          continue;
        }
        if (op === "release") {
          if (!exactKeys(parsed, ["op"]) || !settled) {
            throw protocolError("release requires completed process-group settlement");
          }
          await admission.releaseAfterSettlement();
          closed = true;
          await writeResponse(options.output, { ok: true });
          return;
        }
        if (op === "abandon") {
          if (!exactKeys(parsed, ["op"]) || registration !== null) {
            throw protocolError("abandon applies only before process registration");
          }
          await admission.abandonBeforeRegistration();
          closed = true;
          await writeResponse(options.output, { ok: true });
          return;
        }
        throw protocolError(`unknown operation ${JSON.stringify(op)}`);
      } catch (error) {
        const closeAfterError =
          admission === null || parsedOperation === "release" || parsedOperation === "abandon";
        await writeResponse(options.output, {
          ok: false,
          error: publicError(error),
          ...(closeAfterError ? { closed: true } : {}),
        });
        if (closeAfterError) return;
      }
    }
  } finally {
    try {
      if (!closed) await closeAfterControllerLoss(admission, registration, settled);
    } finally {
      try { if (investigationHost !== null) await investigationHost.close(); }
      finally { await resolved.store.dispose(); }
    }
  }
}
