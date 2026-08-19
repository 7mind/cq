import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export {};

const capturePath = process.env["CQ_T2042_BROKER_CAPTURE"];
const expectedWorktree = process.env["CQ_T2042_WORKTREE"];
const expectedLedgerRoot = process.env["CQ_T2042_LEDGER_ROOT"];
if (
  capturePath === undefined ||
  expectedWorktree === undefined ||
  expectedLedgerRoot === undefined
) {
  throw new Error("capture path and repository boundary are required");
}

const argv = process.argv.slice(2);
if (argv[0] !== "exec") throw new Error("recording executable expected codex exec");
const cwdIndex = argv.indexOf("-C");
const codexCwd = cwdIndex < 0 ? undefined : argv[cwdIndex + 1];
const mcpOverride = argv.find((argument) => argument.startsWith("mcp_servers.ledger="));
const instructionsOverride = argv.find((argument) => argument.startsWith("developer_instructions="));
if (codexCwd !== expectedWorktree || mcpOverride === undefined) {
  throw new Error("Codex role boundary did not select the managed worktree and ledger MCP");
}
if (instructionsOverride === undefined) {
  throw new Error("Codex role boundary omitted the installed worker instructions");
}
const roleInstructions = JSON.parse(instructionsOverride.slice("developer_instructions=".length)) as string;
const normalizedRoleInstructions = roleInstructions.replace(/\s+/gu, " ");
if (
  !normalizedRoleInstructions.includes(
    "A matching `gate-pending` acknowledgement confirms durable handoff to the trusted parent and permits the final response",
  ) ||
  !normalizedRoleInstructions.includes(
    "Without `gitChangeCapability`, only `result-stored` permits the final response",
  )
) {
  throw new Error("installed worker instructions do not permit the parent-gate handoff");
}
if (
  !normalizedRoleInstructions.includes(
    "exempted ONLY for the server-resolved exact-tip/no-new-commit mode",
  ) ||
  !normalizedRoleInstructions.includes(
    "the result reports the lineage verbatim as `gitLineage`",
  )
) {
  throw new Error("installed worker instructions lack the guarded-rebase continuation contract");
}
const commandMatch = /(?:^|[,{}])command=("(?:\\.|[^"\\])*")/.exec(mcpOverride);
const argsMatch = /(?:^|[,{}])args=(\[[^\]]*\])/.exec(mcpOverride);
if (commandMatch?.[1] === undefined || argsMatch?.[1] === undefined) {
  throw new Error("Codex role boundary emitted an unreadable ledger MCP configuration");
}
const ledgerCommand = JSON.parse(commandMatch[1]) as string;
const ledgerArgs = JSON.parse(argsMatch[1]) as string[];
const ledgerCwdIndex = ledgerArgs.indexOf("--cwd");
const ledgerCwd = ledgerCwdIndex < 0 ? undefined : ledgerArgs[ledgerCwdIndex + 1];
if (
  ledgerCwd !== expectedLedgerRoot ||
  ledgerCwd === codexCwd ||
  ledgerArgs.slice(-2).join("\0") !== "--tool-profile\0implement-worker"
) {
  throw new Error("Codex role boundary widened or misplaced the ledger repository boundary");
}

const launch = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
const handle = {
  attestationId: launch["attestationId"],
  generation: launch["generation"],
};
const inputCapability = launch["inputCapability"] as Record<string, unknown>;
const resultCapability = launch["resultCapability"] as Record<string, unknown>;
const gitChangeCapability = launch["gitChangeCapability"] as Record<string, unknown>;
if (
  inputCapability?.["scope"] !== "fetch-input" ||
  resultCapability?.["scope"] !== "store-result" ||
  gitChangeCapability?.["scope"] !== "git-change"
) {
  throw new Error("Codex worker launch lost a scoped capability");
}

const transport = new StdioClientTransport({
  command: ledgerCommand,
  args: ledgerArgs,
  cwd: codexCwd,
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  stderr: "pipe",
});
const client = new Client(
  { name: "t2042-packaged-codex-worker", version: "0.0.1" },
  { capabilities: {} },
);
await client.connect(transport);
const listedTools = (await client.listTools()).tools.map(({ name }) => name).sort();
if (listedTools.join(",") !== "fetch_dispatch_input,git_commit,store_result") {
  throw new Error(`packaged worker saw unexpected tools: ${listedTools.join(",")}`);
}

function decode(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("ledger MCP returned no JSON text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function call(
  name: string,
  body: unknown,
  expectedOk = true,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: body as Record<string, unknown> });
  const isError = (response as { isError?: boolean }).isError === true;
  if (isError === expectedOk) {
    throw new Error(
      `broker probe ${name} returned unexpected MCP result: ${JSON.stringify(response)}`,
    );
  }
  if (!expectedOk) return {};
  return decode(response);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const materialized = await call("fetch_dispatch_input", { ...handle, inputCapability });
const input = materialized["input"] as Record<string, unknown>;
const worktreePath = String(input["worktreePath"]);
const baseCommit = String(input["baseCommit"]);
const startingCommit = String(input["startingCommit"]);
const taskId = String(input["taskId"]);
const branch = String(input["branch"]);
const round = Number(input["round"]);
const inheritedGitReceipts = input["inheritedGitReceipts"];
if (
  inheritedGitReceipts !== undefined &&
  (!Array.isArray(inheritedGitReceipts) || inheritedGitReceipts.length === 0)
) {
  throw new Error("packaged worker received a malformed inherited receipt prefix");
}
const inheritedReceipts = (inheritedGitReceipts ?? []) as Record<string, unknown>[];

function directGitProbe(): { exitCode: number | null; stderr: Buffer } {
  const probe = Bun.spawnSync(
    [
      process.env["CQ_TEST_CODEX_SANDBOX_EXECUTABLE"] ?? "codex",
      "-c",
      'default_permissions="qualification"',
      "-c",
      `permissions.qualification.filesystem={":minimal"="read",` +
        `${JSON.stringify(worktreePath)}="write",` +
        `${JSON.stringify(`${expectedLedgerRoot}/.git`)}="read"}`,
      "sandbox",
      "-P",
      "qualification",
      "-C",
      worktreePath,
      "--",
      process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git",
      "update-ref",
      "refs/heads/cq-direct-git-probe",
      startingCommit,
    ],
    { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
  );
  if (probe.exitCode === 0) {
    throw new Error("direct Git ref mutation unexpectedly succeeded");
  }
  return probe;
}

const guardedLineageInput = input["guardedRebaseLineage"];
if (guardedLineageInput !== undefined) {
  // Guarded-rebase continuation arm: the installed worker receives only the
  // server-materialized lineage and follows the narrow role exemption.
  if (
    guardedLineageInput === null ||
    typeof guardedLineageInput !== "object" ||
    Array.isArray(guardedLineageInput)
  ) {
    throw new Error("packaged worker received a malformed guardedRebaseLineage");
  }
  const lineage = guardedLineageInput as Record<string, unknown>;
  const lineageKeys = Object.keys(lineage).sort();
  if (
    lineageKeys.join(",") !==
    ["exactTip", "guardedRebase", "oldResultCommit", "ontoCommit", "rebasedStartCommit"]
      .sort()
      .join(",")
  ) {
    throw new Error(`packaged worker received foreign lineage keys: ${lineageKeys.join(",")}`);
  }
  const guardedRebase = String(lineage["guardedRebase"]);
  const oldResultCommit = String(lineage["oldResultCommit"]);
  const ontoCommit = String(lineage["ontoCommit"]);
  const rebasedStartCommit = String(lineage["rebasedStartCommit"]);
  if (lineage["exactTip"] !== true && lineage["exactTip"] !== false) {
    throw new Error("packaged worker received a non-boolean exactTip mode");
  }
  const exactTip = lineage["exactTip"] === true;
  if (!/^cq-guarded-rebase:v1:[0-9a-f]{64}$/.test(guardedRebase)) {
    throw new Error("packaged worker received a non-opaque guardedRebase reference");
  }
  for (const [label, value] of [
    ["oldResultCommit", oldResultCommit],
    ["ontoCommit", ontoCommit],
    ["rebasedStartCommit", rebasedStartCommit],
  ] as const) {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`malformed lineage ${label}`);
  }
  if (baseCommit !== ontoCommit) {
    throw new Error("guarded baseCommit does not equal the lineage ontoCommit");
  }
  if (startingCommit !== rebasedStartCommit) {
    throw new Error("guarded startingCommit does not equal the lineage rebasedStartCommit");
  }
  const gitExecutable = process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git";
  const liveHead = Bun.spawnSync([gitExecutable, "rev-parse", "HEAD"], {
    cwd: worktreePath,
    stdout: "pipe",
  });
  if (liveHead.exitCode !== 0 || liveHead.stdout.toString().trim() !== rebasedStartCommit) {
    throw new Error("guarded worktree HEAD is not the rebased start commit");
  }
  if (
    inheritedReceipts.length > 0 &&
    inheritedReceipts[0]!["oldHead"] !== rebasedStartCommit
  ) {
    throw new Error("guarded inherited suffix does not begin at the rebased head");
  }
  const priorResultCommit = input["priorResultCommit"];
  const guardedMode = process.env["CQ_T2151_GUARDED_MODE"];
  const gitLineage = {
    kind: "guarded-rebase",
    guardedRebase,
    ontoCommit,
    rebasedStartCommit,
    exactTip,
  } as const;
  const guardedFilesTouched = (tip: string): string[] =>
    Bun.spawnSync(
      [gitExecutable, "diff", "--name-only", "--no-renames", "-z", ontoCommit, tip, "--"],
      { cwd: worktreePath, stdout: "pipe" },
    )
      .stdout.toString()
      .split("\0")
      .filter(Boolean)
      .sort();
  const guardedFinish = async (
    output: Record<string, unknown>,
    guardedMode: "exact-tip" | "correction",
    directGit: { exitCode: number | null; stderr: Buffer },
    postStoreExpectedHead: string | null,
  ): Promise<never> => {
    const storeResult = await client.callTool({
      name: "store_result",
      arguments: { resultCapability, output },
    });
    if ((storeResult as { isError?: boolean }).isError === true) {
      throw new Error(`store_result failed: ${JSON.stringify(storeResult)}`);
    }
    const acknowledgement = decode(storeResult);
    const failureControls: string[] = [];
    if (postStoreExpectedHead !== null) {
      await call(
        "git_commit",
        {
          ...handle,
          gitChangeCapability,
          operationId: `${taskId}-guarded-deny-post-store`,
          expectedHead: postStoreExpectedHead,
          message: `${taskId}-guarded-deny-post-store`,
          changes: [
            {
              kind: "modify",
              path: "file.txt",
              oldState: { mode: "100644", digest: "0".repeat(64) },
              newState: { mode: "100644", digest: "1".repeat(64) },
            },
          ],
        },
        false,
      );
      failureControls.push("post-store");
    }
    await writeFile(
      capturePath,
      JSON.stringify({
        boundary: { codexCwd, ledgerCommand, ledgerArgs, ledgerCwd, listedTools },
        guardedMode,
        directGit: {
          attempted: true,
          exitStatus: directGit.exitCode,
          stderrDigest: sha256(directGit.stderr.toString()),
        },
        failureControls,
        output,
      }),
    );
    await client.close();
    const payload = [
      JSON.stringify({ type: "thread.started", thread_id: "t2151-packaged-guarded" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "cq_provider_gate_observation", failure_controls: failureControls },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "ledger",
          tool: "store_result",
          result: storeResult,
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(acknowledgement) },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    await new Promise<void>((resolvePromise) => {
      process.stdout.write(payload, () => resolvePromise());
    });
    process.exit(0);
  };

  if (guardedMode === "exact-tip") {
    // The server-resolved exact-tip/no-new-commit exemption: no early WIP
    // commit, no git_commit call at all, an empty fresh suffix, and the exact
    // rebased tip. The initial bridge round binds the exact pre-rebase result.
    if (priorResultCommit !== oldResultCommit) {
      throw new Error("initial bridge round did not bind the exact pre-rebase result");
    }
    if (!exactTip) {
      throw new Error("the server did not resolve the exact-tip mode for this control");
    }
    if (inheritedReceipts.length !== 0) {
      throw new Error("the exact-tip bridge round carries no inherited suffix");
    }
    const directGit = directGitProbe();
    await guardedFinish(
      {
        taskId,
        status: "pass",
        resultCommit: rebasedStartCommit,
        branch,
        actualWorktreePath: worktreePath,
        filesTouched: guardedFilesTouched(rebasedStartCommit),
        gitReceipts: [],
        gitLineage,
        checkSummary: "canonical gate delegated to trusted result-storage boundary",
        baseVerification: {
          status: "verified",
          relation: ontoCommit === rebasedStartCommit ? "equal" : "descendant",
          baseCommit,
          headCommit: rebasedStartCommit,
        },
        summary: "guarded exact-tip continuation: no new commit at the rebased tip",
      },
      "exact-tip",
      directGit,
      null,
    );
  }
  if (guardedMode === "correction") {
    // A guarded correction keeps the ordinary persistence procedure: an early
    // WIP skeleton commit first, then a non-empty contiguous fresh suffix
    // beginning at the rebased head; mutation evidence rides along because the
    // change touches a test path.
    if (typeof priorResultCommit !== "string" || !/^[0-9a-f]{40}$/.test(priorResultCommit)) {
      throw new Error("guarded correction round lacks a full priorResultCommit");
    }
    const priorAncestry = Bun.spawnSync(
      [gitExecutable, "merge-base", "--is-ancestor", priorResultCommit, "HEAD"],
      { cwd: worktreePath },
    );
    if (priorAncestry.exitCode !== 0) {
      throw new Error("guarded correction priorResultCommit is not an ancestor of HEAD");
    }
    const wipPath = `WIP-${taskId}.md`;
    const wipContent =
      [
        "```json",
        JSON.stringify({
          taskId,
          role: "implement-worker",
          baseCommit,
          startedAt: "2026-08-19T00:00:00Z",
          checkpoints: [{ name: "guarded-correction", status: "done" }],
        }),
        "```",
        "",
        "## guarded-correction <!-- cq:wip-checkpoint -->",
        "",
        "Guarded correction round: early persistence at the rebased head.",
        "",
      ].join("\n");
    await writeFile(`${worktreePath}/${wipPath}`, wipContent);
    const wip = await call("git_commit", {
      ...handle,
      gitChangeCapability,
      operationId: `${taskId}-guarded-r${String(round)}-wip`,
      expectedHead: startingCommit,
      message: `${taskId} guarded correction WIP skeleton`,
      changes: [
        {
          kind: "add",
          path: wipPath,
          newState: { mode: "100644", digest: sha256(wipContent) },
        },
      ],
    });
    const beforeCorrection = await readFile(`${worktreePath}/file.txt`, "utf8");
    const afterCorrection = `${beforeCorrection}guarded correction r${String(round)}\n`;
    await writeFile(`${worktreePath}/file.txt`, afterCorrection);
    const testPath = "pkg/test/guarded-correction.test.ts";
    const testContent = `// guarded correction control for ${taskId}\nexport {};
`;
    await mkdir(`${worktreePath}/pkg/test`, { recursive: true });
    await writeFile(`${worktreePath}/${testPath}`, testContent);
    const change = await call("git_commit", {
      ...handle,
      gitChangeCapability,
      operationId: `${taskId}-guarded-r${String(round)}-change`,
      expectedHead: String(wip["newHead"]),
      message: `${taskId} guarded correction change`,
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256(beforeCorrection) },
          newState: { mode: "100644", digest: sha256(afterCorrection) },
        },
        {
          kind: "add",
          path: testPath,
          newState: { mode: "100644", digest: sha256(testContent) },
        },
      ],
    });
    const directGit = directGitProbe();
    await guardedFinish(
      {
        taskId,
        status: "pass",
        resultCommit: change["newHead"],
        branch,
        actualWorktreePath: worktreePath,
        filesTouched: guardedFilesTouched(String(change["newHead"])),
        gitReceipts: [...inheritedReceipts, wip, change],
        gitLineage,
        checkSummary: "canonical gate delegated to trusted result-storage boundary",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit,
          headCommit: change["newHead"],
        },
        summary: "guarded correction: early WIP persistence plus a non-empty fresh suffix",
        mutationTable: [
          {
            mutation: `${testPath}: added by the guarded correction`,
            observed: "filesTouched intersects the test globs, so mutation evidence is required",
            restored: "the correction carries its evidence row",
          },
        ],
      },
      "correction",
      directGit,
      String(change["newHead"]),
    );
  }
  throw new Error(`unknown CQ_T2151_GUARDED_MODE ${String(guardedMode)}`);
}

if (round !== 0 && round !== 1)
  throw new Error(`unexpected packaged worker round ${String(round)}`);
const roundContent =
  round === 0
    ? { before: "before\n", first: "first\n", second: "second\n" }
    : { before: "second\n", first: "third\n", second: "fourth\n" };
const operation = (operationId: string, expectedHead: string, from: string, to: string) => ({
  ...handle,
  gitChangeCapability,
  operationId,
  expectedHead,
  message: operationId,
  changes: [
    {
      kind: "modify",
      path: "file.txt",
      oldState: { mode: "100644", digest: sha256(from) },
      newState: { mode: "100644", digest: sha256(to) },
    },
  ],
});

await writeFile(`${worktreePath}/file.txt`, roundContent.first);
const first = await call(
  "git_commit",
  operation(
    `${taskId}-packaged-r${String(round)}-1`,
    startingCommit,
    roundContent.before,
    roundContent.first,
  ),
);
await writeFile(`${worktreePath}/file.txt`, roundContent.second);
const second = await call(
  "git_commit",
  operation(
    `${taskId}-packaged-r${String(round)}-2`,
    String(first["newHead"]),
    roundContent.first,
    roundContent.second,
  ),
);

const directGit = directGitProbe();

const failureControls: string[] = [];
await call(
  "git_commit",
  {
    ...operation(
      `${taskId}-deny-identity-r${String(round)}`,
      String(second["newHead"]),
      roundContent.second,
      roundContent.second,
    ),
    attestationId: `${String(handle.attestationId)}-foreign`,
  },
  false,
);
failureControls.push("identity");
await call(
  "git_commit",
  {
    ...operation("", String(second["newHead"]), roundContent.second, roundContent.second),
    operationId: "",
  },
  false,
);
failureControls.push("operation");
await call(
  "git_commit",
  {
    ...operation(
      `${taskId}-deny-digest-r${String(round)}`,
      String(second["newHead"]),
      roundContent.second,
      roundContent.second,
    ),
    changes: [
      {
        kind: "modify",
        path: "file.txt",
        oldState: { mode: "100644", digest: "0".repeat(64) },
        newState: { mode: "100644", digest: sha256(roundContent.second) },
      },
    ],
  },
  false,
);
failureControls.push("digest");
await call(
  "git_commit",
  {
    ...operation(
      `${taskId}-deny-generation-r${String(round)}`,
      String(second["newHead"]),
      roundContent.second,
      roundContent.second,
    ),
    generation: Number(handle.generation) + 1,
  },
  false,
);
failureControls.push("generation");
await call(
  "git_commit",
  operation(
    `${taskId}-packaged-r${String(round)}-1`,
    String(second["newHead"]),
    roundContent.second,
    roundContent.second,
  ),
  false,
);
failureControls.push("replay");

const denied: string[] = [];
for (const [label, body] of [
  [
    "main",
    {
      ...operation(
        `${taskId}-deny-main-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      changes: [
        { kind: "add", path: "../main.txt", newState: { mode: "100644", digest: sha256("x") } },
      ],
    },
  ],
  [
    "sibling",
    {
      ...operation(
        `${taskId}-deny-sibling-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      changes: [
        {
          kind: "add",
          path: "/sibling/file.txt",
          newState: { mode: "100644", digest: sha256("x") },
        },
      ],
    },
  ],
  [
    "refs",
    {
      ...operation(
        `${taskId}-deny-ref-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      changes: [
        {
          kind: "add",
          path: ".git/refs/heads/main",
          newState: { mode: "100644", digest: sha256("x") },
        },
      ],
    },
  ],
  [
    "git-metadata",
    {
      ...operation(
        `${taskId}-deny-metadata-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      changes: [
        { kind: "add", path: ".git/config", newState: { mode: "100644", digest: sha256("x") } },
      ],
    },
  ],
  [
    "repository",
    {
      ...operation(
        `${taskId}-deny-repository-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      gitChangeCapability: { scope: "git-change", token: "cq_git_foreign_repository_capability" },
    },
  ],
  [
    "base",
    operation(
      `${taskId}-deny-base-r${String(round)}`,
      baseCommit,
      roundContent.second,
      roundContent.second,
    ),
  ],
] as const) {
  await call("git_commit", body, false);
  denied.push(label);
}
failureControls.push("capability");

await writeFile(`${worktreePath}/undeclared.txt`, "undeclared\n");
await call(
  "git_commit",
  operation(
    `${taskId}-deny-undeclared-r${String(round)}`,
    String(second["newHead"]),
    roundContent.second,
    roundContent.second,
  ),
  false,
);
denied.push("undeclared-path");
await rm(`${worktreePath}/undeclared.txt`);

const output = {
  taskId,
  status: "pass",
  resultCommit: second["newHead"],
  branch,
  actualWorktreePath: worktreePath,
  filesTouched: [
    ...new Set([
      ...inheritedReceipts.flatMap((receipt) => receipt["paths"] as string[]),
      "file.txt",
    ]),
  ].sort(),
  gitReceipts: [...inheritedReceipts, first, second],
  checkSummary: "canonical gate delegated to trusted result-storage boundary",
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit,
    headCommit: second["newHead"],
  },
  summary: "packaged broker worker completed",
};
const storeResult = await client.callTool({
  name: "store_result",
  arguments: { resultCapability, output },
});
if ((storeResult as { isError?: boolean }).isError === true) {
  throw new Error(`store_result failed: ${JSON.stringify(storeResult)}`);
}
const acknowledgement = decode(storeResult);
await call(
  "git_commit",
  operation(
    `${taskId}-deny-post-store-r${String(round)}`,
    String(second["newHead"]),
    roundContent.second,
    roundContent.second,
  ),
  false,
);
failureControls.push("post-store");
await writeFile(
  capturePath,
  JSON.stringify({
    boundary: { codexCwd, ledgerCommand, ledgerArgs, ledgerCwd, listedTools },
    inheritedWorksetCredentials: [
      "CQ_SERVE_TOKEN",
      "CQ_SERVE_MANAGEMENT_TOKEN",
      "CQ_LEDGER_REMOTE_TOKEN",
    ].filter((name) => process.env[name] !== undefined),
    denied,
    directGit: {
      attempted: true,
      exitStatus: directGit.exitCode,
      stderrDigest: sha256(directGit.stderr.toString()),
    },
    failureControls,
    output,
  }),
);
await client.close();
process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: "t2042-packaged-broker" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "cq_provider_gate_observation", failure_controls: failureControls },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "ledger",
        tool: "store_result",
        result: storeResult,
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(acknowledgement) },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n"),
);
