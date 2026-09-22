/**
 * Closed wire contract for handles minted by worktree_manage.
 *
 * Version 1 retains UUIDv7 path placement. Version 2 represents an adopted
 * task worktree whose path predates the registry identity: worktreeId remains
 * an opaque UUIDv7, while task/path/branch/repository identity is canonical.
 */

import type { CohortWorktreeIdentityV1 } from "./cohortEffectEnvelope.js";

export const MANAGED_WORKTREE_HANDLE_KIND = "cq-managed-worktree-handle" as const;

const HANDLE_KEYS = [
  "kind",
  "version",
  "token",
  "worktreeId",
  "taskId",
  "branch",
  "repositoryRoot",
  "absolutePath",
  "baseCommit",
  "createdAt",
  "nonce",
] as const;

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^T\d+$/;
const FULL_COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COHORT_KEYS = ["kind", "version", "cohortId", "definitionDigest", "candidateIntentDigest", "memberSetDigest", "memberAuthorities"] as const;
const MEMBER_AUTHORITY_KEYS = ["taskRef", "taskRevision", "goalRef", "finalizedManifestDigest", "authorityRevision"] as const;

interface ManagedWorktreeHandleFields {
  readonly kind: typeof MANAGED_WORKTREE_HANDLE_KIND;
  readonly token: string;
  readonly worktreeId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  readonly absolutePath: string;
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly nonce: string;
}

/** Original UUID-path handle. Its wire fields and placement remain unchanged. */
export interface ManagedWorktreeHandleV1 extends ManagedWorktreeHandleFields {
  readonly version: 1;
}

/** Adopted task-path handle; worktreeId identifies the registry record, not the basename. */
export interface ManagedWorktreeHandleV2 extends ManagedWorktreeHandleFields {
  readonly version: 2;
}

export interface ManagedWorktreeHandleV3 extends Omit<ManagedWorktreeHandleFields, "taskId"> {
  readonly version: 3;
  readonly cohort: CohortWorktreeIdentityV1;
}

export type ManagedTaskWorktreeHandle = ManagedWorktreeHandleV1 | ManagedWorktreeHandleV2;
export type ManagedWorktreeHandle = ManagedTaskWorktreeHandle | ManagedWorktreeHandleV3;

export type ManagedWorktreeHandleValidation =
  | { readonly status: "valid"; readonly handle: ManagedWorktreeHandle }
  | {
      readonly status: "invalid";
      readonly reason: "handle-invalid" | "handle-foreign" | "handle-path-traversal";
      readonly detail: string;
    };

function normalizeAbsolutePath(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  if (slashed === "/" || /^[A-Za-z]:\/$/.test(slashed)) return slashed;
  return slashed.replace(/\/+$/, "");
}

function hasTraversal(value: string): boolean {
  return normalizeAbsolutePath(value).split("/").includes("..");
}

function closedKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function cohortShapeValid(value: unknown): value is CohortWorktreeIdentityV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (!closedKeys(record, COHORT_KEYS) || record["kind"] !== "cq-cohort-worktree-identity" || record["version"] !== 1 ||
      typeof record["cohortId"] !== "string" || record["cohortId"].trim() === "" ||
      !["definitionDigest", "candidateIntentDigest", "memberSetDigest"].every((key) => typeof record[key] === "string" && SHA256_RE.test(record[key]))) return false;
  const members = record["memberAuthorities"];
  if (!Array.isArray(members) || members.length === 0) return false;
  const taskRefs = new Set<string>();
  for (const value of members as readonly unknown[]) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const member = value as Readonly<Record<string, unknown>>;
    if (!closedKeys(member, MEMBER_AUTHORITY_KEYS) || typeof member["taskRef"] !== "string" ||
        !/^tasks:T\d+$/.test(member["taskRef"]) || typeof member["goalRef"] !== "string" || !/^goals:G\d+$/.test(member["goalRef"]) ||
        !["taskRevision", "finalizedManifestDigest", "authorityRevision"].every((key) => typeof member[key] === "string" && SHA256_RE.test(member[key])) ||
        taskRefs.has(member["taskRef"])) return false;
    taskRefs.add(member["taskRef"]);
  }
  return true;
}

function commonShapeValid(record: Readonly<Record<string, unknown>>): boolean {
  return (
    record["kind"] === MANAGED_WORKTREE_HANDLE_KIND &&
    (record["version"] === 1 || record["version"] === 2 || record["version"] === 3) &&
    typeof record["token"] === "string" &&
    record["token"].trim().length > 0 &&
    typeof record["worktreeId"] === "string" &&
    UUIDV7_RE.test(record["worktreeId"]) &&
    (record["version"] === 3 ? cohortShapeValid(record["cohort"]) :
      typeof record["taskId"] === "string" && TASK_ID_RE.test(record["taskId"])) &&
    typeof record["branch"] === "string" &&
    record["branch"].length > 0 &&
    typeof record["repositoryRoot"] === "string" &&
    record["repositoryRoot"].length > 0 &&
    typeof record["absolutePath"] === "string" &&
    record["absolutePath"].length > 0 &&
    typeof record["baseCommit"] === "string" &&
    FULL_COMMIT_SHA_RE.test(record["baseCommit"]) &&
    typeof record["createdAt"] === "string" &&
    record["createdAt"].length > 0 &&
    typeof record["nonce"] === "string" &&
    record["nonce"].trim().length > 0
  );
}

/** Validate the closed version union and its self-contained placement identity. */
export function validateManagedWorktreeHandle(
  value: unknown,
  expectedRepositoryRoot?: string,
): ManagedWorktreeHandleValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid", reason: "handle-invalid", detail: "handle must be an object" };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = record["version"] === 3 ? [...HANDLE_KEYS.filter((key) => key !== "taskId"), "cohort"] : HANDLE_KEYS;
  if (!closedKeys(record, keys) || !commonShapeValid(record)) {
    return {
      status: "invalid",
      reason: "handle-invalid",
      detail: "handle does not match the closed task or cohort version shape",
    };
  }

  const handle = record as unknown as ManagedWorktreeHandle;
  if (
    handle.repositoryRoot.includes("\0") ||
    handle.absolutePath.includes("\0") ||
    !ABSOLUTE_PATH_RE.test(handle.repositoryRoot) ||
    !ABSOLUTE_PATH_RE.test(handle.absolutePath) ||
    hasTraversal(handle.repositoryRoot) ||
    hasTraversal(handle.absolutePath)
  ) {
    return {
      status: "invalid",
      reason: "handle-path-traversal",
      detail: "repositoryRoot and absolutePath must be absolute traversal-free paths",
    };
  }

  const repositoryRoot = normalizeAbsolutePath(handle.repositoryRoot);
  if (
    expectedRepositoryRoot !== undefined &&
    normalizeAbsolutePath(expectedRepositoryRoot) !== repositoryRoot
  ) {
    return {
      status: "invalid",
      reason: "handle-foreign",
      detail: "handle repositoryRoot differs from the expected repository",
    };
  }

  const absolutePath = normalizeAbsolutePath(handle.absolutePath);
  const managedParent = `${repositoryRoot}/.claude/worktrees`;
  if (!absolutePath.startsWith(`${managedParent}/`)) {
    return {
      status: "invalid",
      reason: handle.version === 1 ? "handle-path-traversal" : "handle-foreign",
      detail: "handle absolutePath lies outside its repositoryRoot",
    };
  }

  if (handle.version === 1 || handle.version === 3) {
    if (absolutePath !== `${managedParent}/${handle.worktreeId}`) {
      return {
        status: "invalid",
        reason: "handle-path-traversal",
        detail: `version ${handle.version} absolutePath basename must equal worktreeId`,
      };
    }
    if (handle.version === 3 && handle.branch !== `implement/cohort-${handle.cohort.candidateIntentDigest}`) {
      return { status: "invalid", reason: "handle-invalid", detail: "cohort branch must bind its exact candidate intent" };
    }
    return { status: "valid", handle };
  }

  const expectedBranch = `implement/${handle.taskId}`;
  const expectedPath = `${managedParent}/implement-${handle.taskId}`;
  if (handle.branch !== expectedBranch || absolutePath !== expectedPath) {
    return {
      status: "invalid",
      reason: "handle-invalid",
      detail:
        `version 2 requires branch ${expectedBranch} and adopted path ${expectedPath}`,
    };
  }
  return { status: "valid", handle };
}

export function isManagedWorktreeHandle(value: unknown): value is ManagedWorktreeHandle {
  return validateManagedWorktreeHandle(value).status === "valid";
}

export type ManagedTaskWorktreeHandleValidation =
  | { readonly status: "valid"; readonly handle: ManagedTaskWorktreeHandle }
  | Extract<ManagedWorktreeHandleValidation, { readonly status: "invalid" }>;

export function validateManagedTaskWorktreeHandle(value: unknown, expectedRepositoryRoot?: string): ManagedTaskWorktreeHandleValidation {
  const validation = validateManagedWorktreeHandle(value, expectedRepositoryRoot);
  if (validation.status === "invalid") return validation;
  if (validation.handle.version === 3) {
    return { status: "invalid", reason: "handle-invalid", detail: "task worktree operation cannot consume a cohort handle" };
  }
  return { status: "valid", handle: validation.handle };
}

export function isManagedTaskWorktreeHandle(value: unknown): value is ManagedTaskWorktreeHandle {
  return validateManagedTaskWorktreeHandle(value).status === "valid";
}

export function managedWorktreeHandlesEqual(
  left: ManagedWorktreeHandle,
  right: ManagedWorktreeHandle,
): boolean {
  if (left.version === 3 || right.version === 3) {
    if (left.version !== 3 || right.version !== 3) return false;
    return HANDLE_KEYS.filter((key) => key !== "taskId").every((key) => left[key] === right[key]) &&
      COHORT_KEYS.filter((key) => key !== "memberAuthorities").every((key) => left.cohort[key] === right.cohort[key]) &&
      left.cohort.memberAuthorities.length === right.cohort.memberAuthorities.length &&
      left.cohort.memberAuthorities.every((member, index) => MEMBER_AUTHORITY_KEYS.every((key) => member[key] === right.cohort.memberAuthorities[index]![key]));
  }
  return HANDLE_KEYS.every((key) => left[key] === right[key]);
}
