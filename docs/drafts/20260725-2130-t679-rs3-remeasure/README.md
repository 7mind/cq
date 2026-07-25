# T679 — RS3-corpus re-measurement harness

Re-measures the **implemented** ledger MCP wire shapes (compact/full
projections, fixed mutation acknowledgements, minified JSON) against the corpus
`researches:RS3` measured, and against the RS3-era server itself.

Report: `docs/drafts/20260725-2130-t679-rs3-remeasurement.md`.

## What each script does

| Script | Question it answers |
|---|---|
| `pin-corpus.ts` | Which 357 transcripts are the RS3 corpus? Writes `corpus-manifest.json` (name/size/sha256) and fails unless the set is exactly 357 files / 95,152,796 bytes. |
| `remeasure.ts` | For every captured ledger tool result in that corpus: bytes + `o200k_base` tokens before, and after passing the captured payload through the SHIPPED `wireResponseContract.ts` transforms in the SHIPPED envelopes. Also request-side arg cost, `projection:"full"` control, per-call regression counts, compact/ack correctness assertions, and per-transcript amortization scenarios. |
| `schema-overhead.ts` | What does `tools/list` cost, and how much of the growth is the response contract? Boots the real stdio MCP server over an in-memory transport and tokenizes the returned tool definitions. Run it against BOTH trees. |
| `twin-server-probe.ts` | For tools the corpus never exercised (`search_items`, `update_milestone`, `create_ledger`, `reopen_item`, `unarchive_item`): drives the RS3-era server and the cutover server with an identical operation script and compares the actual responses. |

## Exact commands

```sh
# 0. deps for this harness only (gpt-tokenizer@3.4.0); does not touch the workspace lockfile
cd docs/drafts/20260725-2130-t679-rs3-remeasure && bun install

# 1. materialise the RS3-era tree (read-only; extracts to a scratch dir)
SCRATCH=/tmp/t679-rs3-tree && mkdir -p "$SCRATCH"
git archive -o /tmp/t679-rs3.tar 3fe3b8a7935f3027218581e76bb9da2ce1b833e2 nix/pkg/cq-ledgers
tar -xf /tmp/t679-rs3.tar -C "$SCRATCH"
(cd "$SCRATCH/nix/pkg/cq-ledgers" && bun install)

# 2. pin the corpus (already committed as corpus-manifest.json; re-running must be a no-op)
bun run pin-corpus.ts

# 3. corpus replay
bun run remeasure.ts --schema-delta 2214            # -> out/corpus-remeasurement.json

# 4. request-side schema cost, both trees
bun run schema-overhead.ts --workspace "$PWD/../../../nix/pkg/cq-ledgers" --json out/schema-current.json
bun run schema-overhead.ts --workspace "$SCRATCH/nix/pkg/cq-ledgers"   --json out/schema-rs3.json

# 5. twin-server differential
bun run twin-server-probe.ts \
  --before "$SCRATCH/nix/pkg/cq-ledgers" \
  --after  "$PWD/../../../nix/pkg/cq-ledgers"          # -> out/twin-server-probe.json
```

`remeasure.ts` exits non-zero if the corpus drifts from the manifest, if any
JSONL line fails to parse, or if any compact/ack correctness assertion fails.

## What the numbers are and are not

Every figure is the size of one serialized response or request in UTF-8 bytes
and in `gpt-tokenizer@3.4.0` / `o200k_base` tokens. They are **wire-shape**
measurements. They are not billed tokens: host framing, prompt caching, call
mix, tool-schema caching and downstream reasoning are all outside the probe,
and `o200k_base` is a reproducible proxy, not the tokenizer any Claude model
bills with.

## Corpus provenance

`corpus-manifest.json` pins the 357 `*.jsonl` raw subagent transcripts under
`$XDG_STATE_HOME/cq/projects/9faab3c136afe411b16a43206b14f834382ed440/logs/raw`
whose mtime predates the RS3 measurement (2026-07-24T11:00 local). That project
key is the one whose `logs/` also holds the RS3 session logs, and the resulting
set reproduces RS3's stated corpus exactly: 357 files, 95,152,796 bytes. The
directory keeps growing, so re-runs verify the manifest's sha256 digests rather
than re-deriving the set from mtimes.
