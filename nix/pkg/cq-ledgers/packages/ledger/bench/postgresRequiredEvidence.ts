export interface PostgresCaseEvidence {
  readonly cases: number;
  readonly postgresCases: number;
  readonly postgresSkipped: number;
  readonly postgresInapplicable: readonly PostgresInapplicableCase[];
}

interface PostgresInapplicableCase {
  readonly file: string;
  readonly suite: string;
  readonly name: string;
  readonly reason: "retired-public-backend" | "dummy-only-protocol-control";
}

// Q406 approves only these cells, not whole files, retired suites, or environmental skips.
const INAPPLICABLE_CELLS: readonly PostgresInapplicableCase[] = [
  {
    file: "packages/ledger/test/backup-exporter.test.ts",
    suite: "backup exporter — T582 public postgres backend retired (T736)",
    reason: "retired-public-backend" as const,
    names: [
      'backup="in-tree": a mutation produces a parseable .cq/ dump carrying every tenant log artifact byte-identically',
      'backup="orphan-branch": the dump lands as a commit on the configured ref with the same tenant .cq/logs/** bytes',
      "default config (backup=none): NOTHING is written in-tree or to any ref; no scheduler is constructed",
    ],
  },
  {
    file: "packages/ledger-tui/test/embeddedPostgres.test.tsx",
    suite: "embedded ledger-tui over backend='postgres' retired (T736)",
    reason: "retired-public-backend" as const,
    names: [
      "McpLedgerClient.embedded resolves backend='postgres' with a live pg handle",
      "<App> renders against the postgres-backed embedded store — lists the canonical ledgers",
      "<App> creates an item through the postgres store and shows it in the list",
    ],
  },
  {
    file: "packages/ledger/test/create-ledger-store-project-identity.test.ts",
    suite: "live PostgreSQL exclusion retired with public backend (T736)",
    reason: "retired-public-backend" as const,
    names: ["does not write XDG identity metadata for a successful PostgreSQL open"],
  },
  {
    file: "packages/ledger/test/remote-ledger-client-contract.test.ts",
    suite: "RemoteLedgerClient contract — real cq serve/PostgreSQL hub (Behavioral-Active Blackbox-GoodCommunication)",
    reason: "dummy-only-protocol-control" as const,
    names: [
      "fails loud with RemoteProtocolError when the service negotiates an unsupported protocol version",
      "fails loud with RemoteMalformedResponseError on a malformed tool result, then recovers",
    ],
  },
].flatMap(({ names, ...identity }) => names.map((name) => ({ ...identity, name })));

function inapplicableCell(file: string, suite: string, name: string): PostgresInapplicableCase | undefined {
  return INAPPLICABLE_CELLS.find((cell) => cell.file === file && cell.suite === suite && cell.name === name);
}

const POSTGRES_IDENTITY = /\b(?:postgres(?:ql)?|pg)\b/i;

function attributes(source: string): Map<string, string> {
  const entities: Readonly<Record<string, string>> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return new Map([...source.matchAll(/([\w:-]+)="([^"]*)"/g)]
    .map((match) => [match[1]!, match[2]!.replace(/&(amp|quot|apos|lt|gt);/g, (_entity, name: string) => entities[name]!)]));
}

/** Reads the structural tags emitted by Bun's JUnit reporter; failure text is not evidence. */
export function postgresEvidenceFromJunit(xml: string): PostgresCaseEvidence {
  const structural = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const suites: { name: string; file: string }[] = [];
  let current: { postgres: boolean; skipped: boolean; inapplicable: PostgresInapplicableCase | undefined } | null = null;
  let declaredCases: number | null = null;
  let closed = false;
  let cases = 0;
  let postgresCases = 0;
  let postgresSkipped = 0;
  const postgresInapplicable: PostgresInapplicableCase[] = [];
  const complete = () => {
    if (current === null) throw new Error("JUnit testcase close without an open testcase");
    cases++;
    if (current.inapplicable !== undefined) {
      if (!current.skipped) throw new Error("inapplicable PostgreSQL cell executed; review its applicability before counting coverage");
      postgresInapplicable.push(current.inapplicable);
    } else if (current.postgres) {
      if (current.skipped) postgresSkipped++;
      else postgresCases++;
    }
    current = null;
  };
  for (const token of structural.matchAll(/<(\/?)([\w:-]+)\b((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    const closing = token[1] === "/";
    const name = token[2]!;
    const attrs = attributes(token[3]!);
    const selfClosing = token[4] === "/";
    if (name === "testsuites") {
      if (closing) closed = true;
      else {
        if (declaredCases !== null) throw new Error("JUnit contains multiple roots");
        const count = attrs.get("tests");
        if (count === undefined || !/^\d+$/.test(count)) throw new Error("JUnit root omits its test count");
        declaredCases = Number(count);
      }
    } else if (name === "testsuite") {
      if (closing) {
        if (current !== null || suites.pop() === undefined) throw new Error("JUnit suite nesting is invalid");
      } else {
        if (selfClosing || current !== null) throw new Error("JUnit suite shape is unsupported");
        suites.push({ name: attrs.get("name") ?? "", file: attrs.get("file") ?? "" });
      }
    } else if (name === "testcase") {
      if (closing) complete();
      else {
        if (current !== null || suites.length === 0) throw new Error("JUnit testcase nesting is invalid");
        const suite = suites.at(-1)!;
        const identity = [...suites.flatMap((entry) => [entry.name, entry.file]), attrs.get("name"), attrs.get("classname"), attrs.get("file")].join(" ");
        current = {
          postgres: POSTGRES_IDENTITY.test(identity) && !/\bBlackbox-Atomic\b/.test(identity), skipped: false,
          inapplicable: inapplicableCell(attrs.get("file") ?? suite.file, suite.name, attrs.get("name") ?? ""),
        };
        if (selfClosing) complete();
      }
    } else if (name === "skipped" && !closing) {
      if (current === null) throw new Error("JUnit skip outside a testcase");
      current.skipped = true;
    } else if ((name === "failure" || name === "error") && !closing) {
      throw new Error("JUnit contains a failed testcase");
    }
  }
  if (!closed || suites.length !== 0 || current !== null || declaredCases !== cases) throw new Error("JUnit report is incomplete or has inconsistent counts");
  return requirePostgresCases({ cases, postgresCases, postgresSkipped, postgresInapplicable });
}

export function requirePostgresCases(evidence: PostgresCaseEvidence): PostgresCaseEvidence {
  for (const value of [evidence.cases, evidence.postgresCases, evidence.postgresSkipped]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("PostgreSQL evidence counts must be nonnegative integers");
  }
  if (!Array.isArray(evidence.postgresInapplicable)) throw new Error("PostgreSQL evidence must report inapplicable cells explicitly");
  const seen = new Set<PostgresInapplicableCase>();
  for (const cell of evidence.postgresInapplicable) {
    if (cell === null || typeof cell !== "object") throw new Error("PostgreSQL evidence contains an invalid inapplicable cell");
    const approved = inapplicableCell(cell.file, cell.suite, cell.name);
    if (approved === undefined || approved.reason !== cell.reason || seen.has(approved)) throw new Error("PostgreSQL evidence contains an unapproved or duplicate inapplicable cell");
    seen.add(approved);
  }
  if (evidence.postgresSkipped !== 0) throw new Error(`required PostgreSQL gate skipped ${evidence.postgresSkipped} cases`);
  if (evidence.postgresCases === 0 || evidence.cases < evidence.postgresCases + seen.size) throw new Error("required PostgreSQL gate executed no valid PostgreSQL case set");
  return evidence;
}
