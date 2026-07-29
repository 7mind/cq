# Flake upgrade audit

Manually-triggered skill. Inventory the flake in the **current working
directory**, research whether each entry can be upgraded or retired, and present
a table report. **Do not apply any change until the user reviews the report and
explicitly asks you to perform specific rows.**

## Preconditions

- CWD (or the path the user names) contains a `flake.nix`.
- If no `flake.nix` is present, stop and say so — do not invent a target.
- Prefer pure-eval commands (`nix flake metadata`, `nix eval`, reading files).
  Network is allowed for version discovery (npm registry, GitHub releases,
  `nix flake update --dry-run` style checks).

## Phase 1 — Inventory

Build three lists from the flake tree. Record file paths and evidence for every
entry.

### 1. Local / vendored packages

Sources of truth (walk all that exist):

| Signal | Where to look |
|--------|----------------|
| In-tree derivations | `nix/pkg/**`, `pkgs/**`, `packages/**`, `overlay*/**` |
| `callPackage ./…` | `flake.nix` `outputs` / `perSystem` / `legacyPackages` |
| `packages.<system>.*` attrs whose drv comes from a path in this repo | `flake.nix`, `flake/packages.nix`, `**/default.nix` |
| `fetchFromGitHub` / `fetchzip` / `fetchurl` with a pinned `version` or `tag` **defined in this repo** (not via an input) | package.nix files |
| Comments saying "vendored", "pin", "update.sh", "Manual recipe" | package headers |
| Companion `update.sh` next to `package.nix` | same directory |

For each package record:

- **name** (attr / pname)
- **current version** (from `version =`, `tag =`, `package.json`, lock, or comment)
- **source kind**: npm tarball, GitHub release binary, `fetchFromGitHub` source build, copy of nixpkgs derivation, other
- **definition path**
- **update helper** if present (`update.sh`, `nix-update-script`, documented recipe in the header)
- **why vendored** (comment, missing upstream nix, pin ahead of nixpkgs, patches) — quote the comment when present

### 2. Packages with patches / overlay overrides

| Signal | Where to look |
|--------|----------------|
| `patches = [ … ]` | any `.nix` under the flake |
| `overrideAttrs` / `override` that injects patches or postPatch | overlays, `packageOverrides`, per-package files |
| `overlays.default` / `nixpkgs.overlays` | `flake.nix`, `overlays/`, HM/NixOS modules |
| `applyPatches`, `substituteInPlace` in `postPatch` fixing upstream bugs | package.nix |

For each record:

- **name**
- **patch paths** (or inline patch summary)
- **what the patch does** (read the `.patch` header / first hunk comment, or the `substituteInPlace` rationale)
- **upstream issue / PR** if referenced
- **base version** the patch was written against

### 3. External flake inputs

From `flake.nix` `inputs` + `flake.lock`:

| Signal | Where to look |
|--------|----------------|
| Every `inputs.<name>` | `flake.nix` |
| Locked rev / lastModified / original ref | `flake.lock` (`nix flake metadata` is fine) |
| `flake = false` source-only inputs | `flake.nix` |
| `inputs.*.follows` pins | `flake.nix` |
| Non-flake inputs consumed as `src = inputs.<name>` | package call sites |

For each record:

- **input name**
- **url / original ref** (e.g. `github:NixOS/nixpkgs/nixos-unstable`)
- **locked rev** (short) and **lastModified** (ISO date)
- **flake?** (true/false)
- **consumers** in this repo (which packages/modules reference `inputs.<name>`)
- **follows** relationships that constrain bumps

Skip the flake's own `self`. Note but do not "upgrade" `follows` edges — they
are constraints, not version pins.

## Phase 2 — Research each entry

Work entry-by-entry. Prefer evidence over guesses. When a check needs network
and network fails, mark the cell `unknown (network)` rather than inventing a
version.

### (a) Version can be bumped? — local / vendored packages

1. Identify the upstream channel from the package definition:
   - npm: `curl -fsSL https://registry.npmjs.org/<pkg>/latest`
   - GitHub release binary: releases/latest API or `git ls-remote --tags`
   - `fetchFromGitHub` tag/rev: latest tag on that repo
   - nixpkgs-tracking pin: compare to `nixpkgs#<attr>.version` on the flake's
     nixpkgs input (and on `nixos-unstable` if different)
2. If an `update.sh` or header recipe exists, treat it as the authoritative
   bump procedure — do not invent a different one.
3. Classify:
   - `yes (current → latest)` when latest > current
   - `already latest` when equal
   - `unknown` when the channel cannot be queried
   - `no (pinned intentionally)` only when a comment/decision explicitly pins
     below latest — quote it

Also note **breakage risk**: major bump, native hash refresh needed, companion
FOD/`npmDepsHash`/`cargoHash` that must change together, platform matrix.

### (b) Patches can be removed?

For each patch/override:

1. Read the patch. Identify the upstream defect it addresses.
2. Check whether upstream absorbed it:
   - linked PR/issue closed + present in the version you would bump to
   - `nixpkgs#<attr>` at current nixpkgs already carries an equivalent fix
   - the patched file hunk no longer applies (suggests fixed or drifted)
3. Classify:
   - `yes — fixed upstream in <ver/PR#>` 
   - `no — still required (evidence)`
   - `maybe — verify by building without patch on <ver>`
   - `stale — patch fails to apply; re-examine`

Never delete a patch in the report phase. "yes" means "candidate for removal
after a rebuild proves it".

### (c) Vendored package can be retired for an external alternative?

For each local/vendored package:

1. Search for an external source that could replace it:
   - `nixpkgs#<pname>` (same or acceptable version)
   - an upstream flake (`github:<owner>/<repo>`) exposing the package
   - a well-maintained overlay/flake the ecosystem already uses
2. Compare: version, platforms, wrappers/hooks this repo adds, patches,
   sandbox integration, meta.mainProgram.
3. Classify:
   - `yes — use <attr/flake> @ <ver>` when external covers needs
   - `no — keep vendored` with the concrete reason (missing platform, extra
     wrapper, patches, pin ahead of nixpkgs, no upstream nix)
   - `partial — external exists but lacks <X>` (wrapper, patch, platform)

### (d) Input flake version can be bumped?

For each external input:

1. Resolve the newest rev of the tracked ref:
   - `nix flake metadata <original-url>` 
   - or GitHub compare of locked rev vs tip of the branch/tag
2. For `flake = false` inputs, check the tracked branch tip vs locked rev;
   also note any FOD/npmDepsHash in consumers that a bump would invalidate.
3. Classify:
   - `yes (locked → tip of <ref>)` with age gap if useful
   - `already at tip`
   - `constrained by follows` (name the follows)
   - `unknown`

Flag inputs whose bump is high-blast-radius (nixpkgs, rust-overlay) vs
low-blast-radius (single-consumer source pins).

## Phase 3 — Report (table form)

Present **one markdown table per inventory class**, then a short summary.
Use exactly these columns.

### Table A — Local / vendored packages

| Package | Current | Latest | Bump? | External alternative | Retire vendored? | Path | Notes |
|---------|---------|--------|-------|----------------------|------------------|------|-------|
| … | … | … | a | c | c summary | `nix/pkg/…` | risk, update.sh |

### Table B — Patches / overlay overrides

| Package | Patch | Against version | Still needed? | Upstream fix | Path | Notes |
|---------|-------|-----------------|---------------|--------------|------|-------|
| … | `foo.patch` / override summary | … | b | PR/issue/ver | … | |

### Table C — External flake inputs

| Input | Ref | Locked (rev, date) | Tip available? | Bump? | Consumers | Notes |
|-------|-----|--------------------|----------------|-------|-----------|-------|
| … | `github:…` | `abc1234`, 2026-… | rev/date | d | `pkg/…` | follows, FOD refresh |

### Summary block (required)

After the tables, write:

1. **Actionable now** — rows where bump/retire/remove-patch is `yes`, ordered
   low-risk first.
2. **Needs decision** — `maybe` / `partial` rows and anything with intentional
   pins.
3. **No action** — already latest / still required.
4. **Explicit stop** — one line:

   > No changes applied. Tell me which rows to execute (by package/input name),
   > or say "do all actionable".

## Phase 4 — Apply (only on user request)

When the user names rows (or "all actionable"):

1. Re-state the exact plan (files touched, version old → new, patches removed,
   inputs updated). Wait if the user's selection is ambiguous.
2. Apply surgically:
   - prefer existing `update.sh` / header recipe over ad-hoc edits
   - for inputs: `nix flake lock --update-input <name>` (or `nix flake update <name>`)
   - refresh FOD / `npmDepsHash` / per-platform hashes via the package's documented method
   - remove patches only together with a version bump that contains the fix, or
     after a no-patch rebuild succeeds on the current version
3. Verify before declaring done:
   - `nix build .#<attr>` for each touched package
   - `nix flake check` when practical (or the repo's documented check)
   - note any attribute you could not build (platform/sandbox limits)
4. **Commit on green.** When every verification in step 3 that you ran
   succeeded (and any skipped attr is only for platform/sandbox limits, not a
   failed build), create a git commit of the phase-4 diff:
   - stage **only** the files this apply touched (package.nix / update
     artefacts / `flake.lock` / removed patches) — never unrelated dirty state
   - message: concise, imperative; list each bumped package/input with
     `old → new` (e.g. `codex 0.145.0 → 0.146.0, pi-coding-agent 0.82.0 → 0.82.1,
     nixpkgs 241313f4 → 624af665`)
   - do **not** commit if any verification failed or was not run for a touched
     attr that *can* build on this host; fix or stop instead
   - do **not** push unless the user asks
5. Report what landed vs what was skipped, with old → new versions, and the
   commit hash when step 4 ran.

## Rules of engagement

- **Manual trigger only.** Do not run this audit because the user edited a
  `package.nix` or mentioned nixpkgs.
- **Report first, change second.** The deliverable of a bare invocation is the
  tables + summary, not a diff.
- **No drive-by refactors.** Touch only what a selected row requires.
- **No silent major bumps.** If latest is a new major, call it out in Notes and
  require explicit user OK for that row.
- **Quote intentional pins.** A comment like "pin 2.1.x until sandbox lands"
  makes bump = `no (pinned intentionally)`.
- **Stay inside the target flake** unless the user names another path.
- **Deterministic tables.** Same flake state should yield the same row set;
  unstable "latest" versions are whatever the channel returned at audit time —
  stamp the report with the date.
