export interface PostgresCaseEvidence {
  readonly cases: number;
  readonly postgresCases: number;
  readonly postgresSkipped: number;
}

const POSTGRES_IDENTITY = /\b(?:postgres(?:ql)?|pg)\b/i;

function attributes(source: string): Map<string, string> {
  return new Map([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));
}

/** Reads the structural tags emitted by Bun's JUnit reporter; failure text is not evidence. */
export function postgresEvidenceFromJunit(xml: string): PostgresCaseEvidence {
  const structural = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const suites: string[] = [];
  let current: { postgres: boolean; skipped: boolean } | null = null;
  let declaredCases: number | null = null;
  let closed = false;
  let cases = 0;
  let postgresCases = 0;
  let postgresSkipped = 0;
  const complete = () => {
    if (current === null) throw new Error("JUnit testcase close without an open testcase");
    cases++;
    if (current.postgres) {
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
        suites.push(`${attrs.get("name") ?? ""} ${attrs.get("file") ?? ""}`);
      }
    } else if (name === "testcase") {
      if (closing) complete();
      else {
        if (current !== null || suites.length === 0) throw new Error("JUnit testcase nesting is invalid");
        const identity = [...suites, attrs.get("name"), attrs.get("classname"), attrs.get("file")].join(" ");
        current = { postgres: POSTGRES_IDENTITY.test(identity) && !/\bBlackbox-Atomic\b/.test(identity), skipped: false };
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
  return requirePostgresCases({ cases, postgresCases, postgresSkipped });
}

export function requirePostgresCases(evidence: PostgresCaseEvidence): PostgresCaseEvidence {
  for (const value of [evidence.cases, evidence.postgresCases, evidence.postgresSkipped]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("PostgreSQL evidence counts must be nonnegative integers");
  }
  if (evidence.postgresSkipped !== 0) throw new Error(`required PostgreSQL gate skipped ${evidence.postgresSkipped} cases`);
  if (evidence.postgresCases === 0 || evidence.cases < evidence.postgresCases) throw new Error("required PostgreSQL gate executed no valid PostgreSQL case set");
  return evidence;
}
