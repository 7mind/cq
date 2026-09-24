/**
 * D539 snapshot ref: the script must resolve a clean tree to HEAD and a dirty
 * tree to a commit of the working tree's tracked content.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "..", "..", "..", "scripts", "working-tree-flake-ref.sh");
const SCRIPT_IN_REPOSITORY = path.join("nix", "pkg", "cq-ledgers", "scripts", "working-tree-flake-ref.sh");
const TRACKED_FILE = "tracked.txt";
const PAST_MTIME = new Date("2001-01-01T00:00:00Z");
const repositories: string[] = [];

afterAll(async () => {
  await Promise.all(repositories.map((root) => fs.rm(root, { recursive: true, force: true })));
});

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function makeRepository(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "working-tree-flake-ref-")));
  repositories.push(root);
  const scriptCopy = path.join(root, SCRIPT_IN_REPOSITORY);
  await fs.mkdir(path.dirname(scriptCopy), { recursive: true });
  await fs.copyFile(SCRIPT, scriptCopy);
  await fs.writeFile(path.join(root, TRACKED_FILE), "original\n", "utf8");
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=D539", "-c", "user.email=d539@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  return root;
}

function flakeRef(root: string): { readonly repository: string; readonly revision: string } {
  const output = execFileSync(path.join(root, SCRIPT_IN_REPOSITORY), { encoding: "utf8" }).trim();
  const match = /^git\+file:\/\/(.+)\?rev=([0-9a-f]{40})$/.exec(output);
  if (match === null) throw new Error(`unexpected flake ref: ${output}`);
  return { repository: match[1]!, revision: match[2]! };
}

describe("working-tree flake ref", () => {
  test("resolves a clean tree to HEAD", async () => {
    const root = await makeRepository();
    expect(flakeRef(root)).toEqual({ repository: root, revision: git(root, ["rev-parse", "HEAD"]) });
  });

  test("resolves a tree whose tracked file changed only its mtime to HEAD", async () => {
    const root = await makeRepository();
    await fs.utimes(path.join(root, TRACKED_FILE), PAST_MTIME, PAST_MTIME);
    expect(flakeRef(root)).toEqual({ repository: root, revision: git(root, ["rev-parse", "HEAD"]) });
  });

  test("resolves a dirty tree to a commit of its tracked content without touching refs or the index", async () => {
    const root = await makeRepository();
    await fs.writeFile(path.join(root, TRACKED_FILE), "changed\n", "utf8");
    const refsBefore = git(root, ["for-each-ref"]);
    const { revision } = flakeRef(root);
    expect(revision).not.toBe(git(root, ["rev-parse", "HEAD"]));
    expect(git(root, ["show", `${revision}:${TRACKED_FILE}`])).toBe("changed");
    expect(git(root, ["for-each-ref"])).toBe(refsBefore);
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("");
  });
});
