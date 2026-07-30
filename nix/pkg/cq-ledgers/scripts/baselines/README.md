# Ledger tool-surface baselines

`g129-tool-surface.json` records the production ledger MCP server's initialized
instructions and `tools/list` surface with minified `JSON.stringify`
serialization, UTF-8 bytes, and `gpt-tokenizer@3.4.0` `o200k_base` tokens.
Regenerate it from this workspace:

```sh
bun run measure:tool-surface --all-profiles \
  --json scripts/baselines/g129-tool-surface.json
```

The three G129 figures answer different questions:

- **2,214 tokens** is the historical G93 attribution. It came from mechanically
  stripping three overlapping response-contract artifacts from the then-current
  27-tool surface. It does not compare dispatch and non-dispatch inventories.
- **2,309 tokens** applies the same mechanical G93 response-contract strip to
  the current 26-tool surface. It reflects current descriptions and schemas,
  so it does not replace or revise the historical 2,214-token observation.
- **9,518 tokens** is the current total for the complete serialized 26-tool
  non-dispatch `tools/list` inventory, not a delta.

The current 32-tool versus 26-tool inventory difference is reported separately
in the baseline; it answers a fourth question and must not be substituted for
either G93-attribution figure.

Each schema-path marginal independently subtracts a counterfactual whole-tool
serialization with that path removed. BPE tokenization depends on adjacent
bytes, so these marginal deltas must not be summed.
