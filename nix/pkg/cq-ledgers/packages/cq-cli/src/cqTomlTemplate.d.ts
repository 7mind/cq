/**
 * CQ_TOML_TEMPLATE — a fully-commented cq.toml starter template (T331, T349).
 *
 * This is a hand-authored TOML literal (cq-config has only a parser, no
 * serialiser) that, once re-parsed by @cq/config `parseConfig`, is
 * schema-valid and resolves cleanly through `resolveReviewers` /
 * `resolvePlanners`.
 *
 * Active set: three canonical Claude aliases — opus (frontier),
 * sonnet (standard), haiku (fast).  Every other pi-available model
 * (grok-build, minimax, ollama-cloud tokens) is present but COMMENTED OUT
 * so users can opt in by uncommenting.
 *
 * Token grammar (T237 + T286 effort suffix):
 *   claude:<model>[:<effort>]         — e.g. claude:opus-4.8[1m]
 *   pi:<provider>/<model>[:<effort>]  — e.g. pi:grok-build/grok-build
 * Bare pi tokens (no provider qualifier) are CONFIG ERRORs.
 *
 * The `[ledger]` block is present but COMMENTED OUT (T349): absence of
 * [ledger] OR of cq.toml entirely defaults to backend='fs' (FsLedgerStore).
 * Uncomment and set backend='git-object' to opt in to the experimental
 * git-object backend (Q189).
 *
 * Reference: Q184 (active set), D36 (pi provider routing), T286 (effort suffix),
 *            T349 (ledger backend config), Q189 (git-object opt-in).
 */
export declare const CQ_TOML_TEMPLATE: string;
//# sourceMappingURL=cqTomlTemplate.d.ts.map