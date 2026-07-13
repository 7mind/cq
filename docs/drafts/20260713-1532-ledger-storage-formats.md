# Ledger storage-format options survey (G67-A / M209 / T491)

Date: 2026-07-13
Goal: G67 — decide the on-disk/on-ref storage format for the ledger store.
Companion doc: [`20260713-1358-g67-storage-backend-format-research.md`](./20260713-1358-g67-storage-backend-format-research.md)
(T490 — the re-runnable benchmark harness + the **baseline numbers** cited
throughout this survey).

This doc (T491) is the candidate-format survey demanded by M209: it compares
candidate storage engines/formats against the Q245–Q249 requirements and names
the **top two candidates to prototype** in T492 (milestone-A prototypes,
measured with the SAME T490 harness so their numbers are directly comparable to
the baseline).

> **T492 RESULT (2026-07-13):** both named candidates were prototyped and
> measured — **`bun:sqlite` 0.04 ms p95 mutation / 0.35 ms cold init @10k** and
> **JSONL + index 0.61 ms / 16.39 ms @10k**, both **PASS** the Q248 targets
> (< 10ms / < 500ms) with wide margins, and both **PASS** the two-writer
> multi-process smoke (Q246). See the companion doc's
> [§6 T492 prototype numbers](./20260713-1358-g67-storage-backend-format-research.md#6-t492-milestone-a-prototype-numbers-2026-07-13).

> All measured numbers are dated and cited. Where a number is a *target* it is
> labelled as such; where it is an *external* benchmark the URL is inline;
> where it is *this repo's* measurement it points at the T490 companion doc.

---

## 1. The requirements this format must satisfy

The clarified questions that constrain the decision (verbatim intent):

- **Q248 targets** — for the NEW store: **p95 single-item mutation < 10ms** and
  **cold `init()` < 500ms at 10,000 items**. The *baselines to beat* (T490,
  measured 2026-07-13, Linux x86_64, bun 1.3.13):

  | current backend | p95 mutation @10k | cold init @10k |
  |-----------------|------------------:|---------------:|
  | `fs` (markdown) | **7,621 ms**      | **7,429 ms**   |
  | `git-object`    | **7,957 ms**      | **6,901 ms**   |

  (@1k: fs 549 / 394 ms; git-object 543 / 470 ms.) Both current backends miss
  the mutation target by **~760x** and the cold-init target by **~14x** at 10k.
  T490's root-cause finding: the cost is the **monolithic one-file-per-ledger
  markdown format** (full parse + full rewrite per single-item mutation, O(n)),
  NOT the storage medium — so any winning candidate must avoid whole-ledger
  rewrite/reparse per mutation.

- **Q246 — multi-process concurrent writers.** Worktrees/clones share ONE store;
  several `cq` processes (TUI, web server, CLI, concurrent implement-flow
  workers) may mutate it at once. The format must give safe multi-*process*
  (not merely multi-thread) write semantics.

- **Q245(d) — mandatory human-readable EXPORT path.** The primary store MAY be
  fully binary, but a human-readable export (markdown / JSONL) MUST be
  producible. Human-readability of the *primary* is desirable (git-diffable,
  hand-inspectable) but not required if a faithful export exists.

- **Q247 — logs storage.** Append-once immutable blobs, redaction-on-write,
  `read_log` streaming. This is a *different* access pattern from the item
  ledgers (write-once large blobs vs. frequent small mutations) and MAY use a
  different mechanism.

- **Q249 — Bun + Nix packaging.** `bun:sqlite` is **built into the Bun runtime**
  → **zero packaging burden**. Any **native addon** (LMDB, LevelDB/RocksDB
  class) needs a compiled `.node` binary, which must build inside the Nix FOD
  (`node-modules` fixed-output derivation) — this needs **EXPLICIT
  justification**. (Confirmed: the current workspace ships **no** native addons
  — `grep` for `.node`/`node-gyp` deps in `packages/*/package.json` is empty —
  so adding one is a real new packaging obligation, not a free extension.)

---

## 2. Candidate classes

Three classes, five concrete candidates:

- **A. `bun:sqlite`** (embedded relational, built-in) — normalized rows OR a
  JSON/blob column per item; real B-tree indexes; WAL for readers + single
  writer; incremental single-row writes.
- **B. Embedded KV / NoSQL native addon**
  - **B1. LMDB** (`lmdb-js`) — memory-mapped B+tree, MVCC, ACID, multi-process.
  - **B2. LevelDB / RocksDB class** (`classic-level` / `rocksdb`) — LSM-tree.
- **C. Hybrid text + derived index** — human-readable canonical file(s)
  (JSONL or per-item markdown files) as the sole source of truth, PLUS a
  **derived, rebuildable** binary index (SQLite or a persisted `minisearch`)
  that is NEVER authoritative and can be dropped and rebuilt.
  - **C1. JSONL (or per-item files) + SQLite derived index.**
  - **C2. JSONL + persisted `minisearch` derived index.**

---

## 3. Criteria matrix

Each cell cites a measured number, an external source, or a T490 baseline.
"Mutation" and "cold init" columns below were **projected** against the Q248
targets from the cited external throughput/latency figures; the actual measured
numbers now come from the T492 prototype run (see the callout above / the
companion doc §6) and CONFIRM the projections — bun:sqlite 0.04 ms/0.35 ms and
JSONL+index 0.61 ms/16.39 ms @10k, both well inside target.

| # | Candidate | Incremental mutation latency (evidence) | Cold init @10k (evidence) | Multi-**process** writers (Q246) | Crash-safety / atomic write | Human-readable EXPORT (Q245d) | Nix/Bun packaging (Q249) |
|---|-----------|-----------------------------------------|---------------------------|----------------------------------|-----------------------------|-------------------------------|--------------------------|
| — | *baseline* `fs` markdown | **7,621 ms** p95 @10k (T490) | **7,429 ms** (T490) | lockfile + full rewrite; O(n) reparse | tmp-file + rename (current code) | IS the primary (markdown) | zero (built-in) |
| A | **bun:sqlite** | single-row insert **~2.8 µs/row** amortized (10k rows WAL = ~28 ms bulk, [bun.com](https://bun.com/docs/runtime/sqlite) / [techbytes 2026](https://techbytes.app/posts/bun-1-2-full-stack-framework-http-sqlite-test-runner/)); mixed-workload write **P99 < 10ms** below core-count concurrency ([shivekkhurana 2025](https://shivekkhurana.com/blog/sqlite-in-production/)) | index/B-tree open is O(1)-ish, not full parse; read P99 **0.6–5.6 ms** @60 workers ([shivekkhurana 2025](https://shivekkhurana.com/blog/sqlite-in-production/)) | **single writer only**, even in WAL ([turso 2025](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes)); WAL lets unlimited readers + 1 writer; cross-process serialized via `SQLITE_BUSY`/busy_timeout; WAL cuts P99 30–60% for 2+ writers ([shivekkhurana 2025](https://shivekkhurana.com/blog/sqlite-in-production/)) | ACID; WAL + `synchronous=NORMAL` durable except last txn on OS crash ([avi.im 2025](https://avi.im/blag/2025/sqlite-fsync/), [powersync](https://powersync.com/blog/sqlite-optimizations-for-ultra-high-performance)) | **derived** — `SELECT` → JSONL/markdown export | **zero** — built into Bun ([bun.com](https://bun.com/docs/runtime/sqlite)); Q249 says zero packaging burden |
| B1 | **LMDB** (`lmdb-js`) | full encode+put **~500k puts/s single-thread (~2 µs)**, ~1.7M/s multi-thread ([lmdb-js README](https://github.com/kriszyp/lmdb-js/blob/master/README.md)) | mmap B+tree, no parse; get ~0.5 µs (~1.9M/s) ([lmdb-js](https://github.com/kriszyp/lmdb-js)) | **native multi-process** MVCC, ACID, "scales across processes" ([lmdb-js](https://github.com/kriszyp/lmdb-js)); single-writer txn but readers never block | ACID, crash-proof / copy-on-write B+tree ([lmdb-js](https://github.com/kriszyp/lmdb-js)) | **derived** — cursor scan → JSONL export | **native addon** ⇒ FOD build + Q249 EXPLICIT justification; prebuilt binaries, node-gyp fallback |
| B2 | **LevelDB / RocksDB** | LSM writes fast but **write-stall** during compaction spikes P99 to ms range; concurrent-write blob 12x faster than RocksDB (131 µs vs 1.69 ms) ([RocksDB benchmarks](https://github.com/facebook/rocksdb/wiki/Performance-Benchmark-201807)) | LSM open reads manifest+SST index, sub-parse | LevelDB **single-process lock** (one process opens the DB); RocksDB multi-thread but **NOT multi-process** ([stackshare](https://stackshare.io/stackups/leveldb-vs-rocksdb)) — fails Q246 outright | WAL + compaction; write-stall latency variance | **derived** — iterator → JSONL export | **native addon** ⇒ FOD build + Q249 justification; RocksDB adds heavy C++ build |
| C1 | **JSONL/per-item files + SQLite derived index** | append one line ≈ one `write`+fsync (**tens of µs**, atomic-append); index update is a bun:sqlite upsert (~µs, see A) | canonical read = stream JSONL; index rebuild from 10k rows ≈ SQLite bulk ~tens of ms; lazy/on-demand rebuild | canonical file: **append-only** ⇒ multi-writer via O_APPEND atomicity + per-record lock; index is per-process/rebuildable so no shared-write contention | per-item file rename OR JSONL append + dir fsync ([0xkiire](https://0xkiire.com/crash-consistency-fsync-rename/), [dev.to crash-safe JSON 2025](https://dev.to/constanta/crash-safe-json-at-scale-atomic-writes-recovery-without-a-db-3aic)) | **IS the primary** (JSONL/markdown) — export is identity | **zero** — bun:sqlite built-in; JSONL is plain FS |
| C2 | **JSONL + persisted `minisearch` index** | append one JSONL line (tens of µs); `minisearch` **incremental** add/replace, no full rebuild ([minisearch](https://github.com/lucaong/minisearch)) | index rebuild "thousands of docs in tens of ms", query <1 ms; 1k-doc index ≈500 KB ([minisearch](https://github.com/lucaong/minisearch)) | canonical append-only (as C1); index is in-memory/rebuildable per process | JSONL atomic append + dir fsync (as C1) | **IS the primary** (JSONL) | **zero** — pure-JS ~7 kB gzipped, no addon ([minisearch](https://github.com/lucaong/minisearch)) |

---

## 4. Analysis per requirement

### 4.1 Hitting the Q248 latency/init targets (the hard gate)

The baseline fails because **every mutation rewrites and reparses the whole
ledger** (T490 §4). Any candidate that stores items *individually* (a SQLite
row, an LMDB key, a JSONL line, a per-item file) turns the O(n) whole-file
rewrite into an **O(1) single-record write** and the O(n) whole-file parse into
an **indexed lookup or a bounded append** — which is exactly the 2–3 orders of
magnitude the target demands.

- **bun:sqlite** and **LMDB** both write a single record in the **low
  microseconds** ([bun.com](https://bun.com/docs/runtime/sqlite);
  [lmdb-js README](https://github.com/kriszyp/lmdb-js/blob/master/README.md)),
  ~1000x under the 10ms p95 target with headroom for our mutex/lockfile funnel.
  Cold init is an index/mmap open, not a 7-second parse — comfortably under
  500ms.
- **JSONL + index (C1/C2)**: mutation cost is an atomic append (tens of µs) plus
  an incremental index update; cold init is either a JSONL stream (needs a size
  check at 10k — a 10k-line JSONL parse is ms-scale, well under 500ms) or a load
  of the persisted derived index. `minisearch` indexes "thousands of documents
  in tens of milliseconds" ([minisearch](https://github.com/lucaong/minisearch)),
  so even a from-scratch rebuild at init stays inside budget.
- **LevelDB/RocksDB** meet raw latency but suffer **write-stall** P99 spikes
  during compaction ([RocksDB wiki](https://github.com/facebook/rocksdb/wiki/Performance-Benchmark-201807)),
  a poor fit for a p95-mutation SLO on a small dataset.

### 4.2 Multi-process concurrent writers (Q246) — the discriminator

This is where the KV class splits:

- **LevelDB**: a single OS process holds an exclusive lock on the DB directory;
  a second `cq` process cannot open it. **Disqualifies B2-LevelDB for Q246.**
  RocksDB is multi-*thread* but likewise **not multi-process**
  ([stackshare](https://stackshare.io/stackups/leveldb-vs-rocksdb)).
- **LMDB**: genuinely multi-process (mmap + MVCC, "scales across processes",
  [lmdb-js](https://github.com/kriszyp/lmdb-js)) — the one KV that satisfies
  Q246 natively.
- **bun:sqlite**: WAL gives **unlimited readers + one writer across processes**;
  concurrent writers serialize via the file lock (`SQLITE_BUSY`, mitigated with
  `busy_timeout`), and WAL cuts P99 30–60% for 2+ writers
  ([shivekkhurana 2025](https://shivekkhurana.com/blog/sqlite-in-production/);
  [turso 2025](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes)).
  For our workload — a handful of `cq` processes making small, infrequent
  mutations — serialized single-writer with a busy_timeout is adequate and the
  behavior is well understood.
- **Hybrid C1/C2**: the **canonical** store is append-only JSONL/per-item files,
  which multi-writer via `O_APPEND` record atomicity (or per-item file rename);
  the **derived index is per-process and rebuildable**, so index writes never
  contend across processes. This sidesteps the single-writer question for the
  authoritative data entirely.

### 4.3 Crash-safety / atomic writes

- SQLite/LMDB provide **ACID** out of the box (WAL / copy-on-write B+tree)
  ([avi.im 2025](https://avi.im/blag/2025/sqlite-fsync/);
  [lmdb-js](https://github.com/kriszyp/lmdb-js)). Note SQLite's default
  `synchronous=NORMAL` under WAL can roll back the last transaction(s) on an
  **OS** crash (not app crash) — acceptable, or use `FULL` for the mutation that
  must be durable.
- Text/hybrid needs us to implement the **tmp-file + fsync + rename + directory
  fsync** discipline correctly — rename atomicity alone is not durability
  ([0xkiire](https://0xkiire.com/crash-consistency-fsync-rename/);
  [dev.to 2025](https://dev.to/constanta/crash-safe-json-at-scale-atomic-writes-recovery-without-a-db-3aic)).
  The current `fs` backend already does tmp-file+rename, so the pattern exists
  in-repo; the append-only variant additionally needs a torn-last-line recovery
  step on load.

### 4.4 Human-readable export (Q245d)

- **Hybrid C1/C2 wins trivially**: the primary IS human-readable, so export is
  the identity function and git-diffs stay meaningful — a major operational
  advantage that matches the repo's current "don't hand-edit but do read `.cq/`"
  posture.
- SQLite/LMDB satisfy Q245(d) via a **derived export** (`SELECT`/cursor →
  JSONL/markdown); primary stays binary. Acceptable per Q245(d) but loses
  git-diffability of the source of truth.

### 4.5 Logs (Q247)

Logs are **append-once immutable blobs with redaction-on-write and streaming
reads** — a different pattern from item mutation. This argues for keeping logs
on their **own mechanism regardless of the item-store choice**: the current
git-object orphan-ref CAS already gives append-once immutability and content
addressing, and a plain append-only blob file with an offset index also fits.
The item-store decision should NOT be coupled to logs; a SQLite blob table or an
LMDB value store *could* hold logs, but the immutability + streaming
requirements are already met by the existing CAS, so **logs are out of scope for
the item-format choice** and can stay as-is or move to append-only blobs
independently.

### 4.6 Packaging (Q249) — the tie-breaker against native addons

- **bun:sqlite** and both **hybrid** variants add **zero** native-addon
  packaging burden (bun:sqlite is in the runtime; `minisearch` is ~7 kB pure JS;
  JSONL is the filesystem). No FOD change beyond a lockfile bump for
  `minisearch`.
- **LMDB / LevelDB / RocksDB** each require a compiled `.node` addon inside the
  Nix `node-modules` FOD. Per Q249 that demands **explicit justification**. LMDB
  *could* justify it via native multi-process MVCC — but bun:sqlite (built-in)
  already gives adequate multi-process semantics for our workload, so the
  packaging cost is **not** justified for a first prototype. RocksDB's heavy C++
  build makes it the worst packaging fit.

---

## 5. Scorecard and decision

| candidate | meets Q248 latency | Q246 multi-proc | crash-safe | Q245d export | Q249 packaging | verdict |
|-----------|:---:|:---:|:---:|:---:|:---:|---------|
| **A. bun:sqlite** | ✅ (~µs writes) | ✅ WAL single-writer, adequate | ✅ ACID | ✅ derived | ✅ **zero** | **PROTOTYPE** |
| **C1. JSONL + SQLite index** | ✅ | ✅ append-only canonical | ⚠️ must implement fsync discipline | ✅✅ **primary is readable** | ✅ zero | **PROTOTYPE** |
| C2. JSONL + minisearch | ✅ | ✅ | ⚠️ same as C1 | ✅✅ primary readable | ✅ zero | strong backup for C1 (search-only index) |
| B1. LMDB | ✅ (~µs) | ✅✅ native MVCC | ✅ ACID | ✅ derived | ❌ native addon (needs Q249 justification) | defer unless SQLite writer-serialization proves inadequate |
| B2. LevelDB/RocksDB | ⚠️ write-stall P99 | ❌ **not multi-process** | ✅ | ✅ derived | ❌ native addon | **rejected** (fails Q246 + packaging) |

### Top two candidates to prototype (T492)

1. **`bun:sqlite`** (candidate A) — best raw latency-per-effort with **zero
   packaging cost** (Q249), ACID crash-safety, and adequate multi-process
   semantics via WAL + busy_timeout (Q246). The obvious first prototype: it
   removes the O(n) rewrite bottleneck (T490 §4) with the least new machinery.

2. **Hybrid JSONL canonical + derived index** (candidate C1, with C2's
   `minisearch` as the FTS layer) — keeps the source of truth **human-readable
   and git-diffable** (best possible Q245(d) posture, preserving the repo's
   current file-inspectable ethos), sidesteps the single-writer question for the
   authoritative data (append-only, Q246), and still reaches the Q248 targets
   because mutations become bounded appends and reads go through a rebuildable
   index. It carries the extra cost of getting append/fsync/rename crash-recovery
   right — which the T492 prototype must measure and validate.

**LMDB (B1)** is held in reserve: prototype it only if bun:sqlite's
single-writer serialization shows unacceptable `SQLITE_BUSY` contention under
the real multi-process worktree workload, since it is the only KV option that
both meets Q246 natively and would justify (per Q249) its native-addon cost.
**LevelDB/RocksDB (B2)** are rejected: not multi-process (Q246) and heaviest
packaging burden (Q249).

Both prototypes MUST be measured with the T490 harness (add a `BackendDriver`
per the companion doc) so their p95-mutation and cold-init numbers sit in the
same table as the baseline above.

---

## 6. Sources

- bun:sqlite — https://bun.com/docs/runtime/sqlite
- Bun 1.2 SQLite deep dive (2026) — https://techbytes.app/posts/bun-1-2-full-stack-framework-http-sqlite-test-runner/
- SQLite in production, real-world benchmark (2025) — https://shivekkhurana.com/blog/sqlite-in-production/
- SQLite fsync / durability (2025) — https://avi.im/blag/2025/sqlite-fsync/
- SQLite ultra-high-performance tuning — https://powersync.com/blog/sqlite-optimizations-for-ultra-high-performance
- Turso: beyond the single-writer limitation (2025) — https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes
- lmdb-js README + benchmarks — https://github.com/kriszyp/lmdb-js/blob/master/README.md , https://github.com/kriszyp/lmdb-js
- RocksDB performance benchmarks — https://github.com/facebook/rocksdb/wiki/Performance-Benchmark-201807
- LevelDB vs RocksDB — https://stackshare.io/stackups/leveldb-vs-rocksdb
- Crash consistency: fsync / rename / durability — https://0xkiire.com/crash-consistency-fsync-rename/
- Crash-safe JSON at scale: atomic writes + recovery (2025) — https://dev.to/constanta/crash-safe-json-at-scale-atomic-writes-recovery-without-a-db-3aic
- MiniSearch — https://github.com/lucaong/minisearch
- T490 baseline (this repo) — [`20260713-1358-g67-storage-backend-format-research.md`](./20260713-1358-g67-storage-backend-format-research.md)
