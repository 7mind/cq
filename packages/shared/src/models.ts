/**
 * models.ts — single source of truth for the model dropdown and the
 * model → platform routing function.
 *
 * The cq UI does NOT have a separate "platform" selector; the model
 * dropdown IS the router. `modelToPlatform(model)` is the canonical
 * function that decides which backend bridge handles a session.
 *
 * Anything prefixed `claude-` routes to Claude; anything prefixed
 * `gpt-` or `o<digit>-`/`o<digit>` routes to Codex.
 */

/** Platforms cq can route a session to. */
export type Platform = "claude" | "codex";

/**
 * Entry in the model dropdown allow-list. Both bridges consult this list
 * at session-start to validate the requested model — unknown ids are
 * accepted (forward-compat) but routing falls back to startsWith-based
 * detection.
 */
export interface ModelEntry {
  /** Model id sent in `ChatStart.model` and forwarded to the SDK. */
  readonly id: string;
  /** Display label shown in the dropdown. */
  readonly label: string;
  /** Which backend handles this model. */
  readonly platform: Platform;
}

/**
 * The curated dropdown list, in display order. Order matters — the first
 * entry is the default selection on a fresh tab.
 *
 * Claude variants intentionally come first so cq's existing dogfooding
 * UX is preserved. Codex variants follow.
 */
export const MODELS: readonly ModelEntry[] = [
  // Claude — 1M context tier first, base second (matches existing Header order).
  { id: "claude-opus-4-8[1m]",   label: "claude-opus-4-8 (1M)",   platform: "claude" },
  { id: "claude-opus-4-8",       label: "claude-opus-4-8",        platform: "claude" },
  { id: "claude-opus-4-7[1m]",   label: "claude-opus-4-7 (1M)",   platform: "claude" },
  { id: "claude-opus-4-7",       label: "claude-opus-4-7",        platform: "claude" },
  { id: "claude-sonnet-4-6[1m]", label: "claude-sonnet-4-6 (1M)", platform: "claude" },
  { id: "claude-sonnet-4-6",     label: "claude-sonnet-4-6",      platform: "claude" },
  { id: "claude-haiku-4-5",      label: "claude-haiku-4-5",       platform: "claude" },
  // Codex — exposed via @openai/codex-sdk (drives the `codex` CLI).
  // NOTE: Codex with ChatGPT-account auth restricts the model set — most
  // ids ("gpt-5", "gpt-5.1", "o3", any "-codex"/"-pro"/"-mini" variant,
  // "gpt-5.3", "gpt-5.5-pro") are rejected with "model is not supported
  // when using Codex with a ChatGPT account". The entries below are the
  // verified-working plain models (2026-05-30); gpt-5.5 first to match the
  // common `~/.codex/config.toml` default. A deployment on API-key auth or
  // a different account tier may support a different set — these are the
  // ones that actually work against ChatGPT-account Codex today.
  { id: "gpt-5.5",  label: "gpt-5.5",       platform: "codex" },
  { id: "gpt-5.4",  label: "gpt-5.4",       platform: "codex" },
  { id: "gpt-5.2",  label: "gpt-5.2",       platform: "codex" },
] as const;

/** Default model on a fresh tab (preserves prior behaviour). */
export const DEFAULT_MODEL = "claude-opus-4-8[1m]";

/**
 * Decide which backend handles a given model id.
 *
 * Lookup order:
 *  1. Exact match against MODELS (covers curated ids).
 *  2. Prefix rules: `claude-` → claude; `gpt-` or `o<digit>` → codex.
 *  3. Fallback: claude (preserves existing behaviour for unknown ids).
 *
 * The fallback is intentional — adding a new Claude model id should not
 * break cq; it just routes through ClaudeBridge as before.
 */
export function modelToPlatform(model: string): Platform {
  for (const entry of MODELS) {
    if (entry.id === model) return entry.platform;
  }
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("gpt-")) return "codex";
  // Match o-series: "o3", "o3-mini", "o4", etc.
  if (/^o\d/.test(model)) return "codex";
  return "claude";
}

/** Models grouped by platform — convenience for popup rendering. */
export function modelsForPlatform(platform: Platform): readonly ModelEntry[] {
  return MODELS.filter((m) => m.platform === platform);
}
