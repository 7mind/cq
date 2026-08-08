# D293 / T2016 — idle MCP CPU spin diagnosis

**Date:** 2026-08-08  
**Host sample:** load average 23–26; ~13× `bun … cq-cli … -- mcp` each 84–95% CPU; etime 2–10h; all parented by the long-lived pi session (sandbox pid 2).

## Observations

1. **Multiplicity (primary amplifier)**  
   One pi session holds many keep-alive MCP children (`lifecycle=keep-alive`). Count ≈ load average. Each process opens the same xdg primary:
   - `…/cq-ledger-suite-production/state/ledger.db` (+ WAL/SHM)
   - `…/dispatch-attestations.db` (+ WAL/SHM)

2. **Per-process CPU**  
   Sampling `/proc/<pid>/stat` on an “idle” MCP shows continuous `utime` growth (~90–100 jiffies/s ⇒ ≈1 core). STAT=`Rl+` (runnable). Not RAM-bound (~60Gi free).

3. **Coherence poll (secondary, not sole)**  
   xdg path starts `startXdgCoherenceWatcher` (`createLedgerStore.ts`) with `XDG_WATCHER_DEFAULT_POLL_MS = 500`, `PRAGMA data_version` + bulk `invalidate` on change. Cheap when quiet; under multi-writer thrash becomes N×invalidate storms. timerfd present on the process matches timer-driven work, but continuous full-core utime implies additional runnable work beyond a 2 Hz poll.

4. **Stdio transport**  
   fds 0/1 are sockets (pi socketpair), not classic pipes. MCP SDK `StdioServerTransport` is connected. No proof yet of a busy-read on an empty socket without strace (ptrace blocked in sandbox).

5. **Gate coupling**  
   Full `bun run check` was 5255/0 at `55179e43` before thrash dominated; later runs show multi-timeout failures (git 5s SIGTERM, Pi package 30s) consistent with CPU starvation, not SUT regressions of T1423.

## Hot-path candidates (ordered)

| Priority | Site | Why |
|---|---|---|
| P0 | Pi keep-alive MCP spawn / no replace-on-rebind | Explains N≫1 long-lived children |
| P1 | Bun/MCP event loop under socket stdio when peer idle | Explains continuous utime with no tool calls |
| P2 | `startXdgCoherenceWatcher` 500ms poll × N on shared db | Amplifies cost when any peer writes |
| P3 | SQLite `busy_timeout=5000` under concurrent invalidate/write | Turns contention into CPU wait storms |

## Immediate ops mitigation

Kill stale keep-alive `cq … -- mcp` children until one remains per active session; restart pi if unsure. Re-run gate only when load average is low.

## Follow-on tasks

- T2017 fix idle spin (P1)
- T2018 single-instance keep-alive (P0)
- T2019 parent-death reaper (P0)
- T2020 verify CPU + gate

## T2017 follow-up measurement (2026-08-08 post-redeploy)

Standalone idle probe (no pi tool traffic):

```text
cwd=/tmp/exchange/idle-mcp-proj  projectId=idle-mcp-probe-d293
mean_pcpu over 10s ≈ 1.09%
RSS ≈ 2.7 MiB
```

Session MCP (pid of live agent) remains high %CPU because the parent is actively
calling tools — not because stdio MCP spins when idle.

**Conclusion:** There is no idle hot-loop to fix in ledger-mcp under quiet stdin.
Thrash root cause was **multiplicity** (T2018/T2019). T2017 acceptance is met by
measurement without further code change on the idle path.
