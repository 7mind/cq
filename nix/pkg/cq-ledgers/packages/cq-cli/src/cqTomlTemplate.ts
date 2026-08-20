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
 *    one harness's kind — so they live under `[harness.claude]` / `[harness.pi]` /
 *    `[harness.codex]`, not at top level. The active CONFIGURATION SELECTOR is
 *    chosen at runtime (CQ_HARNESS, else claude), so the default `cq init`
 *    config resolves the claude panel. `codex` names both a selector and an
 *    executable dispatch transport, so `[harness.codex]` is
 *    FAIL-CLOSED (T861): it must define its own reviewers, planners, AND
 *    `[harness.codex.tiers]` (no fall-through to the shared/claude/pi values),
 *    and every active alias it references must resolve to a non-claude token.
 *  - `[aliases]` are inert definitions; nothing dispatches until a panel or a
 *    `[tiers]` entry references an alias. So the trio plus a few extra aliases
 *    ship live.
 *  - `[tiers]` is harness-specific too: there is no shared top-level `[tiers]`;
 *    each harness carries its own `[harness.<name>.tiers]` map (claude models
 *    under claude, pi models under pi, and the same pi-backed OpenAI-Codex
 *    GPT-5.6 ladder under codex). A model is dispatchable only if its
 *    harness's tiers block names it for some tier. `[harness.pi.tiers]` and
 *    `[harness.codex.tiers]` intentionally ship the SAME frontier/standard/fast
 *    ladder (sol/terra/luna). Native `codex:<model>` tokens are equally valid
 *    when the Codex executable should dispatch directly.
 *  - `[ledger]` sets `backend = "xdg"` (T501): the out-of-tree bun:sqlite
 *    primary is the default for a FRESH `cq init`. This ONLY affects fresh
 *    inits — an existing repo's cq.toml (untouched by `cq init` without
 *    `--force`) keeps whatever backend it already has. The backup mode
 *    defaults to `none` (T494; unaffected). A commented `backend = "remote"`
 *    + required `serverUrl` example documents repository-backed operation;
 *    its bearer secret belongs only in `CQ_LEDGER_REMOTE_TOKEN`. PostgreSQL
 *    is private `cq serve` state and is not a public `[ledger]` backend.
 *  - `[project]` (T570/Q270) is documented, commented out: its one key
 *    (`name`) is a purely cosmetic display-name override — no credentials
 *    ever belong there either.
 */

export const CQ_TOML_TEMPLATE: string = `\
# cq.toml — cq review orchestrator config.
# Full schema and the flat backward-compatible layout: see cq.toml.example.
# Global harness/model defaults may instead live in the XDG config file cq/cq.toml.

# alias -> "<harness>:<model>" token. Definitions only — an alias does nothing
# until a panel (reviewers/planners) or a [harness.<h>.tiers] entry references it.
# Optional trailing reasoning-effort suffix ":<effort>" (higher = more thinking):
#   pi     — off | none | minimal | low | medium | high | xhigh | max  (used at dispatch)
#   claude — low | medium | high | xhigh | max                         (parsed; not yet used)
#   codex  — low | medium | high | xhigh | max | ultra                 (used at dispatch)
# Codex values are the packaged executable's gpt-5.6-sol vocabulary.
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
#   codex  — low | medium | high | xhigh | max | ultra
# [agent_efforts]
#   plan-reviewer = "max"

# Global dispatch policy. This stays the same under claude, codex, and pi;
# it cannot be placed in a [harness.<name>] block.
[dispatch]
  forceShellout = false
  # UNSAFE compatibility switch for Codex sandbox defects. A Codex role that
  # requests read-only runs with danger-full-access while enabled. Remove or
  # reset to false after the upstream defect is fixed.
  unsafeDisableCodexReadOnlySandbox = false

# [upstream] — kill-switches for ordinary third-party reports (Q336).
# Absence, or a missing key, means enabled. These never authorize security
# reporting or inner-loop filing; /cq:upstream files only explicit ordinary
# reports. Recheck is independent. Inner loops only record/defer.
# [upstream]
#   filing  = "enabled"   # or "disabled"
#   recheck = "enabled"   # or "disabled"

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

# The codex harness: active when CQ_HARNESS=codex (set by the packaged Codex
# wrapper, T863). "codex" is both a CONFIGURATION SELECTOR and executable
# dispatch transport, so this block is FAIL-CLOSED (T861): it must
# define reviewers, planners, AND [harness.codex.tiers] itself (no fall-through
# to the shared/claude/pi values above), and every active alias it references
# must resolve to a non-claude token — a dispatch-panel read (resolveReviewers /
# resolvePlanners / tierModel / resolveAgentModel) throws otherwise. It reuses
# the SAME pi-executable GPT-5.6 ladder as [harness.pi.tiers] above.
[harness.codex]
  reviewers = ["codex"]
  planners  = ["codex"]
[harness.codex.tiers]              # same GPT-5.6 ladder as [harness.pi.tiers]
  frontier = "codex"               # sol (flagship) at xhigh
  standard = "terra"               # balanced everyday
  fast     = "luna"                # fast, high-volume

# Ledger storage backend — "xdg" is the DEFAULT (K117; also what a fresh
# \`cq init\` writes, T501): the out-of-tree bun:sqlite primary (K102), keyed
# off this repo's git identity (or [ledger].projectId below). "fs" (in-tree
# .cq/) and "git-object" are LEGACY, deprecated — selecting one explicitly
# still works but warns and points at \`cq migrate\`.
# "remote" selects a repository-backed cq serve endpoint; serverUrl is a
# required, non-secret HTTP(S) URL. Its ordinary bearer secret comes only from
# CQ_LEDGER_REMOTE_TOKEN and never from this file.
# backup (default: "none") is OFF by default (Q244); projectId is an
# optional committed project-identity key (Q246), needed only for a repo
# with no stable git root commit (e.g. a shallow clone).
[ledger]
  backend   = "xdg"
# backup    = "none"
# projectId = "my-project"

# To use the repository-backed remote service, uncomment this block instead.
# serverUrl must use HTTP(S) and contain no credentials, query, or fragment.
# Set the bearer secret in CQ_LEDGER_REMOTE_TOKEN; never add it to cq.toml.
# [ledger]
#   backend   = "remote"
#   serverUrl = "https://cq.example.com"
#   backup    = "none"
#   projectId = "my-project"

# PostgreSQL is private cq serve state. Start the hub with --pg-url /
# CQ_LEDGER_PG_URL, then point checkouts at it with backend = "remote".
# Ordinary token: CQ_LEDGER_REMOTE_TOKEN. Admin token:
# CQ_LEDGER_REMOTE_ADMIN_TOKEN (migrate/backup/restore/reset/erase).

# [project] (T570) — optional project-level metadata; \`name\` is a cosmetic
# display-name override (Q270's reconciled chain: [project].name >
# [ledger].projectId > repo root basename > the resolved projectKey itself).
# No credentials belong here either.
# [project]
#   name = "my-project"
`;

function globalHarnessSettings(projectTemplate: string): string {
  const firstHarnessSetting = projectTemplate.indexOf("# alias ->");
  const firstLocalSetting = projectTemplate.indexOf("# Ledger storage backend");
  if (firstHarnessSetting < 0 || firstLocalSetting <= firstHarnessSetting) {
    throw new Error("CQ_TOML_TEMPLATE global harness boundaries are missing or out of order");
  }
  return projectTemplate.slice(firstHarnessSetting, firstLocalSetting).trimEnd();
}

export const CQ_TOML_GLOBAL_TEMPLATE: string = `\
# cq.toml — global cq review orchestrator config.
# [ledger] and [project] are LOCAL-ONLY and ignored in this global file.
# Put backend, projectId, and project name in each repository's cq.toml.

${globalHarnessSettings(CQ_TOML_TEMPLATE)}
`;
