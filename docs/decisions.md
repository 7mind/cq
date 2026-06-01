---
ledger: decisions
counters:
  milestone: 0
  item: 2
archives: []
---

# decisions

## M3

### K1 — locked

- createdAt: 2026-06-01T20:13:09.941Z
- updatedAt: 2026-06-01T20:13:09.941Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- headline: "Subagent session-logs: subagent returns summary, orchestrator writes the file"
- rationale: Subagents' final message is returned to the orchestrator, so the subagent emits a 'Session summary' section (did/achieved/discovered/issues) and the orchestrator writes ./docs/logs/<timestamp>-<agent-id>.md (agent-id from the Agent tool result, timestamp stamped by the orchestrator). Keeps subagents read-only (no Write tool; the T13 denylist stays), avoids the worktree-log-merge problem (a worker writing inside its isolated worktree), and is concurrency-safe with a single writer and unique filenames.
- alternatives: "(a) Grant each subagent Write scoped to ./docs/logs/ and have it write its own log — rejected: re-introduces Write into read-only agents and needs worker logs carried across merge-back. User chose the orchestrator-writes approach."
- ledgerRefs: ["goals:G1"]

## M2

### K2 — proposed

- createdAt: 2026-06-01T20:13:13.876Z
- updatedAt: 2026-06-01T20:14:34.268Z
- author: "opus-4.8[1m]"
- session: b946b5c5-0dca-4058-a5bf-45caaea6111d
- headline: "In-process ledgers: relocate the MCP server into the UI process, don't make UIs read files"
- rationale: |
    Goal: omitting --mcp-url should let each UI work without a separate ledger-mcp process. Constraint: the repo invariant 'frontends are pure MCP clients — never read ledger files directly' (CLAUDE.md) must hold. Resolution: co-locate the MCP *server* in the same OS process as the UI, not bypass MCP.
    
    TUI (a Bun process): build FsLedgerStore(cwd)+init, buildServer(store), connect it to a Client over InMemoryTransport.createLinkedPair() (verified present in @modelcontextprotocol/sdk 1.29.0 /inMemory.js). The existing McpLedgerClient wraps that Client unchanged — no HTTP, no network, UI still speaks MCP.
    
    Web (browser UI cannot touch the FS): the ledger-web serve process hosts /mcp (Streamable HTTP) and /ws (live) itself from an embedded FsLedgerStore instead of reverse-proxying to an upstream. Browser still connects same-origin via MCP HTTP — pure client preserved.
    
    The standalone ledger-mcp binary stays (the agent's stdio server via .mcp.json still needs it).
- alternatives: "(1) Add a LocalLedgerClient that calls FsLedgerStore methods directly — rejected: violates the pure-MCP-client invariant and duplicates the tool layer's shape-mapping (fetch view, fts hit, milestone create). (2) Web embedded via loopback self-host (serveHttp on 127.0.0.1:0 + proxy to it) — pragmatic, zero refactor, but adds an in-process network hop; kept as a fallback if the handler extraction (T17) proves heavy."
