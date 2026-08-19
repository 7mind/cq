import {
  RemoteLedgerClient,
  resolveRemoteAdminLaunch,
  resolveRemoteLaunch,
} from "@cq/ledger";

export async function withRemoteClient<T>(
  cwd: string,
  fn: (client: RemoteLedgerClient) => Promise<T>,
): Promise<T> {
  const launch = await resolveRemoteLaunch(cwd);
  if (launch === null) {
    throw new Error(`cq: ${cwd} is not a backend=remote checkout`);
  }
  const client = await RemoteLedgerClient.connect({
    serverUrl: launch.serverUrl,
    projectKey: launch.projectKey,
    token: launch.token,
  });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function withRemoteAdminClient<T>(
  cwd: string,
  fn: (client: RemoteLedgerClient) => Promise<T>,
): Promise<T> {
  const launch = await resolveRemoteAdminLaunch(cwd);
  if (launch === null) {
    throw new Error(`cq: ${cwd} is not a backend=remote checkout`);
  }
  const client = await RemoteLedgerClient.connectAdmin({
    serverUrl: launch.serverUrl,
    projectKey: launch.projectKey,
    adminToken: launch.adminToken,
  });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
