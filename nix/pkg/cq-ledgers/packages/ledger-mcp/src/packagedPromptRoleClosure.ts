import * as path from "node:path";

export type PromptSurface = "claude" | "codex" | "pi";

export function assertPackagedRoleClosure(
  surface: PromptSurface,
  roleRoot: string,
  expectedRoleIds: readonly string[],
  roleFiles: readonly string[],
): void {
  const expectedRoleFiles = expectedRoleIds
    .map((roleId) => path.join(roleRoot, `${roleId}.md`))
    .sort();
  const actualRoleFiles = [...roleFiles].sort();
  const expectedRoleSet = new Set(expectedRoleFiles);
  const actualRoleSet = new Set(actualRoleFiles);
  const missing = expectedRoleFiles.filter((filePath) => !actualRoleSet.has(filePath));
  const unexpected = actualRoleFiles.filter((filePath) => !expectedRoleSet.has(filePath));
  const exact =
    actualRoleFiles.length === expectedRoleFiles.length &&
    actualRoleFiles.every((filePath, index) => filePath === expectedRoleFiles[index]);
  if (!exact) {
    const display = (filePaths: readonly string[]): string =>
      filePaths.length === 0
        ? "none"
        : filePaths.map((filePath) => path.relative(roleRoot, filePath)).join(", ");
    throw new Error(
      `${surface} role closure failed: ${roleRoot}: missing ${display(missing)}; unexpected ${display(unexpected)}`,
    );
  }
}
