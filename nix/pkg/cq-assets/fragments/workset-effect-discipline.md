## Workset effect discipline

Before selecting an explicit target or batch, read
`workset({ op: "get", projection: "compact" })`. Empty persisted roots retain
the historical unrestricted behavior. With non-empty roots, its current graph
is authoritative: canonicalize every requested ref, require every explicit
target to be an active graph node, validate a complete batch before acting,
and reject the whole batch before its first effect when any target is absent.
Never fall back to the whole ledger when configured roots resolve only to
inactive nodes.

Every write uses the contextual public tool surface. Plan claim, publish,
release, and finalize use only `claim_plan`, `publish_plan_draft`,
`release_plan_claim`, and `finalize_plan`. Ordinary updates, archive, reopen,
and unarchive use their guarded public tools. Under restrictive roots, every
creation must name the selected owner through `create_item` arguments
`owner_ref` and `creation_kind`; reject the entire ownerless intake before its
first mutation. Use this owner matrix:

- idea → goal: `idea-to-goal`;
- goal → gate question/review/review defect/research/decision/handoff:
  `exact-gate-question`, `review`, `review-filed-defect`, `research`,
  `decision`, or `handoff`;
- defect → hypothesis/research/fix goal/handoff: `hypothesis`, `research`,
  `fix-goal`, or `handoff`;
- research → hypothesis/gate question/handoff: `hypothesis`,
  `exact-gate-question`, or `handoff`;
- task → implementation defect/research/gate question/handoff:
  `implementation-defect`, `research`, `exact-gate-question`, or `handoff`.

Children receive only a prepared typed input carrying exactly one canonical
goal, defect, research, or task id. The trusted host broker acquires one
admission before launch and retains it through observable completion and
descendant settlement; never place that capability or management credentials
in a prompt, argv, environment, transcript, result, or inline child context.
Use `worktree_manage` and `cq gate git-effect` for mutating worktree/Git effects;
raw stores, launchers, and mutating Git commands are forbidden.

Re-read `workset({ op: "get", projection: "compact" })` after every admitted
mutation or observable effect completion before selecting another target.
Administrative restore, reset, erase, migrate, or reinitialization never runs
from these flow contexts; only a dedicated trusted management constructor may
invoke it under an exclusive administrative admission.
