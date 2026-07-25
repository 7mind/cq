# T658 packaged prompt-surface verification

Date: 2026-07-25

## Outcome

The G91/G93 capstone acceptance matrix passes without product-source changes.
The Nix-built Claude, Codex, and Pi roots each contain 24 rendered roles. The
packaged `cq` binary returns the selected surface's exact `plan-advance` bytes
over both stdio and HTTP, while all six responses carry byte-equivalent schema
serialization. The three prompt bodies differ by surface as required.

No projection fallout, unresolved renderer slot, canonical-source link,
temporary rendered root, or stale full-mutation-result assumption was observed.

The complete acceptance matrix is reproducible from a dependency-free checkout:

```sh
cd nix/pkg/cq-ledgers
bun run verify-packaged-prompt-surfaces
```

The committed harness at
`packages/ledger-mcp/scripts/verify-packaged-prompt-surfaces.ts` begins with
`bun install --frozen-lockfile`, so this invocation does not depend on
worktree-specific package links.

## Reproductions before verification

Before the round-2 correction, the reusable-harness precondition failed:

```sh
test -f packages/ledger-mcp/scripts/verify-packaged-prompt-surfaces.ts
```

Result: exit 1. The six packaged transports and three-root hygiene scan recorded
below therefore could not be rerun from the round-1 commit.

The first `gen-agents` run in the isolated worktree failed with
`Cannot find module '@cq/config/prompt-renderer'`. The root dependency link alone
does not provide Bun workspace-package links. Attaching the existing dependency
trees for each workspace package corrected that verification fixture; no source
change was involved.

The first packaged smoke used an empty temporary CWD and closed its MCP
connection at startup. Direct execution reproduced the expected boundary
failure: the default XDG backend cannot resolve a stable project key outside a
Git repository without `[ledger].projectId`. Adding
`projectId = "t658-packaged-smoke"` to the temporary fixture corrected the
fixture; the same six transport cases then passed.

## Generator freshness

From `nix/pkg/cq-ledgers`:

```sh
bun run gen-prompt-catalog
bun run gen-agents
sha256sum packages/cq-config/src/promptCatalog.gen.ts \
  packages/ledger-web/src/agentsCatalogue.gen.ts \
  > /tmp/t658-generators-first.sha256
cp packages/cq-config/src/promptCatalog.gen.ts \
  /tmp/t658-promptCatalog-first.ts
cp packages/ledger-web/src/agentsCatalogue.gen.ts \
  /tmp/t658-agentsCatalogue-first.ts
bun run gen-prompt-catalog
bun run gen-agents
sha256sum -c /tmp/t658-generators-first.sha256
cmp /tmp/t658-promptCatalog-first.ts \
  packages/cq-config/src/promptCatalog.gen.ts
cmp /tmp/t658-agentsCatalogue-first.ts \
  packages/ledger-web/src/agentsCatalogue.gen.ts
git diff --exit-code -- \
  packages/cq-config/src/promptCatalog.gen.ts \
  packages/ledger-web/src/agentsCatalogue.gen.ts
```

Result: both second generations matched the first byte-for-byte, and neither
committed generated path changed. The explicit `cmp` operands identify the
changed path if freshness fails.

The committed harness performs the same comparisons in memory and fails with
`changed path: <repository-relative path>` for either committed-output drift or
non-determinism between the first and second runs. It also refuses to start when
either generated path already differs in the index or worktree, naming that
path. A controlled one-line probe against
`packages/cq-config/src/promptCatalog.gen.ts` produced
`freshness precondition failed: generated path already differs:
packages/cq-config/src/promptCatalog.gen.ts` and left the probe unmodified,
confirming that diagnostics precede generator writes.

## Focused behavioral gates

From `nix/pkg/cq-ledgers`:

```sh
bun test packages/ledger-mcp/test/promptSurfaceTransports.test.ts
bun test packages/ledger/test/cq-tool-response-contract.test.ts
bun test scripts/link-prompts.test.ts
bun test packages/cq-config/test/promptCatalog.test.ts \
  packages/cq-config/test/promptCatalogAuthority.test.ts \
  packages/cq-config/test/promptCatalogVerification.test.ts \
  packages/cq-config/test/promptSurfaces.test.ts \
  packages/cq-config/test/promptRenderer.test.ts
```

Results:

- surface transport contract: 4 passed, 0 failed;
- response-policy inventory, including plan, investigate/research, and
  advance/begin/implement families: 10 passed, 0 failed;
- `link-prompts` publication contract against its strict in-memory dummy and
  the real temporary-filesystem adapter: 33 passed, 0 failed;
- prompt catalogue, renderer, surface, authority, and centralized verification:
  52 passed, 0 failed.

The transport and publication suites follow a shared behavioral contract across
their adapters. In constructive-test-taxonomy terms, the in-memory legs are
Behavioral-Active Blackbox-Group checks and the process/filesystem legs are
Behavioral-Active Effectual Good-Communication checks.

## Nix and repository gates

From the repository root:

```sh
nix build \
  .#checks.x86_64-linux.codex-cq-skills \
  .#checks.x86_64-linux.claude-prompt-root \
  .#checks.x86_64-linux.pi-prompt-root \
  .#checks.x86_64-linux.prompt-catalog \
  .#checks.x86_64-linux.prompt-surfaces \
  .#checks.x86_64-linux.claude-prompt-home \
  --no-link
nix build .#cq --no-link --print-out-paths
```

Both commands passed. Nix reported an unavailable configured SSH builder and
then completed the affected derivations on an available builder. The packaged
binary output from the committed harness run was:

```text
/nix/store/yap1dixlg0k1ygp7nis4icy0xkvjg91y-cq-0.0.1
```

From `nix/pkg/cq-ledgers`:

```sh
bun run check
```

Result: 2,701 passed, 67 skipped, 0 failed across 255 files. The skips identify
tests requiring `CQ_TEST_PG_URL` or a real PTY; none belongs to the G91/G93
prompt-surface matrix.

## Packaged transport smoke

The committed harness discovers the binary and roots with four independent
`nix build <attribute> --no-link --print-out-paths` calls. It starts the built
`cq` binary over stdio and HTTP for each Nix-built surface root, calls
`fetch_prompt({ roleId: "plan-advance" })`, compares `promptTemplate` with that
root's `roles/plan-advance.md`, and compares `version`, `inputSchema`, and
`outputSchema` across all responses.

```text
claude: stdio+http bytes=33427 schemas=identical
codex: stdio+http bytes=33376 schemas=identical
pi: stdio+http bytes=33409 schemas=identical
packaged prompt smoke: 6/6 transports passed; 3 surface bytes distinct
```

The same harness checks all three packaged roots:

```text
all 3 packaged roots: 24 roles, nested projections+acks present, no unresolved slots or stale mutation prose
```

The scanned nested artifacts were `begin.md`, `plan.md`,
`plan/advance.md`, `research.md`, and `research/advance.md`. Each contained an
explicit `projection: "compact"` or `projection: "full"` call and the fixed
mutation-acknowledgement rule. The scan rejected unresolved
`{{cq:fragment:...}}`/`CQ_HARNESS` tokens and legacy prose claiming that a
mutation returns a full item or entity. It rejects packaged symlinks as possible
raw-source authority, rejects `.tmp-*`/`.publication.lock` artifacts, and runs
the `link-prompts` contract against both its strict in-memory dummy and the real
temporary-filesystem adapter to verify current-root link targets and cleanup.
