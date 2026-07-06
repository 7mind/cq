/**
 * CQ_TOML_TEMPLATE — the cq.toml starter that `cq init` writes.
 *
 * A hand-authored, schema-valid TOML literal: it parses via @cq/config
 * `parseConfig` and resolves cleanly through `resolveReviewers` /
 * `resolvePlanners`. Kept lean — active defaults plus a couple of inline
 * examples. The exhaustive schema reference (all options, the flat
 * backward-compatible layout) lives in `cq.toml.example`.
 *
 * Layout rationale:
 *  - Panels (reviewers/planners) are HARNESS-SPECIFIC — a panel lists models of
 *    one harness's kind — so they live under `[harness.claude]` / `[harness.pi]`,
 *    not at top level. The active harness is chosen at runtime (CQ_HARNESS, else
 *    claude), so the default `cq init` config resolves the claude panel.
 *  - `[aliases]` are inert definitions; nothing dispatches until a panel or a
 *    `[tiers]` entry references an alias. So the trio plus a few extra aliases
 *    ship live.
 *  - `[tiers]` is harness-specific too: there is no shared top-level `[tiers]`;
 *    each harness carries its own `[harness.<name>.tiers]` classifier (claude
 *    tokens under claude, pi tokens under pi). A model is dispatchable only if
 *    its harness's tiers block classifies it.
 *  - `[ledger]` is commented out, so the backend defaults to `fs`.
 */

export const CQ_TOML_TEMPLATE: string = `\
# cq.toml — cq review orchestrator config.
# Full schema and the flat backward-compatible layout: see cq.toml.example.

# alias -> "<harness>:<model>" token. Definitions only — an alias does nothing
# until a panel (reviewers/planners) or a [harness.<h>.tiers] entry references it.
# Optional trailing reasoning-effort suffix ":<effort>" (higher = more thinking):
#   pi     — off | minimal | low | medium | high | xhigh   (used at dispatch)
#   claude — low | medium | high | xhigh | max             (parsed; not yet used)
[aliases]
  opus     = "claude:opus-4.8[1m]"
  sonnet   = "claude:sonnet-5"
  haiku    = "claude:haiku-4.5"
  opus-max = "claude:opus-4.8[1m]:max"          # opus, max reasoning effort
  fable    = "claude:fable-5"                    # Anthropic's most capable
  grok     = "pi:grok-build/grok-build:high"     # pi: <provider>/<model>
  codex    = "pi:openai-codex/gpt-5.5:xhigh"     # Codex (GPT-5.5) via pi

# Per-agent tier. An agent not listed here defaults to "standard".
[agent_tiers]
  investigate-explorer        = "frontier"
  investigate-prober          = "standard"
  plan-advance                = "frontier"
  plan-reviewer               = "frontier"
  implement-worker            = "standard"
  implement-reviewer          = "frontier"
  implement-conflict-resolver = "standard"

# Panels + tier classifier for the default (claude) harness. Tiers are
# harness-specific — there is no shared [tiers]. The classifier is what makes a
# model dispatchable; an alias absent here is inert.
[harness.claude]
  reviewers = ["opus"]
  planners  = ["opus"]
[harness.claude.tiers]
  opus   = "frontier"
  sonnet = "standard"
  haiku  = "fast"
  # fable = "frontier"     # uncomment to use fable for frontier-tier roles

# The pi harness: its own panels + tier classifier. Ignored under claude; active
# when CQ_HARNESS=pi. [harness.pi.tiers] wholly replaces the shared [tiers].
[harness.pi]
  reviewers = ["grok", "codex"]
  planners  = ["codex"]
[harness.pi.tiers]
  grok  = "standard"
  codex = "frontier"

# Ledger storage backend (default: "fs"). Uncomment for the experimental
# git-object backend.
# [ledger]
#   backend = "git-object"
`;
