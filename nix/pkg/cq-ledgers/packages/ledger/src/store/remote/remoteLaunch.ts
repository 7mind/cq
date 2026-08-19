/**
 * T733/T734 — resolve a backend=remote checkout into a cq serve MCP URL.
 */
import { loadConfig, resolveRemoteAdminToken, resolveRemoteLedgerToken } from "@cq/config";
import { resolveLedgerBackend } from "../createLedgerStore.js";
import { resolveProjectKey } from "../../projectKey.js";
import { remoteAdminMcpUrl, remoteMcpUrl } from "./RemoteLedgerClient.js";

export interface RemoteLaunchTarget {
  readonly mcpUrl: string;
  readonly token: string;
  readonly projectKey: string;
  readonly serverUrl: string;
}

export interface RemoteAdminLaunchTarget extends RemoteLaunchTarget {
  readonly adminMcpUrl: string;
  readonly adminToken: string;
}

export async function resolveRemoteLaunch(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RemoteLaunchTarget | null> {
  if (resolveLedgerBackend(cwd).backend !== "remote") return null;
  const config = loadConfig(cwd);
  if (config?.ledger?.backend !== "remote") return null;
  const projectKey = await resolveProjectKey({
    repoRoot: cwd,
    projectId: config.ledger.projectId,
  });
  return {
    serverUrl: config.ledger.serverUrl,
    projectKey,
    mcpUrl: remoteMcpUrl(config.ledger.serverUrl, projectKey),
    token: resolveRemoteLedgerToken(env),
  };
}

export async function resolveRemoteAdminLaunch(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RemoteAdminLaunchTarget | null> {
  const ordinary = await resolveRemoteLaunch(cwd, env);
  if (ordinary === null) return null;
  const adminToken = resolveRemoteAdminToken(env);
  return {
    ...ordinary,
    adminToken,
    adminMcpUrl: remoteAdminMcpUrl(ordinary.serverUrl, ordinary.projectKey),
  };
}
