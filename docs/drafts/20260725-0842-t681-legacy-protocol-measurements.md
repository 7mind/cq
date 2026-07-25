# T681 legacy protocol measurement fixtures

Date: 2026-07-25

## Outcome

The two legacy parent-visible duplication paths now have immutable, test-only
measurement fixtures:

1. `fetch_prompt` materializing a rendered dispatched-role prompt, surface
   metadata, and both schemas into the parent context; and
2. a child result followed by an ordinary `validate_output` call that resends
   the complete structured output through the parent.

The prompt fixture covers all nine dispatched roles on the Claude, Codex, and
Pi rendered surfaces. The output fixture retains the exact accepted RS5 Codex
pair at N=1. These fixtures support serialization comparisons only. They do not
support an aggregate workload claim or a cross-harness performance claim.

All fixture content resides below
`nix/pkg/cq-ledgers/packages/ledger-mcp/test/fixtures/t681/`. It contains only
JSON and Markdown data; no fixture helper enters a package export. The
deterministic assertions reside in
`packages/ledger-mcp/test/legacyProtocolMeasurements.test.ts` and make no
`fetch_prompt` or `validate_output` production call. T698 and T708 therefore
retain ownership of removing the production legacy paths.

The test contains independent SHA-256 oracles for the complete 27-record
inventory, its typed inputs, the historical RS4 representative, and every RS5
exact-pair and strategy serialization. Fixture-carried lengths, totals, and
hashes therefore cannot authorize a self-consistent payload substitution.

## Reproduction before the fixture

From `nix/pkg/cq-ledgers`, before adding the files:

```sh
test -f packages/ledger-mcp/test/fixtures/t681/prompt-dispatch.json \
  -a -f packages/ledger-mcp/test/fixtures/t681/rs5-codex-n1.json \
  -a -f packages/ledger-mcp/test/legacyProtocolMeasurements.test.ts
```

Result: exit 1. No durable oracle covered either legacy serialization path.

The follow-up immutability reproduction changed one ASCII byte in the retained
RS4 prompt (`Research` to `Researcg`). Its byte count, word count, and all
derived totals remained unchanged, and the original five tests incorrectly
passed. With the independent historical SHA-256 assertion added while the
substitution remained, the focused test failed with expected hash
`1ffcc029…` and received hash `80edd72b…`. Restoring the historical byte made
the regression pass.

A second follow-up changed the legacy strategy's declared parent-visible byte
count from 1,873 to 1,874 without changing its serialization, and replaced the
provider-usage explanation with another `Unavailable:` string. The focused
tests incorrectly accepted both substitutions. With the exact strategy-object,
computed-byte, and four-key unavailable-object assertions added, the same run
failed once for each substituted field. Restoring both fixture values made the
regressions pass.

## Measurement definitions

For each prompt-dispatch row:

- **Legacy parent bytes** are the UTF-8 bytes in the exact minified
  `JSON.stringify(fetch_prompt result)`, including rendered prompt text,
  surface metadata, input schema, and output schema. The outer MCP transport
  envelope is not included.
- **Compact parent bytes** are the UTF-8 bytes in
  `JSON.stringify({ roleId, input })`, where `input` satisfies the frozen
  response's input schema.
- **Child prompt bytes** are the exact rendered role artifact bytes.
- **Input bytes** are `JSON.stringify(input)` bytes.
- **Child bytes** are child prompt bytes plus input bytes. This arithmetic does
  not infer provider framing.
- **Fetches** count model-mediated prompt fetches visible to the parent:
  legacy=1 and compact native/dispatcher resolution=0.

Each row represents one deterministic serialization fixture (N=1), not an
observed provider request.

## Dispatched-role results

| Surface | Role                          | Legacy parent bytes | Compact parent bytes | Child prompt bytes | Input bytes | Child bytes | Legacy fetches | Compact fetches |
| ------- | ----------------------------- | ------------------: | -------------------: | -----------------: | ----------: | ----------: | -------------: | --------------: |
| claude  | `plan-advance`                |               39536 |                   50 |              35076 |          16 |       35092 |              1 |               0 |
| claude  | `plan-reviewer`               |               16854 |                   51 |              13659 |          16 |       13675 |              1 |               0 |
| claude  | `implement-worker`            |               11339 |                  229 |               7469 |         191 |        7660 |              1 |               0 |
| claude  | `implement-reviewer`          |               11142 |                  422 |               7153 |         382 |        7535 |              1 |               0 |
| claude  | `implement-conflict-resolver` |                8079 |                  261 |               4596 |         212 |        4808 |              1 |               0 |
| claude  | `investigate-explorer`        |               12517 |                  213 |               8385 |         171 |        8556 |              1 |               0 |
| claude  | `investigate-prober`          |               14339 |                  318 |              10379 |         278 |       10657 |              1 |               0 |
| claude  | `research-explorer`           |               14488 |                  194 |              10307 |         155 |       10462 |              1 |               0 |
| claude  | `research-experimenter`       |               15927 |                  305 |              12440 |         262 |       12702 |              1 |               0 |
| codex   | `plan-advance`                |               39483 |                   50 |              35025 |          16 |       35041 |              1 |               0 |
| codex   | `plan-reviewer`               |               16800 |                   51 |              13607 |          16 |       13623 |              1 |               0 |
| codex   | `implement-worker`            |               11298 |                  229 |               7431 |         191 |        7622 |              1 |               0 |
| codex   | `implement-reviewer`          |               11082 |                  422 |               7095 |         382 |        7477 |              1 |               0 |
| codex   | `implement-conflict-resolver` |                8048 |                  261 |               4567 |         212 |        4779 |              1 |               0 |
| codex   | `investigate-explorer`        |               12449 |                  213 |               8319 |         171 |        8490 |              1 |               0 |
| codex   | `investigate-prober`          |               14296 |                  318 |              10339 |         278 |       10617 |              1 |               0 |
| codex   | `research-explorer`           |               14423 |                  194 |              10244 |         155 |       10399 |              1 |               0 |
| codex   | `research-experimenter`       |               15889 |                  305 |              12405 |         262 |       12667 |              1 |               0 |
| pi      | `plan-advance`                |               39514 |                   50 |              35058 |          16 |       35074 |              1 |               0 |
| pi      | `plan-reviewer`               |               16832 |                   51 |              13641 |          16 |       13657 |              1 |               0 |
| pi      | `implement-worker`            |               11314 |                  229 |               7449 |         191 |        7640 |              1 |               0 |
| pi      | `implement-reviewer`          |               11113 |                  422 |               7128 |         382 |        7510 |              1 |               0 |
| pi      | `implement-conflict-resolver` |                8075 |                  261 |               4596 |         212 |        4808 |              1 |               0 |
| pi      | `investigate-explorer`        |               12488 |                  213 |               8360 |         171 |        8531 |              1 |               0 |
| pi      | `investigate-prober`          |               14314 |                  318 |              10359 |         278 |       10637 |              1 |               0 |
| pi      | `research-explorer`           |               14459 |                  194 |              10282 |         155 |       10437 |              1 |               0 |
| pi      | `research-experimenter`       |               15907 |                  305 |              12425 |         262 |       12687 |              1 |               0 |

Fields unavailable for every row remain separate from the byte counts:

- parent-visible tokens: unavailable; this fixture did not run a tokenizer;
- child tokens: unavailable; this fixture did not run a tokenizer;
- model-visible full-output copies: not applicable to prompt delivery;
- latency: unavailable; deterministic serialization made no provider call;
- provider usage: unavailable; no usage event can be attributed to a row.

The four unavailable keys and their complete messages are frozen exactly; a
missing key or a different `Unavailable:` explanation fails the fixture test.
No byte-to-token conversion or latency estimate was inferred.

## Retained RS4 representative

The fixture retains the exact `research-explorer.md` bytes from commit
`96823788f5b47440b5f74d4ba5ff7ccfe95cccb8`, before surface rendering changed
the current artifact:

- full prompt: 10,092 UTF-8 bytes / 1,453 whitespace-delimited words;
- compact reference `{"roleId":"research-explorer","version":1}`: 42 bytes /
  1 word;
- valid typed input: 155 bytes / 10 words;
- compact reference plus input: 197 bytes / 11 words;
- reduction: 98.047959% bytes / 99.242946% words.

The historical nine-role inventory remains recorded as 103,687 bytes / 14,787
words. The test pins `researchId=RS4`, the historical commit, every role's exact
byte/word tuple, and the representative's SHA-256, role, fixture path, compact
reference, and typed input. These are deterministic file measurements. RS4 did
not measure tokenizer tokens, provider usage, cache behavior, billing, or
latency; those fields remain unavailable rather than estimated.

The current 27-row compact encoding uses one
`{ roleId, input }` object, while the retained RS4 calculation concatenates its
historical `{ roleId, version }` reference and typed-input strings. The fixture
keeps both definitions explicit instead of treating their byte counts as
interchangeable.

## Retained RS5 exact pair

RS5's only exact child-output-to-validation pair came from Codex
`implement-reviewer`. The corpus contained no exact Claude or Pi pair, so the
following table is Codex N=1 only:

The fixture pins `researchId=RS5`, `hypothesisId=H108`, `harness=codex`, frozen commit
`104d1c2f8fb962a852152bafdf26c7f0a0d27859`, corpus cutoff
`2026-07-24T17:52:41.427Z`, and corpus-manifest SHA-256
`2b3c136fe963ea1fb72e07f1ab0f01d5b2244f36e051502f10f352497ddcfb46`.

| Strategy                              | Parent-visible bytes | Parent-visible o200k tokens | Child bytes | Full-output model-visible copies | Typed fetches | Validation calls | Parent round trips |
| ------------------------------------- | -------------------: | --------------------------: | ----------: | -------------------------------: | ------------: | ---------------: | -----------------: |
| Legacy child + `validate_output`      |                 1873 |                         432 |        1131 |                                2 |             0 |                1 |                  2 |
| Ref-first handle + single typed fetch |                  839 |                         207 |        1131 |                                1 |             1 |                0 |                  2 |
| Dispatcher-owned finalization         |                  745 |                         161 |        1131 |                                1 |             0 |                0 |                  1 |

The exact legacy decomposition also remains frozen:

- child payload: 1,131 bytes / 273 o200k tokens;
- `validate_output` arguments: 668 bytes / 132 tokens;
- validation result: 74 bytes / 27 tokens, semantically `{ "ok": true }`.

The ref-first serialization consists of a 32-hex-character content-handle
acknowledgement, the same handle as typed fetch arguments, and one terminal
envelope carrying the structured output. Dispatcher finalization returns that
terminal envelope once. Every strategy object is pinned in full after replacing
its wire strings with their fixed SHA-256 values, and every declared
`parentVisibleBytes` value must equal the measured UTF-8 length of its
`serializedParentVisible` field.

Latency remains a separate measurement:

- Codex validation calls, N=159: p50 69 ms / p95 726 ms;
- exact child-to-validation interval, N=1: 4,919 ms;
- ref-first store/fetch latency: unavailable;
- dispatcher-finalization latency: unavailable.

Provider usage remains separate and unattributed. The nearest usage event
reported 30,774 input tokens, 29,440 cached input tokens, and 173 output tokens,
but the transcript does not attribute those totals to the exact pair. They must
not be used as per-pair cost.

Corpus coverage was Claude 1 validation call / 0 exact pairs, Codex 159 calls /
1 exact pair, and Pi 0 calls / 0 exact pairs. This supports neither an aggregate
savings claim nor a cross-harness comparison.

## Pi recursion boundary

Pi's `fetch_prompt(commandRoleId)` inline command recursion remains outside the
27 dispatched-role measurements. The fixture records
`fetch_prompt("plan")` as an orchestrator-command example and explicitly marks
it as unmeasured by the dispatched-role comparison. Removing parent
`fetch_prompt` materialization for ordinary child dispatch must not remove this
distinct Pi command-loading mechanism.

## Verification

From `nix/pkg/cq-ledgers`:

```sh
bun test packages/ledger-mcp/test/legacyProtocolMeasurements.test.ts
```

Result after the immutability regressions: 5 passed, 0 failed, with 535
assertions.

`bun run typecheck` and `bun run lint` also passed. The repository-wide
`bun run check` reached 2,970 passes and 131 environment-dependent skips, then
failed one unrelated existing test:
`FsLedgerStore concurrency > T845: concurrent planning sessions leave only the
selected DAG actionable`. An isolated rerun reproduced the same unexpected
actionable `M2`; the T681 change adds no production or store code.

In constructive-test-taxonomy terms, these are Behavioral-Active
Blackbox-Atomic checks over frozen artifacts: they deliberately pin exact wire
bytes and historical measurement metadata without contacting a provider,
store, MCP transport, or production legacy dispatcher.
