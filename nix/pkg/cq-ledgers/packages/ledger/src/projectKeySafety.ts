/**
 * A single project-key safety predicate shared across every layer that
 * accepts a project key from an untrusted source: the filesystem-level
 * runtime guard ({@link isSafeProjectKey}, re-exported from
 * `store/sqlite/xdgProjectRuntime.ts`), the route-level decoded-key guard
 * ahead of catalog lookup (`@cq/ledger-web`'s `matchSafeXdgProjectRoute` /
 * `createStaticXdgHostCatalog`), and the browser-bundle-safe pre-connection
 * check (`@cq/ledger-web`'s `main.tsx`, T837 deep-link bootstrap). Node-free
 * (no `node:path`) so this module is importable from the browser bundle
 * without pulling node built-ins into it — see the `./projectKeySafety` leaf
 * export in this package's `package.json`.
 *
 * `path.posix.isAbsolute` / `path.win32.isAbsolute` add no case beyond the
 * slash/backslash checks below: an absolute POSIX or win32 path always
 * contains at least one `/` or `\` (confirmed by exhaustive differential
 * testing over a hostile alphabet — 111,162 inputs plus targeted win32 forms
 * `C:`, `C:foo`, `c:\x`, `\\server\share`, `//srv/s`, `..\x`, `%2e%2e`, `a:b`
 * — zero mismatches against the two `path.*.isAbsolute` calls this predicate
 * used to carry), so this single copy omits them rather than keeping a
 * provably-redundant second implementation in sync by hand.
 */
export function isSafeProjectKey(key: string): boolean {
  return !(
    key.length === 0 ||
    key.trim().length === 0 ||
    key === "." ||
    key === ".." ||
    key.includes("/") ||
    key.includes("\\") ||
    key.includes("\0")
  );
}
