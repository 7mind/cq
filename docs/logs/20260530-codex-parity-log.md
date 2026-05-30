# Codex-parity cycle (codexwf) — session log

Date: 2026-05-30
Branch: `codex-parity` (worktree off main `bfa8717`)
Closes: **WF-D01** — `/plan` WorkflowRuntime now works on Codex models.

## Problem

`/plan` worked on Claude but not Codex. The Claude producer + phase subagents
force structured output via in-process harness-owned `submit_*` MCP tools (the
model calls `submit_plan` etc.; the harness validates + writes ledgers). The
Codex SDK `@openai/codex-sdk@0.134.0` (`Thread.runStreamed`) has NO in-process
forced-tool mechanism; its only MCP surface is the standalone `cq-mcp` stdio
binary. Approved mechanism (option a): expose a harness-owned `submit_*` tool
through cq-mcp that RELAYS the structured payload to the cq server over the
internal-WS channel (the askproxy pattern), where the WorkflowRuntime validates
+ writes — so the HARNESS still owns every ledger write; cq-mcp never writes
ledgers for the submit tool.

## Mechanism shipped

1. **internalProtocol** (`packages/shared`): new Zod variants `workflow.submit
   { submitId, phase, payload }` (cq-mcp → server) and `workflow.submit_ack
   { submitId, ok, error? }` (server → cq-mcp). `WorkflowSubmitPhase` enum
   (`produce`/`clarify_review`/`plan`/`plan_review`). sourcePid loop-guard.
2. **cq-mcp** (`packages/cq-mcp`): `CqMcpSubmitBroker` (submitId-keyed two-slot
   race machine, mirrors `CqMcpAskBroker`) + a single harness-owned
   `submit_workflow_phase` tool, registered ONLY when the workflow env
   (`CQ_WORKFLOW_SUBMIT_ID` + `CQ_WORKFLOW_PHASE`) is present. The handler relays
   the model's `payload` upstream, parks on the broker, returns ok / isError on
   the ack. It takes NO ledger store — relay only.
3. **WorkflowSubmitProxy** (`packages/server/src/workflow`): the server side.
   `register(submitId, phase, schema)` parks a typed promise; `onSubmit`
   correlates submitId → dispatch, asserts the relayed phase matches, validates
   `payload` against the phase schema, resolves on success (the runtime writes
   the ledgers) + acks ok, or acks `{ok:false,error}` on a malformed payload
   WITHOUT writing (the dispatch stays pending for a resubmit). `reject` on
   teardown.
4. **codexHeadless** (`dispatchCodexPhase`): the headless Codex lane (analogue of
   `headlessQuery.ts`). Registers the correlation BEFORE starting the thread,
   spawns a headless Codex thread (own `Codex` instance — never the pool=1
   interactive Bridge) with `config.mcp_servers.cq` primed via env, awaits the
   relayed+validated payload, always `proxy.reject(submitId)` on teardown.
   `CodexProducer`/`CodexPhaseSubagent` are thin wrappers.
5. **server.ts**: constructs the `WorkflowSubmitProxy` (sendAck → broadcast),
   registers the `workflow.submit` handler, and wires the Codex producer/subagent
   with a lazily-read `internalWsUrl` (set after bind) + a per-process submitId
   generator.

## Key empirical finding (headless lane)

The first real-Codex run failed: the model DID call `submit_workflow_phase`, but
the Codex CLI auto-CANCELLED it (`"user cancelled MCP tool call"`). Cause: in the
headless `exec` lane the CLI's default approval policy / non-`danger` sandbox
gates MCP tool calls and, with no approver, cancels them. Fix:
`approvalPolicy="never"` + `sandboxMode="danger-full-access"` on the headless
thread (the same combination the proven `codex-mcp-roundtrip` e2e uses). After
that the model's submit lands and the goal is written to disk.

## Real-Codex reliability (observed)

- The model RELIABLY calls `submit_workflow_phase` (13/13 phase dispatches in a
  long run; producer + clarify-reviewer both reach their ledger effect).
- It typically makes ONE malformed first attempt (spreads the result's fields as
  separate tool args / flattens `goal` to a string) then RESUBMITS a correct
  payload after the proxy's `ack{ok:false,error}` — so the resubmit-on-validation-
  failure path is load-bearing and proven against a real model.
- Full loop convergence to `planned` is NOT asserted against real Codex: the
  real clarify-reviewer is a model judgement (observed perpetually-unsatisfied
  with a generic answer batch — NOT a relay defect). Convergence is the
  deterministic fake-driven test; the real-Codex tests prove the relay + the
  producer/phase-subagent paths reach disk.

## Manual scenario (equivalent, captured)

The auth-gated server-integration test drives the SAME path as `bun run dev` +
selecting a Codex model + `/plan <text>` (`workflow.startPlan({platform:"codex"})`
→ real CodexProducer → real cq-mcp child → relay → proxy → HARNESS write).
Captured run (`CQ_RUN_CODEX_REAL=1 CODEX_HOME=$HOME/.codex`):

```
workflowSubmit.invalid_payload {submitId: wfsubmit-…-1, phase: produce, error: goal expected object, received string}
workflowSubmit.accepted        {submitId: wfsubmit-…-1, phase: produce}
workflow.questions_ready       {goalId: G1, questionCount: 8}
```

Goal `G1` (status `clarifying`) + spec milestone + 8 questions landed on disk.
No `LedgerBusyError` (LOCK-D01 lockfile-wait holds for the concurrent
cq-server + cq-mcp child writes).

## PR commit list

- `codexwf-1` internalProtocol workflow.submit / workflow.submit_ack variants
- `codexwf-2` CqMcpSubmitBroker + cq-mcp submit_workflow_phase relay tool
- `codexwf-3` WorkflowSubmitProxy — server-side validate + ack
- `codexwf-4` headless Codex producer + phase subagent via the relay (WF-D01)
- `codexwf-5` real-Codex producer relay integration + cq-mcp relay e2e; +
  clarify-reviewer phase relay; + test gating (CQ_RUN_CODEX_REAL)
- docs: resolve WF-D01 in defects.md

## Discharge

- `bun run check` exit 0 TWICE, deterministic: **968 pass / 0 fail** (baseline
  928 + 40 new). The real-Codex tests auto-skip in the default suite (opt-in
  gate) so check stays hermetic.
- `bun run e2e` green TWICE: **24 passed** each run, ZERO `LedgerBusyError`
  (WFL-D02 ordering + LOCK-D01 lock-wait not regressed).
- `nix build .#default` exit 0; `result/bin/{cq,cq-mcp}` produced.
- cq-mcp `tools/list`: **13** standalone (`main.test`), **14** with the workflow
  env (`submitRelay.e2e.test` — 13 ledger tools + `submit_workflow_phase`).

## Invariants held (adversarial review)

1. The HARNESS writes every ledger on the Codex path — cq-mcp's submit tool takes
   no store and relays only; proven by the integration test's per-write tracking.
2. submitId correlation is sound under the ack/submit race + teardown (broker +
   proxy unit tests: submit-before-ack, ack-before-submit, reject-on-disconnect,
   unknown id acked false, teardown rejects the parked promise).
3. The headless Codex lane never touches pool=1 chat (own `Codex` instance;
   `workflow-codex-pool1-regression` proves interactive chat works mid-flight +
   on failure).
4. Per-phase validation rejects malformed Codex output loudly (`ack{ok:false}`)
   with NO half-written ledger (proxy test + relay-integration malformed test).
5. No `LedgerBusyError` when the Codex workflow's cq-mcp child and the cq server
   both write (LOCK-D01 lock-wait holds — confirmed across both e2e runs).
