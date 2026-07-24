import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  NodePromptPublicationStore,
  checkLinks,
  linksFromCatalog,
  materializeClaudePrompts,
  validateRenderedClaudeRoot,
  type ClaudePromptRenderer,
  type PromptFile,
  type PromptPathKind,
  type PromptPublicationStore,
} from "./link-prompts.ts";

const OLD_TREE: readonly PromptFile[] = [
  {
    path: "catalog.json",
    content: JSON.stringify([
      {
        roleId: "begin",
        canonicalSource: "commands/cq/begin.md",
      },
      {
        roleId: "plan-advance",
        canonicalSource: "agents/plan-advance.md",
      },
    ]),
  },
  {
    path: "roles/begin.md",
    content: "---\ndescription: begin\n---\n\nOld begin $ARGUMENTS\n",
  },
  {
    path: "roles/plan-advance.md",
    content: "---\nname: plan-advance\n---\n\nOld planner\n",
  },
];

const NEW_TREE: readonly PromptFile[] = OLD_TREE.map((file) =>
  file.path === "roles/begin.md"
    ? { ...file, content: file.content.replace("Old begin", "New begin") }
    : file,
);

class StaticRenderer implements ClaudePromptRenderer {
  constructor(private readonly files: readonly PromptFile[]) {}

  async render(): Promise<readonly PromptFile[]> {
    return this.files;
  }
}

class FailingRenderer implements ClaudePromptRenderer {
  async render(): Promise<readonly PromptFile[]> {
    throw new Error("injected render failure");
  }
}

class GatedRenderer implements ClaudePromptRenderer {
  readonly entered: Promise<void>;
  private readonly gate: Promise<void>;
  private signalEntered!: () => void;
  private releaseGate!: () => void;

  constructor(private readonly files: readonly PromptFile[]) {
    this.entered = new Promise((resolve) => {
      this.signalEntered = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  async render(): Promise<readonly PromptFile[]> {
    this.signalEntered();
    await this.gate;
    return this.files;
  }

  release(): void {
    this.releaseGate();
  }
}

interface MemoryNode {
  readonly kind: "directory" | "file" | "symlink";
  readonly content?: string;
  readonly target?: string;
}

/** Hand-written strict in-memory dummy for the shared publication contract. */
class MemoryPromptPublicationStore implements PromptPublicationStore {
  private readonly nodes = new Map<string, MemoryNode>();
  private sequence = 0;

  constructor() {
    this.ensureDirectory("/");
  }

  private normalize(targetPath: string): string {
    return path.posix.resolve(targetPath);
  }

  private ensureDirectory(directory: string): void {
    const normalized = this.normalize(directory);
    if (normalized !== "/") {
      this.ensureDirectory(path.posix.dirname(normalized));
    }
    const existing = this.nodes.get(normalized);
    if (existing !== undefined && existing.kind !== "directory") {
      throw new Error(`not a directory: ${normalized}`);
    }
    this.nodes.set(normalized, { kind: "directory" });
  }

  private resolvedRoot(root: string): string {
    const normalized = this.normalize(root);
    const node = this.nodes.get(normalized);
    if (node?.kind !== "symlink") {
      return normalized;
    }
    return this.normalize(path.posix.resolve(path.posix.dirname(normalized), node.target));
  }

  putDirectory(directory: string): void {
    this.ensureDirectory(directory);
  }

  putFile(filePath: string, content: string): void {
    const normalized = this.normalize(filePath);
    this.ensureDirectory(path.posix.dirname(normalized));
    this.nodes.set(normalized, { kind: "file", content });
  }

  async acquirePublicationLock(generatedRoot: string): Promise<string> {
    this.ensureDirectory(generatedRoot);
    const lockPath = path.posix.join(generatedRoot, ".publication.lock");
    if (this.nodes.has(this.normalize(lockPath))) {
      throw new Error(
        `prompt publication lock exists at "${lockPath}"; another publisher is active or a stale lock requires manual removal`,
      );
    }
    this.ensureDirectory(lockPath);
    return lockPath;
  }

  async releasePublicationLock(lockPath: string): Promise<void> {
    await this.removeTree(lockPath);
  }

  async createStagingDirectory(generatedRoot: string): Promise<string> {
    this.ensureDirectory(generatedRoot);
    const staging = path.posix.join(this.normalize(generatedRoot), `.tmp-${++this.sequence}`);
    this.ensureDirectory(staging);
    return staging;
  }

  async writeTree(root: string, files: readonly PromptFile[]): Promise<void> {
    for (const file of files) {
      const destination = path.posix.join(this.normalize(root), file.path);
      if (this.nodes.has(destination)) {
        throw new Error(`path already exists: ${destination}`);
      }
      this.putFile(destination, file.content);
    }
  }

  async readTree(root: string): Promise<readonly PromptFile[]> {
    const normalized = this.resolvedRoot(root);
    if (this.nodes.get(normalized)?.kind !== "directory") {
      throw new Error(`not a directory: ${normalized}`);
    }
    const prefix = `${normalized}/`;
    return [...this.nodes.entries()]
      .filter(([nodePath, node]) => node.kind === "file" && nodePath.startsWith(prefix))
      .map(([nodePath, node]) => ({
        path: nodePath.slice(prefix.length),
        content: node.content as string,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async pathKind(targetPath: string): Promise<PromptPathKind> {
    const node = this.nodes.get(this.normalize(targetPath));
    if (node === undefined) return "missing";
    if (node.kind === "directory") return "directory";
    if (node.kind === "symlink") return "symlink";
    return "other";
  }

  async completeGeneration(source: string, destination: string): Promise<void> {
    const normalizedSource = this.normalize(source);
    const normalizedDestination = this.normalize(destination);
    if (this.nodes.has(normalizedDestination)) {
      throw new Error(`destination exists: ${normalizedDestination}`);
    }
    const moved = [...this.nodes.entries()].filter(
      ([nodePath]) => nodePath === normalizedSource || nodePath.startsWith(`${normalizedSource}/`),
    );
    if (moved.length === 0) {
      throw new Error(`source missing: ${normalizedSource}`);
    }
    for (const [nodePath] of moved) {
      this.nodes.delete(nodePath);
    }
    for (const [nodePath, node] of moved) {
      this.nodes.set(`${normalizedDestination}${nodePath.slice(normalizedSource.length)}`, node);
    }
  }

  async replaceSymlinkAtomic(linkPath: string, linkTarget: string): Promise<void> {
    const normalizedLink = this.normalize(linkPath);
    const kind = await this.pathKind(normalizedLink);
    if (kind !== "missing" && kind !== "symlink") {
      throw new Error(`refusing to replace non-symlink ${normalizedLink}`);
    }
    this.ensureDirectory(path.posix.dirname(normalizedLink));
    this.nodes.set(normalizedLink, {
      kind: "symlink",
      target: linkTarget,
    });
  }

  async readLink(linkPath: string): Promise<string> {
    const node = this.nodes.get(this.normalize(linkPath));
    if (node?.kind !== "symlink") {
      throw new Error(`not a symlink: ${linkPath}`);
    }
    return node.target as string;
  }

  async listDirectory(directory: string): Promise<readonly string[]> {
    const normalized = this.normalize(directory);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const children = new Set<string>();
    for (const nodePath of this.nodes.keys()) {
      if (!nodePath.startsWith(prefix)) continue;
      const relative = nodePath.slice(prefix.length);
      if (relative !== "") {
        children.add(relative.split("/")[0] as string);
      }
    }
    return [...children].sort();
  }

  async removeTree(targetPath: string): Promise<void> {
    const normalized = this.normalize(targetPath);
    for (const nodePath of [...this.nodes.keys()]) {
      if (nodePath === normalized || nodePath.startsWith(`${normalized}/`)) {
        this.nodes.delete(nodePath);
      }
    }
  }
}

class OneShotFailingSymlinkStore implements PromptPublicationStore {
  private armed = true;

  constructor(
    private readonly delegate: PromptPublicationStore,
    private readonly failedPath: string,
    private readonly failAfterReplacement = false,
  ) {}

  acquirePublicationLock(generatedRoot: string): Promise<string> {
    return this.delegate.acquirePublicationLock(generatedRoot);
  }

  releasePublicationLock(lockPath: string): Promise<void> {
    return this.delegate.releasePublicationLock(lockPath);
  }

  createStagingDirectory(generatedRoot: string): Promise<string> {
    return this.delegate.createStagingDirectory(generatedRoot);
  }

  writeTree(root: string, files: readonly PromptFile[]): Promise<void> {
    return this.delegate.writeTree(root, files);
  }

  readTree(root: string): Promise<readonly PromptFile[]> {
    return this.delegate.readTree(root);
  }

  pathKind(targetPath: string): Promise<PromptPathKind> {
    return this.delegate.pathKind(targetPath);
  }

  completeGeneration(source: string, destination: string): Promise<void> {
    return this.delegate.completeGeneration(source, destination);
  }

  async replaceSymlinkAtomic(linkPath: string, targetPath: string): Promise<void> {
    if (this.armed && linkPath === this.failedPath) {
      this.armed = false;
      if (this.failAfterReplacement) {
        await this.delegate.replaceSymlinkAtomic(linkPath, targetPath);
      }
      throw new Error("injected symlink replacement failure");
    }
    await this.delegate.replaceSymlinkAtomic(linkPath, targetPath);
  }

  readLink(linkPath: string): Promise<string> {
    return this.delegate.readLink(linkPath);
  }

  listDirectory(directory: string): Promise<readonly string[]> {
    return this.delegate.listDirectory(directory);
  }

  removeTree(targetPath: string): Promise<void> {
    return this.delegate.removeTree(targetPath);
  }
}

interface PublicationHarness {
  readonly store: PromptPublicationStore;
  readonly ledgersRoot: string;
  readonly generatedRoot: string;
  putDirectory(directory: string): Promise<void>;
  putFile(filePath: string, content: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  readLink(linkPath: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function makeRealHarness(): Promise<PublicationHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "cq-link-prompts-"));
  const store = new NodePromptPublicationStore();
  const ledgersRoot = path.join(root, "nix", "pkg", "cq-ledgers");
  const generatedRoot = path.join(root, "nix", "pkg", "cq-assets", ".generated", "claude");
  await mkdir(ledgersRoot, { recursive: true });
  return {
    store,
    ledgersRoot,
    generatedRoot,
    putDirectory: (directory) => mkdir(directory, { recursive: true }),
    putFile: async (filePath, content) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    },
    readFile: (filePath) => readFile(filePath, "utf8"),
    readLink: (linkPath) => store.readLink(linkPath),
    cleanup: async () => {
      await new NodePromptPublicationStore().removeTree(root);
    },
  };
}

async function makeMemoryHarness(): Promise<PublicationHarness> {
  const store = new MemoryPromptPublicationStore();
  const ledgersRoot = "/fixture/nix/pkg/cq-ledgers";
  const generatedRoot = "/fixture/nix/pkg/cq-assets/.generated/claude";
  store.putDirectory(ledgersRoot);
  return {
    store,
    ledgersRoot,
    generatedRoot,
    putDirectory: async (directory) => store.putDirectory(directory),
    putFile: async (filePath, content) => store.putFile(filePath, content),
    readFile: async (filePath) => {
      const root = path.posix.dirname(filePath);
      const file = (await store.readTree(root)).find(
        (entry) => entry.path === path.posix.basename(filePath),
      );
      if (file === undefined) throw new Error(`missing file: ${filePath}`);
      return file.content;
    },
    readLink: (linkPath) => store.readLink(linkPath),
    cleanup: async () => {},
  };
}

function currentPath(harness: PublicationHarness): string {
  return path.join(harness.generatedRoot, "current");
}

function absoluteLinkTarget(linkPath: string, target: string): string {
  return path.resolve(path.dirname(linkPath), target);
}

function publish(
  harness: PublicationHarness,
  renderer: ClaudePromptRenderer,
  store: PromptPublicationStore = harness.store,
) {
  return materializeClaudePrompts({
    store,
    renderer,
    ledgersRoot: harness.ledgersRoot,
    generatedRoot: harness.generatedRoot,
  });
}

function publicationContract(
  adapterName: string,
  makeHarness: () => Promise<PublicationHarness>,
): void {
  // Memory leg: Behavioral-Active Blackbox-Atomic.
  // Real leg: Behavioral-Active Effectual-GoodCommunication.
  describe(`prompt publication contract (${adapterName})`, () => {
    let harness: PublicationHarness;

    beforeEach(async () => {
      harness = await makeHarness();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    test("publishes one content-addressed tree and links only through current", async () => {
      const result = await publish(harness, new StaticRenderer(OLD_TREE));

      expect(path.basename(result.generation)).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(await harness.store.pathKind(result.generation)).toBe("directory");
      expect(
        absoluteLinkTarget(currentPath(harness), await harness.readLink(currentPath(harness))),
      ).toBe(result.generation);
      expect(await harness.store.readTree(result.generation)).toEqual(OLD_TREE);

      for (const link of result.links) {
        expect(link.source).toStartWith("../cq-assets/.generated/claude/current/roles/");
        const absoluteLink = path.join(harness.ledgersRoot, link.link);
        expect(absoluteLinkTarget(absoluteLink, await harness.readLink(absoluteLink))).toBe(
          path.join(harness.ledgersRoot, link.source),
        );
      }
    });

    test("reuses identical content and cleans stale artifacts only after success", async () => {
      const staleGeneration = path.join(harness.generatedRoot, `sha256-${"a".repeat(64)}`);
      const staleTemp = path.join(harness.generatedRoot, ".tmp-stale");
      await harness.putDirectory(staleGeneration);
      await harness.putDirectory(staleTemp);

      const first = await publish(harness, new StaticRenderer(OLD_TREE));
      const second = await publish(harness, new StaticRenderer(OLD_TREE));

      expect(second.generation).toBe(first.generation);
      expect((await harness.store.listDirectory(harness.generatedRoot)).sort()).toEqual([
        "current",
        path.basename(first.generation),
      ]);
    });

    for (const [label, contenderTree] of [
      ["identical content", OLD_TREE],
      ["different content", NEW_TREE],
    ] as const) {
      test(`fails fast without disturbing an active ${label} publication`, async () => {
        const gatedRenderer = new GatedRenderer(OLD_TREE);
        const activePublication = publish(harness, gatedRenderer);
        await gatedRenderer.entered;
        let activeResult!: Awaited<ReturnType<typeof publish>>;

        try {
          const before = await harness.store.listDirectory(harness.generatedRoot);
          expect(before).toContain(".publication.lock");
          expect(before.filter((entry) => entry.startsWith(".tmp-"))).toHaveLength(1);

          await expect(publish(harness, new StaticRenderer(contenderTree))).rejects.toThrow(
            "another publisher is active or a stale lock",
          );
          expect(await harness.store.listDirectory(harness.generatedRoot)).toEqual(before);
        } finally {
          gatedRenderer.release();
          activeResult = await activePublication;
        }

        expect(await harness.store.pathKind(activeResult.generation)).toBe("directory");
        expect(await harness.store.listDirectory(harness.generatedRoot)).not.toContain(
          ".publication.lock",
        );
      });
    }

    test("does not reclaim a stale publication lock automatically", async () => {
      const lockPath = path.join(harness.generatedRoot, ".publication.lock");
      await harness.putDirectory(lockPath);

      await expect(publish(harness, new StaticRenderer(OLD_TREE))).rejects.toThrow(
        "a stale lock requires manual removal",
      );
      expect(await harness.store.pathKind(lockPath)).toBe("directory");
      expect(await harness.store.listDirectory(harness.generatedRoot)).toEqual([
        ".publication.lock",
      ]);
    });

    test("render failure preserves the old pointer and leaves stale artifacts untouched", async () => {
      await expect(publish(harness, new FailingRenderer())).rejects.toThrow(
        "injected render failure",
      );
      expect(await harness.store.pathKind(currentPath(harness))).toBe("missing");
      expect(await harness.store.listDirectory(harness.generatedRoot)).toEqual([]);

      const first = await publish(harness, new StaticRenderer(OLD_TREE));
      const staleTemp = path.join(harness.generatedRoot, ".tmp-stale");
      await harness.putDirectory(staleTemp);
      const oldPointer = await harness.readLink(currentPath(harness));

      await expect(publish(harness, new FailingRenderer())).rejects.toThrow(
        "injected render failure",
      );

      expect(await harness.readLink(currentPath(harness))).toBe(oldPointer);
      expect(await harness.store.pathKind(first.generation)).toBe("directory");
      expect(
        (await harness.store.listDirectory(harness.generatedRoot)).filter((entry) =>
          entry.startsWith(".tmp-"),
        ),
      ).toEqual([".tmp-stale"]);
    });

    test("validation failure preserves an old pointer or creates no first pointer", async () => {
      const invalidTree = NEW_TREE.map((file) =>
        file.path === "roles/begin.md"
          ? { ...file, content: `${file.content}${SLOT_FIXTURE}` }
          : file,
      );
      await expect(publish(harness, new StaticRenderer(invalidTree))).rejects.toThrow(
        "contains an unresolved slot",
      );

      expect(await harness.store.pathKind(currentPath(harness))).toBe("missing");
      expect(
        await harness.store.pathKind(
          path.join(harness.ledgersRoot, ".claude/commands/cq/begin.md"),
        ),
      ).toBe("missing");
      expect(await harness.store.listDirectory(harness.generatedRoot)).toEqual([]);

      const first = await publish(harness, new StaticRenderer(OLD_TREE));
      const oldPointer = await harness.readLink(currentPath(harness));
      await expect(publish(harness, new StaticRenderer(invalidTree))).rejects.toThrow(
        "contains an unresolved slot",
      );
      expect(await harness.readLink(currentPath(harness))).toBe(oldPointer);
      expect(await harness.store.pathKind(first.generation)).toBe("directory");
      expect(
        (await harness.store.listDirectory(harness.generatedRoot)).filter((entry) =>
          entry.startsWith(".tmp-"),
        ),
      ).toEqual([]);
    });

    test("switch failure preserves an old pointer and never publishes new links", async () => {
      const first = await publish(harness, new StaticRenderer(OLD_TREE));
      const oldPointer = await harness.readLink(currentPath(harness));
      const beginLink = path.join(harness.ledgersRoot, ".claude/commands/cq/begin.md");
      const oldLink = await harness.readLink(beginLink);
      const failingStore = new OneShotFailingSymlinkStore(harness.store, currentPath(harness));

      await expect(publish(harness, new StaticRenderer(NEW_TREE), failingStore)).rejects.toThrow(
        "injected symlink replacement failure",
      );

      expect(await harness.readLink(currentPath(harness))).toBe(oldPointer);
      expect(await harness.readLink(beginLink)).toBe(oldLink);
      expect(await harness.store.pathKind(first.generation)).toBe("directory");
      expect(
        (await harness.store.listDirectory(harness.generatedRoot)).filter((entry) =>
          entry.startsWith(".tmp-"),
        ),
      ).toEqual([]);
    });

    test("switch failure creates no first pointer", async () => {
      const failingStore = new OneShotFailingSymlinkStore(harness.store, currentPath(harness));
      await expect(publish(harness, new StaticRenderer(OLD_TREE), failingStore)).rejects.toThrow(
        "injected symlink replacement failure",
      );

      expect(await harness.store.pathKind(currentPath(harness))).toBe("missing");
      expect(
        await harness.store.pathKind(
          path.join(harness.ledgersRoot, ".claude/commands/cq/begin.md"),
        ),
      ).toBe("missing");
      expect(
        (await harness.store.listDirectory(harness.generatedRoot)).filter((entry) =>
          entry.startsWith(".tmp-"),
        ),
      ).toEqual([]);
    });

    test("rolls back the exact prior pointer and links after every prompt-link failure", async () => {
      await publish(harness, new StaticRenderer(OLD_TREE));
      const promptLinks = linksFromCatalog(validateRenderedClaudeRoot(OLD_TREE));
      const linkPaths = promptLinks.map((link) => path.join(harness.ledgersRoot, link.link));
      await harness.store.replaceSymlinkAtomic(
        currentPath(harness),
        `./${await harness.readLink(currentPath(harness))}`,
      );
      for (const linkPath of linkPaths) {
        await harness.store.replaceSymlinkAtomic(linkPath, `./${await harness.readLink(linkPath)}`);
      }
      const oldPointer = await harness.readLink(currentPath(harness));
      const oldLinks = await Promise.all(linkPaths.map((linkPath) => harness.readLink(linkPath)));

      for (const failedPath of linkPaths) {
        await expect(
          publish(
            harness,
            new StaticRenderer(NEW_TREE),
            new OneShotFailingSymlinkStore(harness.store, failedPath, true),
          ),
        ).rejects.toThrow("injected symlink replacement failure");

        expect(await harness.readLink(currentPath(harness))).toBe(oldPointer);
        expect(await Promise.all(linkPaths.map((linkPath) => harness.readLink(linkPath)))).toEqual(
          oldLinks,
        );
        expect(await harness.store.readTree(currentPath(harness))).toEqual(OLD_TREE);
      }
    });

    test("removes the first pointer and every link after each prompt-link failure", async () => {
      const promptLinks = linksFromCatalog(validateRenderedClaudeRoot(OLD_TREE));
      const linkPaths = promptLinks.map((link) => path.join(harness.ledgersRoot, link.link));

      for (const failedPath of linkPaths) {
        await expect(
          publish(
            harness,
            new StaticRenderer(OLD_TREE),
            new OneShotFailingSymlinkStore(harness.store, failedPath, true),
          ),
        ).rejects.toThrow("injected symlink replacement failure");

        expect(await harness.store.pathKind(currentPath(harness))).toBe("missing");
        expect(
          await Promise.all(linkPaths.map((linkPath) => harness.store.pathKind(linkPath))),
        ).toEqual(linkPaths.map(() => "missing"));
      }
    });

    test("rejects an ordinary link path before switching or changing any link", async () => {
      const rejectedLink = path.join(harness.ledgersRoot, ".claude/commands/cq/begin.md");
      await harness.putFile(rejectedLink, "human-owned");

      await expect(publish(harness, new StaticRenderer(OLD_TREE))).rejects.toThrow(
        "refusing to replace non-symlink .claude/commands/cq/begin.md",
      );

      expect(await harness.readFile(rejectedLink)).toBe("human-owned");
      expect(await harness.store.pathKind(currentPath(harness))).toBe("missing");
      expect(
        await harness.store.pathKind(
          path.join(harness.ledgersRoot, ".claude/agents/plan-advance.md"),
        ),
      ).toBe("missing");
      expect(await harness.store.listDirectory(harness.generatedRoot)).toEqual([]);
    });
  });
}

const SLOT_FIXTURE = "{{cq:fragment:cq-command-invocation}}";

publicationContract("memory dummy", makeMemoryHarness);
publicationContract("real temporary filesystem", makeRealHarness);

describe("rendered Claude root validation", () => {
  test("requires the exact catalog-declared role set", () => {
    expect(() =>
      validateRenderedClaudeRoot(OLD_TREE.filter((file) => file.path !== "roles/begin.md")),
    ).toThrow('rendered prompt root is missing "roles/begin.md"');
    expect(() =>
      validateRenderedClaudeRoot([
        ...OLD_TREE,
        { path: "roles/undeclared.md", content: "unexpected" },
      ]),
    ).toThrow('rendered prompt root contains undeclared file "roles/undeclared.md"');
  });

  test("projects every link through current rather than canonical Markdown", () => {
    const links = linksFromCatalog(validateRenderedClaudeRoot(OLD_TREE));
    expect(links).toEqual([
      {
        link: ".claude/commands/cq/begin.md",
        source: "../cq-assets/.generated/claude/current/roles/begin.md",
      },
      {
        link: ".claude/agents/plan-advance.md",
        source: "../cq-assets/.generated/claude/current/roles/plan-advance.md",
      },
    ]);
  });
});

describe("NodePromptPublicationStore atomic symlink semantics", () => {
  // Targeted Behavioral-Active Effectual-GoodCommunication coverage for the
  // POSIX rename-over-symlink guarantee intentionally omitted from the dummy.
  test("atomically replaces an existing symlink without leaving a temp link", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-link-swap-"));
    const store = new NodePromptPublicationStore();
    try {
      const link = path.join(root, "current");
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      await mkdir(first);
      await mkdir(second);

      await store.replaceSymlinkAtomic(link, first);
      await store.replaceSymlinkAtomic(link, second);

      expect(absoluteLinkTarget(link, await store.readLink(link))).toBe(second);
      expect(await store.listDirectory(root)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".cq-prompt-link-")]),
      );
    } finally {
      await store.removeTree(root);
    }
  });

  test("publishes generation directories and files without write permission", async () => {
    const harness = await makeRealHarness();
    try {
      const result = await publish(harness, new StaticRenderer(OLD_TREE));
      const directories = [result.generation, path.join(result.generation, "roles")];
      const files = [
        path.join(result.generation, "catalog.json"),
        path.join(result.generation, "roles", "begin.md"),
        path.join(result.generation, "roles", "plan-advance.md"),
      ];

      for (const targetPath of [...directories, ...files]) {
        expect((await stat(targetPath)).mode & 0o222).toBe(0);
      }
      await expect(writeFile(files[0]!, "mutation", "utf8")).rejects.toMatchObject({
        code: "EACCES",
      });
      await expect(
        writeFile(path.join(result.generation, "undeclared.md"), "mutation", "utf8"),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await harness.cleanup();
    }
  });
});

describe("prompt publication review reproductions", () => {
  test("restores the prior current pointer when the first prompt link fails", async () => {
    const harness = await makeRealHarness();
    try {
      await publish(harness, new StaticRenderer(OLD_TREE));
      const oldPointer = await harness.readLink(currentPath(harness));
      const failedLink = path.join(harness.ledgersRoot, ".claude/commands/cq/begin.md");

      await expect(
        publish(
          harness,
          new StaticRenderer(NEW_TREE),
          new OneShotFailingSymlinkStore(harness.store, failedLink, true),
        ),
      ).rejects.toThrow("injected symlink replacement failure");

      expect(await harness.readLink(currentPath(harness))).toBe(oldPointer);
    } finally {
      await harness.cleanup();
    }
  });

  test("checkLinks rejects a missing catalog link even when its source exists", async () => {
    const harness = await makeRealHarness();
    try {
      const result = await publish(harness, new StaticRenderer(OLD_TREE));
      await harness.store.removeTree(path.join(harness.ledgersRoot, result.links[0]!.link));

      expect(await checkLinks(result.links, harness.ledgersRoot)).toEqual([
        expect.objectContaining({
          link: result.links[0]!.link,
          reason: "link-missing",
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("checkLinks rejects a symlink with the wrong target", async () => {
    const harness = await makeRealHarness();
    try {
      const result = await publish(harness, new StaticRenderer(OLD_TREE));
      const checkedLink = result.links[0]!;
      await harness.store.replaceSymlinkAtomic(
        path.join(harness.ledgersRoot, checkedLink.link),
        path.join(harness.ledgersRoot, result.links[1]!.source),
      );

      expect(await checkLinks(result.links, harness.ledgersRoot)).toEqual([
        expect.objectContaining({
          link: checkedLink.link,
          reason: "target-mismatch",
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("checkLinks rejects an ordinary file at a catalog link path", async () => {
    const harness = await makeRealHarness();
    try {
      const result = await publish(harness, new StaticRenderer(OLD_TREE));
      const checkedLink = result.links[0]!;
      const absoluteLink = path.join(harness.ledgersRoot, checkedLink.link);
      await harness.store.removeTree(absoluteLink);
      await harness.putFile(absoluteLink, "not a link");

      expect(await checkLinks(result.links, harness.ledgersRoot)).toEqual([
        expect.objectContaining({
          link: checkedLink.link,
          reason: "link-not-symlink",
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});
