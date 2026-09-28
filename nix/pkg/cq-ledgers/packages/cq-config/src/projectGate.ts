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
 * `resolveProjectGateForRoot` (projectGateConfig.ts) is the other half of
 * H310: it turns a project's declared `[gate]` into that specification, so a
 * consumer project does not inherit `nix/pkg/cq-ledgers` and fail with ENOENT.
 * It lives in a SEPARATE module on purpose — this one must stay import-free so
 * the packaged prompt-surface renderer's source closure, which vendors
 * `schemas/implement-worker.ts`, does not have to vendor the config reader.
 */

/** The worktree-relative `cwd` naming the managed worktree root itself. */
export const PROJECT_GATE_ROOT_CWD = "." as const;

/** The worktree-relative command a project's full gate runs. */
export interface ProjectGateSpecification {
  /** Exact argv; never a shell string. */
  readonly argv: readonly string[];
  /**
   * Directory the command runs in, RELATIVE to the managed worktree root.
   * The supervised runner refuses an absolute path, one escaping the worktree,
   * and an EMPTY one — so the worktree root itself is spelled `"."`, which
   * {@link resolveProjectGate} canonicalizes an omitted or empty `cwd` to.
   */
  readonly cwd: string;
  /**
   * D568: the project's rule for "tests really ran". A regex whose first group
   * is the passed-test count; when declared, a green exit with no counted pass
   * is a zero-test run and is rejected. Null leaves the exit status authoritative.
   */
  readonly passCountPattern: string | null;
  /** D568: a regex whose first group is the failed-test count; null derives failure from the exit status. */
  readonly failCountPattern: string | null;
}

/** The flags every gate count pattern is compiled with: every match, Unicode. */
export const GATE_COUNT_PATTERN_FLAGS = "gu" as const;

/** Why `source` is not a usable count pattern, or null when it is. */
export function gateCountPatternError(source: string): string | null {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, GATE_COUNT_PATTERN_FLAGS);
  } catch (error) {
    return `is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  // An alternation with the empty pattern always matches, exposing the group count.
  const groups = new RegExp(`${pattern.source}|`, GATE_COUNT_PATTERN_FLAGS).exec("")!.length - 1;
  return groups >= 1 ? null : "must capture the count in its first group";
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
  // Bun's ` 42 pass` / ` 0 fail` summary lines (D564 zero-test guard).
  passCountPattern: String.raw`(?:^|\n)\s*([0-9]+)\s+pass\b`,
  failCountPattern: String.raw`(?:^|\n)\s*([0-9]+)\s+fail\b`,
});

/**
 * The authorization shape: the specification plus the empty environment list
 * the cohort digest comparisons canonicalize. Key order matches the literals
 * it replaces, so the digests are unchanged.
 */
export function projectGateAuthorizationForm(
  gate: ProjectGateSpecification,
): { readonly argv: readonly string[]; readonly cwd: string; readonly environment: readonly [] } {
  return { argv: gate.argv, cwd: gate.cwd, environment: [] };
}

/**
 * Resolve the gate a dispatch must run, from the project's declared `[gate]`.
 *
 * D573: a project that declares no gate has NO gate. Falling back to
 * {@link CANONICAL_PROJECT_GATE} ran CQ's own `bun run check` in a directory a
 * consumer does not have, and surfaced as a red gate instead of a missing
 * configuration. CQ's own cq.toml declares its gate explicitly.
 */
export function resolveProjectGate(
  declared: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly passCountPattern: string | null;
    readonly failCountPattern: string | null;
  } | null | undefined,
): ProjectGateSpecification | null {
  if (declared === null || declared === undefined) return null;
  // A project that declares no `cwd` means the worktree root, which the
  // supervised runner spells `"."` — it refuses an empty one outright, so
  // canonicalizing here is what makes the natural consumer shape runnable.
  return Object.freeze({
    argv: Object.freeze([...declared.argv]),
    cwd: declared.cwd === "" ? PROJECT_GATE_ROOT_CWD : declared.cwd,
    passCountPattern: declared.passCountPattern,
    failCountPattern: declared.failCountPattern,
  });
}

/** The refusal every gate-running flow gives a project that declares no `[gate]` (D573). */
export class ProjectGateUndeclaredError extends Error {
  constructor() {
    super("this project declares no full gate: declare [gate] in cq.toml (argv, and cwd relative to the repository root) before CQ admits, runs or accepts implementation work");
    this.name = "ProjectGateUndeclaredError";
  }
}

export function requireProjectGate(gate: ProjectGateSpecification | null): ProjectGateSpecification {
  if (gate === null) throw new ProjectGateUndeclaredError();
  return gate;
}
