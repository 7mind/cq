/**
 * Behavioral-Active × Blackbox-Group contract for cq web mode selection.
 *
 * Specified origin: T834.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HUB_DEFAULT_PORT, parseHubArgs } from "../src/hubServe.js";
import {
  parseArgs,
  resolveWebMode,
  WHOLE_STORE_DEFAULT_PORT,
} from "../src/serve.js";

const savedEnvironment = {
  LEDGER_ROOT: process.env["LEDGER_ROOT"],
  XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
  CQ_SERVE_TOKEN: process.env["CQ_SERVE_TOKEN"],
  CQ_LEDGER_PG_URL: process.env["CQ_LEDGER_PG_URL"],
  DATABASE_URL: process.env["DATABASE_URL"],
};
const temporaryRoots: string[] = [];

afterEach(() => {
  restoreEnvironment();
});

afterAll(async () => {
  restoreEnvironment();
  await Promise.all(
    temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

interface RepositoryFixture {
  readonly commit: boolean;
  readonly projectId: string | null;
  readonly webPort: number | null;
  readonly ledgerBackend: "xdg" | "postgres";
}

async function makeRepository(fixture: RepositoryFixture): Promise<string> {
  const root = await makeDirectory("ledger-web-mode-repo-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const configLines = [
    ...(fixture.webPort === null ? [] : ["[webui]", `port = ${fixture.webPort}`, ""]),
    "[ledger]",
    `backend = "${fixture.ledgerBackend}"`,
    ...(fixture.projectId === null ? [] : [`projectId = "${fixture.projectId}"`]),
  ];
  if (fixture.ledgerBackend === "postgres") {
    configLines.push('url = "postgres://must-not-be-read.invalid/cq"');
  }
  await fs.writeFile(path.join(root, "cq.toml"), `${configLines.join("\n")}\n`, "utf8");
  if (fixture.commit) {
    execFileSync("git", ["add", "cq.toml"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T834",
        "-c",
        "user.email=t834@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
  }
  return root;
}

async function makeDirectory(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe("cq web whole-store mode selection", () => {
  it("recognises the explicit XDG backend instead of silently selecting embedded mode", () => {
    const parsed = parseArgs(["--backend=xdg"]);
    expect(parsed).toHaveProperty("backend", "xdg");
  });

  it("selects embedded only for committed or explicitly-keyed repositories", async () => {
    const cases = [
      {
        label: "committed repository",
        root: await makeRepository({
          commit: true,
          projectId: null,
          webPort: null,
          ledgerBackend: "xdg",
        }),
        expected: "embedded",
      },
      {
        label: "uncommitted repository with projectId",
        root: await makeRepository({
          commit: false,
          projectId: "unborn-pinned",
          webPort: null,
          ledgerBackend: "xdg",
        }),
        expected: "embedded",
      },
      {
        label: "uncommitted repository without projectId",
        root: await makeRepository({
          commit: false,
          projectId: null,
          webPort: null,
          ledgerBackend: "xdg",
        }),
        expected: "xdg",
      },
      {
        label: "non-repository even with cq.toml projectId",
        root: await makeDirectory("ledger-web-mode-nonrepo-"),
        expected: "xdg",
      },
    ] as const;
    await fs.writeFile(
      path.join(cases[3].root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nprojectId = "not-a-repository"\n',
      "utf8",
    );

    for (const fixture of cases) {
      const mode = await resolveWebMode(parseArgs(["--cwd", fixture.root]));
      expect(mode.kind, fixture.label).toBe(fixture.expected);
      if (mode.kind === "xdg") {
        expect(mode.source, fixture.label).toBe("implicit");
        expect(mode.opts.cwdHint, fixture.label).toBe(fixture.root);
      }
    }
  });

  it("rejects fabricated directory and file .git markers even with projectId", async () => {
    for (const marker of ["directory", "file"] as const) {
      const root = await makeDirectory(`ledger-web-mode-fake-${marker}-`);
      await fs.writeFile(
        path.join(root, "cq.toml"),
        '[ledger]\nbackend = "xdg"\nprojectId = "fabricated"\n',
        "utf8",
      );
      if (marker === "directory") {
        await fs.mkdir(path.join(root, ".git"));
      } else {
        await fs.writeFile(path.join(root, ".git"), "arbitrary marker\n", "utf8");
      }

      const mode = await resolveWebMode(parseArgs(["--cwd", root]));
      expect(mode.kind, marker).toBe("xdg");
      if (mode.kind !== "xdg") throw new Error(`expected ${marker} marker rejection`);
      expect(mode.source).toBe("implicit");
    }
  });

  it("resolves nested normal and linked checkout paths to the canonical top-level", async () => {
    const repository = await makeRepository({
      commit: true,
      projectId: "canonical-root",
      webPort: 6211,
      ledgerBackend: "xdg",
    });
    const normalNested = path.join(repository, "nested", "cwd");
    await fs.mkdir(normalNested, { recursive: true });

    const linkedParent = await makeDirectory("ledger-web-mode-linked-parent-");
    const linkedRoot = path.join(linkedParent, "checkout");
    execFileSync(
      "git",
      ["worktree", "add", "--quiet", "--detach", linkedRoot, "HEAD"],
      { cwd: repository },
    );
    const linkedNested = path.join(linkedRoot, "nested", "cwd");
    await fs.mkdir(linkedNested, { recursive: true });

    for (const [label, cwd, expectedRoot] of [
      ["normal", normalNested, repository],
      ["linked", linkedNested, linkedRoot],
    ] as const) {
      const mode = await resolveWebMode(parseArgs(["--cwd", cwd]));
      expect(mode.kind, label).toBe("embedded");
      if (mode.kind !== "embedded") throw new Error(`expected ${label} embedded mode`);
      expect(mode.opts.cwd, label).toBe(await fs.realpath(expectedRoot));
      expect(mode.opts.port, label).toBe(6211);
    }
  });

  it("applies --cwd > LEDGER_ROOT > process cwd before implicit selection", async () => {
    const envRepo = await makeRepository({
      commit: false,
      projectId: "from-environment",
      webPort: null,
      ledgerBackend: "xdg",
    });
    const flagRepo = await makeRepository({
      commit: false,
      projectId: "from-flag",
      webPort: null,
      ledgerBackend: "xdg",
    });
    const nonRepository = await makeDirectory("ledger-web-mode-env-nonrepo-");

    process.env["LEDGER_ROOT"] = envRepo;
    let mode = await resolveWebMode(parseArgs([]));
    expect(mode.kind).toBe("embedded");
    if (mode.kind !== "embedded") throw new Error("expected embedded mode");
    expect(mode.opts.cwd).toBe(envRepo);

    mode = await resolveWebMode(parseArgs(["--cwd", flagRepo]));
    expect(mode.kind).toBe("embedded");
    if (mode.kind !== "embedded") throw new Error("expected embedded mode");
    expect(mode.opts.cwd).toBe(flagRepo);

    process.env["LEDGER_ROOT"] = nonRepository;
    mode = await resolveWebMode(parseArgs([]));
    expect(mode.kind).toBe("xdg");
    if (mode.kind !== "xdg") throw new Error("expected implicit XDG mode");
    expect(mode.source).toBe("implicit");
    expect(mode.opts.cwdHint).toBe(nonRepository);
  });

  it("uses explicit XDG mode, the default projects root, and cwd only as a hint", async () => {
    const repo = await makeRepository({
      commit: false,
      projectId: "preselected",
      webPort: 6123,
      ledgerBackend: "postgres",
    });
    const xdgStateHome = await makeDirectory("ledger-web-mode-xdg-home-");
    process.env["XDG_STATE_HOME"] = xdgStateHome;
    process.env["CQ_SERVE_TOKEN"] = "must-not-be-read";
    process.env["CQ_LEDGER_PG_URL"] = "postgres://must-not-be-read.invalid/env";
    process.env["DATABASE_URL"] = "postgres://must-not-be-read.invalid/database";

    const mode = await resolveWebMode(
      parseArgs(["--backend=xdg", "--cwd", repo]),
    );
    expect(mode.kind).toBe("xdg");
    if (mode.kind !== "xdg") throw new Error("expected explicit XDG mode");
    expect(mode.source).toBe("explicit");
    expect(mode.opts).toEqual({
      host: "127.0.0.1",
      port: WHOLE_STORE_DEFAULT_PORT,
      projectsRoot: path.join(xdgStateHome, "cq", "projects"),
      cwdHint: repo,
      outdir: process.env["LEDGER_WEB_OUTDIR"] ??
        path.resolve(new URL("../dist", import.meta.url).pathname),
    });
    expect(mode).not.toHaveProperty("token");
    expect(mode.opts).not.toHaveProperty("token");
    expect(mode.opts).not.toHaveProperty("pgUrl");
    expect(mode.opts).not.toHaveProperty("backend");
  });

  it("normalizes a custom store path and honors explicit host/port overrides", async () => {
    const cwd = await makeDirectory("ledger-web-mode-custom-cwd-");
    const mode = await resolveWebMode(
      parseArgs([
        "--backend",
        "xdg",
        "--store=relative/projects",
        "--cwd",
        cwd,
        "--host=0.0.0.0",
        "--port",
        "6200",
      ]),
    );
    expect(mode.kind).toBe("xdg");
    if (mode.kind !== "xdg") throw new Error("expected explicit XDG mode");
    expect(mode.opts.projectsRoot).toBe(path.resolve("relative/projects"));
    expect(mode.opts.cwdHint).toBe(cwd);
    expect(mode.opts.host).toBe("0.0.0.0");
    expect(mode.opts.port).toBe(6200);
  });

  it("preserves proxy/repository-local precedence and keeps all three default ports distinct", async () => {
    const defaultRepo = await makeRepository({
      commit: true,
      projectId: null,
      webPort: null,
      ledgerBackend: "xdg",
    });
    const configuredRepo = await makeRepository({
      commit: false,
      projectId: "configured",
      webPort: 6201,
      ledgerBackend: "xdg",
    });

    let mode = await resolveWebMode(parseArgs(["--cwd", defaultRepo]));
    expect(mode.kind).toBe("embedded");
    expect(mode.opts.port).toBe(5180);

    mode = await resolveWebMode(parseArgs(["--cwd", configuredRepo]));
    expect(mode.kind).toBe("embedded");
    expect(mode.opts.port).toBe(6201);

    mode = await resolveWebMode(
      parseArgs([
        "--cwd",
        configuredRepo,
        "--mcp-url",
        "http://127.0.0.1:7777/mcp",
        "--port",
        "6202",
      ]),
    );
    expect(mode.kind).toBe("proxy");
    if (mode.kind !== "proxy") throw new Error("expected proxy mode");
    expect(mode.opts.mcpUrl).toBe("http://127.0.0.1:7777/mcp");
    expect(mode.opts.port).toBe(6202);

    expect(HUB_DEFAULT_PORT).toBe(5190);
    expect(parseHubArgs([]).port).toBe(5190);
    expect(WHOLE_STORE_DEFAULT_PORT).toBe(5191);
  });

  it("rejects missing, unsupported, conflicting, duplicate, positional, and auth/Postgres flags", () => {
    const cases: ReadonlyArray<readonly [readonly string[], RegExp]> = [
      [["--backend"], /--backend requires a value/],
      [["--backend="], /--backend requires a value/],
      [["--backend=postgres"], /supports only "xdg"/],
      [["--store"], /--store requires a value/],
      [["--store="], /--store requires a value/],
      [["--store=/tmp/projects"], /--store requires --backend=xdg/],
      [
        ["--backend=xdg", "--mcp-url=http://127.0.0.1:7777/mcp"],
        /--mcp-url conflicts with --backend=xdg/,
      ],
      [["--backend=xdg", "projects"], /positional arguments are not accepted/],
      [["projects"], /positional arguments are not accepted/],
      [["--unknown"], /unrecognized option/],
      [["--token=secret"], /unrecognized option/],
      [["--pg-url=postgres://localhost/cq"], /unrecognized option/],
      [["--backend=xdg", "--backend=xdg"], /may be passed only once/],
      [["--port"], /--port requires a value/],
      [["--port=0"], /--port must be 1\.\.65535/],
      [["--host="], /--host requires a value/],
      [["--mcp-url="], /--mcp-url requires a value/],
      [["--cwd="], /--cwd requires a value/],
    ];

    for (const [argv, expected] of cases) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(expected);
    }
  });
});
