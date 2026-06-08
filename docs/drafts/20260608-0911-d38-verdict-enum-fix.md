# D38 fix — why a paraphrased verdict can no longer silently mis-gate

**Defect D38:** a Pi-dispatched cq reviewer child returned `verdict:"fail"` instead of the
plan-review rubric's `go-ahead|revise`. The value parsed cleanly but matched neither
reconcile branch, so it was silently mis-gated. Root cause confirmed in hypothesis **H27**;
fix planned under goal **G31** (milestone M96, tasks T240–T244).

## The two complementary fix layers

1. **Producer side — reinforce the enum on the Pi path** (T240).
   `nix/pkg/llm-contexts/pi-context.md`, "Dispatching cq subagents" section, new bullet
   after "Emit the tool CALL": a dispatched cq child whose rubric defines a `verdict`
   field MUST emit the EXACT canonical enum literal — `go-ahead`/`revise` for plan-review,
   `approve`/`disapprove` for implement-review — never a paraphrase/synonym (never `fail`,
   `pass`, `ok`, `reject`). The verdict is a CLOSED enum, not free text.

2. **Consumer side — orchestrator fail-loud off-enum → abstention** (T241 + T242).
   - `nix/pkg/cq-assets/commands/cq/plan/advance.md` (T241), new "Off-enum verdict ⇒
     ABSTENTION" step in §2b-i (after the fence-strip parse + the existing abstention
     rule, BEFORE the reconcile string-equality §ii): a `verdict` not exactly in
     `{go-ahead, revise}` is treated as an ABSTENTION (dropped from the panel, logged with
     alias + raw value + cause). No synonym normalization/coercion — off-enum is fail-loud,
     never silently recovered.
   - `nix/pkg/cq-assets/commands/cq/implement/advance.md` (T242), structurally identical
     step in §3c (after the quorum-floor bullet, BEFORE the strictest-wins Verdict bullet):
     a `verdict` not exactly in `{approve, disapprove}` is treated as an ABSTENTION.

## The pre-fix silent mis-gate chain (four steps)

1. The Pi child paraphrases the verdict, e.g. emits `verdict:"fail"`.
2. The orchestrator fence-strips and parses the JSON — it **parses** fine (all contract
   keys present), so the abstention rule (which keyed only on *parseability*) does NOT drop
   it.
3. The reconcile step compares the verdict by bare string-equality against the enum
   literals — `"fail"` equals neither `go-ahead`/`approve` (the all-approve branch) nor
   `revise`/`disapprove` (the any-dissent branch).
4. Matching **no** reconcile branch, the off-enum value is silently mis-gated — the panel's
   verdict is computed as if that reviewer's stance were undefined, with no error.

## Why the chain is now broken (both enums, both dispatch paths)

The break point is **step 2 → step 3**: the new validation step runs *after* parse but
*before* reconcile, and reclassifies any non-enum-literal `verdict` from
"parseable-and-surviving" to **abstention (dropped + logged)**. An off-enum value therefore
never reaches the reconcile string-equality of step 3 — it is dropped+logged at the
validation step instead of silently surviving. A reviewer reading
plan/advance.md (the new §2b-i bullet) or implement/advance.md (the new §3c bullet) can
point to exactly that line.

D38's root cause is **path-independent** — it names two routes. Both are now closed:

- **`dispatch_agent` child path** (the T227 demo path): closed by **layer 1** (T240) — the
  pi-context.md reinforcement makes a conformant child emit the literal enum, so the
  producer no longer paraphrases.
- **Direct `pi -p` reviewer-panel path** (the path the plan/implement orchestrators
  actually gate on, K30): closed by **layer 2** (T241/T242) — even if a non-conformant
  child still paraphrases, the orchestrator drops the off-enum verdict as an abstention
  before reconcile.

Both the plan-review enum (`go-ahead|revise`) and the implement-review enum
(`approve|disapprove`) are covered (T241 and T242 respectively; T240 names both).

## Verification (T243)

- `bun run check` (from `nix/pkg/cq-ledgers/`): 1037 pass / 1 skip / 0 fail; tsc + eslint
  clean.
- `nix build .#llm-contexts .#llm-context-with-env .#llm-skills` (repo root): all exit 0
  (`llm-contexts` rebuilt with the T240 pi-context.md edit). `nix/pkg/cq-assets` is
  eval-time-only (read via `assets.nix` `readFile`/`readDir` into the flake-level
  `llmAssets`), so the T241/T242 markdown edits have no per-file build target; `bun run
  check` is their substantive guard and the grep-style acceptance the per-task reviews
  verified.
