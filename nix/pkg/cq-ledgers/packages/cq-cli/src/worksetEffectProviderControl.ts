import { once } from "node:events";
import { createInterface } from "node:readline";
import {
  WORKSET_EXTERNAL_EFFECT_KINDS,
  WorksetAdmissionError,
  createLedgerStore,
  requireWorksetStore,
  worksetEffectAdmissionProviderFromStore,
  type WorksetExternalEffectAdmission,
  type WorksetExternalEffectKind,
} from "@cq/ledger";
import {
  isRegisteredProcessGroupAlive,
  readProcessIdentity,
  settleProcessGroups,
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
  admission: WorksetExternalEffectAdmission | null,
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
  const provider = worksetEffectAdmissionProviderFromStore(requireWorksetStore(resolved.store));
  let admission: WorksetExternalEffectAdmission | null = null;
  let registration: ProcessGroupRegistration | null = null;
  let settled = false;
  let closed = false;
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
            !exactKeys(parsed, ["op", "kind", "targetRef"]) ||
            typeof parsed["kind"] !== "string" ||
            !WORKSET_EXTERNAL_EFFECT_KINDS.includes(
              parsed["kind"] as WorksetExternalEffectKind,
            ) ||
            typeof parsed["targetRef"] !== "string" ||
            parsed["targetRef"].trim() === ""
          ) {
            throw protocolError("acquire must be the first valid typed operation");
          }
          admission = await provider.acquire({
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
      await resolved.store.dispose();
    }
  }
}
