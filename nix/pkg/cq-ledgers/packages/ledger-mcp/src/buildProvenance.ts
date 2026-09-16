import { PACKAGED_BUILD_COMMIT } from "./buildProvenance.gen.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;

function assertFullBuildCommit(commit: string, source: string): void {
  if (commit.includes("dirty")) throw new Error(`${source} build provenance is dirty`);
  if (!FULL_SHA.test(commit)) throw new Error(`${source} build provenance is malformed`);
}

export function resolveImplementationEvidenceBuildCommit(
  packagedBuildCommit: string | undefined,
  trustedSourceWorkspaceBuildCommit: string | undefined,
): string {
  if (packagedBuildCommit !== undefined) {
    assertFullBuildCommit(packagedBuildCommit, "packaged");
    if (
      trustedSourceWorkspaceBuildCommit !== undefined &&
      trustedSourceWorkspaceBuildCommit !== packagedBuildCommit
    ) {
      throw new Error(
        "trusted source-workspace build provenance cannot substitute packaged provenance",
      );
    }
    return packagedBuildCommit;
  }
  if (trustedSourceWorkspaceBuildCommit === undefined) {
    throw new Error("packaged implementation-evidence build provenance is unavailable");
  }
  assertFullBuildCommit(trustedSourceWorkspaceBuildCommit, "trusted source-workspace");
  return trustedSourceWorkspaceBuildCommit;
}

export function implementationEvidenceBuildCommit(
  trustedSourceWorkspaceBuildCommit: string | undefined,
): string {
  return resolveImplementationEvidenceBuildCommit(
    PACKAGED_BUILD_COMMIT,
    trustedSourceWorkspaceBuildCommit,
  );
}
