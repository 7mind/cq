/**
 * CQ_TOML_TEMPLATE — the cq.toml starter that `cq init` writes. It must stay
 * schema-valid; the exhaustive reference lives in `cq.toml.example`.
 *
 * The harness section (from the aliases through the codex harness) is also the
 * global template's body, so it must not contain [ledger] or [project].
 */

const HARNESS_SECTION_START = "# Model aliases:";
const LOCAL_SECTION_START = "# Ledger storage:";
const COMMENTED_PROJECT_ID = '# projectId = "my-project"';

function renderTemplate(projectIdLine: string): string {
  return `\
# cq.toml — cq configuration. Full reference: cq.toml.example.

${HARNESS_SECTION_START} "<harness>:<model>[:<effort>]"; pi tokens are "pi:<provider>/<model>".
[aliases]
  opus            = "claude:opus"
  opus-max        = "claude:opus:max"
  fable           = "claude:fable"
  sonnet          = "claude:sonnet"
  haiku           = "claude:haiku"
  grok            = "pi:grok-build/grok-build:high"
  pi-astra        = "pi:openai-codex/gpt-6-astra:xhigh"
  pi-astra-max    = "pi:openai-codex/gpt-6-astra:max"
  pi-sol          = "pi:openai-codex/gpt-6-sol:high"
  pi-luna         = "pi:openai-codex/gpt-6-luna:low"
  codex-astra     = "codex:gpt-6-astra:xhigh"
  codex-astra-max = "codex:gpt-6-astra:max"
  codex-sol       = "codex:gpt-6-sol:high"
  codex-luna      = "codex:gpt-6-luna:low"

# Agents not listed default to "standard".
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

# Per-agent reasoning-effort override.
# [agent_efforts]
#   plan-reviewer = "max"

[dispatch]
  forceShellout = false
  # Unsafe: runs read-only Codex roles with full access. Keep false.
  unsafeDisableCodexReadOnlySandbox = false

# Third-party issue reporting; both default to enabled.
# [upstream]
#   filing  = "enabled"
#   recheck = "enabled"

# Panels and tiers per harness (selected by CQ_HARNESS; default claude).
[harness.claude]
  reviewers = ["opus"]
  planners  = ["opus"]
[harness.claude.tiers]
  frontier = "opus"
  # frontier = "fable"
  standard = "sonnet"
  fast     = "haiku"

[harness.pi]
  reviewers = ["grok", "pi-astra"]
  planners  = ["pi-astra"]
[harness.pi.tiers]
  frontier = "pi-astra"
  standard = "pi-sol"
  fast     = "pi-luna"

# The codex harness must define its own panels and tiers, all non-claude.
[harness.codex]
  reviewers = ["codex-astra"]
  planners  = ["codex-astra"]
[harness.codex.tiers]
  frontier = "codex-astra"
  standard = "codex-sol"
  fast     = "codex-luna"

${LOCAL_SECTION_START} "xdg" keeps the ledger out of tree, keyed by the git root commit or projectId.
[ledger]
  backend   = "xdg"
  ${projectIdLine}

# Remote ledger service. Tokens come from CQ_LEDGER_REMOTE_TOKEN and
# CQ_LEDGER_REMOTE_ADMIN_TOKEN, never from this file.
# [ledger]
#   backend = "remote"
#   serverUrl = "https://cq.example.com"
#   backup    = "none"
#   projectId = "my-project"

# [project]
#   name = "my-project"
`;
}

export const CQ_TOML_TEMPLATE: string = renderTemplate(COMMENTED_PROJECT_ID);

/** The project template with an active [ledger].projectId, for a directory with no git root commit. */
export function cqTomlTemplateWithProjectId(projectId: string): string {
  return renderTemplate(`projectId = ${JSON.stringify(projectId)}`);
}

function globalHarnessSettings(projectTemplate: string): string {
  const firstHarnessSetting = projectTemplate.indexOf(HARNESS_SECTION_START);
  const firstLocalSetting = projectTemplate.indexOf(LOCAL_SECTION_START);
  if (firstHarnessSetting < 0 || firstLocalSetting <= firstHarnessSetting) {
    throw new Error("CQ_TOML_TEMPLATE global harness boundaries are missing or out of order");
  }
  return projectTemplate.slice(firstHarnessSetting, firstLocalSetting).trimEnd();
}

export const CQ_TOML_GLOBAL_TEMPLATE: string = `\
# cq.toml — global cq configuration. [ledger] and [project] belong in each
# repository's cq.toml and are ignored here.

${globalHarnessSettings(CQ_TOML_TEMPLATE)}
`;
