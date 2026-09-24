# Follow-up defect record: supervised gate evidence records CQ's gate command regardless of what ran

Split out of `defects:D403` / `hypothesis:H310` while fixing the EXECUTION half.
Filed here rather than in the ledger because generic `create_item` on `defects`
is still denied under the project's restrictive workset roots — the
`defect-intake` exemption that permits it exists in this tree but the running
`cq` MCP server is the packaged (Nix) build, which predates it.

**Severity:** medium. **Tags:** gate, attestation, portability, implement-worker.
**Refs:** `defects:D403`, `hypothesis:H310`, `goals:G195`,
https://github.com/7mind/cq/issues/6

## What is now correct

`createNodeSupervisedWorkerGateRunner(settlement, gate)` executes the project's
resolved `[gate]`, and `createSingleProjectDispatchRuntime` resolves it from the
store's `configRoot`. A consumer project that declares

```toml
[gate]
  argv = ["npm", "test"]
```

has `npm test` executed at its worktree root.

## What is still wrong

The ATTESTATION LABEL recorded alongside that execution is still the fixed CQ
string:

- `packages/ledger/src/supervisedWorkerGate.ts` records
  `command: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND` in both the rejection
  details (~line 246) and the success evidence (~line 1096);
- `packages/ledger-mcp/src/dispatchCapability.ts` produces
  `gateCommand: IMPLEMENT_WORKER_CANONICAL_GATE_COMMAND` at two enqueue sites;
- `packages/cq-config/src/dispatchImplementationQueue.ts`
  (`enqueueImplementationCandidate`) and `packages/ledger/src/workCohortGate.ts`
  REFUSE anything but that constant;
- `taskSupervisedGateEvidenceSchema.command` pins it as a JSON-Schema `const`.

Consequence for a consumer project: the runner executes `npm test` at the
repository root while the stored evidence, the rejection record and the queue
binding all assert
`cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check`.
Both sides compare the same constant, so the mismatch never trips — the
attestation chain records a command that did not run, which is worse than
refusing.

## Reproduction status

NOT reproduced end to end. The observable path needs a supervised gate run under
a non-CQ `[gate]`, which the enqueue/receipt comparisons currently make
unreachable: they reject before evidence is stored. That unreachability is
itself part of the defect shape, and is why this is filed separately rather than
folded into the D403 fix.

## Fix direction

Thread the resolved `ProjectGateSpecification` through the evidence producers
and the two comparison sites: render the label with
`implementWorkerGateCommandLine(gate)` (which already exists for exactly this)
and compare against the gate the dispatch was PREPARED with, instead of against
a module constant. The `const` in `taskSupervisedGateEvidenceSchema` then has to
become a prepare-time binding rather than a fixed string.
