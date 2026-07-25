import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as ledger from "../src/index.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import {
  SqliteXdgProjectIdentityAccess,
  type XdgProjectIdentity,
} from "../src/store/sqlite/projectIdentity.js";
import {
  FilesystemXdgProjectIdentityBackfillAccess,
  XdgProjectIdentityBackfill,
  XdgProjectIdentityBackfillBoundaryError,
  type XdgCheckoutResolution,
  type XdgProjectIdentityBackfillAccess,
  type XdgProjectIdentityBackfillAccessEvent,
  type XdgProjectIdentityBackfillAccessObserver,
  type XdgProjectIdentityBackfillRequest,
} from "../src/store/sqlite/xdgProjectIdentityBackfill.js";
import type {
  XdgProjectCatalogDiagnostic,
  XdgProjectCatalogEntry,
  XdgProjectCatalogResult,
} from "../src/store/sqlite/xdgProjectCatalog.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("XDG project identity backfill", () => {
  test("exports the bounded identity-backfill capability", () => {
    expect("backfillXdgProjectIdentities" in ledger).toBe(true);
  });

  for (const factory of [dummyFactory(), filesystemFactory()]) {
    describe(factory.name, () => {
      test("fills and refreshes matching readable identities with bounded, repeatable access", async () => {
        const fixture = await factory.build();
        const backfill = new XdgProjectIdentityBackfill(fixture.access);
        const fillIdentity = requiredIdentity(
          fixture.expectedIdentities,
          "fill-project",
        );
        const sharedIdentity = requiredIdentity(
          fixture.expectedIdentities,
          "shared-project",
        );

        const first = await backfill.run(fixture.request);

        expect(first.projects).toEqual([
          {
            projectKey: "fill-project",
            ...fillIdentity,
            status: "updated",
          },
          {
            projectKey: "shared-project",
            ...sharedIdentity,
            status: "updated",
          },
        ]);
        expect(first.diagnostics.map((entry) => entry.code)).toEqual([
          "duplicate-checkout",
          "not-repository",
          "stale-checkout",
          "unmatched-checkout",
          "unmatched-project",
        ]);
        expect(first.diagnostics.find((entry) => entry.code === "duplicate-checkout"))
          .toMatchObject({
            checkoutRoot: fixture.duplicateCheckoutRoot,
            projectKey: "shared-project",
        });
        expect(await fixture.readIdentity("fill-project")).toEqual(
          fillIdentity,
        );
        expect(await fixture.readIdentity("shared-project")).toEqual(
          sharedIdentity,
        );
        expect(await fixture.readIdentity("orphan-project")).toEqual(
          fixture.orphanIdentity,
        );
        expect(fixture.writtenProjectKeys()).toEqual([
          "fill-project",
          "shared-project",
        ]);

        const second = await backfill.run(fixture.request);
        expect(second.projects.map((entry) => entry.status)).toEqual([
          "unchanged",
          "unchanged",
        ]);

        const reversed = await backfill.run({
          projectsRoot: fixture.request.projectsRoot,
          checkoutRoots: [...fixture.request.checkoutRoots].reverse(),
        });
        expect(
          reversed.projects.find((entry) => entry.projectKey === "shared-project"),
        ).toMatchObject({
          repositoryPath: sharedIdentity.repositoryPath,
          displayName: sharedIdentity.displayName,
          status: "unchanged",
        });

        for (const event of fixture.accessEvents) {
          if (event.scope === "projects") {
            expect(isAtOrBeneath(event.path, fixture.request.projectsRoot)).toBe(true);
          } else {
            expect(
              fixture.request.checkoutRoots.some((checkoutRoot) =>
                isAtOrBeneath(event.path, checkoutRoot),
              ),
            ).toBe(true);
          }
        }
      });
    });
  }

  test("continues matching writes after one identity write fails", async () => {
    const projectsRoot = "/bounded/projects";
    const failingRoot = "/bounded/checkouts/failing";
    const succeedingRoot = "/bounded/checkouts/succeeding";
    const access = new DummyBackfillAccess(
      new Map([
        [
          failingRoot,
          resolved(failingRoot, "a-failing", {
            repositoryPath: failingRoot,
            displayName: "Failing",
          }),
        ],
        [
          succeedingRoot,
          resolved(succeedingRoot, "b-succeeding", {
            repositoryPath: succeedingRoot,
            displayName: "Succeeding",
          }),
        ],
      ]),
      catalog([
        catalogProject("a-failing", null),
        catalogProject("b-succeeding", null),
      ]),
      new Map(),
      new Set(["a-failing"]),
    );

    const result = await new XdgProjectIdentityBackfill(access).run({
      projectsRoot,
      checkoutRoots: [failingRoot, succeedingRoot],
    });

    expect(result.projects).toEqual([
      {
        projectKey: "b-succeeding",
        repositoryPath: succeedingRoot,
        displayName: "Succeeding",
        status: "updated",
      },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "write-failed",
        projectKey: "a-failing",
      }),
    ]);
    expect(access.writtenProjectKeys()).toEqual(["a-failing", "b-succeeding"]);
  });

  test("rejects non-absolute boundaries before touching an adapter", async () => {
    const access = new DummyBackfillAccess(
      new Map(),
      catalog([]),
      new Map(),
      new Set(),
    );
    const backfill = new XdgProjectIdentityBackfill(access);

    await expect(
      backfill.run({
        projectsRoot: "relative-projects",
        checkoutRoots: ["/checkout"],
      }),
    ).rejects.toBeInstanceOf(XdgProjectIdentityBackfillBoundaryError);
    await expect(
      backfill.run({
        projectsRoot: "/projects",
        checkoutRoots: ["relative-checkout"],
      }),
    ).rejects.toBeInstanceOf(XdgProjectIdentityBackfillBoundaryError);
    expect(access.events).toEqual([]);
  });
});

interface ContractFixture {
  readonly access: XdgProjectIdentityBackfillAccess;
  readonly request: XdgProjectIdentityBackfillRequest;
  readonly duplicateCheckoutRoot: string;
  readonly expectedIdentities: ReadonlyMap<string, XdgProjectIdentity>;
  readonly orphanIdentity: XdgProjectIdentity;
  readonly accessEvents: readonly XdgProjectIdentityBackfillAccessEvent[];
  readIdentity(projectKey: string): Promise<XdgProjectIdentity | null>;
  writtenProjectKeys(): readonly string[];
}

interface ContractFactory {
  readonly name: string;
  build(): Promise<ContractFixture>;
}

function dummyFactory(): ContractFactory {
  return {
    name: "hand-written dummy — Behavioral-Active Blackbox",
    async build(): Promise<ContractFixture> {
      const projectsRoot = "/bounded/projects";
      const winnerRoot = "/bounded/checkouts/a-shared";
      const duplicateRoot = "/bounded/checkouts/z-shared";
      const fillRoot = "/bounded/checkouts/fill";
      const staleRoot = "/bounded/checkouts/stale";
      const nonRepositoryRoot = "/bounded/checkouts/non-repository";
      const unmatchedRoot = "/bounded/checkouts/unmatched";
      const winnerIdentity = {
        repositoryPath: winnerRoot,
        displayName: "Shared winner",
      };
      const fillIdentity = {
        repositoryPath: fillRoot,
        displayName: "Filled project",
      };
      const orphanIdentity = {
        repositoryPath: "/retired/orphan",
        displayName: "Retired orphan",
      };
      const identities = new Map<string, XdgProjectIdentity>([
        [
          "shared-project",
          { repositoryPath: "/old/shared", displayName: "Old shared" },
        ],
        ["orphan-project", orphanIdentity],
      ]);
      const resolutions = new Map<string, XdgCheckoutResolution>([
        [
          winnerRoot,
          resolved(winnerRoot, "shared-project", winnerIdentity),
        ],
        [
          duplicateRoot,
          resolved(duplicateRoot, "shared-project", {
            repositoryPath: duplicateRoot,
            displayName: "Shared duplicate",
          }),
        ],
        [fillRoot, resolved(fillRoot, "fill-project", fillIdentity)],
        [
          staleRoot,
          {
            ok: false,
            checkoutRoot: staleRoot,
            code: "stale-checkout",
            message: "stale",
          },
        ],
        [
          nonRepositoryRoot,
          {
            ok: false,
            checkoutRoot: nonRepositoryRoot,
            code: "not-repository",
            message: "not repository",
          },
        ],
        [
          unmatchedRoot,
          resolved(unmatchedRoot, "unmatched-checkout", {
            repositoryPath: unmatchedRoot,
            displayName: "Unmatched checkout",
          }),
        ],
      ]);
      const access = new DummyBackfillAccess(
        resolutions,
        catalog([
          catalogProject("shared-project", identities.get("shared-project") ?? null),
          catalogProject("fill-project", null),
          catalogProject("orphan-project", orphanIdentity),
        ]),
        identities,
        new Set(),
      );
      return {
        access,
        request: {
          projectsRoot,
          checkoutRoots: [
            duplicateRoot,
            staleRoot,
            fillRoot,
            unmatchedRoot,
            nonRepositoryRoot,
            winnerRoot,
          ],
        },
        duplicateCheckoutRoot: duplicateRoot,
        expectedIdentities: new Map([
          ["fill-project", fillIdentity],
          ["shared-project", winnerIdentity],
        ]),
        orphanIdentity,
        accessEvents: access.events,
        readIdentity: async (key) => identities.get(key) ?? null,
        writtenProjectKeys: () => access.writtenProjectKeys(),
      };
    },
  };
}

function filesystemFactory(): ContractFactory {
  return {
    name: "filesystem + SQLite adapter — Behavioral-Active Blackbox",
    async build(): Promise<ContractFixture> {
      const root = await mkdtemp(path.join(tmpdir(), "t831-backfill-"));
      tempRoots.push(root);
      const projectsRoot = path.join(root, "projects");
      const checkoutsRoot = path.join(root, "checkouts");
      await mkdir(projectsRoot, { recursive: true });
      await mkdir(checkoutsRoot, { recursive: true });

      const winnerRoot = await seedCheckout(
        checkoutsRoot,
        "a-shared",
        "shared-project",
        "Shared winner",
      );
      const duplicateRoot = await seedCheckout(
        checkoutsRoot,
        "z-shared",
        "shared-project",
        "Shared duplicate",
      );
      const fillRoot = await seedCheckout(
        checkoutsRoot,
        "fill",
        "fill-project",
        "Filled project",
      );
      const unmatchedRoot = await seedCheckout(
        checkoutsRoot,
        "unmatched",
        "unmatched-checkout",
        "Unmatched checkout",
      );
      const nonRepositoryRoot = path.join(checkoutsRoot, "non-repository");
      await mkdir(nonRepositoryRoot);
      const staleRoot = path.join(checkoutsRoot, "stale");

      const winnerIdentity = {
        repositoryPath: await realpath(winnerRoot),
        displayName: "Shared winner",
      };
      const fillIdentity = {
        repositoryPath: await realpath(fillRoot),
        displayName: "Filled project",
      };
      const orphanIdentity = {
        repositoryPath: "/retired/orphan",
        displayName: "Retired orphan",
      };
      await seedProjectDatabase(projectsRoot, "shared-project", {
        repositoryPath: "/old/shared",
        displayName: "Old shared",
      });
      await seedProjectDatabase(projectsRoot, "fill-project", null);
      await seedProjectDatabase(projectsRoot, "orphan-project", orphanIdentity);

      const events: XdgProjectIdentityBackfillAccessEvent[] = [];
      const observer: XdgProjectIdentityBackfillAccessObserver = {
        record(event): void {
          events.push(event);
        },
      };
      const access = new FilesystemXdgProjectIdentityBackfillAccess(observer);
      const writtenKeys: string[] = [];
      const observedAccess: XdgProjectIdentityBackfillAccess = {
        resolveCheckout: (checkoutRoot) => access.resolveCheckout(checkoutRoot),
        discoverProjects: (rootPath) => access.discoverProjects(rootPath),
        async upsertProjectIdentity(rootPath, key, identity) {
          writtenKeys.push(key);
          return access.upsertProjectIdentity(rootPath, key, identity);
        },
      };
      return {
        access: observedAccess,
        request: {
          projectsRoot,
          checkoutRoots: [
            duplicateRoot,
            staleRoot,
            fillRoot,
            unmatchedRoot,
            nonRepositoryRoot,
            winnerRoot,
          ],
        },
        duplicateCheckoutRoot: duplicateRoot,
        expectedIdentities: new Map([
          ["fill-project", fillIdentity],
          ["shared-project", winnerIdentity],
        ]),
        orphanIdentity,
        accessEvents: events,
        readIdentity: (key) => readProjectIdentity(projectsRoot, key),
        writtenProjectKeys: () => [...new Set(writtenKeys)].sort(),
      };
    },
  };
}

class DummyBackfillAccess implements XdgProjectIdentityBackfillAccess {
  readonly events: XdgProjectIdentityBackfillAccessEvent[] = [];
  private readonly writes: string[] = [];

  constructor(
    private readonly resolutions: ReadonlyMap<string, XdgCheckoutResolution>,
    private readonly catalogResult: XdgProjectCatalogResult,
    private readonly identities: Map<string, XdgProjectIdentity>,
    private readonly failingProjectKeys: ReadonlySet<string>,
  ) {}

  async resolveCheckout(checkoutRoot: string): Promise<XdgCheckoutResolution> {
    this.events.push({ scope: "checkout", path: checkoutRoot });
    const resolution = this.resolutions.get(checkoutRoot);
    if (resolution === undefined) throw new Error(`unexpected checkout: ${checkoutRoot}`);
    return resolution;
  }

  async discoverProjects(projectsRoot: string): Promise<XdgProjectCatalogResult> {
    this.events.push({ scope: "projects", path: projectsRoot });
    return this.catalogResult;
  }

  async upsertProjectIdentity(
    projectsRoot: string,
    projectKey: string,
    identity: XdgProjectIdentity,
  ): Promise<boolean> {
    this.events.push({
      scope: "projects",
      path: path.join(projectsRoot, projectKey, "state", "ledger.db"),
    });
    this.writes.push(projectKey);
    if (this.failingProjectKeys.has(projectKey)) {
      throw new Error("injected write failure");
    }
    const current = this.identities.get(projectKey);
    if (
      current?.repositoryPath === identity.repositoryPath &&
      current.displayName === identity.displayName
    ) {
      return false;
    }
    this.identities.set(projectKey, identity);
    return true;
  }

  writtenProjectKeys(): readonly string[] {
    return [...new Set(this.writes)].sort();
  }
}

async function seedCheckout(
  checkoutsRoot: string,
  name: string,
  projectId: string,
  displayName: string,
): Promise<string> {
  const checkoutRoot = path.join(checkoutsRoot, name);
  await mkdir(checkoutRoot);
  execFileSync("git", ["init", "--quiet"], { cwd: checkoutRoot });
  await writeFile(
    path.join(checkoutRoot, "cq.toml"),
    `[project]\nname = ${JSON.stringify(displayName)}\n\n` +
      `[ledger]\nbackend = "xdg"\nprojectId = ${JSON.stringify(projectId)}\n`,
  );
  return checkoutRoot;
}

async function seedProjectDatabase(
  projectsRoot: string,
  projectKey: string,
  identity: XdgProjectIdentity | null,
): Promise<void> {
  const stateDir = path.join(projectsRoot, projectKey, "state");
  await mkdir(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "ledger.db");
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  await store.dispose();
  if (identity !== null) {
    const db = openLedgerDb(dbPath);
    try {
      new SqliteXdgProjectIdentityAccess(db).upsertProjectIdentity(identity);
    } finally {
      db.close();
    }
  }
}

async function readProjectIdentity(
  projectsRoot: string,
  projectKey: string,
): Promise<XdgProjectIdentity | null> {
  const db = openLedgerDb(
    path.join(projectsRoot, projectKey, "state", "ledger.db"),
  );
  try {
    return new SqliteXdgProjectIdentityAccess(db).readProjectIdentity();
  } finally {
    db.close();
  }
}

function resolved(
  checkoutRoot: string,
  projectKey: string,
  identity: XdgProjectIdentity,
): XdgCheckoutResolution {
  return {
    ok: true,
    checkout: { checkoutRoot, projectKey, identity },
  };
}

function catalog(
  projects: readonly XdgProjectCatalogEntry[],
  diagnostics: readonly XdgProjectCatalogDiagnostic[] = [],
): XdgProjectCatalogResult {
  return { projects, diagnostics };
}

function catalogProject(
  key: string,
  identity: XdgProjectIdentity | null,
): XdgProjectCatalogEntry {
  return {
    key,
    displayName: identity?.displayName ?? key,
    repositoryPath: identity?.repositoryPath ?? null,
    content: "bootstrap-only",
  };
}

function isAtOrBeneath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requiredIdentity(
  identities: ReadonlyMap<string, XdgProjectIdentity>,
  projectKey: string,
): XdgProjectIdentity {
  const identity = identities.get(projectKey);
  if (identity === undefined) {
    throw new Error(`missing expected identity for ${projectKey}`);
  }
  return identity;
}
