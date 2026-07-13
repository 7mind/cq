# G67 storage-backend format research (M209 milestone A: research spike & decision gate)

Date: 2026-07-13
Branch: implement/T490
Bench harness: `nix/pkg/cq-ledgers/packages/ledger/bench/storeBackendBench.ts`
(`bun run bench` from `packages/ledger/`, or `bun run bench:store` from the
workspace root)

---

## 1. Purpose

G67 milestone A is a research spike to decide the on-disk/on-ref storage
format for the ledger store, ahead of a milestone-C implementation. This
document collects:

- **T490** (this task): a re-runnable benchmark harness + baseline numbers for
  the two backends that exist TODAY (`FsLedgerStore`, `GitObjectLedgerBackend`),
  giving the Q248 reference metrics every candidate format is compared against.
- **T491** (follow-up): a survey of candidate storage formats/engines — see
  [`20260713-1532-ledger-storage-formats.md`](./20260713-1532-ledger-storage-formats.md).
- **T492** (follow-up): milestone-A prototypes measured with this SAME harness.

## 2. Q248 reference metrics and targets

Q248 asks for two numbers per backend, at two synthetic workload sizes (1,000
and 10,000 items in the `tasks` ledger):

- **(a) p95 single-item mutation latency** — `updateItem` through the store's
  real write funnel (mutex + lockfile + reload + persist), sampled across the
  population.
- **(b) cold `init()` time** — constructing a fresh store instance bound to
  already-populated on-disk/on-ref state and timing `await store.init()` only.

**Targets for the new store** (Q248): p95 mutation latency < 10ms, cold init
< 500ms, both at 10k items.

## 3. Harness design

`storeBackendBench.ts` (`packages/ledger/bench/`):

1. For each backend driver (`fs`, `git-object`) and each size (1k, 10k):
   - `setupRoot()` — a fresh `mkdtemp` root; for `git-object`, additionally
     `git init` a throwaway repo with one real commit on `main` (the backend's
     orphan ref lives on `refs/heads/cq-ledger`, never touching `main`).
   - **Populate**: one store instance creates a real milestone via
     `createMilestone` (cheap, O(1)); then the N synthetic `tasks` items are
     built as one in-memory `Ledger`, serialized ONCE with the store's own
     `serializeLedger`, and written directly at the persistence seam
     (`fs.writeFile` of `.cq/tasks.md` for fs; a single blob+tree+commit via
     `GitPlumbing` for git-object). Rationale: every store mutation rewrites
     the WHOLE ledger source (`writeLedgerFile` in `AbstractLedgerStore`), so
     populating via N sequential `createItem` calls is O(n²) — measured at
     ~135s for 1k items on `FsLedgerStore`, extrapolating to multiple hours at
     10k. No real workflow creates 10k items in one session; the direct seed
     reproduces the on-disk/on-ref state such a ledger would have accumulated.
   - **Mutation p95**: a fresh store instance flips `status` on an
     evenly-spaced sample of 50 items, alternating `planned`/`wip`; each
     `updateItem` call (the REAL write funnel: mutex + lockfile + full reload
     + full-rewrite persist) is timed with `performance.now()`; p95 over the
     sample.
   - **Cold init**: another brand-new store instance is constructed against
     the now-populated root and `await store.init()` is timed in isolation.
   - `teardownRoot()` removes the tmp dir.
2. Prints each size's row IMMEDIATELY when measured (an interrupted run still
   yields every completed data point), then a summary table; exits 0 on
   success (fail-fast — a broken backend aborts the run instead of printing
   garbage).

The harness never touches this repo's own `.cq/` or its `cq-ledger` ref — every
measurement runs against a disposable `mkdtemp` root.

Re-run for milestone-A prototypes / milestone-C by adding a new
`BackendDriver` (same `setupRoot`/`openStore`/`seedTasksLedger`/`teardownRoot`
shape) — the workload generation and measurement code stays identical, so new
numbers are directly comparable to the baseline below.

## 4. Baseline numbers (current backends, 2026-07-13)

Measured on the implementer's worktree host (Linux x86_64, bun 1.3.13, git on
PATH), single run, 50 mutation samples per cell, no warm-up — see §5 caveats.
Harness exited 0.

| backend    | size (items) | p95 mutation (ms) | cold init (ms) |
|------------|-------------:|------------------:|---------------:|
| fs         | 1,000        | 549.00            | 393.54         |
| fs         | 10,000       | 7,621.12          | 7,429.47       |
| git-object | 1,000        | 542.92            | 470.19         |
| git-object | 10,000       | 7,957.16          | 6,901.01       |

Raw harness output:

```
backend      size     p95 mutation (ms)   cold init (ms)
-----------  -------  ------------------  ---------------
fs              1000              549.00           393.54
fs             10000             7621.12          7429.47
git-object      1000              542.92           470.19
git-object     10000             7957.16          6901.01
```

### Reading vs the Q248 targets (p95 mutation < 10ms, cold init < 500ms @ 10k)

- **Both current backends miss the mutation target by ~760x at 10k** (7.6–8.0s
  vs 10ms) and **miss the cold-init target by ~14x** (6.9–7.4s vs 500ms).
- Mutation latency scales ~linearly with item count (~0.55s @ 1k → ~7.6–8.0s
  @ 10k, ≈14x for 10x the items): the cost is dominated by the
  `AbstractLedgerStore` write funnel doing a FULL ledger reload (parse of the
  whole markdown source, H41/D61) plus a FULL serialize+rewrite on every
  single-item update — O(n) per mutation by design of the current format.
- `git-object` is only marginally slower than `fs` at both sizes: the git
  subprocess overhead (~4 plumbing calls per write) is small relative to the
  shared parse/serialize cost. **The bottleneck is the monolithic
  one-file-per-ledger markdown format, not the storage medium.** A candidate
  format that avoids whole-ledger rewrite/reparse per mutation (per-item
  files, append-only log, or an indexed store) is where the 2-3 orders of
  magnitude must come from.
- Cold init pays full-file parse of every ledger; at 10k items that is ~7s —
  any candidate format needs either a smaller parse surface or lazy loading to
  reach < 500ms.

## 5. Caveats

- Single run, single host, no statistical repetition — these are baseline
  ORDER-OF-MAGNITUDE numbers for the decision gate, not a rigorous
  benchmark-grade study. Milestone-A prototype comparisons should re-run this
  harness on the same host in the same session for apples-to-apples numbers.
- The mutation sample is 50 evenly-spaced items regardless of `size` (each
  sampled `updateItem` costs a full O(n) reload+rewrite, so a large sample
  makes the 10k×2-backend run take tens of minutes); 50 keeps a full pass in
  minutes while the p95 stays stable across runs at this cost scale (an
  earlier 200-sample partial run measured fs@1k p95 443ms / git-object@1k
  501ms — same order of magnitude as the 50-sample numbers above).
- The populate phase seeds the ledger source directly at the persistence seam
  (see §3) instead of N `createItem` calls; the measured operations
  (`updateItem`, `init()`) still go through the full production code path.
- `git-object` shells out to `git` per plumbing operation (hash-object,
  write-tree, commit-tree, update-ref) with no batching; at these sizes that
  overhead is minor next to the shared parse/serialize cost (see §4).

---

## 6. T492 milestone-A prototype numbers (2026-07-13)

T492 prototypes the **top two candidates** the survey
([`20260713-1532-ledger-storage-formats.md`](./20260713-1532-ledger-storage-formats.md) §5)
named — **A. `bun:sqlite`** and **C1/C2. JSONL canonical + derived index** — as
THROWAWAY adapters under `packages/ledger/bench/proto/` (NOT wired into
`src/`), and runs the SAME harness workload against them by adding two
`BackendDriver`s (`sqlite`, `jsonl+index`) alongside the existing
`fs`/`git-object` drivers. The workload generation and measurement code are
identical, so these numbers sit in the same table as the §4 baseline.

Prototype shape (enough surface for the bench workload only — `init` /
`createMilestone` / `updateItem` / `dispose`; see `bench/proto/protoStore.ts`):

- **`SqliteProtoStore`** (`bench/proto/sqliteProtoStore.ts`) — normalized rows
  in one SQLite file (`.cq/ledger.db`) opened WAL + `synchronous=NORMAL` +
  `busy_timeout=5000ms`. A mutation is one PK-indexed `UPDATE`; cold `init()`
  opens the file + sets PRAGMAs (no scan). Seed = one bulk-insert transaction.
- **`JsonlProtoStore`** (`bench/proto/jsonlProtoStore.ts`) — append-only
  canonical JSONL (`.cq/tasks.jsonl`, last-record-per-id wins) as the
  human-readable source of truth, PLUS an in-memory `Map<id,item>` derived
  index. A mutation appends ONE record line under the repo's advisory
  `Lockfile` (the same one `FsLedgerStore` uses); cold `init()` streams the
  JSONL once and folds it into the index. Seed = write the whole JSONL once.

Same host/run as §4 (Linux x86_64, bun 1.3.13), 50 mutation samples per cell,
harness exited 0. Baseline rows repeated for contrast:

| backend       | size (items) | p95 mutation (ms) | cold init (ms) |
|---------------|-------------:|------------------:|---------------:|
| fs (baseline) | 10,000       | 9,693.86          | 6,903.26       |
| git-object    | 10,000       | 7,750.20          | 6,834.81       |
| **sqlite**    | 1,000        | 0.13              | 0.45           |
| **sqlite**    | 10,000       | **0.04**          | **0.35**       |
| **jsonl+index** | 1,000      | 1.15              | 1.59           |
| **jsonl+index** | 10,000     | **0.61**          | **16.39**      |

Raw harness output (all four drivers, one run):

```
backend      size     p95 mutation (ms)   cold init (ms)
-----------  -------  ------------------  ---------------
fs              1000              626.10           520.85
fs             10000             9693.86          6903.26
git-object      1000              486.94           515.58
git-object     10000             7750.20          6834.81
sqlite          1000                0.13             0.45
sqlite         10000                0.04             0.35
jsonl+index     1000                1.15             1.59
jsonl+index     10000                0.61            16.39
```

### Pass/fail vs the Q248 targets @ 10k (p95 mutation < 10ms, cold init < 500ms)

| candidate     | p95 mutation @10k | vs < 10ms | cold init @10k | vs < 500ms | verdict  |
|---------------|------------------:|:---------:|---------------:|:----------:|:--------:|
| **A. bun:sqlite** | **0.04 ms**   | ✅ PASS (~250x margin) | **0.35 ms** | ✅ PASS (~1400x margin) | **PASS** |
| **C1/C2. JSONL + index** | **0.61 ms** | ✅ PASS (~16x margin) | **16.39 ms** | ✅ PASS (~30x margin) | **PASS** |

Both prototypes **PASS both Q248 targets at 10k** with wide margins, confirming
the survey's root-cause thesis (§4): storing items *individually* (a SQLite row
/ a JSONL append) turns the baseline's O(n) whole-ledger rewrite+reparse into an
O(1) single-record write and an indexed/bounded-parse init — the 2–3
orders-of-magnitude gap the target demanded. Concretely at 10k:

- **sqlite**: mutation **0.04 ms** vs baseline ~7.6–9.7 s ≈ **~200,000x faster**;
  cold init **0.35 ms** vs ~6.8–6.9 s ≈ **~20,000x faster**.
- **jsonl+index**: mutation **0.61 ms** ≈ **~13,000x faster**; cold init
  **16.39 ms** ≈ **~420x faster**. Its cold init is the only number that scales
  visibly with N (1.6 ms @1k → 16.4 ms @10k) because it re-folds the whole JSONL
  at startup — still ~30x under budget at 10k, but the one figure to watch for a
  much larger population (a persisted index would flatten it).

### Two-writer smoke (Q246 multi-process sharing)

`bench/proto/concurrentWriterSmoke.ts` (`bun run bench:concurrent`) seeds one
store dir with 500 items, then spawns **two Bun subprocesses**
(`concurrentWriterWorker.ts`) that concurrently mutate **disjoint partitions**
(even / odd item ids) of that ONE store to `wip`, one single-item mutation at a
time — contending on the same store's cross-process write path. On join it
asserts (a) both children exited 0 (zero read/write failures) and (b) every
item is `wip` on a fresh read (zero lost updates).

| candidate      | cross-process mechanism                                   | result |
|----------------|-----------------------------------------------------------|:------:|
| **bun:sqlite** | WAL + `busy_timeout=5000ms` (SQLITE_BUSY serialization)   | **PASS** — 500 items, 0 lost, 0 read failures |
| **JSONL + index** | advisory `Lockfile` around each O_APPEND record write  | **PASS** — 500 items, 0 lost, 0 read failures |

```
sqlite       PASS  500 items mutated by 2 processes, 0 lost, 0 read failures
jsonl+index  PASS  500 items mutated by 2 processes, 0 lost, 0 read failures
```

**Signal for the T497 contract:** sqlite's cross-process safety is intrinsic to
the engine (WAL + busy_timeout, no app-level lock). The JSONL hybrid needs an
**explicit per-store write lock** around the canonical-log append (the advisory
`Lockfile` sufficed here) because a full JSON record line can exceed `PIPE_BUF`
so raw `O_APPEND` atomicity is not guaranteed; the derived index is per-process
and rebuildable, so it needs no cross-process coordination. The JSONL fold also
tolerates a torn final line (crash mid-append) — an interior corrupt line still
fails fast.

### Caveats (T492)

- These prototypes implement ONLY the four operations the bench measures; they
  are NOT full `LedgerStore` implementations and skip schema validation,
  transition guards, milestone resolution, FTS, archives, and the milestones
  registry beyond an id counter. Real implementations (milestone C) will add
  per-mutation overhead — but the baseline gap is 2–3 orders of magnitude, so
  there is ample headroom.
- Same single-run / single-host caveats as §5 apply. The prototype numbers are
  so far under target that run-to-run variance does not change any verdict.
- The two-writer smoke uses disjoint partitions (a clean lost-update check); it
  does NOT exercise last-writer-wins on the SAME id under contention, nor
  `SQLITE_BUSY` timeout exhaustion under heavy write pressure — both are milestone-C
  concerns the T497 contract should specify.
