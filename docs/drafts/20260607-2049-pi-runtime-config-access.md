# T228 — Pi dispatch extension: runtime config-access strategy (cq.toml [tiers]/[agent_tiers])

**Task:** T228 (M89) · **Goal:** G28 · **Decision:** K46 (locked) · status: design note (backing for K46)

## Problem
The cq subagent-dispatch extension (T224) is a **standalone store-path `.ts`** loaded by the
vendored pi-coding-agent runtime via `programs.pi.settings.extensions`. It is **not** part of the
`nix/pkg/cq-ledgers` Bun workspace, so it **cannot** rely on workspace-relative imports
(`@cq/config`, `@cq/ledger`) being resolvable at runtime. It must still read the cq.toml
`[tiers]` + `[agent_tiers]` tables that T223 added (to resolve a dispatched agent NAME → tier →
provider+model).

## Options
- **(A) Locate + parse cq.toml directly — CHOSEN.** The extension finds the project root and parses
  cq.toml itself, with no cross-workspace import.
- (B) Cross-workspace import of a built `@cq/config` module from a store path — REJECTED: the
  standalone-store-path loader (jiti) does not give the extension the workspace's module graph; the
  two existing `nix/pkg/pi-extensions/*.ts` use only type-only imports + the `pi` runtime object.
- (C) Inline the resolved map at Nix build time — REJECTED: it would bake cq.toml values into the
  Nix store and break the "edit cq.toml, re-resolve at runtime" expectation.

## Decision (Route A) — the contract T224/T225 implement against, WITHOUT re-deciding
1. **Finding cq.toml:** the extension reads env var **`CQ_CONFIG`** if set (absolute path to the
   toml); else **`$CQ_PROJECT_ROOT/cq.toml`**; else falls back to **`process.cwd()/cq.toml`**.
   `CQ_PROJECT_ROOT` (and `CQ_CONFIG`) are set on the **`piWrapped`** wrapper in `nix/hm/dev-llm.nix`,
   **alongside `CQ_AGENTS_DIR`** from T222 (one consistent env-injection site). If no cq.toml is
   found, the extension does NOT fail — it falls back to the parent session's active model (the
   documented default from T225).
2. **TOML reader:** an **inlined, dependency-free reader for the flat-string-table subset** cq.toml
   uses (`[table]` headers + `key = "value"` lines, `#` comments) — `[aliases]`, `[tiers]`,
   `[agent_tiers]` are all flat string→string tables, so a ~30-line parser is sufficient and avoids
   any runtime dependency the standalone extension can't guarantee. (Do NOT import `smol-toml`: it is
   a workspace dep of `@cq/config`, not resolvable from the store-path extension.)
3. **Shared resolution helper:** the agent-name → tier → provider+model logic is **inlined as a tiny
   dependency-free helper inside the extension** (mirroring `@cq/config`'s `resolveAgentTier` /
   `resolveTierToken` / `resolveAgentModel`, but copied — NOT imported). It is small (lookup in
   `agent_tiers` with a documented default tier → lookup in `tiers` → split the `<harness>:<model>`
   token). T224 implements it; T225 reuses the SAME helper. Because the canonical logic also lives in
   `@cq/config` (tested by T223), the two must stay behaviorally identical — T224's tests assert the
   inlined helper matches `@cq/config`'s resolution on the same cq.toml.

## Consumption contract (verbatim, for T224/T225 — cite K46, do not re-decide)
> The extension reads `$CQ_CONFIG` (default `$CQ_PROJECT_ROOT/cq.toml`, final fallback
> `process.cwd()/cq.toml`), parses `[tiers]` + `[agent_tiers]` with an **inlined flat-table TOML
> reader**, and resolves a dispatched agent NAME → tier (via `[agent_tiers]`, default `standard`) →
> provider+model (via `[tiers]`, value is an `[aliases]` name or a direct `<harness>:<model>` token)
> via an **inlined dependency-free resolver helper**. Missing cq.toml / unlisted agent / absent
> table → fall back to the parent pi session's active model.
