/**
 * D106 regression guard: every `@cq/ledger/<subpath>` specifier imported under
 * ledger-web's src/ must be DIST-INDEPENDENTLY resolvable to a real
 * packages/ledger/src source file — via EITHER a `compilerOptions.paths` key in
 * this package's tsconfig.json pointing at ../ledger/src, OR a src-pointing
 * target in @cq/ledger's package.json `exports`.
 *
 * Why: `cq web` bundles the browser UI at startup with Bun.build. Bun.build
 * honors tsconfig paths; a subpath MISSING from paths falls through to
 * @cq/ledger's exports map, which targets ./dist/src/*.js — output the nix
 * derivation never builds (dist/ is gitignored, flake buildPhase is a no-op).
 * The dev tree's stale on-disk dist/ satisfies that fallback, so the ordinary
 * serve tests stay green while the shipped product fails with
 * `Could not resolve: "@cq/ledger/refs"` (defects:D106). This guard is static —
 * it never consults dist/ — so it fails in the dev tree too.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const pkgRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(pkgRoot, "src");
const ledgerPkgRoot = path.resolve(pkgRoot, "..", "ledger");

/** Every `@cq/ledger/<subpath>` specifier statically or dynamically imported under src/. */
function importedLedgerSubpaths(): Set<string> {
  const specifiers = new Set<string>();
  // `from "@cq/ledger/x"` (static import/export) and `import("@cq/ledger/x")` (dynamic).
  const importRe = /(?:from\s*|import\s*\(\s*)["'](@cq\/ledger\/[^"']+)["']/g;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(importRe)) specifiers.add(m[1]!);
      }
    }
  };
  walk(srcDir);
  return specifiers;
}

/** tsconfig paths keys that map onto ../ledger/src source files. */
function tsconfigSrcTargets(): Map<string, string[]> {
  const tsconfig = JSON.parse(
    fs.readFileSync(path.join(pkgRoot, "tsconfig.json"), "utf8"),
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  return new Map(Object.entries(tsconfig.compilerOptions?.paths ?? {}));
}

/** @cq/ledger exports entries whose import target points into src (not dist). */
function exportsSrcTargets(): Map<string, string> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ledgerPkgRoot, "package.json"), "utf8"),
  ) as { exports?: Record<string, { import?: string } | string> };
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === "string" ? value : value.import;
    if (target !== undefined && /^\.\/src\//.test(target)) {
      out.set(key.replace(/^\./, "@cq/ledger"), target);
    }
  }
  return out;
}

/** Resolve one specifier to an existing ../ledger/src file, or explain why not. */
function resolveDistIndependently(specifier: string): string | null {
  const paths = tsconfigSrcTargets();
  const viaPaths = paths.get(specifier);
  if (viaPaths !== undefined) {
    for (const target of viaPaths) {
      if (!target.includes("../ledger/src/")) continue;
      const abs = path.resolve(pkgRoot, target);
      if (fs.existsSync(abs)) return abs;
    }
  }
  const viaExports = exportsSrcTargets().get(specifier);
  if (viaExports !== undefined) {
    const abs = path.resolve(ledgerPkgRoot, viaExports);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

describe("ledger-web @cq/ledger subpath coverage (D106)", () => {
  it("finds the known subpath imports", () => {
    // Sanity: the scanner itself works (refs is imported by dagData.ts).
    expect([...importedLedgerSubpaths()]).toContain("@cq/ledger/refs");
  });

  it("every imported @cq/ledger subpath resolves dist-independently to ledger src", () => {
    const unresolved: string[] = [];
    for (const specifier of [...importedLedgerSubpaths()].sort()) {
      if (resolveDistIndependently(specifier) === null) unresolved.push(specifier);
    }
    expect(
      unresolved,
      `unresolvable @cq/ledger subpath specifier(s): ${unresolved.join(", ")} — ` +
        "add a compilerOptions.paths entry in packages/ledger-web/tsconfig.json " +
        "pointing at ../ledger/src (or a src-pointing exports target in " +
        "packages/ledger/package.json); Bun.build cannot resolve these without dist/ (D106)",
    ).toEqual([]);
  });
});
