/**
 * D403 / H310 — a project's declared `[gate]` as a gate specification.
 *
 * Split from `projectGate.ts` so THAT module stays import-free: the packaged
 * prompt-surface renderer vendors `schemas/implement-worker.ts` (which needs
 * the canonical gate) into a deliberately minimal Nix source closure, and must
 * not have to vendor the cq.toml reader with it.
 */
import { loadConfig } from "./config.js";
import { resolveProjectGate, type ProjectGateSpecification } from "./projectGate.js";

/**
 * Resolve the gate declared by the cq.toml at `configRoot`.
 *
 * The ONE place a project's configuration becomes a gate specification. A root
 * with no cq.toml, or one declaring no `[gate]`, takes the compatibility
 * fallback documented on {@link resolveProjectGate} rather than failing
 * construction — dispatch runtimes are built for fixture roots too.
 */
export function resolveProjectGateForRoot(configRoot: string): ProjectGateSpecification {
  return resolveProjectGate(loadConfig(configRoot)?.gate ?? null);
}
