import {
  FINALIZED_IMPLEMENTATION_REVIEW_OUTCOME_CONTRACT,
  IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY,
  IMPLEMENTATION_EVIDENCE_SERVICE_PROTOCOL_VERSION,
} from "@cq/ledger";
import { withRemoteManagementClient } from "./remoteClient.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface ImplementationEvidenceStatusIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

interface ParsedStatusArgs {
  readonly cwd: string;
}

function valueAfter(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const prefix = `${name}=`;
  return argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

export function parseImplementationEvidenceStatusArgs(
  argv: readonly string[],
  processCwd: string,
): ParsedStatusArgs {
  if (argv[0] !== "implementation-evidence" || argv[1] !== "status")
    throw new Error("cq ledger: expected `implementation-evidence status`");
  if (!argv.includes("--json")) throw new Error("cq ledger implementation-evidence status requires --json");
  for (const name of ["--goal-ref", "--manifest-id", "--expected-head"]) {
    if (argv.some((entry) => entry === name || entry.startsWith(`${name}=`)))
      throw new Error(`${name} is service-derived and must not be supplied by the caller`);
  }
  const cwd = valueAfter(argv, "--cwd") ?? processCwd;
  return { cwd };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertImplementationEvidenceServiceStatus(value: unknown): asserts value is {
  readonly startupBuildCommit: string;
  readonly repositoryHead: string;
} {
  if (!object(value) || value["version"] !== 1)
    throw new Error("implementation evidence service returned a malformed status version");
  if (value["protocolVersion"] !== IMPLEMENTATION_EVIDENCE_SERVICE_PROTOCOL_VERSION)
    throw new Error("implementation evidence service protocol is not supported");
  if (
    typeof value["startupBuildCommit"] !== "string" ||
    !FULL_SHA.test(value["startupBuildCommit"]) ||
    typeof value["repositoryHead"] !== "string" ||
    !FULL_SHA.test(value["repositoryHead"])
  )
    throw new Error("implementation evidence service commit identity is malformed");
  if (
    typeof value["finalizedManifestDigest"] !== "string" ||
    !SHA256.test(value["finalizedManifestDigest"])
  )
    throw new Error("implementation evidence finalized manifest digest is malformed");
  if (
    JSON.stringify(value["operationInventory"]) !==
    JSON.stringify(IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY)
  )
    throw new Error("implementation evidence service operation inventory is incomplete");
  if (
    JSON.stringify(value["finalizedReviewOutcomeContract"]) !==
    JSON.stringify(FINALIZED_IMPLEMENTATION_REVIEW_OUTCOME_CONTRACT)
  )
    throw new Error("implementation evidence finalized-review outcome contract is unsupported");
  const inventory = value["packagedManifestInventory"];
  if (
    !Array.isArray(inventory) ||
    inventory.length === 0 ||
    !inventory.every((entry) => typeof entry === "string" && entry.length > 0)
  )
    throw new Error("implementation evidence packaged manifest inventory is malformed");
  const mappings = value["mappings"];
  if (
    !object(mappings) ||
    !["evidenceTaskRef", "historicalTaskRef", "activationTaskRef"].every(
      (name) => typeof mappings[name] === "string" && /^tasks:T[0-9]+$/u.test(mappings[name]),
    )
  )
    throw new Error("implementation evidence finalized task mappings are malformed");
}

export type ImplementationEvidenceStatusQuery = (cwd: string) => Promise<unknown>;

const queryRemoteImplementationEvidenceStatus: ImplementationEvidenceStatusQuery = async (cwd) =>
  await withRemoteManagementClient(cwd, async (client) =>
    await client.getImplementationEvidenceServiceStatus(),
  );

export async function runImplementationEvidenceStatus(
  argv: readonly string[],
  io: ImplementationEvidenceStatusIo,
  processCwd: string = process.cwd(),
  query: ImplementationEvidenceStatusQuery = queryRemoteImplementationEvidenceStatus,
): Promise<{ exitCode: number }> {
  let args: ParsedStatusArgs;
  try {
    args = parseImplementationEvidenceStatusArgs(argv, processCwd);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return { exitCode: 2 };
  }
  try {
    const status = await query(args.cwd);
    assertImplementationEvidenceServiceStatus(status);
    io.out(JSON.stringify(status));
    return { exitCode: 0 };
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}
