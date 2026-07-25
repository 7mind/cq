/**
 * T679 — re-measure the IMPLEMENTED ledger MCP response shapes against the
 * pinned RS3 corpus.
 *
 * Method
 * ------
 * RS3 measured captured tool results in 357 raw transcripts and SIMULATED the
 * savings of a proposed compact/ack contract. This probe replays the same
 * captured results, but computes the "after" side with the functions the
 * shipped server actually calls — `projectItemDto`, `projectMilestoneItem-
 * GroupsDto`, `projectFtsSearchResultsDto`, `projectFetchedMilestoneDto`,
 * `projectItemMutationAckDto`, `projectMilestoneMutationAckDto`,
 * `projectLedgerMutationAckDto` from
 * `packages/ledger/src/mcp/wireResponseContract.ts` — inside the same
 * envelopes the handlers build, serialized as the same minified JSON.
 *
 * Every number this emits is a WIRE-SHAPE measurement of one response's
 * serialized text. It is not a measure of billed tokens: host framing,
 * prompt caching, call mix, and downstream reasoning are outside the probe.
 *
 * Usage:
 *   bun run remeasure.ts [--manifest <file>] [--out <file>]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type { CorpusManifest } from "./pin-corpus.ts";

const WORKSPACE = resolve(import.meta.dir, "../../../nix/pkg/cq-ledgers");
const CONTRACT = `${WORKSPACE}/packages/ledger/src/mcp/wireResponseContract.ts`;
const {
  COMPACT_ITEM_FIELD_NAMES,
  LEDGER_RESPONSE_CONTRACTS,
  projectFetchedLedgerDto,
  projectFetchedMilestoneDto,
  projectFtsSearchResultsDto,
  projectItemDto,
  projectItemMutationAckDto,
  projectMilestoneItemGroupsDto,
  projectMilestoneMutationAckDto,
  projectPaginatedLedgerDto,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} = (await import(CONTRACT)) as any;

/**
 * Host tool names are `mcp__<server>__<tool>`. The server segment is NOT
 * restricted to `[A-Za-z0-9-]`: plugin-provided servers carry underscores
 * (`mcp__plugin_claude-code-home-manager_ledger__fetch_item`). A pattern that
 * excludes `_` from the server segment silently drops an entire namespace, so
 * the server segment is matched non-greedily up to the first `__` separator and
 * every `mcp__*` name that still fails to split is COUNTED, never skipped
 * silently (see `mcpToolNameAudit`).
 */
const TOOL_NAME_RE = /^mcp__(.+?)__(.+)$/;

/**
 * Accounting for every `mcp__*` tool name seen in the corpus, so that a change
 * of MCP server namespace can never again remove calls from the measurement
 * without leaving a trace in the artifact.
 */
const mcpToolNameAudit = {
  /** `mcp__*` names that do not split into server/tool at all — must stay empty */
  unmatchedMcpToolNames: {} as Record<string, number>,
  /** ledger-tool calls, by the MCP server namespace that served them */
  ledgerCallsByServer: {} as Record<string, number>,
  /** matched names whose tool segment is not a ledger tool (correctly ignored) */
  nonLedgerToolsIgnored: {} as Record<string, number>,
};

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * Host notices that REPLACE an oversized tool result with a pointer. The
 * payload never reached the transcript, so it can be neither measured nor
 * replayed — but both notice forms state the size of what they elided, which
 * bounds the unmeasured part of the before-volume.
 */
const ELIDED_CHARACTERS_RE = /^Error: result \(([\d,]+) characters/;
const ELIDED_KILOBYTES_RE = /^<persisted-output>\s*\n\s*Output too large \(([\d.]+)KB\)/;

// ---------------------------------------------------------------------------
// measurement primitives
// ---------------------------------------------------------------------------

interface Size {
  bytes: number;
  tokens: number;
}

function measureText(text: string): Size {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    tokens: encode(text).length,
  };
}

function measureValue(value: unknown): Size {
  return measureText(JSON.stringify(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

// ---------------------------------------------------------------------------
// per-tool replay of the captured payload through the SHIPPED transforms
// ---------------------------------------------------------------------------

type Envelope = Record<string, unknown>;

interface Replay {
  /** contract kind as declared by the shipped server */
  kind: "projection" | "ack" | "unchanged";
  /** the shape the shipped server returns for the default/low-cost path */
  after?: (parsed: Envelope) => Envelope;
  /** the shape the shipped server returns when the caller asks for full content */
  fullControl?: (parsed: Envelope) => Envelope;
  /** correctness assertions over (before, after) */
  check?: (parsed: Envelope, after: Envelope, problems: string[]) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyItem = any;

function checkCompactItem(before: AnyItem, after: AnyItem, where: string, problems: string[]): void {
  for (const key of ["id", "milestoneId", "status", "createdAt", "updatedAt"]) {
    if (after[key] !== before[key]) {
      problems.push(`${where}: compact dropped/changed intrinsic ${key}`);
    }
  }
  if (before.author !== undefined && after.author !== before.author) {
    problems.push(`${where}: compact dropped author`);
  }
  if (before.session !== undefined && after.session !== before.session) {
    problems.push(`${where}: compact dropped session`);
  }
  const allow: string[] = [...COMPACT_ITEM_FIELD_NAMES];
  for (const key of Object.keys(after.fields ?? {})) {
    if (!allow.includes(key)) problems.push(`${where}: compact leaked field ${key}`);
  }
  for (const key of allow) {
    const original = (before.fields ?? {})[key];
    if (original === undefined) continue;
    if (!deepEqual((after.fields ?? {})[key], original)) {
      problems.push(`${where}: compact lost allowlisted field ${key}`);
    }
  }
}

function checkItemAck(before: AnyItem, after: AnyItem, where: string, problems: string[]): void {
  for (const key of ["id", "milestoneId", "status", "createdAt", "updatedAt"]) {
    if (after[key] !== before[key]) problems.push(`${where}: ack dropped/changed ${key}`);
  }
  if (typeof after.id !== "string" || after.id.length === 0) {
    problems.push(`${where}: ack lacks an allocated id`);
  }
  for (const key of ["dependsOn", "blockedBy", "ledgerRefs"]) {
    const original = (before.fields ?? {})[key];
    if (original === undefined) continue;
    if (!deepEqual((after.fields ?? {})[key], original)) {
      problems.push(`${where}: ack lost canonicalized reference field ${key}`);
    }
  }
  for (const key of Object.keys(after.fields ?? {})) {
    if (!["dependsOn", "blockedBy", "ledgerRefs"].includes(key)) {
      problems.push(`${where}: ack leaked narrative field ${key}`);
    }
  }
}

const REPLAYS: Record<string, Replay> = {
  fetch_item: {
    kind: "projection",
    after: (p) => ({ item: projectItemDto(p.item, "compact") }),
    fullControl: (p) => ({ item: projectItemDto(p.item, "full") }),
    check: (p, after, problems) =>
      checkCompactItem(p.item, (after as AnyItem).item, "fetch_item", problems),
  },
  list_milestone_items: {
    kind: "projection",
    after: (p) => ({
      items: projectMilestoneItemGroupsDto(p.items as Record<string, AnyItem[]>, "compact"),
    }),
    fullControl: (p) => ({
      items: projectMilestoneItemGroupsDto(p.items as Record<string, AnyItem[]>, "full"),
    }),
    check: (p, after, problems) => {
      const groups = p.items as Record<string, AnyItem[]>;
      const out = (after as AnyItem).items as Record<string, AnyItem[]>;
      for (const [ledger, items] of Object.entries(groups)) {
        items.forEach((item, index) =>
          checkCompactItem(item, out[ledger]![index], `list_milestone_items:${ledger}[${index}]`, problems),
        );
      }
    },
  },
  fts_search: {
    kind: "projection",
    after: (p) => ({ results: projectFtsSearchResultsDto(p.results as AnyItem[], "compact") }),
    fullControl: (p) => ({ results: projectFtsSearchResultsDto(p.results as AnyItem[], "full") }),
    check: (p, after, problems) => {
      const hits = p.results as AnyItem[];
      const out = (after as AnyItem).results as AnyItem[];
      hits.forEach((hit, index) => {
        checkCompactItem(hit.item, out[index].item, `fts_search[${index}]`, problems);
        if (out[index].score !== hit.score) problems.push(`fts_search[${index}]: score changed`);
        if (!deepEqual(out[index].matchedFields, hit.matchedFields)) {
          problems.push(`fts_search[${index}]: matchedFields changed`);
        }
      });
    },
  },
  search_items: {
    kind: "projection",
    after: (p) => ({ items: (p.items as AnyItem[]).map((i) => projectItemDto(i, "compact")) }),
    fullControl: (p) => ({ items: (p.items as AnyItem[]).map((i) => projectItemDto(i, "full")) }),
  },
  fetch_milestone: {
    kind: "projection",
    after: (p) => projectFetchedMilestoneDto(p as AnyItem, "compact"),
    fullControl: (p) => projectFetchedMilestoneDto(p as AnyItem, "full"),
    check: (p, after, problems) =>
      checkCompactItem(p.milestone, (after as AnyItem).milestone, "fetch_milestone", problems),
  },
  create_item: {
    kind: "ack",
    after: (p) => ({ item: projectItemMutationAckDto(p.item) }),
    check: (p, after, problems) =>
      checkItemAck(p.item, (after as AnyItem).item, "create_item", problems),
  },
  update_item: {
    kind: "ack",
    after: (p) => ({ item: projectItemMutationAckDto(p.item) }),
    check: (p, after, problems) =>
      checkItemAck(p.item, (after as AnyItem).item, "update_item", problems),
  },
  reopen_item: {
    kind: "ack",
    after: (p) => ({ item: projectItemMutationAckDto(p.item) }),
    check: (p, after, problems) =>
      checkItemAck(p.item, (after as AnyItem).item, "reopen_item", problems),
  },
  unarchive_item: {
    kind: "ack",
    after: (p) => ({ item: projectItemMutationAckDto(p.item) }),
    check: (p, after, problems) =>
      checkItemAck(p.item, (after as AnyItem).item, "unarchive_item", problems),
  },
  create_milestone: {
    kind: "ack",
    after: (p) => ({ milestone: projectMilestoneMutationAckDto(p.milestone) }),
  },
  update_milestone: {
    kind: "ack",
    after: (p) => ({ milestone: projectMilestoneMutationAckDto(p.milestone) }),
  },
  create_ledger: {
    kind: "ack",
    after: (p) => ({ ledger: { id: (p.ledger as AnyItem).id } }),
  },
  // `fetch_ledger` has two envelopes in the shipped handler: the paginated one
  // (offset/limit given) and the whole-ledger one. Both are replayable in
  // principle; on THIS corpus every captured fetch_ledger result is a host
  // oversize notice with the payload elided, so the recorded exclusion reason
  // is the elision, not a missing transform.
  fetch_ledger: {
    kind: "projection",
    after: (p) => fetchLedgerAfter(p, "compact"),
    fullControl: (p) => fetchLedgerAfter(p, "full"),
  },
};

function fetchLedgerAfter(parsed: Envelope, projection: "compact" | "full"): Envelope {
  if (Array.isArray((parsed as AnyItem).items)) {
    return projectPaginatedLedgerDto(parsed as AnyItem, projection);
  }
  return { ledger: projectFetchedLedgerDto((parsed as AnyItem).ledger, projection) };
}

// ---------------------------------------------------------------------------
// corpus walk
// ---------------------------------------------------------------------------

interface ToolStats {
  tool: string;
  contractKind: string;
  calls: number;
  resultsCaptured: number;
  errors: number;
  /** tokens of the captured error results, excluded from every before-total */
  errorTokens: number;
  replayed: number;
  unreplayable: number;
  unreplayableReasons: Record<string, number>;
  beforeBytes: number;
  beforeTokens: number;
  /** before-tokens of exactly the calls that were replayable */
  replayedBeforeBytes: number;
  replayedBeforeTokens: number;
  afterBytes: number;
  afterTokens: number;
  fullControlBytes: number;
  fullControlTokens: number;
  /** calls whose after-shape is not smaller than the before-shape */
  nonImprovingCalls: number;
  worstRegressionTokens: number;
  /** before-tokens of EVERY non-error captured result, replayable or not */
  perCallBeforeTokens: number[];
  /**
   * Paired per-call arrays over exactly the replayed calls: index i of all
   * three describes the same call. `perCallBeforeTokens` is NOT aligned with
   * them (it also holds unreplayable calls), so a per-call delta must be taken
   * from `perCallDeltaTokens` — a difference of medians is not a median of
   * differences.
   */
  perCallReplayedBeforeTokens: number[];
  perCallAfterTokens: number[];
  perCallDeltaTokens: number[];
  argsTokens: number;
  argsTokensWithCompact: number;
  argsTokensWithFull: number;
  correctnessProblems: string[];
}

function emptyStats(tool: string): ToolStats {
  const contract = LEDGER_RESPONSE_CONTRACTS[tool];
  return {
    tool,
    contractKind: contract === undefined ? "unknown" : contract.kind,
    calls: 0,
    resultsCaptured: 0,
    errors: 0,
    errorTokens: 0,
    replayed: 0,
    unreplayable: 0,
    unreplayableReasons: {},
    beforeBytes: 0,
    beforeTokens: 0,
    replayedBeforeBytes: 0,
    replayedBeforeTokens: 0,
    afterBytes: 0,
    afterTokens: 0,
    fullControlBytes: 0,
    fullControlTokens: 0,
    nonImprovingCalls: 0,
    worstRegressionTokens: 0,
    perCallBeforeTokens: [],
    perCallReplayedBeforeTokens: [],
    perCallAfterTokens: [],
    perCallDeltaTokens: [],
    argsTokens: 0,
    argsTokensWithCompact: 0,
    argsTokensWithFull: 0,
    correctnessProblems: [],
  };
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
  return value;
}

function resultTextOf(block: AnyItem): string | null {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return null;
  const parts: string[] = [];
  for (const piece of block.content) {
    if (piece?.type === "text" && typeof piece.text === "string") parts.push(piece.text);
  }
  return parts.length === 0 ? null : parts.join("");
}

const manifestPath = resolve(arg("manifest", join(import.meta.dir, "corpus-manifest.json")));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest;

// --- corpus integrity ------------------------------------------------------
let verifiedBytes = 0;
for (const entry of manifest.files) {
  const buffer = readFileSync(join(manifest.corpusRoot, entry.name));
  if (buffer.byteLength !== entry.bytes) {
    throw new Error(`corpus drift: ${entry.name} size ${buffer.byteLength} != ${entry.bytes}`);
  }
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`corpus drift: ${entry.name} sha256 mismatch`);
  }
  verifiedBytes += buffer.byteLength;
}
if (manifest.files.length !== manifest.fileCount || verifiedBytes !== manifest.totalBytes) {
  throw new Error("corpus manifest is internally inconsistent");
}

const stats = new Map<string, ToolStats>();
let jsonlLines = 0;
let jsonlParseFailures = 0;

interface TranscriptStats {
  name: string;
  ledgerCalls: number;
  replayed: number;
  beforeTokens: number;
  afterTokens: number;
  argsDeltaTokens: number;
}
const perTranscript: TranscriptStats[] = [];

/**
 * One captured result whose payload the HOST elided before it reached the
 * transcript. The notice states the size of what it replaced, which is the
 * only evidence available about the unmeasured part of the before-volume.
 */
interface ElidedResult {
  tool: string;
  transcript: string;
  noticeKind: "oversize-error-notice" | "persisted-output-preview";
  /** size of the NOTICE that reached the transcript (this is what got measured) */
  noticeCharacters: number;
  /** payload size the notice states verbatim, in characters */
  statedPayloadCharacters: number | null;
  /** payload size the notice states as a rounded KB figure */
  statedPayloadKilobytes: number | null;
}
const elidedResults: ElidedResult[] = [];

for (const entry of manifest.files) {
  const text = readFileSync(join(manifest.corpusRoot, entry.name), "utf8");
  const transcript: TranscriptStats = {
    name: entry.name,
    ledgerCalls: 0,
    replayed: 0,
    beforeTokens: 0,
    afterTokens: 0,
    argsDeltaTokens: 0,
  };
  perTranscript.push(transcript);
  const pendingUse = new Map<string, { tool: string; input: unknown }>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    jsonlLines++;
    let record: AnyItem;
    try {
      record = JSON.parse(line);
    } catch {
      jsonlParseFailures++;
      continue;
    }
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        if (!block.name.startsWith("mcp__")) continue;
        const match = TOOL_NAME_RE.exec(block.name);
        if (match === null) {
          bump(mcpToolNameAudit.unmatchedMcpToolNames, block.name);
          continue;
        }
        const server = match[1]!;
        const tool = match[2]!;
        if (LEDGER_RESPONSE_CONTRACTS[tool] === undefined) {
          bump(mcpToolNameAudit.nonLedgerToolsIgnored, block.name);
          continue;
        }
        bump(mcpToolNameAudit.ledgerCallsByServer, server);
        pendingUse.set(block.id, { tool, input: block.input });
        const stat = stats.get(tool) ?? emptyStats(tool);
        stat.calls++;
        transcript.ledgerCalls++;
        const args = block.input ?? {};
        const plain = measureValue(args).tokens;
        const withCompact = measureValue({ ...args, projection: "compact" }).tokens;
        stat.argsTokens += plain;
        stat.argsTokensWithCompact += withCompact;
        stat.argsTokensWithFull += measureValue({ ...args, projection: "full" }).tokens;
        if (LEDGER_RESPONSE_CONTRACTS[tool].kind === "mandatory-item-projection") {
          transcript.argsDeltaTokens += withCompact - plain;
        }
        stats.set(tool, stat);
        continue;
      }
      if (block?.type !== "tool_result") continue;
      const use = pendingUse.get(block.tool_use_id);
      if (use === undefined) continue;
      const stat = stats.get(use.tool)!;
      const resultText = resultTextOf(block);
      if (resultText === null) continue;
      stat.resultsCaptured++;
      const before = measureText(resultText);
      const charNotice = ELIDED_CHARACTERS_RE.exec(resultText);
      const kbNotice = ELIDED_KILOBYTES_RE.exec(resultText);
      if (charNotice !== null || kbNotice !== null) {
        elidedResults.push({
          tool: use.tool,
          transcript: entry.name,
          noticeKind: charNotice !== null ? "oversize-error-notice" : "persisted-output-preview",
          noticeCharacters: resultText.length,
          statedPayloadCharacters:
            charNotice === null ? null : Number(charNotice[1]!.replaceAll(",", "")),
          statedPayloadKilobytes: kbNotice === null ? null : Number(kbNotice[1]!),
        });
      }
      if (block.is_error === true) {
        stat.errors++;
        stat.errorTokens += before.tokens;
        continue;
      }
      stat.beforeBytes += before.bytes;
      stat.beforeTokens += before.tokens;
      stat.perCallBeforeTokens.push(before.tokens);

      const replay = REPLAYS[use.tool];
      if (replay === undefined) {
        // Contractually unchanged tool: the shipped response is byte-identical
        // in shape to the captured one.
        const contract = LEDGER_RESPONSE_CONTRACTS[use.tool];
        if (contract.kind === "mandatory-item-projection") {
          stat.unreplayable++;
          stat.unreplayableReasons["no replay transform"] =
            (stat.unreplayableReasons["no replay transform"] ?? 0) + 1;
        } else {
          stat.replayed++;
          transcript.replayed++;
          transcript.beforeTokens += before.tokens;
          transcript.afterTokens += before.tokens;
          stat.replayedBeforeBytes += before.bytes;
          stat.replayedBeforeTokens += before.tokens;
          stat.afterBytes += before.bytes;
          stat.afterTokens += before.tokens;
          stat.fullControlBytes += before.bytes;
          stat.fullControlTokens += before.tokens;
          stat.perCallReplayedBeforeTokens.push(before.tokens);
          stat.perCallAfterTokens.push(before.tokens);
          stat.perCallDeltaTokens.push(0);
        }
        continue;
      }

      let parsed: Envelope;
      try {
        parsed = JSON.parse(resultText) as Envelope;
      } catch {
        stat.unreplayable++;
        const reason = resultText.startsWith("Error:")
          ? "host oversize/error notice, payload not captured"
          : "captured result is not JSON";
        stat.unreplayableReasons[reason] = (stat.unreplayableReasons[reason] ?? 0) + 1;
        continue;
      }
      let after: Envelope;
      let full: Envelope | null = null;
      try {
        after = replay.after!(parsed);
        if (replay.fullControl !== undefined) full = replay.fullControl(parsed);
      } catch (error) {
        stat.unreplayable++;
        const reason = `transform threw: ${(error as Error).message.slice(0, 60)}`;
        stat.unreplayableReasons[reason] = (stat.unreplayableReasons[reason] ?? 0) + 1;
        continue;
      }
      const afterSize = measureValue(after);
      stat.replayed++;
      transcript.replayed++;
      transcript.beforeTokens += before.tokens;
      transcript.afterTokens += afterSize.tokens;
      stat.replayedBeforeBytes += before.bytes;
      stat.replayedBeforeTokens += before.tokens;
      stat.afterBytes += afterSize.bytes;
      stat.afterTokens += afterSize.tokens;
      stat.perCallReplayedBeforeTokens.push(before.tokens);
      stat.perCallAfterTokens.push(afterSize.tokens);
      stat.perCallDeltaTokens.push(before.tokens - afterSize.tokens);
      if (afterSize.tokens >= before.tokens) {
        stat.nonImprovingCalls++;
        stat.worstRegressionTokens = Math.max(
          stat.worstRegressionTokens,
          afterSize.tokens - before.tokens,
        );
      }
      if (full !== null) {
        const fullSize = measureValue(full);
        stat.fullControlBytes += fullSize.bytes;
        stat.fullControlTokens += fullSize.tokens;
        // The full projection must preserve the captured payload exactly.
        if (!deepEqual(full, parsed)) {
          stat.correctnessProblems.push(
            `${use.tool}: full projection is not content-identical to the captured full response`,
          );
        }
      } else {
        stat.fullControlBytes += before.bytes;
        stat.fullControlTokens += before.tokens;
      }
      if (replay.check !== undefined) {
        const problems: string[] = [];
        replay.check(parsed, after, problems);
        for (const problem of problems) {
          if (stat.correctnessProblems.length < 20) stat.correctnessProblems.push(problem);
        }
      }
    }
  }
}

const perTool = [...stats.values()].sort((a, b) => b.beforeTokens - a.beforeTokens);
const totals = perTool.reduce(
  (acc, s) => ({
    calls: acc.calls + s.calls,
    resultsCaptured: acc.resultsCaptured + s.resultsCaptured,
    errors: acc.errors + s.errors,
    errorResultTokens: acc.errorResultTokens + s.errorTokens,
    replayed: acc.replayed + s.replayed,
    unreplayable: acc.unreplayable + s.unreplayable,
    beforeBytes: acc.beforeBytes + s.beforeBytes,
    beforeTokens: acc.beforeTokens + s.beforeTokens,
    afterBytes: acc.afterBytes + s.afterBytes,
    afterTokens: acc.afterTokens + s.afterTokens,
    fullControlBytes: acc.fullControlBytes + s.fullControlBytes,
    fullControlTokens: acc.fullControlTokens + s.fullControlTokens,
    nonImprovingCalls: acc.nonImprovingCalls + s.nonImprovingCalls,
    argsTokens: acc.argsTokens + s.argsTokens,
    argsTokensWithCompact: acc.argsTokensWithCompact + s.argsTokensWithCompact,
    argsTokensWithFull: acc.argsTokensWithFull + s.argsTokensWithFull,
  }),
  {
    calls: 0,
    resultsCaptured: 0,
    errors: 0,
    errorResultTokens: 0,
    replayed: 0,
    unreplayable: 0,
    beforeBytes: 0,
    beforeTokens: 0,
    afterBytes: 0,
    afterTokens: 0,
    fullControlBytes: 0,
    fullControlTokens: 0,
    nonImprovingCalls: 0,
    argsTokens: 0,
    argsTokensWithCompact: 0,
    argsTokensWithFull: 0,
  },
);

// Replayed-subset totals: the only apples-to-apples aggregate.
const replayedTotals = perTool.reduce(
  (acc, s) => ({
    beforeBytes: acc.beforeBytes + s.replayedBeforeBytes,
    beforeTokens: acc.beforeTokens + s.replayedBeforeTokens,
    afterBytes: acc.afterBytes + s.afterBytes,
    afterTokens: acc.afterTokens + s.afterTokens,
    fullControlTokens: acc.fullControlTokens + s.fullControlTokens,
  }),
  {
    beforeBytes: 0,
    beforeTokens: 0,
    afterBytes: 0,
    afterTokens: 0,
    fullControlTokens: 0,
  },
);

// --- how much of the true before-volume was NOT measured -------------------
// Every excluded call is one the probe could not measure, and the exclusions
// are NOT symmetric: `fetch_ledger` is a mandatory-projection tool whose six
// captured calls all used the RS3-era default-full path and overflowed the host
// limit, so replaying them could only INCREASE the measured saving. The notices
// state the elided sizes verbatim, which bounds what was missed. `KB` is not
// disambiguated by the host, so both readings are carried.
const BYTES_PER_KB_DECIMAL = 1000;
const BYTES_PER_KB_BINARY = 1024;
const bytesPerToken = replayedTotals.beforeBytes / replayedTotals.beforeTokens;
const elidedExactCharacters = elidedResults.reduce(
  (a, e) => a + (e.statedPayloadCharacters ?? 0),
  0,
);
const elidedStatedKilobytes = elidedResults.reduce(
  (a, e) => a + (e.statedPayloadKilobytes ?? 0),
  0,
);
const elidedLowerBytes =
  elidedExactCharacters + elidedStatedKilobytes * BYTES_PER_KB_DECIMAL;
const elidedUpperBytes =
  elidedExactCharacters + elidedStatedKilobytes * BYTES_PER_KB_BINARY;
const unmeasuredBeforeVolume = {
  note:
    "Payloads the HOST elided before they reached the transcript. Not measurable, " +
    "but self-describing: each notice states the size it replaced. The omission is " +
    "one-directional in the contract's favour — every elided call is a large " +
    "mandatory-projection response that overflowed on the RS3-era default-full " +
    "path, so replaying it could only increase the measured saving.",
  elidedResults,
  elidedCalls: elidedResults.length,
  statedCharactersExact: elidedExactCharacters,
  statedKilobytesRounded: Number(elidedStatedKilobytes.toFixed(1)),
  elidedBytesLowerBound: elidedLowerBytes,
  elidedBytesUpperBound: elidedUpperBytes,
  corpusBytesPerToken: Number(bytesPerToken.toFixed(4)),
  elidedTokensLowerBound: Math.round(elidedLowerBytes / bytesPerToken),
  elidedTokensUpperBound: Math.round(elidedUpperBytes / bytesPerToken),
  measuredBeforeTokens: replayedTotals.beforeTokens,
  measuredShareOfTrueBeforeVolumePercentLowerBound: Number(
    (
      (replayedTotals.beforeTokens /
        (replayedTotals.beforeTokens + elidedUpperBytes / bytesPerToken)) *
      100
    ).toFixed(2),
  ),
  measuredShareOfTrueBeforeVolumePercentUpperBound: Number(
    (
      (replayedTotals.beforeTokens /
        (replayedTotals.beforeTokens + elidedLowerBytes / bytesPerToken)) *
      100
    ).toFixed(2),
  ),
};

// --- what the elided volume bounds, and what it does not -------------------
// S_e — the saving the 8 elided calls would have contributed — is UNOBSERVABLE,
// because their payloads are gone. Unobservable is not the same as unbounded:
// two facts already established constrain it. Every compact projection and
// every acknowledgement is a key-subset of the entity the RS3-era server
// returned, so S_e >= 0; and no after-shape is negative, so S_e <= B, where B
// is the elided before-volume. With M = measured before-tokens and
// S_m = measured saving, the true corpus-wide rate is (S_m + S_e) / (M + B),
// which over S_e in [0, B] spans [ S_m/(M+B), (S_m+B)/(M+B) ].
// The left endpoint DECREASES in B and the right endpoint INCREASES in B, so
// the widest interval over B in [elidedLower, elidedUpper] is attained at the
// largest admissible B — but the code takes the min/max over both endpoints
// rather than relying on that observation.
const corpusResponseSaving = replayedTotals.beforeTokens - replayedTotals.afterTokens;
const rateBoundCandidates = [
  unmeasuredBeforeVolume.elidedTokensLowerBound,
  unmeasuredBeforeVolume.elidedTokensUpperBound,
].map((elidedTokens) => {
  const trueBeforeTokens = replayedTotals.beforeTokens + elidedTokens;
  return {
    elidedTokens,
    trueBeforeTokens,
    /** S_e = 0: the elided calls compress not at all */
    ratePercentIfElidedSaveNothing: (corpusResponseSaving / trueBeforeTokens) * 100,
    /** S_e = B: the elided calls compress to nothing */
    ratePercentIfElidedSaveEverything:
      ((corpusResponseSaving + elidedTokens) / trueBeforeTokens) * 100,
  };
});
const worstRateCase = rateBoundCandidates.reduce((a, b) =>
  b.ratePercentIfElidedSaveNothing < a.ratePercentIfElidedSaveNothing ? b : a,
);
const bestRateCase = rateBoundCandidates.reduce((a, b) =>
  b.ratePercentIfElidedSaveEverything > a.ratePercentIfElidedSaveEverything ? b : a,
);
const corpusWideSavingRateBounds = {
  note:
    "The measured 74%-ish rate is computed over the replayed subset only, so it is " +
    "not itself a bound on the true corpus-wide rate. The true rate is nonetheless " +
    "BOUNDED, by 0 <= S_e <= B: it lies in [lowerBoundPercent, upperBoundPercent]. " +
    "The absolute saving keeps its stronger property of being a strict lower bound.",
  measuredRatePercentOverReplayedSubset: Number(
    ((corpusResponseSaving / replayedTotals.beforeTokens) * 100).toFixed(2),
  ),
  measuredSavedTokens: corpusResponseSaving,
  measuredBeforeTokens: replayedTotals.beforeTokens,
  lowerBoundPercent: Number(worstRateCase.ratePercentIfElidedSaveNothing.toFixed(2)),
  upperBoundPercent: Number(bestRateCase.ratePercentIfElidedSaveEverything.toFixed(2)),
  lowerBoundFraction: `${corpusResponseSaving}/${worstRateCase.trueBeforeTokens}`,
  upperBoundFraction: `${corpusResponseSaving + bestRateCase.elidedTokens}/${bestRateCase.trueBeforeTokens}`,
  candidates: rateBoundCandidates.map((c) => ({
    elidedTokens: c.elidedTokens,
    trueBeforeTokens: c.trueBeforeTokens,
    ratePercentIfElidedSaveNothing: Number(c.ratePercentIfElidedSaveNothing.toFixed(2)),
    ratePercentIfElidedSaveEverything: Number(
      c.ratePercentIfElidedSaveEverything.toFixed(2),
    ),
  })),
};

// Input-side cost of the mandatory projection parameter, over the calls that
// the cutover made projection-bearing.
const projectionTools = perTool.filter(
  (s) => s.contractKind === "mandatory-item-projection",
);
const inputSideCost = {
  projectionBearingCalls: projectionTools.reduce((a, s) => a + s.calls, 0),
  argTokensCompact: projectionTools.reduce(
    (a, s) => a + (s.argsTokensWithCompact - s.argsTokens),
    0,
  ),
  argTokensFull: projectionTools.reduce(
    (a, s) => a + (s.argsTokensWithFull - s.argsTokens),
    0,
  ),
};

const problems = perTool.flatMap((s) => s.correctnessProblems);

// --- session-level amortization of the cold tools/list schema --------------
// The cutover also enlarged the tool schema (measure it with
// `schema-overhead.ts` against both trees). A response saving is only a net
// saving once that per-context cost is accounted for. These are SCENARIOS
// over explicit assumptions, not measurements of anything billed.
const schemaDelta = Number(arg("schema-delta", "2498"));
const withCalls = perTranscript.filter((t) => t.ledgerCalls > 0);
const netSavingOf = (t: TranscriptStats): number =>
  t.beforeTokens - t.afterTokens - t.argsDeltaTokens;
const savingsPerTranscript = withCalls.map(netSavingOf).sort((a, b) => a - b);
const corpusArgsCost = inputSideCost.argTokensCompact;

// How much could the host-elided calls move the per-transcript MEDIAN? Their
// payloads are unrecoverable, but their LOCATION is known, and that is enough:
// a transcript already above the median cannot move the median however far it
// is lifted. The counterfactual below lifts every holder arbitrarily (to +inf)
// and recomputes — the strongest admissible perturbation.
const halfOfCallingTranscripts = Math.ceil(withCalls.length / 2);
const elidedTranscriptNames = new Set(elidedResults.map((e) => e.transcript));
const elidedHolders = [...withCalls]
  .sort((a, b) => netSavingOf(a) - netSavingOf(b))
  .map((t, index) => ({
    transcript: t.name,
    rankAscending: index + 1,
    netSavingTokens: netSavingOf(t),
    aboveMedian: index + 1 > halfOfCallingTranscripts,
  }))
  .filter((r) => elidedTranscriptNames.has(r.transcript));
const medianIfEveryHolderLiftedArbitrarily = median(
  withCalls.map((t) =>
    elidedTranscriptNames.has(t.name) ? Number.POSITIVE_INFINITY : netSavingOf(t),
  ),
);
const medianRobustnessToElidedCalls = {
  note:
    "Upper bound on how far the 8 elided calls could move the median net saving " +
    "per calling transcript: every transcript holding one is lifted to +infinity " +
    "and the median recomputed. Holders already above the median cannot move it.",
  transcriptsHoldingElidedCalls: elidedHolders,
  holdersAlreadyAboveMedian: elidedHolders.filter((r) => r.aboveMedian).length,
  medianIfEveryHolderLiftedArbitrarily,
};
const sessionAmortization = {
  schemaDeltaTokensPerContext: schemaDelta,
  transcripts: perTranscript.length,
  transcriptsWithLedgerCalls: withCalls.length,
  transcriptsWithoutLedgerCalls: perTranscript.length - withCalls.length,
  transcriptsWhereNetSavingExceedsSchemaDelta: savingsPerTranscript.filter(
    (v) => v > schemaDelta,
  ).length,
  medianNetResponseSavingPerCallingTranscript: median(savingsPerTranscript),
  maxNetResponseSavingPerCallingTranscript:
    savingsPerTranscript[savingsPerTranscript.length - 1] ?? 0,
  medianRobustnessToElidedCalls,
  scenarios: {
    schemaFullyCachedOrIgnored: corpusResponseSaving - corpusArgsCost,
    schemaChargedOncePerCallingTranscript:
      corpusResponseSaving - corpusArgsCost - withCalls.length * schemaDelta,
    schemaChargedOncePerTranscript:
      corpusResponseSaving - corpusArgsCost - perTranscript.length * schemaDelta,
  },
};

const report = {
  probe: "T679 RS3-corpus re-measurement of implemented wire shapes",
  generatedAt: new Date().toISOString(),
  tokenizer: "gpt-tokenizer@3.4.0 / o200k_base",
  corpus: {
    root: manifest.corpusRoot,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    sha256Verified: true,
    rs3PinnedSourceCommit: manifest.rs3PinnedSourceCommit,
    jsonlLines,
    jsonlParseFailures,
  },
  workspaceUnderMeasurement: WORKSPACE,
  totals,
  replayedSubset: {
    beforeBytes: replayedTotals.beforeBytes,
    beforeTokens: replayedTotals.beforeTokens,
    afterBytes: replayedTotals.afterBytes,
    afterTokens: replayedTotals.afterTokens,
    savedBytes: replayedTotals.beforeBytes - replayedTotals.afterBytes,
    savedTokens: replayedTotals.beforeTokens - replayedTotals.afterTokens,
    savedPercent: Number(
      (
        ((replayedTotals.beforeTokens - replayedTotals.afterTokens) /
          replayedTotals.beforeTokens) *
        100
      ).toFixed(2),
    ),
    fullControlTokens: replayedTotals.fullControlTokens,
    fullControlDeltaTokens:
      replayedTotals.fullControlTokens - replayedTotals.beforeTokens,
    /** median of per-call DELTAS (not a difference of medians) */
    medianPerCallDeltaTokens: median(perTool.flatMap((s) => s.perCallDeltaTokens)),
  },
  mcpToolNameAudit,
  unmeasuredBeforeVolume,
  corpusWideSavingRateBounds,
  inputSideCost,
  sessionAmortization,
  perTranscript: perTranscript.filter((t) => t.ledgerCalls > 0),
  perTool: perTool.map((s) => ({
    tool: s.tool,
    contractKind: s.contractKind,
    calls: s.calls,
    resultsCaptured: s.resultsCaptured,
    errors: s.errors,
    errorResultTokens: s.errorTokens,
    replayed: s.replayed,
    unreplayable: s.unreplayable,
    unreplayableReasons: s.unreplayableReasons,
    capturedBeforeBytes: s.beforeBytes,
    capturedBeforeTokens: s.beforeTokens,
    beforeBytes: s.replayedBeforeBytes,
    beforeTokens: s.replayedBeforeTokens,
    afterBytes: s.afterBytes,
    afterTokens: s.afterTokens,
    savedBytes: s.replayedBeforeBytes - s.afterBytes,
    savedTokens: s.replayedBeforeTokens - s.afterTokens,
    savedPercent:
      s.replayedBeforeTokens === 0
        ? 0
        : Number(
            (
              ((s.replayedBeforeTokens - s.afterTokens) / s.replayedBeforeTokens) *
              100
            ).toFixed(2),
          ),
    fullControlBytes: s.fullControlBytes,
    fullControlTokens: s.fullControlTokens,
    fullControlDeltaTokens: s.fullControlTokens - s.replayedBeforeTokens,
    nonImprovingCalls: s.nonImprovingCalls,
    worstRegressionTokens: s.worstRegressionTokens,
    /** over every non-error captured call, replayable or not */
    medianCapturedBeforeTokens: median(s.perCallBeforeTokens),
    /** the three below are paired over exactly the replayed calls */
    medianBeforeTokens: median(s.perCallReplayedBeforeTokens),
    medianAfterTokens: median(s.perCallAfterTokens),
    medianDeltaTokens: median(s.perCallDeltaTokens),
    differenceOfMediansTokens:
      median(s.perCallReplayedBeforeTokens) - median(s.perCallAfterTokens),
    argsTokens: s.argsTokens,
    argsProjectionCompactDeltaTokens: s.argsTokensWithCompact - s.argsTokens,
    argsProjectionFullDeltaTokens: s.argsTokensWithFull - s.argsTokens,
    correctnessProblems: s.correctnessProblems,
  })),
  correctnessProblemCount: problems.length,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const out = resolve(arg("out", join(import.meta.dir, "out/corpus-remeasurement.json")));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

// --- embedded assertions ---------------------------------------------------
const assertions: string[] = [];
if (manifest.fileCount !== 357) assertions.push("corpus file count is not 357");
if (manifest.totalBytes !== 95_152_796) assertions.push("corpus byte count is not 95,152,796");
if (jsonlParseFailures !== 0) assertions.push(`${jsonlParseFailures} JSONL lines failed to parse`);
const unmatchedNames = Object.keys(mcpToolNameAudit.unmatchedMcpToolNames);
if (unmatchedNames.length !== 0) {
  assertions.push(
    `${unmatchedNames.length} mcp__ tool name(s) did not split into server/tool: ${unmatchedNames.join(", ")}`,
  );
}
if (problems.length !== 0) assertions.push(`${problems.length} compact/ack correctness problems`);
if (assertions.length > 0) {
  console.error("ASSERTION FAILURES:");
  for (const failure of assertions) console.error(`  - ${failure}`);
}

console.log(`wrote ${out}`);
console.log(
  JSON.stringify(
    {
      corpus: report.corpus,
      totals: report.totals,
      replayedSubset: report.replayedSubset,
      mcpToolNameAudit: {
        unmatchedMcpToolNames: report.mcpToolNameAudit.unmatchedMcpToolNames,
        ledgerCallsByServer: report.mcpToolNameAudit.ledgerCallsByServer,
      },
      unmeasuredBeforeVolume: {
        elidedCalls: report.unmeasuredBeforeVolume.elidedCalls,
        statedCharactersExact: report.unmeasuredBeforeVolume.statedCharactersExact,
        elidedTokensLowerBound: report.unmeasuredBeforeVolume.elidedTokensLowerBound,
        elidedTokensUpperBound: report.unmeasuredBeforeVolume.elidedTokensUpperBound,
      },
      corpusWideSavingRateBounds: {
        measuredRatePercentOverReplayedSubset:
          report.corpusWideSavingRateBounds.measuredRatePercentOverReplayedSubset,
        lowerBoundPercent: report.corpusWideSavingRateBounds.lowerBoundPercent,
        upperBoundPercent: report.corpusWideSavingRateBounds.upperBoundPercent,
        lowerBoundFraction: report.corpusWideSavingRateBounds.lowerBoundFraction,
        upperBoundFraction: report.corpusWideSavingRateBounds.upperBoundFraction,
      },
      inputSideCost: report.inputSideCost,
      sessionAmortization: report.sessionAmortization,
      correctnessProblemCount: report.correctnessProblemCount,
    },
    null,
    2,
  ),
);
for (const tool of report.perTool) {
  console.log(
    [
      tool.tool.padEnd(22),
      tool.contractKind.padEnd(26),
      `calls=${String(tool.calls).padStart(4)}`,
      `replayed=${String(tool.replayed).padStart(4)}`,
      `before=${String(tool.beforeTokens).padStart(7)}`,
      `after=${String(tool.afterTokens).padStart(7)}`,
      `saved=${String(tool.savedTokens).padStart(7)}`,
      `${String(tool.savedPercent).padStart(6)}%`,
      `nonImproving=${tool.nonImprovingCalls}`,
    ].join(" "),
  );
}
process.exit(assertions.length === 0 ? 0 : 1);
