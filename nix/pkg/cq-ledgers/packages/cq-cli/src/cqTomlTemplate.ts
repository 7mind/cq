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
 *    each harness carries its own `[harness.<name>.tiers]` map (claude models
 *    under claude, pi models under pi). A model is dispatchable only if its
 *    harness's tiers block names it for some tier.
 *  - `[ledger]` sets `backend = "xdg"` (T501): the out-of-tree bun:sqlite
 *    primary is the default for a FRESH `cq init`. This ONLY affects fresh
 *    inits — an existing repo's cq.toml (untouched by `cq init` without
 *    `--force`) keeps whatever backend it already has. The backup mode
 *    defaults to `none` (T494; unaffected).
 */

export const CQ_TOML_TEMPLATE: string = `\
# cq.toml — cq review orchestrator config.
# Full schema and the flat backward-compatible layout: see cq.toml.example.

# alias -> "<harness>:<model>" token. Definitions only — an alias does nothing
# until a panel (reviewers/planners) or a [harness.<h>.tiers] entry references it.
# Optional trailing reasoning-effort suffix ":<effort>" (higher = more thinking):
#   pi     — off | none | minimal | low | medium | high | xhigh | max  (used at dispatch)
#   claude — low | medium | high | xhigh | max                         (parsed; not yet used)
# GPT-5.6 accepts none | low | medium | high | xhigh | max.
# The openai-codex provider serves the GPT-5.6 family, a capability tier ladder:
# sol (flagship, most capable) > terra (balanced everyday) > luna (fast, cheap).
[aliases]
  opus      = "claude:opus"                           # bare alias — the ONLY form the Agent
  sonnet    = "claude:sonnet"                          # tool's per-dispatch model override enum
  haiku     = "claude:haiku"                           # accepts (Q252/T509). opus/sonnet/fable
  opus-max  = "claude:opus:max"                        # resolve to current-family native 1M
  fable     = "claude:fable"                           # context (no [1m] needed); haiku is the 200K fast tier
  grok      = "pi:grok-build/grok-build:high"         # pi: <provider>/<model>
  codex     = "pi:openai-codex/gpt-5.6-sol:xhigh"     # frontier — GPT-5.6 sol (flagship)
  terra     = "pi:openai-codex/gpt-5.6-terra:high"    # standard — balanced everyday
  luna      = "pi:openai-codex/gpt-5.6-luna:low"      # fast — high-volume lightweight
  codex-max = "pi:openai-codex/gpt-5.6-sol:max"       # sol at max thinking

# Per-agent tier. An agent not listed here defaults to "standard".
[agent_tiers]
  investigate-explorer        = "frontier"
  investigate-prober          = "standard"
  research-explorer           = "frontier"
  research-experimenter       = "frontier"
  plan-advance                = "frontier"
  plan-reviewer               = "frontier"
  implement-worker            = "standard"
  implement-reviewer          = "frontier"
  implement-conflict-resolver = "standard"

# Optional per-agent reasoning-effort override (Q254), ORTHOGONAL to
# [agent_tiers]: the tier picks the MODEL; this overrides the resolved token's
# EFFORT (":<effort>" suffix). Override wins; an unlisted agent keeps the tier
# token's effort. Values must be legal for the agent's RESOLVED harness:
#   pi     — off | none | minimal | low | medium | high | xhigh | max
#   claude — low | medium | high | xhigh | max
# [agent_efforts]
#   plan-reviewer = "max"

# Panels + tier->model map for the default (claude) harness. Tiers are
# harness-specific — there is no shared [tiers]. This map is what makes a model
# dispatchable; an alias named by no tier here is inert.
[harness.claude]
  reviewers = ["opus"]
  planners  = ["opus"]
[harness.claude.tiers]           # tier -> one model (a model may serve several tiers)
  frontier = "opus"              # swap to "fable" or "opus-max" to change frontier
  standard = "sonnet"
  fast     = "haiku"

# The pi harness: its own panels + tier->model map. Ignored under claude; active
# when CQ_HARNESS=pi. [harness.pi.tiers] wholly replaces the shared [tiers].
[harness.pi]
  reviewers = ["grok", "codex"]
  planners  = ["codex"]
[harness.pi.tiers]                 # GPT-5.6 family mapped by capability
  frontier = "codex"               # sol (flagship) at xhigh
  standard = "terra"               # balanced everyday
  fast     = "luna"                # fast, high-volume

# Ledger storage backend — "xdg" (T501) is the default for a fresh \`cq init\`:
# the out-of-tree bun:sqlite primary (K102), keyed off this repo's git
# identity (or [ledger].projectId below). "fs" (in-tree .cq/) and
# "git-object" remain available — set backend explicitly to opt back in.
# backup (default: "none") is OFF by default (Q244); projectId is an
# optional committed project-identity key (Q246), needed only for a repo
# with no stable git root commit (e.g. a shallow clone).
[ledger]
  backend   = "xdg"
# backup    = "none"
# projectId = "my-project"
`;
