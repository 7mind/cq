# G94 compact / ref-first cutover

Breaking cutover. There is no old-client compatibility path.

## Actors

| Actor | Owns |
|---|---|
| Parent orchestrator | `prepare_dispatch`, native-completion confirmation, `abort_dispatch`, one `fetch_dispatch_result` |
| Child / extension | capability-scoped `store_result` only |
| G91 prompt surfaces | rendered role bytes, catalog digest, Home Manager prompt roots |
| G94 protocol | attestation, capabilities, lifecycle, telemetry |

## Lifecycle states

`prepared` → (`gate-pending` / `gate-running`) → `result-stored` → `consumed`

Terminal abort reasons: `cancelled`, `native-failure`, `protocol-violation`, `invalid-output`, `missing-result`, `deadline-exceeded`, `parent-lost`, `operational-abstention`.

Lookup states that are not child failures: `attestation-not-found`, `terminal-envelope-expired`, `output-already-materialized`.

Authorization, transport, and storage failures remain errors. They are not lifecycle states.

## Retention

- 24h terminal envelope
- 30d idempotency horizon / tombstone
- Capability tokens are never persisted; only hashes are stored

## Surfaces

- **Claude (T722 / T688):** native or bridge interception; handle-only completion; parent confirms expected child/run; one fetch.
- **Codex (T713 / Q318):** child `store_result`, handle-only final reply, parent native-thread confirmation, one fetch.
- **Pi (Q317 / T693):** extension-local store/fetch; `dispatch_agent` task is the opaque handle; recursion via `inline-command-recursion` is allowlisted separately.

## Explicitly remaining

- `fetch_prompt` for inspection/debug and inventory-declared Pi command recursion
- Catalog validators for non-production inspection

## Explicitly gone from production flows

- parent-side dispatched-role `fetch_prompt` / `prompt-catalog fetch`
- ordinary model-visible `validate_input` / `validate_output`
- raw-result completion
- generic launcher / `task: "<complete prompt>"`
- held-freeform Pi implement parent authority (K267)

## Telemetry (T699–T703)

Attestation-keyed records distinguish **measured zero** from **unavailable(reason, source-shape)**. Provider tokens are never inferred from bytes. RS4's 98.05% representative compact-prompt result and RS5's N=1 output-validation pair stay labeled, non-aggregate, and are not production savings claims.

## Verification

```sh
cd nix/pkg/cq-ledgers && bun run check
nix build .#cq
nix build .#claude-prompt-root .#codex-prompt-root .#pi-prompt-root
```
