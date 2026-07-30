import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

interface CorpusManifestEntry {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface CorpusManifest {
  readonly corpusRoot: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly CorpusManifestEntry[];
}

interface TranscriptRecord {
  readonly attributionAgent?: unknown;
  readonly message?: {
    readonly content?: unknown;
  };
}

interface RoleAggregation {
  transcripts: number;
  zeroLedgerTranscripts: number;
  ledgerCalls: Record<string, number>;
}

interface CorpusAggregation {
  readonly manifest: string;
  readonly corpusRoot: string;
  readonly transcripts: number;
  readonly unclassifiedTranscripts: number;
  readonly roles: Readonly<Record<string, RoleAggregation>>;
}

const DEFAULT_MANIFEST = path.resolve(
  import.meta.dir,
  "../../../../../..",
  "docs/drafts/20260725-2130-t679-rs3-remeasure/corpus-manifest.json",
);
const TOOL_NAME_RE = /^mcp__(.+?)__(.+)$/;
const LEDGER_SERVER = "ledger";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
  return value;
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function roleAggregation(
  roles: Record<string, RoleAggregation>,
  roleId: string,
): RoleAggregation {
  const existing = roles[roleId];
  if (existing !== undefined) return existing;
  const created: RoleAggregation = {
    transcripts: 0,
    zeroLedgerTranscripts: 0,
    ledgerCalls: {},
  };
  roles[roleId] = created;
  return created;
}

function contentBlocks(record: TranscriptRecord): readonly unknown[] {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [];
}

function toolName(block: unknown): string | undefined {
  if (block === null || typeof block !== "object") return undefined;
  const candidate = block as { readonly type?: unknown; readonly name?: unknown };
  if (candidate.type !== "tool_use" || typeof candidate.name !== "string") return undefined;
  const match = TOOL_NAME_RE.exec(candidate.name);
  if (match === null || match[1] !== LEDGER_SERVER) return undefined;
  return match[2];
}

function aggregateTranscript(text: string): {
  readonly roleId: string | undefined;
  readonly ledgerCalls: Readonly<Record<string, number>>;
} {
  const agents = new Set<string>();
  const ledgerCalls: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const record = JSON.parse(line) as TranscriptRecord;
    if (typeof record.attributionAgent === "string") agents.add(record.attributionAgent);
    for (const block of contentBlocks(record)) {
      const name = toolName(block);
      if (name !== undefined) increment(ledgerCalls, name);
    }
  }
  return {
    roleId: agents.size === 1 ? [...agents][0] : undefined,
    ledgerCalls,
  };
}

function aggregateCorpus(
  manifestPath: string,
  corpusRootOverride: string | undefined,
): CorpusAggregation {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest;
  if (manifest.files.length !== manifest.fileCount) {
    throw new Error(
      `manifest declares ${manifest.fileCount} files but contains ${manifest.files.length}`,
    );
  }
  const corpusRoot = path.resolve(corpusRootOverride ?? manifest.corpusRoot);
  const roles: Record<string, RoleAggregation> = {};
  let totalBytes = 0;
  let unclassifiedTranscripts = 0;

  for (const entry of manifest.files) {
    const bytes = readFileSync(path.join(corpusRoot, entry.name));
    totalBytes += bytes.byteLength;
    if (bytes.byteLength !== entry.bytes) {
      throw new Error(
        `${entry.name}: manifest bytes ${entry.bytes}, observed ${bytes.byteLength}`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256) {
      throw new Error(`${entry.name}: manifest sha256 ${entry.sha256}, observed ${sha256}`);
    }
    const transcript = aggregateTranscript(bytes.toString("utf8"));
    if (transcript.roleId === undefined) {
      unclassifiedTranscripts += 1;
      continue;
    }
    const role = roleAggregation(roles, transcript.roleId);
    role.transcripts += 1;
    if (Object.keys(transcript.ledgerCalls).length === 0) {
      role.zeroLedgerTranscripts += 1;
    }
    for (const [tool, count] of Object.entries(transcript.ledgerCalls)) {
      role.ledgerCalls[tool] = (role.ledgerCalls[tool] ?? 0) + count;
    }
  }

  if (totalBytes !== manifest.totalBytes) {
    throw new Error(
      `manifest declares ${manifest.totalBytes} total bytes, observed ${totalBytes}`,
    );
  }
  return {
    manifest: path.resolve(manifestPath),
    corpusRoot,
    transcripts: manifest.files.length,
    unclassifiedTranscripts,
    roles,
  };
}

const manifestPath = path.resolve(argument("manifest") ?? DEFAULT_MANIFEST);
const aggregation = aggregateCorpus(manifestPath, argument("corpus-root"));
process.stdout.write(`${JSON.stringify(aggregation)}\n`);
