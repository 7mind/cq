# T713 — Codex role selection and ref-first child-result conformance: probe evidence

- **Task**: T713 (milestone M318, goal G94). Probe, not a feature — the deliverable is evidence.
- **Date**: 2026-07-27, ~22:00–22:20 UTC.
- **Host**: NixOS, x86_64, inside the `yolo` bubblewrap sandbox (`SMIND_SANDBOXED=1`).
- **Base commit**: `0f3ff1ab0b6fc34e871c284454bc52cf12d0024c` (verified an ancestor of the
  probe worktree HEAD before any work — the base handed out was **current, not stale**).
- **Consumers**: T690 / T691 / T692 (Codex launch wiring) and T695 (MCP exposure).

Every claim below is tagged **OBSERVED** (established by executing a command, output
quoted) or **INFERRED** (read from source, help text, or reasoning over observations).
Secrets are redacted; no API key, token, or auth header appears in this note, and no
credential file was read. Where a probe of mine was *wrong*, the wrong run is kept and
labelled, because the correction is part of the evidence.

---

## 1. Verdicts

| # | Question | Verdict | Basis |
|---|---|---|---|
| 1 | Native role/config selection | **NATIVE-SELECTABLE — but FAIL-OPEN** | OBSERVED (§3) |
| 2 | Ref-first conformance | **BLOCKED-ON-T695** for the wire; **NOT-CONFORMANT as currently shaped** for the parent-side surfaces | OBSERVED in-process (§6, §7) |
| 3 | A real Codex child model turn | **ABSTAINED-ON-AVAILABILITY** | OBSERVED (§2) |

**Verdict 1 — NATIVE-SELECTABLE, with a fail-open hazard.** `codex exec --profile <name>`
really does layer `$CODEX_HOME/<name>.config.toml` and change the effective model, effort
and sandbox (OBSERVED). But **an unknown profile name is silently ignored**: no error, no
warning, exit continues into the model call with the *base* config, and `--strict-config`
does **not** close it. A launcher that selects a role by `--profile` and does not verify
the effective config will run the wrong role and never know.

**Verdict 2 — ref-first is NOT yet conformant, for two reasons that are independent of
the missing wire.** Driving prepare → store_result → confirm → fetch in-process against
T685's strict dummy with a 45,833-byte distinctive payload:

- `store_result`'s child-visible ack is **handle-only** (250 bytes, no body) ✓, and the
  handle-only child response is 71 bytes vs a 45,833-byte payload — a **645× reduction** ✓.
- But **`confirm_dispatch_completion` returns the FULL body** (46,510 bytes, marker
  present). The acceptance requires that *one fetch* returns the body. There are **two**
  body-returning parent surfaces, and the one the parent must call on *every* dispatch is
  the unavoidable one. Exposed verbatim over MCP (T695), confirm alone defeats ref-first.
- **Echo is undetectable by the store, by construction** (OBSERVED): the store never sees
  the child's final *response text*, only its `store_result` submission. Echo detection
  must be a parent-side handle-only schema check, and no such check exists today.
- **`fetch_dispatch_result` enforces no authorization at all** (OBSERVED): its signature is
  `(handle, deps)` — arity 2, no capability, no actor. `dispatchOperationScope` declares it
  `trusted-parent`, but nothing checks that. The only real boundary is *who holds
  `deps.store`*.

**Verdict 3 — ABSTENTION, not a pass and not a failure.** Both Codex routes are
unauthenticated on this host. No Codex model turn was executed, so no claim is made about
model adherence to a handle-only response, about `--output-schema` enforcement in
practice, or about real child/parent transcript separation. Those remain unobserved.

---

## 2. Availability — ABSTENTION (OBSERVED)

### Versions

```
$ codex --version
codex-cli 0.145.0                 # /nix/store/0k5pg58xr2h7ls4192i63acnmib9mqr1-codex-with-prompt-root/bin/codex
$ pi --version
0.82.0                            # /nix/store/y1nggc2v7bcvqv7s4j6ylm5pi4j47s84-pi-coding-agent-wrapped/bin/pi
```

### Route A — Codex via `pi` (the route `cq.toml` configures)

Exactly the T169/K30 invocation shape, `env -u` strip and `</dev/null` included:

```
$ env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session \
    --provider openai-codex --model gpt-5.6-sol:xhigh \
    'Reply with exactly the word PONG and nothing else.' </dev/null
No API key found for openai-codex.

Use /login to log into a provider via OAuth or API key. See:
  …/pi-monorepo/docs/providers.md
  …/pi-monorepo/docs/models.md
EXIT=1
```

The `cq.toml` comment says *"GPT quota exhausted (2026-07-26)"*. That is **not** what is
observed: the failure is **no credential at all**, not a quota rejection. The distinction
matters — a quota error would mean auth works and capacity is exhausted; this means the
`openai-codex` provider is unconfigured for `pi`.

> **Incidental defect, out of scope, reported not fixed.** The same run also crashed the
> `ledger-status` pi extension after the provider error:
> `Error: This extension ctx is stale after session replacement or reload` at
> `/nix/store/…-ledger-status/index.ts:186` (`setStatus`) ← `:205` (`refresh`).
> A provider-auth failure should not take down a status extension. Not investigated.

### Route B — the native `codex` CLI (its own auth domain)

```
$ codex login status
Not logged in
EXIT=1
```

```
$ codex exec --json --skip-git-repo-check --ephemeral 'say PONG' </dev/null
… {"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing
   bearer or basic authentication in header, url: https://api.openai.com/v1/responses …"}}
EXIT=1
```

Both routes unauthenticated. **No Codex model turn was executed by this probe.**
`cq.toml` `[aliases]` (verbatim, non-secret):

```toml
  # GPT quota exhausted (2026-07-26) — codex/terra/luna left defined but INERT
  # (referenced by no pi panel/tier); re-add to [harness.pi] to re-enable.
  codex    = "pi:openai-codex/gpt-5.6-sol:xhigh" # frontier — GPT-5.6 Sol (flagship)
  terra    = "pi:openai-codex/gpt-5.6-terra:high" # standard — balanced everyday
  luna     = "pi:openai-codex/gpt-5.6-luna:low"  # fast — high-volume lightweight
```

---

## 3. Role / config selection — NATIVE-SELECTABLE, FAIL-OPEN (OBSERVED)

`codex exec` prints its **effective config header before any network call**, so selection
is observable while unauthenticated. Probe used a throwaway `CODEX_HOME=/tmp/t713-codex-home`
(the user's `~/.codex` was never written) containing only:

```toml
# /tmp/t713-codex-home/probe.config.toml
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
sandbox_mode = "read-only"
```

| Run | Command | `model:` | `reasoning effort:` |
|---|---|---|---|
| A | `codex exec --skip-git-repo-check --ephemeral hi` | `gpt-5.6-sol` | `none` |
| B | `codex exec --profile probe …` | **`gpt-5.6-luna`** | **`low`** |
| C | `codex exec --profile absent-xyz …` | `gpt-5.6-sol` | `none` |
| D | `codex exec --strict-config --profile absent-xyz …` | `gpt-5.6-sol` | `none` |

Verbatim header from **B** (the known profile — selection works):

```
OpenAI Codex v0.145.0
--------
workdir: …/.claude/worktrees/agent-a5d13f3315bb37b3c
model: gpt-5.6-luna
provider: openai
approval: never
sandbox: read-only
reasoning effort: low
reasoning summaries: none
session id: 019fa59c-f123-7c91-ac8a-71bc2ee8797c
--------
```

Verbatim header from **C** (the unknown profile — byte-identical to baseline A, no error):

```
model: gpt-5.6-sol
provider: openai
approval: never
sandbox: read-only
reasoning effort: none
```

**B vs A proves native selection is real.** **C proves an unknown profile fails OPEN.**
**D proves `--strict-config` does not close it.** `--strict-config` *does* close the
adjacent hole — an unknown config *field*:

```
$ codex exec --strict-config -c nonexistent_key_xyz=1 --skip-git-repo-check --ephemeral hi
Error loading config.toml: unknown configuration field `nonexistent_key_xyz` in -c/--config override
EXIT=1
```

So codex 0.145.0 validates config *keys* under `--strict-config` but never validates that
the *profile file it was told to layer actually exists*.

**Consequence for T690/T691/T692 (INFERRED from the above):** a Codex launcher must not
treat `--profile <role>` as sufficient. Either (a) pass the role config through `-c`
overrides with `--strict-config` (validated, fail-closed), or (b) parse the effective-config
header / `thread.started` event and assert the expected model+effort before accepting the
run. Option (a) is the stronger of the two — `-c` is the only mechanism observed to
fail closed.

### Ambient user config silently changes the child's posture (OBSERVED)

```
$ codex exec --skip-git-repo-check --ephemeral hi         # real ~/.codex
model: gpt-5.6-sol · sandbox: workspace-write [workdir, /tmp, $TMPDIR] · reasoning effort: xhigh

$ codex exec --ignore-user-config --skip-git-repo-check --ephemeral hi
model: gpt-5.6-sol · sandbox: read-only            · reasoning effort: none
```

Cause (OBSERVED — `~/.codex/config.toml`, 28 lines, **contains no credentials**):

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
[projects."/home/pavel/work/safe/flakes/cq"]
trust_level = "trusted"
```

The repo's `trust_level = "trusted"` entry is what upgrades the sandbox from `read-only`
to `workspace-write`. A launcher that wants a deterministic isolation posture must pass
`--ignore-user-config` (and then supply the role config explicitly), or the child's
privileges depend on per-developer machine state.

### `cq mcp` is already wired into Codex (OBSERVED)

```
$ codex mcp list
Name       Command                                    Args         Env  Cwd  Status   Auth
codegraph  …-codegraph-1.5.0/bin/codegraph             serve --mcp  -    -    enabled  Unsupported
ledger     …-cq-0.0.1/bin/cq                           mcp          -    -    enabled  Unsupported
```

**This is the T695 transport, already present.** When T695 exposes
prepare/store_result/confirm/fetch as MCP tools on `cq mcp`, a Codex child reaches them
through this existing registration — no new transport work. Note `Auth: Unsupported`:
Codex's MCP client offers no per-server auth here, so the scoped `store_result` capability
must travel **in the tool arguments / prompt**, not as a transport credential (INFERRED).

---

## 4. Output-shape enforcement — a real, pre-flight-validated hook (OBSERVED, partially)

`codex exec --output-schema <FILE>` validates the schema file **locally, before any
network call**:

```
$ codex exec --output-schema /tmp/t713-bad-schema.json --skip-git-repo-check --ephemeral hi
Output schema file /tmp/t713-bad-schema.json is not valid JSON: control character
( -) found while parsing a string at line 2 column 0
EXIT=1
```

A valid handle-only schema is accepted and the run proceeds to the model call:

```json
{ "type": "object", "additionalProperties": false,
  "required": ["attestationId", "generation"],
  "properties": { "attestationId": { "type": "string", "pattern": "^att_[A-Za-z0-9_-]{32,}$" },
                  "generation": { "type": "integer", "minimum": 1 } } }
```

**OBSERVED**: the flag exists, is pre-flight validated, and accepts a handle-only schema
that structurally forbids a body (`additionalProperties: false`).
**NOT OBSERVED (ABSTENTION)**: whether the model's final response actually conforms. That
needs an authenticated turn. `--output-schema` is a *structured-output request*, and
whether adherence is provider-enforced or best-effort is exactly what a real turn would
settle. **T690/T691/T692 must not assume adherence** — see §7.

`-o/--output-last-message <FILE>` is the out-of-band body channel. **OBSERVED**: on a
failed turn the file is **not created**:

```
$ codex exec -o /tmp/t713-last-message.txt … ; echo EXIT=$?
EXIT=1
last-message file exists? NO
```

Its positive behaviour is unobserved (needs auth).

---

## 5. Enforced tool / isolation shapes (OBSERVED, with one INCONCLUSIVE part)

### A correction, kept deliberately

My first two isolation probes were **invalid**. They invoked `/bin/echo` and
`/usr/bin/touch`, which **do not exist on NixOS**, and I initially misread the resulting
`bwrap: execvp … No such file or directory` as a codex packaging defect. A control run
disproved that reading:

```
$ bwrap --ro-bind / / --dev /dev /bin/echo BWRAP_CONTROL_OK
bwrap: execvp /bin/echo: No such file or directory
```

The "denied write" in those runs was a missing binary, not a policy denial. Corrected runs
below use absolute NixOS paths.

### `/nix/store` is absent from codex's default sandbox readable roots (OBSERVED)

```
$ codex sandbox -p perm --permission-profile t713_ro --cd /tmp -- <cmd>
bwrap: execvp /nix/store/…-codex-0.145.0/bin/.codex-wrapped: No such file or directory
EXIT=1
```

`.codex-wrapped` exists on the host (a 310 MB binary, verified with `ls -l`). Adding the
store as a readable root changes the failure mode, which confirms the diagnosis:

```
$ codex sandbox … --sandbox-state-readable-root /nix/store … -- <cmd>
# proceeds into codex's own linux-sandbox
```

**On a Nix installation, `codex sandbox` cannot start without
`--sandbox-state-readable-root /nix/store`,** because the Nix wrapper re-execs
`.codex-wrapped` from the store and the store is not mounted in the namespace.

### The `[permissions]` schema, discovered by probing (OBSERVED)

`codex sandbox` **requires** `--permission-profile <NAME>`; profiles are declared as
`[permissions.<name>]` (not `[permissions.profiles.<name>]` — that declares a profile
literally named `profiles`):

```toml
# $CODEX_HOME/perm.config.toml
[permissions.t713_ro]
sandbox_mode = "read-only"

[permissions.t713_rw]
sandbox_mode = "workspace-write"
```

### `--permission-profile` FAILS CLOSED on an unknown name (OBSERVED)

```
$ codex sandbox -p perm --permission-profile NO_SUCH_PROFILE …
Error: default_permissions refers to undefined profile `NO_SUCH_PROFILE`
EXIT=1
```

**This is the opposite of `--profile`'s behaviour (§3).** Codex 0.145.0 validates a
*permission* profile name and silently ignores a *config* profile name. Any launcher
audit must treat the two flags differently.

### Enforcement engages (OBSERVED) — but read-only vs workspace-write is INCONCLUSIVE

Writing into the `--cd` workspace itself, so a difference is attributable to policy rather
than to a path missing from the namespace:

| Run | Profile | Operation | Result |
|---|---|---|---|
| A | `t713_ro` | `cat $WS/readable.txt` | `marker`, **EXIT=0** — reads permitted |
| B | `t713_ro` | `touch $WS/w-ro` | `touch: cannot touch '…': **Read-only file system**`, EXIT=1 |
| C | `t713_rw` | `touch $WS/w-rw` | `touch: cannot touch '…': **Read-only file system**`, EXIT=1 |
| D | `t713_rw` | `touch /tmp/t713-outside` | **EXIT=0**, but the file did **not** appear on the host |

- **B is a genuine policy denial**: `EROFS` (`Read-only file system`), not `ENOENT`. The
  sandbox engages and enforces read-only. **OBSERVED.**
- **C is the inconclusive part**: `sandbox_mode = "workspace-write"` in a
  `[permissions.<name>]` profile did **not** make the `--cd` workspace writable. Either
  the writable roots are declared by a key I did not find, or my
  `--sandbox-state-readable-root` flags overrode writability. `codex sandbox --help`
  names `--sandbox-state-json <JSON>` — "JSON value from `codex/sandbox-state-meta`" — as
  the authoritative way to supply sandbox state, and I had no such value. **I therefore do
  not claim to know how to grant a Codex child a writable workspace.** T690/T691/T692
  must settle this before relying on it.
- **D is a hazard worth flagging**: a write reported **success** (EXIT=0) yet produced no
  host-visible file. Most probable reading (**INFERRED**, not confirmed): the sandbox
  provides a private `/tmp`, so the write landed inside the namespace and was discarded.
  If so, a Codex child can believe it wrote a file that no one will ever read — which for
  an implement-worker style role means a silently lost commit or artifact.

### `pi`'s tool-isolation surface (OBSERVED from `--help`)

`--no-tools/-nt`, `--no-builtin-tools/-nbt`, `--tools <allowlist>`,
`--exclude-tools <denylist>`, `--no-extensions`, `--no-skills`, `--no-context-files`,
`--no-session`. The cq invocation shape already uses `--no-tools --no-session`. **A
`--no-tools` child cannot call an MCP tool** — so a ref-first Codex child that must call
`store_result` cannot be launched with `--no-tools`; it needs `--tools store_result`
(allowlist) instead. This is a concrete, presently-unhandled conflict with the existing
K30 invocation shape (**INFERRED** from the help text; not executed, as the provider is
unauthenticated).

---

## 6. Raw child/parent shapes (OBSERVED)

`codex exec --json` emits JSONL events on stdout. Verbatim, unauthenticated run
(cf-ray / request-id values are not secrets but are the provider's; kept as emitted):

```json
{"type":"thread.started","thread_id":"019fa59e-db9e-76a1-8553-c35150390937"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a21ef5d8fc9ec6a4-DUB)"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: …"}}
{"type":"error","message":"unexpected status 401 Unauthorized: … request id: f6609f00-e6b6-409f-8acd-e024fb59cece"}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: … request id: f6609f00-e6b6-409f-8acd-e024fb59cece"}}
```

14 stdout lines total; a parallel human-readable stream goes to stderr.

Three load-bearing facts, all **OBSERVED**:

1. **`thread.started.thread_id` is the native correlation identity, and it is emitted
   first — before any auth failure.** This is the value that binds to T685's
   `expectedChild.childId`, and it is available even on a failed run, so the parent can
   always correlate what it launched. (The in-process probe in §7 uses a real captured
   `thread_id`, `019fa59e-db9e-76a1-8553-c35150390937`, as `childId`.)
2. **`item.completed` carries the full `item` object inline.** Item bodies are emitted
   into the parent's stdout stream verbatim. **This is the leak channel.**
3. **There is no flag that suppresses item bodies while retaining correlation.**
   `codex exec --help` offers `--json` (all events, bodies included) or no `--json` (human
   text, bodies included). Nothing in between.

**Consequence (INFERRED, but forced by 2 + 3):** the parent's *process* unavoidably
receives the child's output. Ref-first can therefore only be enforced at the boundary
between the parent process and the **parent model's context**: the launcher must parse the
JSONL, keep `thread_id` + terminal event type, and discard item bodies. If any production
path pipes raw `codex exec` stdout into a parent model turn, ref-first is defeated *no
matter what the child does* — and it would still show a token "saving" only if the child
also stored, which is precisely the parent-owned raw fallback the acceptance forbids
counting as a saving.

---

## 7. Ref-first conformance, driven in-process against T685's dummy (OBSERVED)

**Honest scope limit.** `DISPATCH_ATTESTATION_MCP_DEFERRED_TO = "T695"`
(`packages/cq-config/src/dispatchAttestation.ts:1786`): there is **no MCP exposure** of
these operations. A real Codex child **cannot call `store_result` over a wire today**. So
the "child" below is a local call holding **only** the scoped capability — the
authorization boundary is real and exercised, the wire is not. Everything in this section
is in-process against `InMemoryAttestationStore` + `FakeDispatchClock`.

Probe source: §9. Run: `bun run packages/cq-config/t713-probe.ts` from `nix/pkg/cq-ledgers/`.

### 7.1 Happy path

Distinctive payload: a schema-valid `implement-worker` result carrying the marker
`T713-DISTINCTIVE-PAYLOAD-MARKER-9d4f2a` in 400 `filesTouched` entries and in `summary`.

```
payload the child submits: 45833 bytes

executedStepOrder: ["resolve-role-contract","validate-role-input",
                    "validate-declared-overlay-data","allocate-attestation",
                    "mint-result-capability"]
```

`prepared` (parent-side; **capability token redacted — it is a bearer secret**):

```json
{
  "attestationId": "att_BeB3kNbyZ-ObCTKTP8A9vz1V_a5zYjzo",
  "generation": 1,
  "responseStoreNow": "2026-07-27T22:09:30.000Z",
  "childCancelAt": "2026-07-27T22:10:00.000Z",
  "launchDeadline": "2026-07-27T22:01:00.000Z",
  "promptProvenance": {
    "roleId": "implement-worker", "version": 1, "surface": "claude",
    "promptDigest": "aaaa…aaaa", "catalogHash": "bbbb…bbbb",
    "inputDigest": "77f82927506f5d0803ee41acaac4f0cba3f56f8c6172cf748822118d9561c599"
  },
  "resultCapability": { "scope": "store-result", "token": "<REDACTED cq_result_…>" }
}
```

`store_result` ack — **what the child gets back. Handle-only, no body:**

```json
{ "state": "result-stored",
  "result": { "state": "result-stored",
    "attestationId": "att_BeB3kNbyZ-ObCTKTP8A9vz1V_a5zYjzo", "generation": 1,
    "storedAt": "2026-07-27T22:00:00.000Z",
    "outputDigest": "e0410fc89647f96a3320ac928db15512bd522bcce099521bf3ff17975922cfee" } }
```

The handle-only child final response, and the whole point of the protocol:

```
HANDLE-ONLY child final response: {"attestationId":"att_DR6nb6ArWFPC7CHHcQwIfAJKJ25D-2u3","generation":1}
  handle bytes=71  vs  payload bytes=45833
  ratio = 645.5x
```

### 7.2 Which surfaces carry the body? — the decisive measurement

Marker presence is the operational test for "the body reached this surface":

| surface | bytes | carries the body? |
|---|---|---|
| `prepare_dispatch` → `prepared` | 636 | no |
| `store_result` → ack (child-visible) | 250 | **no** ✓ |
| `fetch` BEFORE confirm (`result-stored`) | 457 | no |
| `confirm_dispatch_completion` → return | **46 510** | **YES — BODY PRESENT** ✗ |
| `fetch` AFTER confirm (`consumed`) | 46 480 | YES (by design — the one authorized read) |

**This is the conformance failure.** `confirmDispatchCompletion` returns
`ConsumedDispatchResult`, and `consumedResultOf` (`dispatchAttestation.ts:1098`) puts
`output: row.output` on it. Confirm is not optional — it is the only `result-stored →
consumed` promotion — so **every** dispatch's parent surface hands back the full body,
and the acceptance's "one fetch returns the body" is violated by a second, mandatory
surface. The `store_result` ack shows the correct shape to copy: state + handle + digest.

**Recommendation for T695 (the MCP exposure):** make the `confirm_dispatch_completion`
tool response handle-only — `{state, attestationId, generation, consumedAt, outputDigest}`
— mirroring `StoredDispatchResultView`, and let `fetch_dispatch_result` be the sole
body-returning tool. This needs no change to the T685 service if the MCP layer projects
the response; changing `consumedResultOf` itself would be cleaner but is T685's contract.

### 7.3 The eight typed failures the acceptance names

All **OBSERVED**. Every one is a distinct type; none degrades into a lifecycle state.

| # | Scenario | Observed result |
|---|---|---|
| 1 | **Invalid output** | `state=aborted reason=invalid-output`, atomically. Typed details: `role=implement-worker v=1 summary=/ must have required property 'branch'; … /status must be equal to one of the allowed values`. Subsequent `fetch` → `aborted`. Never passed through `result-stored`. |
| 2 | **Body echo** | **Not detectable by the store.** See below. |
| 3 | **Cancellation after store** | `abortDispatch(reason="cancelled")` accepted from `result-stored`; the later confirm → `DispatchStateConflictError: … is aborted (cancelled) and cannot be consumed`. `fetch` → `aborted`, **body not reachable**. Abort wins. |
| 4 | **Stale generation** | `fetch` gen+1 → `{"state":"attestation-not-found","generation":2}`; `confirm` gen+1 → `AttestationNotFoundError: no attestation "att_…" at generation 2`. |
| 5 | **Mismatched child** | `AttestationBindingError: nativeCompletion: completion claims child/run "019fffff-…"/"turn-0001" but attestation "att_…" expects "019fa59e-db9e-76a1-8553-c35150390937"/"turn-0001"`. |
| 5b | **Mismatched provenance** | `AttestationBindingError: expectedProvenance.promptDigest: attestation "att_…" was prepared with promptDigest "aaaa…", not "cccc…"`. |
| 6 | **Unavailable store** | Adapter throwing `AttestationTransportError` → `AttestationTransportError: attestation store unreachable: ECONNREFUSED`. Adapter throwing `AttestationStorageError` on `replace` → `AttestationStorageError: lost update: row revision moved`. |
| 6b | **Untyped adapter failure** | A `TypeError` from the adapter propagates **unwrapped**: `TypeError: undefined is not a function`. The service does **not** normalise store errors — typed-ness is the **adapter's** contract. T720's production adapters must guarantee it. |
| 7 | **Unauthorized fetch** | **No authorization is enforced.** See below. |
| 8 | **Foreign namespace** | `fetch` of a valid handle against another namespace's store → `{"state":"attestation-not-found"}` — absence, correctly, not a leak. |

**#2, echo, in detail (OBSERVED).** A child that stores *and also* echoes the body in its
final response produces a 45,914-byte response containing the marker. No store operation
can see this: the store observes only the `store_result` submission, never the child's
final response text. The check must be parent-side and structural:

```
[echo] parent-side handle-only check -> extra keys: ["output"] => PROTOCOL VIOLATION
```

Per the acceptance, **echo is a protocol/adherence failure, not a convenience**. A
conformant launcher must validate the child's final response against the handle-only
schema (§4) and **abort `protocol-violation`** on any extra key — not accept the handle
and shrug at the body. No such check exists today; it is unowned work for T690/T691/T692.

**#7, unauthorized fetch, in detail (OBSERVED).**

```
dispatchOperationScope("fetch_dispatch_result")      = trusted-parent
resultCapabilityAuthorizes("fetch_dispatch_result")  = false
fetchDispatchResult.length = 2  // (handle, deps) — no capability, no actor
state=consumed; body handed to a caller with NO capability and NO actor? YES
```

The scope table *declares* `fetch_dispatch_result` to be `trusted-parent`, and a result
capability correctly does not authorize it — but `fetchDispatchResult` takes no actor
argument, so **there is nothing to reject**. The only boundary is possession of
`deps.store`. That is adequate in-process (a child never holds the store) and **wholly
inadequate over MCP**, where every caller reaches the same server. **T695 must enforce the
`trusted-parent` scope itself**; it cannot inherit it from T685. Same reasoning applies to
`confirm_dispatch_completion` and `abort_dispatch`, which are also declared
`trusted-parent` and also take no actor.

### 7.4 What the child and parent transcripts show, separately

The acceptance asks that child and parent transcripts be inspected separately and that
opaque ids not be taken as proof of provenance. In-process:

- **Child-visible surface**: capability token (secret) in, `{state, attestationId,
  generation, storedAt, outputDigest}` out. The child never learns the namespace, cannot
  name an attestation id or generation (T685's `StoreResultCannotName` makes this a
  compile-time property), and cannot fetch, confirm, or abort. Verified by the scope table
  and by `RESULT_CAPABILITY_OPERATIONS = ["store_result"]`.
- **Parent-visible surface**: `prepared` (636 B) → `confirm` (**46 510 B, body**) →
  `fetch` (46 480 B, body).
- **Provenance is NOT established by the opaque id.** `att_BeB3kNbyZ-…` on its own proves
  nothing. What binds the record is the pair of checks in `confirmDispatchCompletion`:
  `expectedProvenance` (roleId, version, promptDigest, inputDigest — all four compared,
  failure #5b) **and** `expectedChild` (childId, runId — failure #5). Both were observed to
  reject a mismatch. A launcher that passes a `thread_id` it read out of the child's own
  output rather than out of `thread.started` in its own captured stream would be
  self-certifying; the correlation is only meaningful because `thread.started` arrives on
  the **parent's** stdout (§6, fact 1).

---

## 8. Consequences for the dependent tasks

Ordered by how much a wrong assumption would cost.

1. **T690/T691/T692 must not select a role with bare `--profile`.** It fails open and
   `--strict-config` does not close it (§3). Use `-c` overrides with `--strict-config`, or
   assert the effective config header before accepting the run.
2. **T695 must enforce `trusted-parent` itself** on confirm/abort/fetch. T685 declares the
   scope but implements no actor check (§7.3 #7).
3. **T695 should make the confirm response handle-only.** As shaped, confirm returns the
   full body on every dispatch, which defeats ref-first independently of the child (§7.2).
4. **Whoever owns the launcher must add a parent-side handle-only response check** and
   abort `protocol-violation` on echo. Nothing in the store can do it (§7.3 #2).
5. **The launcher must never pipe raw `codex exec` stdout into a parent model turn.**
   `item.completed` carries bodies inline and no flag suppresses them (§6).
6. **`--no-tools` is incompatible with a ref-first Codex child**, which must be able to
   call `store_result`. The current K30 invocation shape uses `--no-tools` (§5).
7. **Codex's sandbox needs `--sandbox-state-readable-root /nix/store` on NixOS** or it
   cannot start, and **how to grant a writable workspace is unresolved** (§5).
8. **Re-run §2 before building on any of this.** Both routes are unauthenticated; the
   `cq.toml` "quota exhausted" comment is inaccurate — it is a missing credential.

### Still unobserved (requires an authenticated Codex turn)

- Whether a Codex model actually honours a handle-only `--output-schema`.
- Whether `-o/--output-last-message` writes the body out of band on success.
- Real cancellation mid-turn (SIGINT/timeout) event shapes.
- End-to-end capability-bound `store_result` from a real child over MCP (**T695**).

---

## 9. Reproduction

### Shell probes

```bash
# versions + availability
codex --version; pi --version; codex login status
env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session \
  --provider openai-codex --model gpt-5.6-sol:xhigh 'Reply with exactly the word PONG.' </dev/null

# role/config selection (THROWAWAY CODEX_HOME — never write the user's ~/.codex)
H=/tmp/t713-codex-home; mkdir -p "$H"
printf 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n' \
  > "$H/probe.config.toml"
for args in "" "--profile probe" "--profile absent-xyz" "--strict-config --profile absent-xyz"; do
  CODEX_HOME="$H" codex exec $args --skip-git-repo-check --ephemeral hi </dev/null 2>&1 | sed -n '1,14p'
done
codex exec --strict-config -c nonexistent_key_xyz=1 --skip-git-repo-check --ephemeral hi   # fails closed

# ambient-config drift
codex exec --skip-git-repo-check --ephemeral hi </dev/null 2>&1 | grep -E '^(model|sandbox|approval|reasoning effort):'
codex exec --ignore-user-config --skip-git-repo-check --ephemeral hi </dev/null 2>&1 | grep -E '^(model|sandbox|approval|reasoning effort):'

# raw parent-visible event shapes
codex exec --json --skip-git-repo-check --ephemeral 'say PONG' </dev/null

# output-schema pre-flight validation
printf '{ "type": "obj\n' > /tmp/t713-bad-schema.json
codex exec --output-schema /tmp/t713-bad-schema.json --skip-git-repo-check --ephemeral hi

# isolation — NOTE: use absolute NixOS paths, and add /nix/store as a readable root
printf '[permissions.t713_ro]\nsandbox_mode = "read-only"\n\n[permissions.t713_rw]\nsandbox_mode = "workspace-write"\n' \
  > "$H/perm.config.toml"
WS=/tmp/t713-ws; mkdir -p "$WS"; echo marker > "$WS/readable.txt"
RR="--sandbox-state-readable-root /nix/store --sandbox-state-readable-root /run/current-system --sandbox-state-readable-root $WS"
CODEX_HOME="$H" codex sandbox -p perm --permission-profile t713_ro     $RR --cd "$WS" -- "$(command -v cat)"   "$WS/readable.txt"
CODEX_HOME="$H" codex sandbox -p perm --permission-profile t713_ro     $RR --cd "$WS" -- "$(command -v touch)" "$WS/w-ro"
CODEX_HOME="$H" codex sandbox -p perm --permission-profile t713_rw     $RR --cd "$WS" -- "$(command -v touch)" "$WS/w-rw"
CODEX_HOME="$H" codex sandbox -p perm --permission-profile NO_SUCH     $RR --cd "$WS" -- "$(command -v touch)" x   # fails closed
```

### In-process ref-first probe

Save as `nix/pkg/cq-ledgers/packages/cq-config/t713-probe.ts` and run
`bun run packages/cq-config/t713-probe.ts` from `nix/pkg/cq-ledgers/`. (It must live inside
a package that resolves `@cq/config`; at the workspace root the import does not resolve.)

```ts
import {
  AttestationStorageError, AttestationTransportError, DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock, InMemoryAttestationStore, abortDispatch, confirmDispatchCompletion,
  dispatchOperationScope, fetchDispatchResult, invalidOutputDetailsOf, prepareDispatch,
  provenanceBindingOf, resultCapabilityAuthorizes, storeDispatchResult,
  type AttestationNamespace, type AttestationStoreOperation, type DispatchJSONValue,
  type DispatchPrepareAccepted, type DispatchPrepared, type DispatchServiceDeps,
  type NativeCompletionProof, type PrepareDispatchDeps, type PrepareDispatchOutcome,
  type PrepareDispatchRequest,
} from "@cq/config";

const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "cq-ledger-suite" };
const T0 = "2026-07-27T22:00:00.000Z";
const PROMPT_DIGEST = "a".repeat(64);
const CATALOG_HASH = "b".repeat(64);
const TIMEOUT_MS = 600_000;
// A REAL thread_id captured from `codex exec --json` (§6).
const CHILD = { childId: "019fa59e-db9e-76a1-8553-c35150390937", runId: "turn-0001" } as const;
const MARKER = "T713-DISTINCTIVE-PAYLOAD-MARKER-9d4f2a";

const INPUT: DispatchJSONValue = {
  taskId: "T713", headline: "Probe Codex role selection and ref-first conformance",
  acceptance: "A committed secret-redacted evidence note records both verdicts.",
  worktreePath: "/tmp/wt-T713", branch: "implement/T713",
  baseCommit: "0f3ff1ab0b6fc34e871c284454bc52cf12d0024c",
};

/** A LARGE but schema-valid implement-worker result. */
const LARGE_OUTPUT: DispatchJSONValue = {
  taskId: "T713", status: "pass",
  resultCommit: "0f3ff1ab0b6fc34e871c284454bc52cf12d0024c", branch: "implement/T713",
  filesTouched: Array.from({ length: 400 }, (_, i) =>
    `packages/cq-config/src/generated/${MARKER}/file-${String(i).padStart(4, "0")}.ts`),
  checkSummary: "3692 pass / 141 skip / 0 fail",
  summary: `${MARKER} ${"lorem ipsum dolor sit amet ".repeat(400)}`,
};

const COMPLETION: NativeCompletionProof = {
  kind: "native-completion", actor: "trusted-parent",
  childId: CHILD.childId, runId: CHILD.runId, completedAt: "2026-07-27T22:05:00.000Z",
};

function harness(fault?: (op: AttestationStoreOperation) => void) {
  const clock = new FakeDispatchClock(T0);
  const store = fault === undefined
    ? new InMemoryAttestationStore(NAMESPACE)
    : new InMemoryAttestationStore(NAMESPACE, fault);
  return {
    store,
    deps: { store, now: clock.now } as DispatchServiceDeps,
    prepareDeps: { store, now: clock.now,
      randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) } as PrepareDispatchDeps,
  };
}

function prepareRequest(overrides: Record<string, unknown> = {}): PrepareDispatchRequest {
  return {
    namespace: NAMESPACE, roleId: "implement-worker", surface: "claude", input: INPUT,
    idempotencyKey: `T713-probe-${Math.random().toString(36).slice(2)}`,
    timeoutMs: TIMEOUT_MS, registry: DISPATCH_OVERLAY_REGISTRY,
    promptDigest: PROMPT_DIGEST, catalogHash: CATALOG_HASH, expectedChild: CHILD,
    ...overrides,
  } as PrepareDispatchRequest;
}

function accepted(o: PrepareDispatchOutcome): DispatchPrepareAccepted {
  if (!o.accepted) throw new Error(`prepare rejected: ${o.reason} ${o.detail}`);
  return o;
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const hasMarker = (v: unknown) => JSON.stringify(v ?? null).includes(MARKER);

function attempt(label: string, fn: () => unknown): void {
  try { console.log(`[${label}] NO THROW -> ${JSON.stringify(fn()).slice(0, 300)}`); }
  catch (e) { const x = e as Error; console.log(`[${label}] ${x.name}: ${x.message.slice(0, 260)}`); }
}

// --- 1/2: which surfaces carry the body? --------------------------------
{
  const h = harness();
  const p: DispatchPrepared = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
  const stored = storeDispatchResult({ resultCapability: p.resultCapability, output: LARGE_OUTPUT }, h.deps);
  const beforeConfirm = fetchDispatchResult(p, h.deps);
  const confirmed = confirmDispatchCompletion({
    namespace: NAMESPACE, attestationId: p.attestationId, generation: p.generation,
    nativeCompletion: COMPLETION, expectedProvenance: provenanceBindingOf(p),
  }, h.deps);
  const afterConfirm = fetchDispatchResult(p, h.deps);
  console.log(`payload=${bytes(LARGE_OUTPUT)}B  handle=${bytes({ attestationId: p.attestationId, generation: p.generation })}B`);
  for (const [label, v] of [
    ["prepared", p], ["store_result ack", stored], ["fetch before confirm", beforeConfirm],
    ["confirm return", confirmed], ["fetch after confirm", afterConfirm],
  ] as const) console.log(`${label} | ${bytes(v)} | ${hasMarker(v) ? "BODY PRESENT" : "no body"}`);
}

// --- 3: the typed failures --------------------------------------------
{ // invalid output
  const h = harness();
  const p = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
  const out = storeDispatchResult({ resultCapability: p.resultCapability,
    output: { taskId: "T713", status: "maybe", resultCommit: 42 } as unknown as DispatchJSONValue }, h.deps);
  console.log(`[invalid-output] ${out.state} ${"reason" in out.result ? out.result.reason : ""} ` +
    `${invalidOutputDetailsOf(out.result as never)?.summary?.slice(0, 120)}`);
}
{ // echo is not store-detectable
  const h = harness();
  const p = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
  storeDispatchResult({ resultCapability: p.resultCapability, output: LARGE_OUTPUT }, h.deps);
  const echoing = { attestationId: p.attestationId, generation: p.generation, output: LARGE_OUTPUT };
  const extra = Object.keys(echoing).filter((k) => k !== "attestationId" && k !== "generation");
  console.log(`[echo] parent-side handle-only check -> extra keys: ${JSON.stringify(extra)} => PROTOCOL VIOLATION`);
}
{ // cancellation after store — abort wins
  const h = harness();
  const p = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
  storeDispatchResult({ resultCapability: p.resultCapability, output: LARGE_OUTPUT }, h.deps);
  abortDispatch({ namespace: NAMESPACE, attestationId: p.attestationId, generation: p.generation,
    actor: "trusted-parent", reason: "cancelled" }, h.deps);
  attempt("cancel-after-store: confirm", () => confirmDispatchCompletion({
    namespace: NAMESPACE, attestationId: p.attestationId, generation: p.generation,
    nativeCompletion: COMPLETION, expectedProvenance: provenanceBindingOf(p) }, h.deps));
}
{ // stale generation, mismatched child, mismatched provenance
  const h = harness();
  const p = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
  storeDispatchResult({ resultCapability: p.resultCapability, output: LARGE_OUTPUT }, h.deps);
  console.log(`[stale] ${JSON.stringify(fetchDispatchResult({ attestationId: p.attestationId, generation: p.generation + 1 }, h.deps))}`);
  attempt("mismatched-child", () => confirmDispatchCompletion({
    namespace: NAMESPACE, attestationId: p.attestationId, generation: p.generation,
    nativeCompletion: { ...COMPLETION, childId: "019fffff-0000-7000-8000-000000000000" },
    expectedProvenance: provenanceBindingOf(p) }, h.deps));
  attempt("mismatched-provenance", () => confirmDispatchCompletion({
    namespace: NAMESPACE, attestationId: p.attestationId, generation: p.generation,
    nativeCompletion: COMPLETION,
    expectedProvenance: { ...provenanceBindingOf(p), promptDigest: "c".repeat(64) } }, h.deps));
}
{ // store failures: typed vs untyped
  for (const [label, thrower] of [
    ["transport", () => { throw new AttestationTransportError("attestation store unreachable: ECONNREFUSED"); }],
    ["untyped",   () => { throw new TypeError("undefined is not a function"); }],
  ] as const) {
    const h = harness((op) => { if (op === "readByCapabilityHash") thrower(); });
    const p = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
    attempt(`store-${label}`, () => storeDispatchResult({ resultCapability: p.resultCapability, output: LARGE_OUTPUT }, h.deps));
  }
  const h = harness((op) => { if (op === "replace") throw new AttestationStorageError("lost update: row revision moved"); });
  const p = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
  attempt("store-storage", () => storeDispatchResult({ resultCapability: p.resultCapability, output: LARGE_OUTPUT }, h.deps));
}
{ // unauthorized fetch: there is nothing to reject
  const h = harness();
  const p = accepted(prepareDispatch(prepareRequest(), h.prepareDeps)).prepared;
  storeDispatchResult({ resultCapability: p.resultCapability, output: LARGE_OUTPUT }, h.deps);
  confirmDispatchCompletion({ namespace: NAMESPACE, attestationId: p.attestationId,
    generation: p.generation, nativeCompletion: COMPLETION,
    expectedProvenance: provenanceBindingOf(p) }, h.deps);
  console.log(`scope=${dispatchOperationScope("fetch_dispatch_result")} ` +
    `capabilityAuthorizes=${resultCapabilityAuthorizes("fetch_dispatch_result")} ` +
    `arity=${fetchDispatchResult.length}`);
  console.log(`body handed to a caller with NO capability and NO actor? ` +
    `${hasMarker(fetchDispatchResult(p, h.deps)) ? "YES" : "no"}`);
  attempt("foreign-namespace fetch", () => fetchDispatchResult(p, harness().deps));
}
```

### Tests added, and mutation testing

**None.** This task is a probe; its deliverable is this note. No production code was
changed and no guard was added, so there is nothing to mutation-test — an empty mutation
table is the correct report here, not an omission. The findings that *should* become
guards belong to their owning tasks: the handle-only confirm response and the
`trusted-parent` actor check to **T695**, the fail-open `--profile` audit and the
parent-side echo check to **T690/T691/T692**.

### Redaction

Checked before committing. The result capability token is replaced with
`<REDACTED cq_result_…>`; `~/.codex/config.toml` was inspected and **contains no
credential** (only model, effort, MCP server paths, and per-project `trust_level`), so the
four lines quoted in §3 are non-secret. No `auth.json`, API key, bearer token, or
`Authorization` header appears anywhere in this note. The provider `cf-ray` and
`request id` values in §6 are OpenAI-side correlation ids from *failed unauthenticated*
requests, retained because the raw event shape is the evidence.
