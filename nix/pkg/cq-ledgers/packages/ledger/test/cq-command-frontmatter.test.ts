import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

const CQ_COMMANDS_ROOT = path.resolve(import.meta.dir, "../../../../cq-assets/commands/cq");
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const BEGIN_ARGUMENT_HINT = "<mixed request>";
const BEGIN_DESCRIPTION =
  "Split a mixed request into plan, investigate, and research intakes, then run one sequencer pass.";
const IMPLEMENT_START_DESCRIPTION =
  "Resolve implementation scope, validate the initial task DAG, and run the implementation advance loop.";

interface DiscoveredCommand {
  readonly id: string;
  readonly frontmatter: Record<string, unknown>;
}

interface DiscoveryResult {
  readonly commands: ReadonlyMap<string, DiscoveredCommand>;
  readonly parseErrors: readonly string[];
}

function commandFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...commandFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function commandId(file: string): string {
  const relative = path.relative(CQ_COMMANDS_ROOT, file);
  return `cq:${relative.slice(0, -".md".length).split(path.sep).join(":")}`;
}

function discoverCommands(): DiscoveryResult {
  const commands = new Map<string, DiscoveredCommand>();
  const parseErrors: string[] = [];
  for (const file of commandFiles(CQ_COMMANDS_ROOT)) {
    const id = commandId(file);
    const source = readFileSync(file, "utf8");
    const match = FRONTMATTER.exec(source);
    if (match === null) {
      parseErrors.push(`${id}: missing leading YAML frontmatter`);
      continue;
    }
    try {
      const parsed = YAML.parse(match[1]!) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        parseErrors.push(`${id}: frontmatter must be a YAML map`);
        continue;
      }
      commands.set(id, { id, frontmatter: parsed as Record<string, unknown> });
    } catch (error) {
      parseErrors.push(`${id}: ${(error as Error).message}`);
    }
  }
  return { commands, parseErrors };
}

describe("Pi-compatible cq command frontmatter discovery", () => {
  const discovery = discoverCommands();

  it("parses every contributed cq command with Pi-compatible YAML semantics", () => {
    expect(discovery.parseErrors).toEqual([]);
  });

  it("discovers the formerly omitted commands with their exact metadata", () => {
    expect(discovery.commands.get("cq:begin")?.frontmatter).toEqual({
      description: BEGIN_DESCRIPTION,
      "argument-hint": BEGIN_ARGUMENT_HINT,
    });
    expect(discovery.commands.get("cq:implement:start")?.frontmatter).toEqual({
      description: IMPLEMENT_START_DESCRIPTION,
      "argument-hint": ["milestoneId ..."],
    });
  });
});
