# Defects found during the defect-reduction pass (2026-09-24)

Filed here because generic `create_item` on `defects` is denied under this
project's restrictive workset roots, and the `defect-intake` exemption that
permits it exists in this tree but not in the packaged `cq` the MCP server runs.
Each entry is verified by a command whose output is quoted, not inferred.

---

## 1. The pi-extensions test suite is not reachable from the project gate

**Severity:** high. **Tags:** gate, test-coverage, pi, workspace.

`bun run check` runs from `nix/pkg/cq-ledgers`, so the four test files under
`nix/pkg/pi-extensions/` are never executed by it:

    $ ls nix/pkg/pi-extensions/*.test.ts | wc -l
    4
    $ grep -c 'pi-extensions/cq-subagent' <full gate log>
    0

Those files cover the dispatch extension, its native session seam, its process
lifecycle, and a provider retry path — the runtime half of the Pi dispatch
contract. This is not hypothetical: it is why `defects:D399` survived, and
`piRefFirstDispatch.test.ts` already carries a comment acknowledging the gap
("Guard lives HERE (D183): `nix/pkg/pi-extensions/` tests are not in `bun run
check`"), so the workaround has been applied per-guard instead of fixed once.

**Fix direction:** either add the directory to the gate (it has its own
`package.json`/`tsconfig.json` and `bun.lock`, so a second `bun test` invocation
is the cheap form) or fold it into the workspace. A `§6a` form (b) subprocess
guard per concern, which is what D399 and D183 both resorted to, does not scale.

---

## 2. `CQ_SUBAGENT` is an undefined token in production prompts

**Severity:** medium. **Tags:** prompt-contract, dispatch, claude.

    $ grep -rn "CQ_SUBAGENT" nix/pkg/cq-assets/ | grep -v '.generated' \
        | grep -vc "fragments/(claude|pi|codex)/(subagent-dispatch|implement-dispatch-workflow).md"
    0

The token appears in six fragments across all three surfaces and is defined in
none of them. Pi and Codex name a concrete transport alongside it
(`dispatch_agent(...)`, "`spawn_agent` transport"), so the parent can act. The
Claude fragment writes `CQ_SUBAGENT(role:, handle:, model:)` as if it were a
callable, and the only clue to what it really is are the `isolation:` and
`run_in_background:` arguments — parameters of the native `Agent` tool.

`defects:D402` made the surrounding prose truthful about what that transport can
do, but did not define the token. A parent still has to infer its host call.

**Fix direction:** map `CQ_SUBAGENT` in each surface's host-tool-vocabulary
fragment, the way `ledger::*` operational tokens already are.

---

## 3. `tasks:T2345` holds orphaned live worktree authority

**Severity:** medium. **Tags:** managed-worktree, recovery-seal, live-state.

    current.json -> generations/<gen>.json records[0].status = "live"
    branch = implement/T2345
    git worktree list | grep -c refs/heads/implement/T2345  ->  0

A live generation whose worktree Git no longer registers. It also carries a
`committed` current-recovery seal with a `parent-lost` source. `defects:D435`'s
classifier now reports this through `orphanedAuthority` instead of leaving it
buried in the registry, but nothing terminalizes it — that is an operator action
through guarded lifecycle operations, not a code change.

Eight further tasks (T2346, T2818, T2821, T2844, T2850, T2851, T6573, T6580)
have live generations WITH registered worktrees, reported as
`pendingWorktreeDisposal`. Those are healthy; only T2345 is orphaned.

---

## 4. The native dispatch transport machinery has no production consumer

**Severity:** medium. **Tags:** dispatch, dead-code, qualification.

    buildPositiveOnlyDispatchRegistry    production consumers outside its own module: 0
    createPiNativeDispatchAdapter        production consumers outside its own module: 0
    createClaudeNativeDispatchAdapter    production consumers outside its own module: 0
    createClaudeProcessDispatchAdapter   production consumers outside its own module: 0

All four are exercised only by tests. `createClaudeProcessDispatchAdapter` is
the print bridge that `researches:RS14` showed already implements the strong
tool boundary — a per-tool positive allow-list on a child-owned,
profile-narrowed server — and nothing routes to it.

This is recorded inside `defects:D402`'s residual, but it deserves its own item:
it is the starting point for that residual, and qualified, tested transport code
that nothing selects is itself a hazard (it looks like coverage and is not).

---

## 5. `managedWorktreeHandleSegment()` is a dead export

**Severity:** low. **Tags:** dead-code.

    nix/pkg/cq-ledgers/packages/ledger/src/index.ts:427       (re-export)
    nix/pkg/cq-ledgers/packages/ledger/src/managedWorktree.ts:4487  (definition)

No other consumer. Left in place per the repo's "mention, don't delete"
convention for pre-existing dead code; it was touched during `defects:D404` only
because the constant it returned changed.

---

## Process observation, not a defect

Branch `defect-reduction-pass` carried a RED gate before this pass began, from
two independent causes: a stale pinned Node version and tool-surface evidence
left unregenerated by `6950aa324`. Bisecting placed the first stale commit
exactly at `6950aa324`, which means commits were landed without a full
`bun run check`. Both are fixed (`27fd95a77`, `619e66bbe`).
