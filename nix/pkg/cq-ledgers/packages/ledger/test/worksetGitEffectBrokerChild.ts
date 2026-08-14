import { runWorksetGitEffectGate, type WorksetGitEffectBinding } from "@cq/process-control";
import {
  createFsWorksetStore,
  worksetEffectAdmissionProviderFromStore,
} from "../src/index.js";

const repositoryRoot = process.argv[2];
const worktreePath = process.argv[3];
const ontoCommit = process.argv[4];
if (repositoryRoot === undefined || worktreePath === undefined || ontoCommit === undefined) {
  throw new Error("workset Git effect broker child: incomplete arguments");
}

const binding: WorksetGitEffectBinding = {
  kind: "rebase",
  targetRef: "tasks:T1984",
  repositoryRoot,
  worktreePath,
  ontoCommit,
};
const store = createFsWorksetStore({ root: repositoryRoot });
await runWorksetGitEffectGate({
  expected: binding,
  resolve: async () => binding,
  provider: worksetEffectAdmissionProviderFromStore(store),
  settlement: { termGraceMs: 10, killGraceMs: 1_000, pollIntervalMs: 2 },
});
