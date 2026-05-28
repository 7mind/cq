/**
 * codexAuth.ts — shared codex-auth detection + model picking for the
 * codex e2e specs.
 *
 * The codex CLI rejects most explicit `--model <id>` values when the
 * user's auth is a ChatGPT account (the default in this sandbox), with:
 *   "The '<id>' model is not supported when using Codex with a ChatGPT account."
 * The only models that are reliably accepted in that mode are the ones
 * listed in the user's `~/.codex/config.toml`. We therefore pick the
 * model declared there (the user's CLI default) and bypass the cq popup
 * dropdown by setting `localStorage.cq.model` directly. The cq settings
 * popup gracefully renders unknown model ids (see SettingsPopup.tsx).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function codexAuthPathOrNull(): string | null {
  const homeDir = os.homedir();
  if (homeDir === "" || homeDir === undefined) return null;
  const authPath = path.join(homeDir, ".codex", "auth.json");
  try {
    return fs.statSync(authPath).isFile() ? authPath : null;
  } catch {
    return null;
  }
}

export function hasCodexConfigFileAuth(): boolean {
  return codexAuthPathOrNull() !== null;
}

export function hasOpenAiKey(): boolean {
  const key = process.env["OPENAI_API_KEY"];
  return key !== undefined && key !== "";
}

export function hasCodexAuth(): boolean {
  if (hasCodexConfigFileAuth()) return true;
  if (hasOpenAiKey()) return true;
  if (process.env["CQ_E2E_RUN_CODEX"] === "1") return true;
  return false;
}

/**
 * Pick a codex model id that the user's codex CLI will accept.
 *
 * Order:
 *   1. `CQ_E2E_CODEX_MODEL` env override.
 *   2. The `model = "..."` line in `~/.codex/config.toml`.
 *   3. Fallback to `gpt-5.1` (works only with API-key auth; ChatGPT-account
 *      auth will reject this and the test will skip on the auth error).
 */
export function pickCodexModel(): string {
  const envOverride = process.env["CQ_E2E_CODEX_MODEL"];
  if (envOverride !== undefined && envOverride !== "") return envOverride;
  const homeDir = os.homedir();
  if (homeDir !== "") {
    const cfg = path.join(homeDir, ".codex", "config.toml");
    try {
      const txt = fs.readFileSync(cfg, "utf8");
      // Match a top-level `model = "..."` line (before the first `[section]`).
      // Stop scanning once we hit the first section header so per-provider
      // overrides (e.g. `[mcp_servers.foo]`) are not picked up.
      for (const rawLine of txt.split("\n")) {
        const line = rawLine.trim();
        if (line.startsWith("[")) break;
        if (line.startsWith("#")) continue;
        const m = /^model\s*=\s*"([^"]+)"\s*$/.exec(line);
        if (m !== null) return m[1]!;
      }
    } catch { /* config absent or unreadable — fall through */ }
  }
  return "gpt-5.1";
}
