/**
 * D403 / H310 — the project gate specification.
 *
 * The canonical full gate was written out as a literal at five production
 * sites in two packages, in two shapes: the supervised runner's form (whose
 * `environment` is a map) and the authorization form (whose `environment` is a
 * list, because it is DIGESTED and compared). Two of those sites compare a
 * caller-supplied gate against the canonical one by digest, so the copies had
 * to agree byte for byte or a legitimate cohort gate would be refused — a
 * silent, security-relevant coupling with no single definition.
 *
 * This module is that definition. The specification is intentionally NOT a
 * complete command: `environment` stays with each caller, because the runner
 * and the digest disagree about its type on purpose.
 *
 * The remaining half of H310 — making this resolvable per project rather than
 * fixed to CQ's own layout, so a consumer project does not inherit
 * `nix/pkg/cq-ledgers` and fail with ENOENT — builds on this single point.
 */

/** The worktree-relative command a project's full gate runs. */
export interface ProjectGateSpecification {
  /** Exact argv; never a shell string. */
  readonly argv: readonly string[];
  /**
   * Directory the command runs in, RELATIVE to the managed worktree root.
   * The supervised runner refuses an absolute path or one escaping the
   * worktree, so this is relative by contract rather than by convention.
   */
  readonly cwd: string;
}

/**
 * CQ's own gate. This is the value every previous literal spelled out, kept
 * byte-identical so no digest, receipt or stored evidence changes.
 *
 * It is CQ-specific, and that is exactly H310's defect: a consumer project has
 * no `nix/pkg/cq-ledgers`. Naming it once makes the assumption visible and
 * gives the per-project resolution a single place to land.
 */
export const CANONICAL_PROJECT_GATE: ProjectGateSpecification = Object.freeze({
  argv: Object.freeze(["bun", "run", "check"]),
  cwd: "nix/pkg/cq-ledgers",
});

/**
 * The authorization shape: the specification plus the empty environment list
 * the cohort digest comparisons canonicalize. Key order matches the literals
 * it replaces, so the digests are unchanged.
 */
export function projectGateAuthorizationForm(
  gate: ProjectGateSpecification = CANONICAL_PROJECT_GATE,
): { readonly argv: readonly string[]; readonly cwd: string; readonly environment: readonly [] } {
  return { argv: gate.argv, cwd: gate.cwd, environment: [] };
}
