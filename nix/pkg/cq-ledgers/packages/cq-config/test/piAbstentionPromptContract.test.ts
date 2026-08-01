import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

type PayloadKind = "candidate" | "verdict";

interface NormativeSite {
  readonly name: string;
  readonly command: "implement/advance" | "plan/advance";
  readonly marker: string;
  readonly payloadKind: PayloadKind;
}

const NORMATIVE_SITES: readonly NormativeSite[] = [
  {
    name: "implement reviewer usable verdict",
    command: "implement/advance",
    marker: "**External reviewer usable-verdict rule.**",
    payloadKind: "verdict",
  },
  {
    name: "implement reviewer no-timeout restatement",
    command: "implement/advance",
    marker: "**External reviewer no-timeout rule.**",
    payloadKind: "verdict",
  },
  {
    name: "plan candidate usable candidate",
    command: "plan/advance",
    marker: "**Candidate usable-payload rule.**",
    payloadKind: "candidate",
  },
  {
    name: "plan candidate no-timeout restatement",
    command: "plan/advance",
    marker: "**Candidate no-timeout rule.**",
    payloadKind: "candidate",
  },
  {
    name: "plan configured reviewer wrapper",
    command: "plan/advance",
    marker: "**Configured reviewer wrapper rule.**",
    payloadKind: "verdict",
  },
  {
    name: "plan reviewer usable verdict",
    command: "plan/advance",
    marker: "**Reviewer usable-verdict rule.**",
    payloadKind: "verdict",
  },
];

function commandBytes(command: NormativeSite["command"]): string {
  return readFileSync(
    path.join(REPO_ROOT, "nix", "pkg", "cq-assets", "commands", "cq", `${command}.md`),
    "utf8",
  );
}

function extractStatement(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`missing normative statement ${marker}`);
  const end = source.indexOf("\n\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

function requiredQualification(payloadKind: PayloadKind): RegExp {
  return new RegExp(
    `Fence-strip\\s+and\\s+validate\\s+stdout\\s+first\\.\\s+A\\s+complete,\\s+parseable\\s+${payloadKind}\\s+` +
      `counts\\s+as\\s+a\\s+(?:usable\\s+${payloadKind}|vote)\\s+despite\\s+a\\s+non-zero\\s+shell\\s+exit;\\s+log\\s+that\\s+exit\\s+anomaly\\.`,
  );
}

function qualifies(statement: string, payloadKind: PayloadKind): boolean {
  return requiredQualification(payloadKind).test(statement);
}

test("pi shellout abstention statements preserve valid stdout across non-zero exits", () => {
  const sources = new Map<NormativeSite["command"], string>([
    ["implement/advance", commandBytes("implement/advance")],
    ["plan/advance", commandBytes("plan/advance")],
  ]);
  const extracted = NORMATIVE_SITES.map((site) => ({
    site,
    statement: extractStatement(sources.get(site.command)!, site.marker),
  }));

  expect(extracted.map(({ site }) => site.name)).toEqual([
    "implement reviewer usable verdict",
    "implement reviewer no-timeout restatement",
    "plan candidate usable candidate",
    "plan candidate no-timeout restatement",
    "plan configured reviewer wrapper",
    "plan reviewer usable verdict",
  ]);
  for (const { site, statement } of extracted) {
    expect(qualifies(statement, site.payloadKind), site.name).toBe(true);
  }

  for (const { site, statement } of extracted) {
    const mutatedSource = sources
      .get(site.command)!
      .replace(statement, statement.replace(requiredQualification(site.payloadKind), ""));
    const mutatedStatement = extractStatement(mutatedSource, site.marker);
    expect(qualifies(mutatedStatement, site.payloadKind), `${site.name} negative control`).toBe(false);
  }
});
