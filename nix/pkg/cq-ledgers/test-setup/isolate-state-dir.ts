/**
 * D170 guard — force every `bun test` run onto a throwaway `XDG_STATE_HOME`.
 *
 * WHY THIS EXISTS (a real data-loss incident, 2026-07-27T19:22:39Z):
 * `resolveProjectKey` keys the out-of-tree store on the repo's FIRST COMMIT
 * SHA, deliberately identical across every worktree and clone (Q246, to
 * PREVENT split ledgers). The unavoidable consequence is that a test — or any
 * module import — executed from ANY worktree of this repo resolves the SAME
 * out-of-tree store as the developer's live ledger. Confirmed: with
 * XDG_STATE_HOME unset, `resolveStateDirBase(<repo key>)` returns exactly
 * `~/.local/state/cq/projects/<repo key>`.
 *
 * That is not merely a read hazard. `SqliteLedgerStore.init` routes a detected
 * schema divergence through `onSchemaDivergence`, and on the non-default
 * `'backup-reinit'` policy it snapshots the db and then `DELETE`s every table
 * before reseeding canon. Test code passes `'backup-reinit'` explicitly in many
 * places (production code never does — it always takes the `'abort'` default).
 * A subagent running in a worktree therefore destroyed the live ledger: 1147
 * active items and 2278 archived items replaced by a single bootstrap
 * milestone. It was recoverable only because that path happens to snapshot
 * first. The same signature appears on 2026-07-25, so it recurs.
 *
 * The fix is isolation at the boundary rather than discipline in each test:
 * point XDG_STATE_HOME at a per-run temp directory BEFORE any test module is
 * evaluated, so the real store is unreachable no matter what a test does.
 *
 * Escape hatch: set `CQ_TEST_ALLOW_REAL_STATE_HOME=1` to opt out. Nothing in
 * this repo should need it; it exists so an operator debugging the real store
 * can do so deliberately and visibly.
 *
 * Tests that assert the `~/.local/state` FALLBACK branch (stateDir.test.ts)
 * are unaffected — they `delete process.env.XDG_STATE_HOME` themselves and
 * assert pure path composition without touching the filesystem.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPT_OUT_ENV = "CQ_TEST_ALLOW_REAL_STATE_HOME";

if (process.env[OPT_OUT_ENV] !== "1") {
  // Unconditional: an inherited XDG_STATE_HOME is NOT trusted, because the
  // hazard is precisely a value that resolves to the developer's real store.
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "cq-test-state-"));
}
