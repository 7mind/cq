import { constants as fsConstants, promises as fs } from "node:fs";

export interface Arguments {
  readonly candidate: string;
  readonly credentialFile: string;
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string;
  readonly head: string;
  readonly recoveryRef: string;
}

interface FileStatus {
  readonly mode: number;
  readonly uid: number;
  readonly dev: number;
  readonly ino: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface CredentialFileHandle {
  stat(): Promise<FileStatus>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface CredentialRuntime {
  getuid(): number;
  lstat(file: string): Promise<FileStatus>;
  open(file: string, flags: number): Promise<CredentialFileHandle>;
}

const nodeCredentialRuntime: CredentialRuntime = {
  getuid: () => {
    const getuid = process.getuid;
    if (getuid === undefined) throw new Error("current runtime does not expose getuid");
    return getuid.call(process);
  },
  lstat: (file) => fs.lstat(file),
  open: (file, flags) => fs.open(file, flags),
};

export const GUARDED_REBASE_PROBE_REJECTION = {
  path: "input.baseCommit",
  detail: "guarded rebase continuation requires baseCommit to equal the journaled ontoCommit",
} as const;

function required(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index < 0 ? undefined : arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

export function parseArguments(arguments_: readonly string[]): Arguments {
  return {
    candidate: required(arguments_, "--candidate"),
    credentialFile: required(arguments_, "--credential-file"),
    repository: required(arguments_, "--repository"),
    worktree: required(arguments_, "--worktree"),
    branch: required(arguments_, "--branch"),
    head: required(arguments_, "--head"),
    recoveryRef: required(arguments_, "--recovery-ref"),
  };
}

function isSecureCredential(status: FileStatus, uid: number): boolean {
  return (
    status.isFile() &&
    !status.isSymbolicLink() &&
    status.uid === uid &&
    (status.mode & 0o777) === 0o600
  );
}

export async function readCredential(
  file: string,
  runtime: CredentialRuntime = nodeCredentialRuntime,
): Promise<string> {
  const before = await runtime.lstat(file);
  const uid = runtime.getuid();
  if (!isSecureCredential(before, uid)) {
    throw new Error("credential file is not a regular mode-0600 file owned by this user");
  }
  const handle = await runtime.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !isSecureCredential(opened, uid)
    ) {
      throw new Error("credential file changed during secure no-follow open");
    }
    const value = new TextDecoder().decode(await handle.readFile()).trim();
    if (value.length === 0) throw new Error("credential file is empty");
    return value;
  } finally {
    await handle.close();
  }
}

export function sanitizeUniqueTypedRejection(
  decision: Readonly<Record<string, unknown>>,
  opaqueReference: string,
): Readonly<{ path: string; detail: string }> {
  const hasCapabilityField = Object.keys(decision).some((key) =>
    key.toLowerCase().includes("capability"),
  );
  if (
    decision["accepted"] !== false ||
    decision["allocated"] !== false ||
    decision["path"] === "guardedRebase" ||
    typeof decision["path"] !== "string" ||
    typeof decision["detail"] !== "string" ||
    Object.hasOwn(decision, "handle") ||
    Object.hasOwn(decision, "prepared") ||
    hasCapabilityField
  ) {
    throw new Error("probe observed generic rejection or accidental admission");
  }
  if (decision["detail"].includes(opaqueReference)) {
    throw new Error("probe observed a rejection detail containing the guarded-rebase reference");
  }
  if (
    decision["path"] !== GUARDED_REBASE_PROBE_REJECTION.path ||
    decision["detail"] !== GUARDED_REBASE_PROBE_REJECTION.detail
  ) {
    throw new Error("probe observed an unrelated typed rejection");
  }
  return { path: decision["path"], detail: decision["detail"] };
}
