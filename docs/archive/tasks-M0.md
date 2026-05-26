# M0 — Bring-up — archive

Closed: 2026-05-26.
Active span: 5 PRs (PR-01 … PR-05). All [x]. No defects opened.
Acceptance at close: `bun x tsc -b` 0; `bun x eslint .` 0; `bun test packages/server` → 37/37 pass; `bun run start --cwd … --port …` boots, serves `/`, exits 0 on SIGINT; `bun run dev …` same.
Files in tree after M0: see `git ls-files | wc -l` at HEAD of M0 close = 30.

## PR-01 — Workspace skeleton + tsconfig

- **Commit:** `78abb0d`.
- **Acceptance:** `bun install`, `bun x tsc -b`, `bun test --pass-with-no-tests`, `bun x eslint .` all exit 0.
- **Surprises:**
  - Bun 1.3.13 emits `bun.lock` (JSON text), not the older `bun.lockb` (binary). Both are lockfiles; the format change is committed-tracked, not an artefact.
  - TS resolved `^5.7.3` to 5.9.3 (current stable). All required strict flags present and accepted.
  - `tsc -b --noEmit` is incompatible with composite project references (TS6310). The canonical command is `tsc -b`; `noEmit: true` was omitted from `tsconfig.base.json` and the package npm script uses `tsc -b`. The plan's "noEmit in base" line is superseded by this finding.

## PR-02 — Shared protocol package (Zod schemas)

- **Commit:** `aeb31d5`.
- **Acceptance:** `bun test packages/shared` → 76/76 pass; tsc + eslint green.
- **Deliverables:** `protocol.ts` (351 lines, all 22+ wire schemas + heartbeats + `ClientFrame`/`ServerFrame` discriminated unions + `ATTACHMENT_TOTAL_MAX_BYTES`/`base64DecodedByteLength`), `close-codes.ts` (26 lines, 8 constants + `isRetriable()`), `session.ts` (43 lines, `SessionRow`/`InvocationRow` TS interfaces matching plan § 4 DDL), `protocol.test.ts` (345 lines, 76 tests).
- **Surprises:**
  - Zod 4 dialect: `z.looseObject({type:z.string()})` is the named replacement for `z.object(...).passthrough()`. Used for `SDKMessageEnvelope`.
  - `z.record(z.string(), z.unknown())` (two-arg) used throughout for clarity.
  - `HistoryRow` / `HistoryRowFull` ended up in `protocol.ts` (alongside the wire frames that carry them); `session.ts` holds plain TS interfaces for the DB row shapes.
  - `bun-types` had to be added to `packages/shared/devDependencies` + `tsconfig.json` `"types": ["bun-types"]` so test files can `import { test, expect } from "bun:test"`.

## PR-03 — Bun.serve smoke server + HTTP static assets

- **Commit:** `4c09ca0`.
- **Acceptance:** `bun test packages/server/test/args.test.ts` 7 pass; `bun test packages/server/test/smoke.test.ts` 4 pass; manual `bun run start --cwd /tmp --port 5174` returns 200 with `<div id="root">` and exits 0 on SIGINT.
- **Deliverables:** `args.ts` (hand-rolled CLI parser, `--cwd --host --port --db`, no library per plan § 6 PR-03), `buildWeb.ts` (`Bun.build` for `packages/web/src/main.tsx` into `packages/web/dist/`; writes a fresh `index.html` with a stable `/main.js` script src on each startup), `server.ts` (`Bun.serve` with static asset routing; logs `cq listening on …` — replaced by structured logger in PR-04).
- **Surprises:**
  - Bundling decision (A) from the plan: server builds web bundle on startup. Pro: `bun run start` works from a clean checkout.
  - Free-port allocation in the smoke test uses `net.createServer().listen(0)` then reads `.address().port` — TOCTOU-free.
  - `Bun.spawn` typing: `proc.stdout` is `number | ReadableStream<Uint8Array>`; a runtime `instanceof ReadableStream` guard is required under strict TS.
  - Internal imports cannot use `.ts` extensions under `moduleResolution: bundler` + `tsc -b` (TS5097). Stripped throughout.

## PR-04 — Structured JSON logger

- **Commit:** `d2b7b26`.
- **Acceptance:** `bun test packages/server/test/log.test.ts` 22 pass; full server suite 33/33; tsc + eslint green. Operational: log file at `./var/log/cq-YYYYMMDD.log` exists; `tail -1 | jq -e '.level=="info" and (.msg|test("listening")) and .port==5176 and .cwd=="/tmp"'` exit 0.
- **Deliverables:** `log/logger.ts` (`createLogger(opts)`, 107 lines; sync `fs.openSync`+`fs.writeSync`; daily rotation tracked by current-day string; reserved-key precedence on `ts`/`level`/`msg`; injectable clock for tests; per-line stdout mirror).
- **Surprises:**
  - Pre-existing latent defect: `bun test` from the workspace root was picking up compiled JS test files under `dist/` (composite output). Fixed with a root `bunfig.toml` adding `**/dist/**` to `pathIgnorePatterns`.
  - Sync I/O chosen over async to keep `emit()` synchronous and avoid buffering concerns on rotation.

## PR-05 — bun run dev with Bun.serve HMR; README skeleton

- **Commit:** `c3d995c`.
- **Acceptance:** 37/37 server tests pass (was 33; +2 args, +2 dev-server); tsc + eslint green; both `start` mode and `dev` mode return 200 with `<div id="root">` and exit 0 on SIGINT.
- **Deliverables:** `--dev` flag in `args.ts`; `devServer.ts` with `startDevServer()` using `Bun.serve({development:{hmr:true}, routes:{'/': indexHtml}})`; `types/html-import.d.ts` shim (`declare module "*.html" { const html: HTMLBundle; export default html; }`); README.md skeleton (38 lines, two run commands + known limitations).
- **Surprises:**
  - Bun 1.3 HMR API uses `with { type: "html" }` import attribute (compiles cleanly under TS 5.9.3). `HTMLBundle` is defined in `bun-types/bun.d.ts` but not re-exported from the public `"bun"` module — hence the local shim.
  - `Bun.Server.development` is exposed as `readonly development: boolean`; the operational dev-server test asserts it directly. The options-passthrough test uses an injectable `serve: ServeFunction` parameter for testability without HMR WS frame introspection.

## Cross-cutting changes

- `bunfig.toml` at root added in PR-04 to exclude `dist/` from `bun test` discovery (latent defect from PR-01's composite-output emission).
- `packages/web/dist/` is gitignored (already covered by `.gitignore`'s `dist/` rule from PR-01).
- `./var/log/` and `./var/db/` are gitignored (already covered by `var/` rule from `M0.0`'s `.gitignore`).
- `.gitignore` was extended in PR-01 with `*.tsbuildinfo` (composite project-references output).

## Verification (final M0)

```
$ bun --version
1.3.13
$ bun x tsc -b
$ bun x eslint .
$ bun test
[37 tests pass across 4 server test files + 76 shared protocol tests = 113 tests total; 0 fail]
$ bun run start --cwd /tmp --port 5180 &
$ curl -sf http://127.0.0.1:5180/ | grep -q 'id="root"' && echo OK
OK
$ kill -INT %1 && wait %1; echo $?
0
$ bun run dev --cwd /tmp --port 5181 &
$ curl -sf http://127.0.0.1:5181/ | grep -q 'id="root"' && echo OK
OK
$ kill -INT %1 && wait %1; echo $?
0
```

## What M0 hands off to M1

- A working three-package monorepo with strict TS, ESLint 9 flat, Prettier.
- A complete Zod-validated wire protocol surface exported from `packages/shared/`.
- A server that boots, serves the bundled web stub, exits cleanly on signal, and writes structured JSON logs.
- A dev mode with HMR for fast iteration once UI work begins.
- A README skeleton documenting the two run commands and the v1 known limitations.

M1 starts at PR-06 with a clean baseline.
