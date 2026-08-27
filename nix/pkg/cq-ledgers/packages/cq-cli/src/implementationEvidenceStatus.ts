import {
  createManagementLedgerStore,
  implementationEvidenceActivationStatusFromStore,
  nodeGitRunner,
} from "@cq/ledger";

const FULL_SHA = /^[0-9a-f]{40}$/u;

export interface ImplementationEvidenceStatusIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

interface ParsedStatusArgs {
  readonly cwd: string;
  readonly goalRef: string;
  readonly manifestId: string;
  readonly expectedHead: string;
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
  const goalRef = valueAfter(argv, "--goal-ref");
  const manifestId = valueAfter(argv, "--manifest-id");
  const expectedHead = valueAfter(argv, "--expected-head");
  const cwd = valueAfter(argv, "--cwd") ?? processCwd;
  if (goalRef === undefined || !/^goals:G[0-9]+$/u.test(goalRef))
    throw new Error("--goal-ref must be one canonical goals:G<n> ref");
  if (manifestId === undefined || manifestId.length === 0)
    throw new Error("--manifest-id requires a non-empty value");
  if (expectedHead === undefined || !FULL_SHA.test(expectedHead))
    throw new Error("--expected-head must be one full lowercase commit SHA");
  return { cwd, goalRef, manifestId, expectedHead };
}

export async function runImplementationEvidenceStatus(
  argv: readonly string[],
  io: ImplementationEvidenceStatusIo,
  processCwd: string = process.cwd(),
): Promise<{ exitCode: number }> {
  let args: ParsedStatusArgs;
  try {
    args = parseImplementationEvidenceStatusArgs(argv, processCwd);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return { exitCode: 2 };
  }
  const resolved = await createManagementLedgerStore(args.cwd);
  try {
    if (resolved.implementationEvidenceStore === undefined)
      throw new Error("protected implementation evidence store is unavailable");
    const head = await nodeGitRunner(args.cwd)(["rev-parse", "HEAD"]);
    if (head.code !== 0) throw new Error(`repository HEAD is unavailable: ${head.stderr.trim()}`);
    const repositoryHead = head.stdout.trim();
    if (repositoryHead !== args.expectedHead)
      throw new Error("repository HEAD does not match --expected-head");
    io.out(
      JSON.stringify(
        await implementationEvidenceActivationStatusFromStore(
          resolved.implementationEvidenceStore,
          {
            goalRef: args.goalRef,
            manifestId: args.manifestId,
            expectedRepositoryHead: args.expectedHead,
          },
          repositoryHead,
        ),
      ),
    );
    return { exitCode: 0 };
  } finally {
    await resolved.store.dispose();
  }
}
