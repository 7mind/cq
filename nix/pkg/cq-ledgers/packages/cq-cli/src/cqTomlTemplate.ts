/**
 * CQ_TOML_TEMPLATE — the cq.toml starter that `cq init` writes.
 *
 * A hand-authored, schema-valid TOML literal: it parses via @cq/config
 * `parseConfig` and resolves cleanly through `resolveReviewers` /
 * `resolvePlanners`. Kept intentionally lean — the active defaults plus a few
 * commented one-line examples. The exhaustive schema reference (per-harness
 * overrides, effort suffixes, git-object ledger, full option list) lives in
 * `cq.toml.example`.
 *
 * Defaults: opus/sonnet/haiku are the active Claude trio; only opus is on the
 * reviewers/planners panels (T440). Per-role dispatch ([agent_tiers] + [tiers])
 * draws from ALL [aliases], so sonnet (standard) and haiku (fast) still serve
 * their tiers off-panel. `[ledger]` is commented out, so the backend defaults
 * to `fs`.
 */

export const CQ_TOML_TEMPLATE: string = `\
# cq.toml — cq review orchestrator config.
# Full schema and advanced options (per-harness overrides, effort suffixes,
# git-object ledger): see cq.toml.example.

# Panels for multi-reviewer plan/implement review steps (alias names below).
reviewers = ["opus"]
planners  = ["opus"]

# alias -> "<harness>:<model>" token. Panels draw from here; per-role dispatch
# ([agent_tiers] + [tiers]) draws from ALL aliases, not just the panels.
# Optional trailing reasoning-effort suffix ":<effort>" (higher = more thinking):
#   pi     — off | minimal | low | medium | high | xhigh   (used at dispatch)
#   claude — low | medium | high | xhigh | max             (parsed; not yet used)
[aliases]
  opus   = "claude:opus-4.8[1m]"
  sonnet = "claude:sonnet-5"
  haiku  = "claude:haiku-4.5"
  # opus-max = "claude:opus-4.8[1m]:max"          # same model, max reasoning effort
  # fable    = "claude:fable-5"                   # opt-in; also add a [tiers] entry
  # grok     = "pi:grok-build/grok-build:high"    # pi token with "high" effort
  # codex    = "pi:openai-codex/gpt-5.5:xhigh"    # Codex (GPT-5.5) via pi, xhigh effort

# Tier classifier: alias (or token) -> fast | standard | frontier.
[tiers]
  opus   = "frontier"
  sonnet = "standard"
  haiku  = "fast"
  # fable = "frontier"
  # grok  = "standard"

# Per-agent tier. An agent not listed here defaults to "standard".
[agent_tiers]
  investigate-explorer        = "frontier"
  investigate-prober          = "standard"
  plan-advance                = "frontier"
  plan-reviewer               = "frontier"
  implement-worker            = "standard"
  implement-reviewer          = "frontier"
  implement-conflict-resolver = "standard"

# Per-harness overrides: a [harness.<name>] block (<name> = "claude" | "pi")
# REPLACES the shared reviewers/planners/[tiers] for that harness only;
# [aliases] stays shared. Example — give the pi harness its own panel + tiers
# (also uncomment the grok and codex aliases above):
# [harness.pi]
#   reviewers = ["grok", "codex"]
#   planners  = ["codex"]
# [harness.pi.tiers]
#   grok  = "frontier"
#   codex = "frontier"

# Ledger storage backend (default: "fs"). Uncomment for the experimental
# git-object backend.
# [ledger]
#   backend = "git-object"
`;
