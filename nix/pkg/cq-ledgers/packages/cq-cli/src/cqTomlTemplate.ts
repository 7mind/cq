/**
 * CQ_TOML_TEMPLATE — a fully-commented cq.toml starter template (T331, T349, T440, T485).
 *
 * This is a hand-authored TOML literal (cq-config has only a parser, no
 * serialiser) that, once re-parsed by @cq/config `parseConfig`, is
 * schema-valid and resolves cleanly through `resolveReviewers` /
 * `resolvePlanners`.
 *
 * Panel design (T440 / T438 decoupling):
 *   reviewers = ["opus"] / planners = ["opus"] — opus is the ONLY panel
 *   member because opus handles planning and reviewing.  sonnet and haiku
 *   are defined in [aliases] and classified in [tiers] but are NOT on the
 *   panels.  This is intentional: per-role agent-model resolution draws from
 *   ALL [aliases] (the full pool), not from the reviewers/planners panels, so
 *   implement-worker (standard tier) resolves sonnet and investigate-prober
 *   (standard tier) also resolves sonnet — even though sonnet does not appear
 *   in reviewers or planners.  Removing sonnet/haiku from the panels eliminates
 *   redundant multi-reviewer churn on plan/implement review steps while keeping
 *   them available for per-role tier dispatch.
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
 * Per-harness layered overrides (T485 / Q239 / Q240):
 *   The [harness.<name>] section documents the per-harness override mechanism.
 *   All [harness.*] lines in the shipped template are COMMENTED OUT so that the
 *   template remains a flat, backward-compatible config that parses and resolves
 *   cleanly under any harness (T479 backward-compat guard).  Uncomment the
 *   [harness.pi] sample to activate per-harness overrides for the pi harness.
 *
 * Reference: Q184 (active set), D36 (pi provider routing), T286 (effort suffix),
 *            T349 (ledger backend config), Q189 (git-object opt-in),
 *            T438 (candidateTokens decoupling), T440 (opus-only panels),
 *            T485 (template per-harness docs), Q238 (harness resolution),
 *            Q239/Q240 (layered override semantics).
 */

export const CQ_TOML_TEMPLATE: string = `\
# cq.toml — configuration for the cq review orchestrator
#
# This file documents the schema for configuring reviewers and planners in
# the cq review flows.  Absence of cq.toml means only the native Claude
# reviewer is used (feature off).
#
# Schema:
#   [aliases]        — table mapping alias names to reviewer tokens
#   reviewers = [...] — top-level array of alias names to activate as reviewers
#   planners  = [...] — top-level array of alias names to activate as planners
#   [tiers]          — CLASSIFIER: maps each token (or alias) to a tier class
#   [agent_tiers]    — maps agent-name -> tier name (default: "standard")
#
# Token grammar (T237 + T286):
#   claude tokens: claude:<model>[:<effort>]
#     e.g. claude:opus-4.8[1m], claude:sonnet-4.6, claude:haiku-4.5
#     EFFORT SUFFIX (optional): low | medium | high | xhigh | max
#   pi tokens: pi:<provider>/<model>[:<effort>]
#     e.g. pi:grok-build/grok-build, pi:ollama-cloud/minimax-m3
#     EFFORT SUFFIX (optional): off | minimal | low | medium | high | xhigh
#   A bare pi token (missing the provider/ qualifier) is a CONFIG ERROR.
#
# Tier classes: fast | standard | frontier
#
# Panel vs per-role decoupling (T438/T440):
#   reviewers/planners are the PANEL lists — used for multi-reviewer review
#   steps (plan-flow, implement-flow).  Per-role agent-model resolution (e.g.
#   implement-worker, investigate-prober) draws from ALL [aliases] classified
#   in [tiers], NOT from the reviewers/planners panels.  This means sonnet and
#   haiku can serve their tier roles even though they are not on the panels.
#   Only opus belongs on the panels because only opus plans and reviews.

# reviewers — List of ALIAS NAMES (keys from [aliases] below) to activate as
# reviewers.  Each alias is resolved through [aliases] to its token at runtime.
# The reviewers will be invoked in plan-flow and implement-flow review steps.
# Only opus is on the panel — sonnet/haiku are off-panel but still resolve for
# their tiers via per-role [agent_tiers] dispatch (see decoupling note above).
reviewers = ["opus"]

# planners — List of ALIAS NAMES to activate as planners.  Planners MIRROR
# reviewers: same alias-name list shape, resolved through the SAME shared
# [aliases] table below.  Only opus is on the planner panel.
planners = ["opus"]

# [aliases] — Define reviewer/planner instances as tokens.
#
# All three canonical Claude aliases are DEFINED here and classified in [tiers].
# Only opus is listed on the reviewers/planners panels above.  sonnet and haiku
# remain resolvable for per-role dispatch (implement-worker -> standard -> sonnet,
# investigate-prober -> standard -> sonnet, etc.) via [agent_tiers] + [tiers],
# independently of the panel lists.
[aliases]
  # ── Active: canonical Claude trio (all classified in [tiers] below) ───────
  opus     = "claude:opus-4.8[1m]" # frontier tier — on reviewers+planners panels
  fable    = "claude:fable-5"      # frontier tier — off-panel, available per-role
  sonnet   = "claude:sonnet-4.6"   # standard tier — off-panel, available per-role
  sonnet-5 = "claude:sonnet-5"     # standard tier — off-panel, available per-role
  haiku    = "claude:haiku-4.5"    # fast tier    — off-panel, available per-role

  # ── Inactive pi aliases (uncomment to activate) ──────────────────────────
  # These require the relevant pi provider to be configured and accessible.
  # After uncommenting an alias here, also add its name to reviewers/planners
  # above if it should appear on a panel, and add a [tiers] entry for it below.
  #
  # codex      = "pi:grok-build/grok-build"
  # grok       = "pi:grok-build/grok-build"
  # grok-xhigh = "pi:grok-build/grok-build:xhigh"
  # minimax    = "pi:ollama-cloud/minimax-m3"

  # ── Inactive Claude aliases with explicit effort suffix ───────────────────
  # opus-high = "claude:opus-4.8[1m]:high"

# [tiers] — CLASSIFIER: maps each concrete token (or alias) to its dispatch
# tier class.  THIS IS NOT A DISPATCH TABLE — it tells cq what tier a given
# token belongs to; per-role agent-model resolution draws from ALL [aliases]
# (not just the panels), so a token classified here is eligible for its tier
# even when it is not listed on the reviewers/planners panels.
#
# Each KEY must be a valid ReviewerToken (alias name from [aliases], or a full
# token in the grammar: claude:<model> | pi:<provider>/<model>).
# Each VALUE is the tier class: fast | standard | frontier.
#
# A token not listed here is unclassified; resolving an unclassified token
# throws CqConfigError.  Both alias keys and full token keys are accepted.
[tiers]
  # Canonical Claude trio — classified by capability (all three must be here
  # even though only opus is on the panels, so per-role dispatch can resolve
  # sonnet for standard-tier roles and haiku for fast-tier roles):
  opus     = "frontier"   # alias key — resolves to claude:opus-4.8[1m]
  fable    = "frontier"   # alias key — resolves to claude:fable-5    (off-panel)
  sonnet   = "standard"   # alias key — resolves to claude:sonnet-4.6 (off-panel)
  sonnet-5 = "standard"   # alias key — resolves to claude:sonnet-5   (off-panel)
  haiku    = "fast"       # alias key — resolves to claude:haiku-4.5  (off-panel)

  # Inactive pi entries (uncomment the matching alias above first):
  # "pi:grok-build/grok-build"      = "standard"
  # grok-xhigh                       = "frontier"   # alias key with effort suffix
  # minimax                          = "fast"        # alias key
  #
  # Inactive Claude with effort suffix:
  # "claude:opus-4.8[1m]:high"      = "frontier"

# [agent_tiers] — Map each named cq agent to its dispatch tier.
# An agent with NO entry here falls back to the "standard" tier.
# The tier here selects, from ALL [aliases] classified in [tiers], the first
# token of the matching class — independent of the reviewers/planners panels.
# Valid tier values: "fast", "standard", "frontier".
[agent_tiers]
  investigate-explorer    = "frontier"
  investigate-prober      = "standard"
  plan-advance            = "frontier"
  plan-reviewer           = "frontier"
  implement-worker        = "standard"
  implement-reviewer      = "frontier"
  implement-conflict-resolver = "standard"

# [ledger] — Ledger storage backend configuration (T349).
# Absence of this block (or of cq.toml entirely) defaults to backend="fs"
# (the standard filesystem-backed FsLedgerStore).  The "git-object" backend
# is opt-in experimental (Q189): it stores ledger data in git object storage
# instead of plain files.
#
# Keys:
#   backend — storage backend: "fs" (default) | "git-object"
#   branch  — git branch for the git-object backend (default: "cq-ledger")
#   remote  — git remote for the git-object backend (default: "origin")
#
# To activate the git-object backend, uncomment the block below and set
# backend = "git-object".  The branch/remote keys are optional; the shown
# values are the defaults.
#
# [ledger]
#   backend = "git-object"   # "fs" (default) | "git-object" (experimental)
#   branch  = "cq-ledger"    # git branch to store ledger objects on
#   remote  = "origin"       # git remote to push/fetch ledger objects from

# ---------------------------------------------------------------------------
# PER-HARNESS LAYERED OVERRIDES (Q239 / Q240)
# ---------------------------------------------------------------------------
#
# cq supports two harnesses: "claude" (Claude Code) and "pi" (pi shell).
# A \`[harness.<name>]\` block (where <name> is "claude" or "pi") overrides
# the shared top-level config for that harness only.  Absent blocks fall
# through to the shared values above — backward compatible with flat cq.toml.
#
# LAYERING SEMANTICS:
#   - When a per-harness block is present, each section it carries WHOLLY
#     REPLACES the corresponding shared top-level value.  There is NO union or
#     supplement: the shared [tiers]/reviewers/planners entries are DISCARDED
#     for that harness and replaced entirely by the per-harness entries.
#   - An absent per-harness section (null/omitted) falls through to the shared
#     value unchanged — backward compatible with today's flat config.
#   - [aliases] is SHARED-ONLY: per-harness tiers still resolve alias keys
#     through the shared [aliases] table.
#
# SHARED (cannot be overridden per-harness — shared across all harnesses):
#   [aliases]      — alias name -> reviewer token map
#   [webui]        — web-UI port / bind config
#   [ledger]       — storage backend (fs / git-object)
#   [agent_tiers]  — agent-name -> tier class map
#
# PER-HARNESS OVERRIDABLE (present in [harness.<name>]):
#   reviewers = [...]         — REPLACES shared top-level reviewers
#   planners  = [...]         — REPLACES shared top-level planners
#   [harness.<name>.tiers]    — WHOLLY REPLACES the shared [tiers] classifier
#
# Q238 HARNESS SELECTION RULE (priority order):
#   1. Explicit CQ_HARNESS env var wins (e.g. CQ_HARNESS=pi).
#      nix/hm/pi.nix is intended to set CQ_HARNESS=pi (wired in a later task).
#      Any non-empty unknown value is a CqConfigError (fail fast, no silent
#      fallback).
#   2. CLAUDE_CODE_SESSION_ID non-empty => "claude".
#   3. Default => "claude" (preserves today's bare \`cq\` invocation behaviour).
#
# EXAMPLE — activate grok + minimax for the pi harness (COMMENTED OUT; see
# note about T479: no uncommented [harness.*] lines may appear in this file):
#
# [harness.pi]
# reviewers = ["grok", "minimax"]
# planners  = ["grok"]
#
# [harness.pi.tiers]
# grok    = "frontier"   # alias key — resolves to pi:grok-build/grok-build
# minimax = "fast"       # alias key — resolves to pi:ollama-cloud/minimax-m3
`;
