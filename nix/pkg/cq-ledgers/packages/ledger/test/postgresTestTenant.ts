import type { SQL } from "bun";

/** Remove one throwaway tenant in FK order without weakening production erase admission. */
export async function dropTenant(admin: SQL, projectKey: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM workset_admissions WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM workset_roots WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM work_cohort_state WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM implementation_completion_bindings WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM plan_operations WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM plan_claims WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM mcp_usage_stats WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM archived_items WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM archive_pointers WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM items WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM groups WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM ledgers WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM logs WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM projects WHERE project_key = ${projectKey}`;
  });
}
