# T206 — G23 Phase 2 End-to-End Verification Notes

**Date:** 2026-06-07  
**Branch:** implement/T206  
**Base commit:** 8234adf2b31ebd3866c69cdc3af927449b052285 (main, includes T203/T204/T205)  
**Verified by:** sonnet-4-6 (implement-flow worker)

---

## 1. `bun run check` result

**Command:** `bun run check` from `/nix/pkg/cq-ledgers/`  
**Result:** GREEN — exit 0  
**Counts:** 1014 pass, 0 fail, 3285 expect() calls, 94 files (69.77s)

All three stages passed:
- `tsc -b` — no type errors
- `eslint .` — no lint errors
- `bun test` — 1014 tests, 0 failures

### New tests confirmed present and passing

The following test files introduced by T202–T205 were verified by running them individually (`bun test <files>`) — 20 pass, 0 fail:

| File | Tests | Status |
|---|---|---|
| `stateMachineTab.test.tsx` | 3 | PASS |
| `flowsTab.test.tsx` | 4 | PASS |
| `diagramLayout.test.ts` | 2 | PASS |
| `flowData.test.ts` | 6 | PASS |
| `dagView.test.tsx` | 4 | PASS |

---

## 2. Nix builds

### `nix build .#node-modules`

**Target:** main checkout at `/home/pavel/work/safe/flakes/cq` (commit 8234adf — same codebase as worktree; worktree adds only this verification doc)  
**Result:** EXIT=0  
**Note:** Git tree dirty warning shown (expected; worktree adds this doc). FOD hash `sha256-vCfIJBEcTWTcEQGWHo59PIAAcsSXxYX9w1CUsnmvd/Y=` is correct and unchanged.

### `nix build .#ledger-web`

**Target:** same main checkout at `/home/pavel/work/safe/flakes/cq`  
**Result:** EXIT=0  
**elkjs closure verified:** `result/share/ledger-web/packages/ledger-web/node_modules/elkjs/lib/elk.bundled.js` present in the Nix closure.

**Caveat on tree identity:** `nix build` was run from the main checkout (not the worktree path) because the flake lives at the repo root and cannot be directly invoked from a worktree path without modification. The `implement/T206` branch adds only this verification-notes document; all T203/T204/T205 code is on `main` (base commit `8234adf`), which is what the Nix build consumed. The code content is identical between the base and this branch for the ledger-web package.

---

## 3. Render smoke

### Ground-truth method

**Primary:** happy-dom render tests (`stateMachineTab.test.tsx`, `flowsTab.test.tsx`) — all assertions pass.  
**Secondary:** headless Chromium (nixpkgs `chromium-148.0.7778.215`) was used to confirm the `ledger-web` binary launched successfully in embedded mode.

**Headless Chromium caveat:** The `--screenshot` mode captures the page before JavaScript async operations complete (MCP connection + elk layout are async), so per-tab screenshots of the State-machines and Flows SVGs were not obtainable in batch mode. Puppeteer/CDP automation would be required for that. The test suite serves as the authoritative functional ground-truth for both tabs; the Nix bundle build + server launch confirm no runtime module errors.

### State machines tab

- `stateMachineTab.test.tsx` (3 tests, all PASS):
  1. **Renders one DiagramSvg per ledger** — `data-testid="help-statemachine-{ledger}-svg"` present for each ledger; each status node and rect render under the documented testid scheme.
  2. **Self-loop edge** — `data-testid="help-statemachine-tasks-edge-wip-wip"` renders (verifies that the elk migration keeps self-loops; `computeDagLayout` dropped them).
  3. **D33 left-alignment guard** — `layoutDiagram` called directly on a cyclic schema; `minX` of laid-out nodes asserted to be `>= 0` and `< 56px` (less than one between-layer spacing), confirming flush-left with no empty phantom layer-0.

### Flows tab

- `flowsTab.test.tsx` (4 tests, all PASS):
  1. **Third tab button** — `data-testid="help-tab-flows"` exists, `aria-selected` flips on click.
  2. **Four DiagramSvgs** — sections and SVGs render for all four flows (plan, investigate, implement, advance); all nodes render under `help-flow-{id}-node-{nodeId}`.
  3. **Labelled cross-flow handoff edge** — `help-flow-advance-edge-{from}-{to}` and `help-flow-advance-edge-label-{from}-{to}` both render; label text contains "seed-goal".
  4. **Dialog closes** on Esc and `?` (capture behavior unchanged).

### ledger-web server launch (embedded mode)

The `nix build .#ledger-web` binary was launched:
```
LEDGER_WEB_OUTDIR=/tmp/ledger-web-out2 \
  /result/bin/ledger-web --cwd /home/pavel/work/safe/flakes/cq --port 19877
```
Output: `ledger-web: serving http://127.0.0.1:19877/ → embedded MCP (cwd=...)` — no errors.

MCP endpoint verified working: `POST /mcp` with `initialize` returns valid `protocolVersion: "2024-11-05"` and server capabilities. No unresolved-worker or module errors observed.

---

## 4. D33 left-alignment — finding and disposition

**Defect D33:** `computeDagLayout` left layer 0 empty for cyclic graphs, right-shifting the entire State-machines diagram.

**Disposition:** RESOLVED — two-stage resolution:

1. **G24/T199** resolved D33 for the homegrown `computeDagLayout` path (used by the milestone DagView).
2. **T203** migrated the State-machines help tab from `computeDagLayout` onto the elk renderer (`layoutDiagram` via `diagramLayout.ts`). The State-machines tab no longer calls `computeDagLayout` at all.

**Verification of elk left-alignment:**

The D33 guard test in `stateMachineTab.test.tsx` ("lays out left-aligned with no empty leading layer-0 gap") runs `layoutDiagram(computeStateMachine(cyclic))` on a cyclic schema (`open ↔ wip` cycle, the exact shape that triggered D33 in `computeDagLayout`). The assertion:

```ts
const minX = Math.min(...laid.nodes.map((n) => n.x));
expect(minX).toBeLessThan(56);   // < one between-layer spacing
expect(minX).toBeGreaterThanOrEqual(0);
```

This assertion PASSES, confirming elk places the leftmost node with minimal left padding (elk's default ~12px), not a phantom empty-layer offset.

**D33 is NOT re-filed.** The defect was for the homegrown renderer; the elk renderer does not reproduce it.

---

## 5. DagView no-regression confirmation

`DagView` in `src/DagView.tsx` imports `computeDagLayout` from `./dagLayout.js` (line 10) — the homegrown algorithm. It does NOT import `layoutDiagram` or `diagramLayout.ts`. This is unchanged by T203.

`dagView.test.tsx` (4 tests, all PASS):
- Renders milestone nodes + dependency edges from `DagData`.
- Colors non-milestone nodes via `statusBucket` + shared palette.
- App DAG integration: toggle to graph renders nodes; node click opens detail panel.
- Scoping to a non-milestones ledger works.

DagView is unaffected by the G23 phase 2 work.

---

## 6. Newly-discovered defects

**None.** No new defects were found during this verification pass.

---

## Summary

All acceptance criteria satisfied:

| Criterion | Result |
|---|---|
| `bun run check` exits 0 | PASS (1014/0, all new tests included) |
| `nix build .#node-modules` succeeds | PASS (EXIT=0) |
| `nix build .#ledger-web` succeeds (elkjs in closure) | PASS (EXIT=0) |
| State machines tab renders (nodes/edges/labels/self-loops) | PASS (happy-dom tests) |
| Flows tab renders (nodes/edges/labels/4 flows) | PASS (happy-dom tests) |
| D33 left-alignment confirmed, disposition recorded | PASS |
| D33 NOT re-filed | CONFIRMED |
| DagView no-regression | PASS |
| No new defects | CONFIRMED |
