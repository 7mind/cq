/**
 * D571 — cohort witnesses and member relationships are not TypeScript-only.
 *
 * Every witness file used to be parsed as TSX and every relationship read
 * through `ts.preProcessFile`, so a Python, Rust, Go or JVM repository could
 * never supply a repository-derived cohort boundary. TS/JS keeps its precise
 * analysis; other files use the documented language-neutral rule.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "bun:test";
import { GitCohortLocalRepositoryV1, repositoryWitnessDeclaresSymbol } from "../src/workCohort.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Readonly<Record<string, string>>): Promise<GitCohortLocalRepositoryV1> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "cq-cohort-neutral-"));
  roots.push(repositoryRoot);
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
    await writeFile(join(repositoryRoot, path), bytes);
  }
  const git = async (...args: string[]) => await execFileAsync("git", args, { cwd: repositoryRoot });
  await git("init", "--quiet");
  await git("config", "user.name", "cq-test");
  await git("config", "user.email", "cq-test@localhost");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "fixture");
  return new GitCohortLocalRepositoryV1({ repositoryRoot, repositoryId: "repository:neutral" });
}

describe("D571 language-neutral cohort witnesses [Behavioral-Active Blackbox-Atomic]", () => {
  test.each([
    ["pricing.py", "def price(order):\n    return order.total\n", "price"],
    ["pricing.py", "class Pricing:\n    pass\n", "Pricing"],
    ["pricing.py", "RATE: float = 0.2\n", "RATE"],
    ["src/pricing.rs", "pub fn price(order: &Order) -> u64 {\n    order.total\n}\n", "price"],
    ["pricing/pricing.go", "func (p *Pricer) Price(o Order) int {\n\treturn o.Total\n}\n", "Price"],
    ["src/main/scala/Pricing.scala", "object Pricing {\n  def price(o: Order): Long = o.total\n}\n", "Pricing"],
    ["src/contracts/shared.ts", "export interface CohortContract { readonly version: 1 }\n", "CohortContract"],
  ])("%s declares %#", (path, source, symbol) => {
    expect(repositoryWitnessDeclaresSymbol(path, source, symbol)).toBe(true);
  });

  test.each([
    ["pricing.py", "# def price(order): commented out\nrate = 1\n", "price"],
    ["pricing.py", "total = price(order)\n", "price"],
    ["src/pricing.rs", "// pub fn price() {}\nfn other() {}\n", "price"],
    ["src/contracts/shared.ts", "// export interface CohortContract {}\nexport const actual = true;\n", "CohortContract"],
  ])("%s does not declare %#", (path, source, symbol) => {
    expect(repositoryWitnessDeclaresSymbol(path, source, symbol)).toBe(false);
  });

  test("relates non-JS sources that reference the target module", async () => {
    const repo = await repository({
      "pricing.py": "def price(order):\n    return order.total\n",
      "checkout.py": "from pricing import price\n\ndef checkout(order):\n    return price(order)\n",
      "tests/test_pricing.py": "from pricing import price\n",
      "src/pricing.rs": "pub fn price() -> u64 { 1 }\n",
      "src/main.rs": "mod pricing;\nuse crate::pricing::price;\n",
      "unrelated.py": "def other():\n    return 2\n",
    });
    const identity = await repo.resolveIdentity();
    expect(await repo.resolveRelationship(identity, "checkout.py", "pricing.py")).toBe("import");
    expect(await repo.resolveRelationship(identity, "tests/test_pricing.py", "pricing.py")).toBe("test");
    expect(await repo.resolveRelationship(identity, "src/main.rs", "src/pricing.rs")).toBe("import");
    expect(await repo.resolveRelationship(identity, "unrelated.py", "pricing.py")).toBeNull();
  });
});
