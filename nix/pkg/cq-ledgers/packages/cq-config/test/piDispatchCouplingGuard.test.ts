/**
 * T1145 (defects:D186, milestone M319) — the pi dispatch CROSS-ARTIFACT
 * coupling guard.
 *
 * The pi dispatch CONTRACT spans two artifacts that deploy together but were
 * changed separately:
 *
 *   - the prompt asset `nix/pkg/cq-assets/fragments/pi/subagent-dispatch.md`,
 *     which tells the pi orchestrator what call to make;
 *   - the extension source under `nix/pkg/pi-extensions/`, whose typebox
 *     `DispatchParams` schema decides what that call may contain.
 *
 * Nothing coupled them. tasks:T979's assertion in
 * `crossSurfaceDispatchConformance.test.ts` pins the fragment's TEXT, so the
 * fragment was guarded for EXISTENCE but not for AGREEMENT with the code it
 * drives — which is why a green `bun run check` could coexist with a pi surface
 * that refuses every dispatch (defects:D186). This file closes that: it DERIVES
 * the advertised set from the fragment's real bytes, DERIVES the accepted set
 * from the extension's real typebox schema, and asserts they agree. Two
 * hand-maintained literals would be the same unenforced duplication one layer
 * up, so neither side is written down here.
 *
 * ORDERING IS THE POINT (defects:D186 suggestedFix step 1). On main today the
 * `{agent, task}` extension MATCHES the fragment, so this guard is GREEN on
 * arrival. It turns RED the moment tasks:T693's ref-first extension merges
 * without the fragment migration — converting an invisible latent break into a
 * failing gate. It is deliberately additive to T979's text assertion and
 * neither weakens nor relocates it.
 *
 * The extension source is resolved across BOTH layouts (main's single file and
 * T693's directory form) on purpose: after that merge the guard must fail with
 * the intended "advertised but refused: agent, task" diagnosis, not with ENOENT.
 *
 * NEGATIVE CONTROLS live at the bottom of this file, per decisions:K166 rule 4
 * (a guard that cannot fail is not a guard):
 *   (a) the REAL divergent state — T693's live extension bytes when its ref is
 *       available, otherwise provenance-checked excerpts committed with this
 *       test — against main's real fragment bytes must be DETECTED, naming the
 *       members on each side;
 *   (b) the positive case — main's real fragment against main's real extension —
 *       must PASS, which is what makes the guard green on arrival;
 *   (c) extractor NON-VACUITY — an extractor that finds nothing must not be
 *       able to satisfy the comparison.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Six levels: test -> cq-config -> packages -> cq-ledgers -> pkg -> nix -> repo root. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");

const PI_DISPATCH_FRAGMENT = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "cq-assets",
  "fragments",
  "pi",
  "subagent-dispatch.md",
);

const PI_EXTENSIONS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "pi-extensions");

const TEST_RELATIVE_PATH = path.join(
  "packages",
  "cq-config",
  "test",
  "piDispatchCouplingGuard.test.ts",
);

const T693_FIXTURE_ROOT = path.join(
  import.meta.dir,
  "fixtures",
  "t693-ref-first-dispatch",
);

const CANDIDATE_ONLY_PROBE_ENV = "CQ_T1145_CANDIDATE_ONLY_PROBE";

/**
 * The extension layouts this guard understands, in resolution order. main ships
 * the single file; tasks:T693's ref-first cutover ships the directory form,
 * whose schema lives in `index.ts` and whose by-name refusal list lives in
 * `dispatch.ts`. Resolving both means the post-merge failure is the INTENDED
 * divergence report rather than a missing-file error.
 */
const EXTENSION_LAYOUTS: readonly { readonly label: string; readonly files: readonly string[] }[] = [
  { label: "single-file", files: ["cq-subagent-dispatch.ts"] },
  {
    label: "directory",
    files: [
      path.join("cq-subagent-dispatch", "index.ts"),
      path.join("cq-subagent-dispatch", "dispatch.ts"),
    ],
  },
];

/** The tool the fragment advertises and the extension registers. */
const DISPATCH_TOOL_NAME = "dispatch_agent";

/** The typebox binding that defines the accepted launch parameters. */
const SCHEMA_BINDING = "DispatchParams";

/** The optional by-name refusal list (present only on the ref-first extension). */
const REFUSAL_BINDING = "LEGACY_DISPATCH_FIELDS";

// ---------------------------------------------------------------------------
// Extracted shapes
// ---------------------------------------------------------------------------

/** What the pi fragment instructs the orchestrator to call. */
interface AdvertisedCallShape {
  readonly toolName: string;
  readonly params: readonly string[];
  readonly sourcePath: string;
}

/** What the extension's typebox schema will actually accept. */
interface AcceptedCallShape {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** Names the extension rejects EXPLICITLY, when it keeps such a list. */
  readonly refusedByName: readonly string[];
  readonly schemaPath: string;
}

/** The three ways the two artifacts can disagree. */
interface CallShapeDivergence {
  /** Advertised, but the schema does not accept it at all — the dispatch is refused. */
  readonly advertisedButRefused: readonly string[];
  /** Required by the schema, but no fragment tells the orchestrator to send it. */
  readonly acceptedButUnadvertised: readonly string[];
  /** Advertised as part of the call, but merely optional in the schema. */
  readonly advertisedButOptional: readonly string[];
}

interface CallShapeExtractors {
  readonly advertised: (fragmentText: string, sourcePath: string) => AdvertisedCallShape;
  readonly accepted: (files: readonly ExtensionSourceFile[]) => AcceptedCallShape;
}

/** Raised when an extractor cannot locate what it must derive. Never a silent empty set. */
class DispatchShapeExtractionError extends Error {}

/** Raised when the two artifacts disagree. Its message names the members and both paths. */
class DispatchCouplingError extends Error {}

// ---------------------------------------------------------------------------
// A small balanced scanner: enough TS/markdown lexing to walk a call or an
// object literal without mistaking a brace inside a string or a comment for
// structure. Template-literal interpolation is NOT interpreted; no dispatch
// schema uses one, and an unparsable property throws rather than being skipped.
// ---------------------------------------------------------------------------

const OPENERS: Readonly<Record<string, string>> = { "(": ")", "{": "}", "[": "]" };
const CLOSERS = new Set([")", "}", "]"]);

/** Index of the closing quote of the string literal opening at `start`. */
function skipStringLiteral(source: string, start: number): number {
  const quote = source.charAt(start);
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  throw new DispatchShapeExtractionError(`unterminated ${quote} string literal at offset ${start}`);
}

/** Index just before the end of the comment opening at `start`, or -1 if none opens there. */
function skipComment(source: string, start: number): number {
  if (source.charAt(start) !== "/") return -1;
  const next = source.charAt(start + 1);
  if (next === "/") {
    const newline = source.indexOf("\n", start);
    return newline < 0 ? source.length : newline;
  }
  if (next === "*") {
    const end = source.indexOf("*/", start + 2);
    if (end < 0) throw new DispatchShapeExtractionError(`unterminated block comment at ${start}`);
    return end + 1;
  }
  return -1;
}

/** Index of the delimiter closing the one at `open`. */
function findMatchingDelimiter(source: string, open: number): number {
  const expected = OPENERS[source.charAt(open)];
  if (expected === undefined) {
    throw new DispatchShapeExtractionError(`offset ${open} is not an opening delimiter`);
  }
  const stack: string[] = [];
  for (let i = open; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(source, i);
      continue;
    }
    const afterComment = skipComment(source, i);
    if (afterComment >= 0) {
      i = afterComment;
      continue;
    }
    const closer = OPENERS[ch];
    if (closer !== undefined) {
      stack.push(closer);
      continue;
    }
    if (CLOSERS.has(ch)) {
      if (stack[stack.length - 1] !== ch) {
        throw new DispatchShapeExtractionError(`unbalanced "${ch}" at offset ${i}`);
      }
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  throw new DispatchShapeExtractionError(`no delimiter closes the one at offset ${open}`);
}

/** Split a call-argument / object-property body on its TOP-LEVEL commas. */
function splitTopLevel(body: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(body, i);
      continue;
    }
    const afterComment = skipComment(body, i);
    if (afterComment >= 0) {
      i = afterComment;
      continue;
    }
    if (OPENERS[ch] !== undefined) {
      depth += 1;
      continue;
    }
    if (CLOSERS.has(ch)) {
      depth -= 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      segments.push(body.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(body.slice(start));
  return segments.filter((segment) => segment.trim().length > 0);
}

const NAMED_ENTRY = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*([A-Za-z_$][\w$]*)\s*:([\s\S]*)$/;

/** Parse one `name: value` entry. Throws rather than skipping, so nothing is lost silently. */
function parseNamedEntry(segment: string, what: string): { name: string; value: string } {
  const matched = NAMED_ENTRY.exec(segment);
  if (matched === null) {
    throw new DispatchShapeExtractionError(
      `${what}: cannot read a "name: value" entry from ${JSON.stringify(segment.trim())}`,
    );
  }
  return { name: matched[1] as string, value: (matched[2] as string).trim() };
}

/** Body text between the delimiters that open at `open`. */
function delimitedBody(source: string, open: number): string {
  return source.slice(open + 1, findMatchingDelimiter(source, open));
}

// ---------------------------------------------------------------------------
// Extractor 1 — what the FRAGMENT advertises
// ---------------------------------------------------------------------------

/**
 * Derive the advertised parameter names from the fragment's real bytes. The
 * fragment is a markdown blockquote whose call may reflow across lines, so
 * blockquote markers are stripped and the lines rejoined before scanning.
 */
function extractAdvertisedCallShape(fragmentText: string, sourcePath: string): AdvertisedCallShape {
  const flattened = fragmentText
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ");
  const anchor = `${DISPATCH_TOOL_NAME}(`;
  const at = flattened.indexOf(anchor);
  if (at < 0) {
    throw new DispatchShapeExtractionError(
      `${sourcePath}: no "${anchor}...)" call signature found — the fragment no longer advertises a call shape this guard can read`,
    );
  }
  const open = at + anchor.length - 1;
  const args = splitTopLevel(delimitedBody(flattened, open));
  if (args.length === 0) {
    throw new DispatchShapeExtractionError(
      `${sourcePath}: "${anchor})" advertises no parameters at all`,
    );
  }
  const params = args.map((arg) => parseNamedEntry(arg, sourcePath).name);
  return { toolName: DISPATCH_TOOL_NAME, params, sourcePath };
}

// ---------------------------------------------------------------------------
// Extractor 2 — what the EXTENSION accepts
// ---------------------------------------------------------------------------

/** One extension source file, read from the working tree or from a git object. */
interface ExtensionSourceFile {
  readonly path: string;
  readonly text: string;
}

interface T693FixtureFileProvenance {
  readonly fixture: string;
  readonly sourcePath: string;
  readonly sourceLines: string;
  readonly sourceGitBlob: string;
  readonly sourceSha256: string;
  readonly fixtureGitBlob: string;
  readonly fixtureSha256: string;
}

interface T693FixtureProvenance {
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly files: readonly T693FixtureFileProvenance[];
}

interface DivergentExtensionSources {
  readonly files: readonly ExtensionSourceFile[];
  readonly origin: "live-ref" | "committed-fixture";
  readonly sourceCommit: string;
}

/** Names listed in the optional by-name refusal array. Absent list => no names. */
function extractRefusedFieldNames(files: readonly ExtensionSourceFile[]): string[] {
  for (const file of files) {
    const at = file.text.indexOf(`${REFUSAL_BINDING} = [`);
    if (at < 0) continue;
    const body = delimitedBody(file.text, file.text.indexOf("[", at));
    return [...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] as string);
  }
  return [];
}

/**
 * Derive the accepted parameter set from the real typebox schema. Optionality
 * comes from the `Type.Optional(...)` wrapper, not from a comment. Fails loudly
 * when the schema cannot be located: a silent empty set would make the
 * comparison vacuously true, which is the failure mode this guard exists to
 * prevent.
 */
function extractAcceptedCallShape(files: readonly ExtensionSourceFile[]): AcceptedCallShape {
  const anchor = `${SCHEMA_BINDING} = Type.Object(`;
  const carrying = files.filter((file) => file.text.includes(anchor));
  if (carrying.length === 0) {
    throw new DispatchShapeExtractionError(
      `no "${anchor}" schema found in ${files.map((file) => file.path).join(", ") || "(no files)"} — the accepted parameter set cannot be derived`,
    );
  }
  if (carrying.length > 1) {
    throw new DispatchShapeExtractionError(
      `"${anchor}" is defined in more than one file (${carrying.map((file) => file.path).join(", ")}) — which one binds the tool is ambiguous`,
    );
  }
  const schemaFile = carrying[0] as ExtensionSourceFile;
  const at = schemaFile.text.indexOf(anchor);
  const callBody = delimitedBody(schemaFile.text, at + anchor.length - 1);
  const propertiesOpen = callBody.indexOf("{");
  if (propertiesOpen < 0) {
    throw new DispatchShapeExtractionError(
      `${schemaFile.path}: "${anchor}" has no properties object literal`,
    );
  }
  const required: string[] = [];
  const optional: string[] = [];
  for (const segment of splitTopLevel(delimitedBody(callBody, propertiesOpen))) {
    const entry = parseNamedEntry(segment, schemaFile.path);
    if (entry.value.startsWith("Type.Optional(")) optional.push(entry.name);
    else required.push(entry.name);
  }
  if (required.length === 0 && optional.length === 0) {
    throw new DispatchShapeExtractionError(
      `${schemaFile.path}: "${anchor}" declares no properties — the accepted set would be vacuously empty`,
    );
  }
  return {
    required,
    optional,
    refusedByName: extractRefusedFieldNames(files),
    schemaPath: schemaFile.path,
  };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

function compareCallShapes(
  advertised: AdvertisedCallShape,
  accepted: AcceptedCallShape,
): CallShapeDivergence {
  const requiredSet = new Set(accepted.required);
  const optionalSet = new Set(accepted.optional);
  const advertisedSet = new Set(advertised.params);
  return {
    advertisedButRefused: advertised.params.filter(
      (name) => !requiredSet.has(name) && !optionalSet.has(name),
    ),
    acceptedButUnadvertised: accepted.required.filter((name) => !advertisedSet.has(name)),
    advertisedButOptional: advertised.params.filter((name) => optionalSet.has(name)),
  };
}

function isCoupled(divergence: CallShapeDivergence): boolean {
  return (
    divergence.advertisedButRefused.length === 0 &&
    divergence.acceptedButUnadvertised.length === 0 &&
    divergence.advertisedButOptional.length === 0
  );
}

/** A message that tells a future reader WHAT diverged, on which side, in which file. */
function describeDivergence(
  advertised: AdvertisedCallShape,
  accepted: AcceptedCallShape,
  divergence: CallShapeDivergence,
): string {
  const lines = [
    `pi dispatch call shape diverged between the prompt asset and the extension (defects:D186):`,
    `  advertised by  ${advertised.sourcePath}: ${advertised.toolName}(${advertised.params.join(", ")})`,
    `  accepted by    ${accepted.schemaPath}: required {${accepted.required.join(", ")}}, optional {${accepted.optional.join(", ")}}`,
  ];
  if (divergence.advertisedButRefused.length > 0) {
    const refusedByName = divergence.advertisedButRefused.filter((name) =>
      accepted.refusedByName.includes(name),
    );
    lines.push(
      `  ADVERTISED BUT REFUSED (every such dispatch fails): ${divergence.advertisedButRefused.join(", ")}` +
        (refusedByName.length > 0 ? ` [rejected BY NAME: ${refusedByName.join(", ")}]` : ""),
    );
  }
  if (divergence.acceptedButUnadvertised.length > 0) {
    lines.push(
      `  ACCEPTED BUT UNADVERTISED (required, yet no fragment asks for it): ${divergence.acceptedButUnadvertised.join(", ")}`,
    );
  }
  if (divergence.advertisedButOptional.length > 0) {
    lines.push(
      `  ADVERTISED BUT ONLY OPTIONAL: ${divergence.advertisedButOptional.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** The guard proper: derive both sides, compare, throw a naming failure on divergence. */
function assertDispatchCallShapesAgree(
  advertised: AdvertisedCallShape,
  accepted: AcceptedCallShape,
): void {
  const divergence = compareCallShapes(advertised, accepted);
  if (!isCoupled(divergence)) {
    throw new DispatchCouplingError(describeDivergence(advertised, accepted, divergence));
  }
}

const REAL_EXTRACTORS: CallShapeExtractors = {
  advertised: extractAdvertisedCallShape,
  accepted: extractAcceptedCallShape,
};

function extractAndAssertDispatchCallShapesAgree(
  fragment: { readonly text: string; readonly sourcePath: string },
  extensionFiles: readonly ExtensionSourceFile[],
  extractors: CallShapeExtractors = REAL_EXTRACTORS,
): { readonly advertised: AdvertisedCallShape; readonly accepted: AcceptedCallShape } {
  const advertised = extractors.advertised(fragment.text, fragment.sourcePath);
  if (advertised.params.length === 0) {
    throw new DispatchShapeExtractionError(
      `${advertised.sourcePath}: advertised-call extractor returned an empty parameter set`,
    );
  }
  const accepted = extractors.accepted(extensionFiles);
  if (accepted.required.length === 0 && accepted.optional.length === 0) {
    throw new DispatchShapeExtractionError(
      `${accepted.schemaPath}: accepted-call extractor returned an empty parameter set`,
    );
  }
  assertDispatchCallShapesAgree(advertised, accepted);
  return { advertised, accepted };
}

// ---------------------------------------------------------------------------
// Real-artifact readers
// ---------------------------------------------------------------------------

function readFragment(): { text: string; sourcePath: string } {
  return {
    text: readFileSync(PI_DISPATCH_FRAGMENT, "utf8"),
    sourcePath: path.relative(REPO_ROOT, PI_DISPATCH_FRAGMENT),
  };
}

/** Resolve whichever extension layout the working tree currently carries. */
function readExtensionSources(): { files: ExtensionSourceFile[]; layout: string } {
  for (const layout of EXTENSION_LAYOUTS) {
    const absolute = layout.files.map((relative) => path.join(PI_EXTENSIONS_ROOT, relative));
    if (!existsSync(absolute[0] as string)) continue;
    const files = absolute
      .filter((file) => existsSync(file))
      .map((file) => ({
        path: path.relative(REPO_ROOT, file),
        text: readFileSync(file, "utf8"),
      }));
    return { files, layout: layout.label };
  }
  throw new DispatchShapeExtractionError(
    `no pi dispatch extension found under ${path.relative(REPO_ROOT, PI_EXTENSIONS_ROOT)} in any known layout (${EXTENSION_LAYOUTS.map((l) => l.label).join(", ")})`,
  );
}

function readT693FixtureProvenance(): T693FixtureProvenance {
  const provenancePath = path.join(T693_FIXTURE_ROOT, "provenance.json");
  const parsed = JSON.parse(readFileSync(provenancePath, "utf8")) as T693FixtureProvenance;
  if (
    !/^refs\/heads\/\S+$/.test(parsed.sourceRef) ||
    !/^[0-9a-f]{40}$/.test(parsed.sourceCommit) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0
  ) {
    throw new DispatchShapeExtractionError(
      `${path.relative(REPO_ROOT, provenancePath)}: incomplete T693 fixture provenance`,
    );
  }
  return parsed;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function gitBlobId(text: string): string {
  return execFileSync("git", ["hash-object", "--stdin"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: text,
  }).trim();
}

/** Read the committed, provenance-checked excerpts used when the T693 ref is absent. */
function readT693FixtureSources(
  provenance: T693FixtureProvenance,
): DivergentExtensionSources {
  const files = provenance.files.map((entry) => {
    const fixturePath = path.join(T693_FIXTURE_ROOT, entry.fixture);
    const text = readFileSync(fixturePath, "utf8");
    if (sha256(text) !== entry.fixtureSha256 || gitBlobId(text) !== entry.fixtureGitBlob) {
      throw new DispatchShapeExtractionError(
        `${path.relative(REPO_ROOT, fixturePath)}: bytes differ from the recorded T693 fixture provenance`,
      );
    }
    return {
      path:
        `${path.relative(REPO_ROOT, fixturePath)} ` +
        `(from ${provenance.sourceCommit}:${entry.sourcePath} lines ${entry.sourceLines})`,
      text,
    };
  });
  return {
    files,
    origin: "committed-fixture",
    sourceCommit: provenance.sourceCommit,
  };
}

/**
 * Prefer the current T693 ref when this checkout still carries it. A pushed
 * candidate or fresh clone does not: in that environment the committed,
 * digest-checked excerpts preserve the same real divergence without relying on
 * an ambient object database.
 */
function readT693ExtensionSources(): DivergentExtensionSources {
  const provenance = readT693FixtureProvenance();
  const resolved = spawnSync(
    "git",
    ["rev-parse", "--verify", `${provenance.sourceRef}^{commit}`],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (resolved.status !== 0) return readT693FixtureSources(provenance);

  const sourceCommit = resolved.stdout.trim();
  const files = provenance.files.map((entry) => {
    const objectPath = `${sourceCommit}:${entry.sourcePath}`;
    const text = execFileSync("git", ["show", objectPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (sourceCommit === provenance.sourceCommit) {
      const sourceGitBlob = execFileSync(
        "git",
        ["rev-parse", `${sourceCommit}:${entry.sourcePath}`],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
      if (sourceGitBlob !== entry.sourceGitBlob || sha256(text) !== entry.sourceSha256) {
        throw new DispatchShapeExtractionError(
          `${objectPath}: bytes differ from the recorded source blob provenance`,
        );
      }
    }
    return { path: objectPath, text };
  });
  return { files, origin: "live-ref", sourceCommit };
}

function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the operation to fail");
}

// ---------------------------------------------------------------------------
// THE GUARD — green on main, red the moment T693 merges without the fragments
// ---------------------------------------------------------------------------

// Behavioral-Active × Effectual × Good Communication; regression origin: defects:D186.
describe("pi dispatch cross-artifact coupling (T1145 / defects:D186)", () => {
  it("the fragment's advertised call shape equals the extension's accepted parameter set", () => {
    const fragment = readFragment();
    const extension = readExtensionSources();
    extractAndAssertDispatchCallShapesAgree(fragment, extension.files);
  });

  it("characterizes what each side currently says, so a change is visible in the diff", () => {
    const fragment = readFragment();
    const extension = readExtensionSources();
    const advertised = extractAdvertisedCallShape(fragment.text, fragment.sourcePath);
    const accepted = extractAcceptedCallShape(extension.files);

    expect(advertised.toolName).toBe("dispatch_agent");
    expect(new Set(advertised.params)).toEqual(new Set(accepted.required));
    // Optional schema members are legitimately absent from the advertised call.
    expect(accepted.optional.every((name) => !advertised.params.includes(name))).toBe(true);
  });

  it("detects real T693 {roleId,input} bytes diverging from the fragment's {agent,task}", () => {
    const fragment = readFragment();
    const divergent = readT693ExtensionSources();
    const extensionFiles = divergent.files;
    const advertised = extractAdvertisedCallShape(fragment.text, fragment.sourcePath);
    const accepted = extractAcceptedCallShape(extensionFiles);
    const divergence = compareCallShapes(advertised, accepted);

    expect(divergence.advertisedButRefused).toEqual(["agent", "task"]);
    expect(divergence.acceptedButUnadvertised).toEqual(["roleId", "input"]);
    expect(divergence.advertisedButOptional).toEqual([]);

    const error = captureError(() =>
      extractAndAssertDispatchCallShapesAgree(fragment, extensionFiles),
    );
    expect(error).toBeInstanceOf(DispatchCouplingError);
    expect(error.message).toContain(fragment.sourcePath);
    expect(error.message).toContain(extensionFiles[0]!.path);
    expect(error.message).toContain("ADVERTISED BUT REFUSED (every such dispatch fails): agent, task");
    expect(error.message).toContain("rejected BY NAME: agent, task");
    expect(error.message).toContain(
      "ACCEPTED BUT UNADVERTISED (required, yet no fragment asks for it): roleId, input",
    );
  });

  it("the committed T693 fallback excerpts retain their recorded divergence", () => {
    const fragment = readFragment();
    const fallback = readT693FixtureSources(readT693FixtureProvenance());
    const advertised = extractAdvertisedCallShape(fragment.text, fragment.sourcePath);
    const accepted = extractAcceptedCallShape(fallback.files);

    expect(fallback.origin).toBe("committed-fixture");
    expect(fallback.sourceCommit).toBe("2b497f375df004bc289dcb5f99e36663bf52cd35");
    expect(compareCallShapes(advertised, accepted)).toEqual({
      advertisedButRefused: ["agent", "task"],
      acceptedButUnadvertised: ["roleId", "input"],
      advertisedButOptional: [],
    });
  });

  it("rejects an advertised-call extractor mutated to return an empty set", () => {
    const fragment = readFragment();
    const extensionFiles = readT693ExtensionSources().files;
    const mutatedExtractors: CallShapeExtractors = {
      ...REAL_EXTRACTORS,
      advertised: (_fragmentText, sourcePath) => ({
        toolName: DISPATCH_TOOL_NAME,
        params: [],
        sourcePath,
      }),
    };

    const error = captureError(() =>
      extractAndAssertDispatchCallShapesAgree(fragment, extensionFiles, mutatedExtractors),
    );
    expect(error).toBeInstanceOf(DispatchShapeExtractionError);
    expect(error.message).toBe(
      `${fragment.sourcePath}: advertised-call extractor returned an empty parameter set`,
    );
  });

  it("rejects an accepted-call extractor mutated to return an empty set", () => {
    const fragment = readFragment();
    const extensionFiles = readT693ExtensionSources().files;
    const mutatedExtractors: CallShapeExtractors = {
      ...REAL_EXTRACTORS,
      accepted: (files) => ({
        required: [],
        optional: [],
        refusedByName: [],
        schemaPath: files[0]!.path,
      }),
    };

    const error = captureError(() =>
      extractAndAssertDispatchCallShapesAgree(fragment, extensionFiles, mutatedExtractors),
    );
    expect(error).toBeInstanceOf(DispatchShapeExtractionError);
    expect(error.message).toBe(
      `${extensionFiles[0]!.path}: accepted-call extractor returned an empty parameter set`,
    );
  });

  if (process.env[CANDIDATE_ONLY_PROBE_ENV] !== "1") {
    it("the exact guard passes in a HEAD-only clone with no ambient T693 ref or object", () => {
      const isolatedRoot = mkdtempSync(path.join(tmpdir(), "cq-T1145-candidate-only-"));
      try {
        const bundlePath = path.join(isolatedRoot, "candidate.bundle");
        const cloneRoot = path.join(isolatedRoot, "clone");
        const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        }).trim();
        const provenance = readT693FixtureProvenance();

        execFileSync("git", ["bundle", "create", bundlePath, "HEAD"], { cwd: REPO_ROOT });
        execFileSync("git", ["init", "-q", cloneRoot]);
        execFileSync("git", ["-C", cloneRoot, "bundle", "unbundle", bundlePath]);
        execFileSync(
          "git",
          ["-C", cloneRoot, "update-ref", "refs/heads/candidate", candidateHead],
        );
        execFileSync("git", ["-C", cloneRoot, "checkout", "-q", "candidate"]);

        const refProbe = spawnSync(
          "git",
          ["-C", cloneRoot, "rev-parse", "--verify", `${provenance.sourceRef}^{commit}`],
          { encoding: "utf8" },
        );
        const objectProbe = spawnSync(
          "git",
          ["-C", cloneRoot, "cat-file", "-e", `${provenance.sourceCommit}^{commit}`],
          { encoding: "utf8" },
        );
        expect(refProbe.status).not.toBe(0);
        expect(objectProbe.status).not.toBe(0);

        const child = spawnSync(process.execPath, ["test", TEST_RELATIVE_PATH], {
          cwd: path.join(cloneRoot, "nix", "pkg", "cq-ledgers"),
          encoding: "utf8",
          env: { ...process.env, [CANDIDATE_ONLY_PROBE_ENV]: "1" },
        });
        const childOutput = `${child.stdout}\n${child.stderr}`;
        expect(child.status, childOutput).toBe(0);
        expect(childOutput).toContain(
          "detects real T693 {roleId,input} bytes diverging from the fragment's {agent,task}",
        );
      } finally {
        rmSync(isolatedRoot, { recursive: true, force: true });
      }
    });
  }
});
