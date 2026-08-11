export const TEST_GIT_CONFLICT_STATE = {
  baseCommit: "a".repeat(40),
  currentHead: "b".repeat(40),
  expectedAncestry: [],
  sequencer: {
    kind: "rebase-merge",
    identity: "c".repeat(64),
    headName: "refs/heads/implement/T2043",
    originalTip: "d".repeat(40),
    onto: "e".repeat(40),
    stoppedCommit: "f".repeat(40),
    currentCommand: `pick ${"f".repeat(40)} task change`,
    todoDigest: "a".repeat(64),
    doneDigest: "b".repeat(64),
  },
  conflicts: [{ path: "conflict.txt", stage: 1, mode: "100644", oid: "f".repeat(40) }],
} as const;
