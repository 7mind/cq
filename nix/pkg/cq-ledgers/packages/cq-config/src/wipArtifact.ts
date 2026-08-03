/** A self-describing partial-work artifact that can be safely harvested. */

export const WIP_CHECKPOINT_STATUSES = ["done", "todo", "unmeasured"] as const;

export type WipCheckpointStatus = (typeof WIP_CHECKPOINT_STATUSES)[number];

export interface WipArtifactCheckpoint {
  readonly name: string;
  readonly status: WipCheckpointStatus;
  readonly body: string;
}

export interface WipArtifact {
  readonly id: string;
  readonly role: string;
  readonly baseCommit: string;
  readonly startedAt: string;
  readonly checkpoints: readonly WipArtifactCheckpoint[];
  readonly complete: boolean;
  readonly openCheckpoints: readonly string[];
}

type WipArtifactHeader = {
  readonly id: string;
  readonly role: string;
  readonly baseCommit: string;
  readonly startedAt: string;
  readonly checkpoints: readonly Omit<WipArtifactCheckpoint, "body">[];
};

/** A catchable boundary diagnostic for a present but malformed WIP artifact. */
export class WipArtifactParseError extends Error {
  constructor(
    readonly candidatePath: string,
    readonly reason: string,
  ) {
    super(`Cannot parse WIP artifact at ${candidatePath}: ${reason}`);
    this.name = "WipArtifactParseError";
  }
}

/** Serialize an artifact with a strict JSON header and readable Markdown sections. */
export function serializeWipArtifact(artifact: WipArtifact): string {
  const header = validateArtifact(artifact, "artifact");
  const headerText = JSON.stringify(
    {
      taskId: header.id,
      role: header.role,
      baseCommit: header.baseCommit,
      startedAt: header.startedAt,
      checkpoints: header.checkpoints,
    },
    null,
    2,
  );
  const sections = artifact.checkpoints
    .map(
      (checkpoint, index) => `${index === 0 ? "" : "\n"}## ${checkpoint.name}\n${checkpoint.body}`,
    )
    .join("");
  return "```json\n" + headerText + "\n```\n" + sections;
}

/**
 * Parse an artifact boundary strictly while retaining all Markdown body text as
 * opaque checkpoint content. Callers can catch {@link WipArtifactParseError}
 * to distinguish a malformed present file from no file at all.
 */
export function parseWipArtifact(candidatePath: string, content: string): WipArtifact {
  const headerMatch = /^```json\r?\n([\s\S]*?)\r?\n```\r?\n/.exec(content);
  if (headerMatch === null) {
    throw new WipArtifactParseError(candidatePath, "missing fenced JSON header");
  }

  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(headerMatch[1]!);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "malformed JSON header";
    throw new WipArtifactParseError(candidatePath, `malformed JSON header: ${reason}`);
  }

  const header = parseHeader(candidatePath, parsedHeader);
  const markdown = content.slice(headerMatch[0].length);
  const checkpoints = parseCheckpointBodies(header.checkpoints, markdown);
  const openCheckpoints = checkpoints
    .filter((checkpoint) => checkpoint.status !== "done")
    .map((checkpoint) => checkpoint.name);

  return {
    id: header.id,
    role: header.role,
    baseCommit: header.baseCommit,
    startedAt: header.startedAt,
    checkpoints,
    complete: openCheckpoints.length === 0,
    openCheckpoints,
  };
}

function parseHeader(candidatePath: string, value: unknown): WipArtifactHeader {
  if (!isRecord(value)) {
    throw new WipArtifactParseError(candidatePath, "JSON header must be an object");
  }

  const idEntries = ["taskId", "hypothesisId", "researchId"]
    .map((field) => value[field])
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (idEntries.length !== 1) {
    throw new WipArtifactParseError(
      candidatePath,
      "header must contain exactly one non-empty taskId, hypothesisId, or researchId",
    );
  }

  const role = requiredString(value, "role", candidatePath);
  const baseCommit = requiredString(value, "baseCommit", candidatePath);
  const startedAt = requiredString(value, "startedAt", candidatePath);
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length === 0) {
    throw new WipArtifactParseError(candidatePath, "header checkpoints must be a non-empty list");
  }

  const checkpointNames = new Set<string>();
  const checkpoints = value.checkpoints.map((checkpoint, index) => {
    if (!isRecord(checkpoint)) {
      throw new WipArtifactParseError(candidatePath, `checkpoint ${index} must be an object`);
    }
    const name = requiredString(checkpoint, "name", candidatePath);
    if (name.includes("\n") || name.includes("\r")) {
      throw new WipArtifactParseError(
        candidatePath,
        `checkpoints[${index}].name must be a single line`,
      );
    }
    if (checkpointNames.has(name)) {
      throw new WipArtifactParseError(
        candidatePath,
        `checkpoint name ${JSON.stringify(name)} is duplicated`,
      );
    }
    checkpointNames.add(name);
    const status = checkpoint.status;
    if (!isWipCheckpointStatus(status)) {
      throw new WipArtifactParseError(
        candidatePath,
        `checkpoints[${index}].status must be done, todo, or unmeasured`,
      );
    }
    return { name, status };
  });

  return { id: idEntries[0]!, role, baseCommit, startedAt, checkpoints };
}

function validateArtifact(artifact: WipArtifact, candidatePath: string): WipArtifactHeader {
  return parseHeader(candidatePath, {
    taskId: artifact.id,
    role: artifact.role,
    baseCommit: artifact.baseCommit,
    startedAt: artifact.startedAt,
    checkpoints: artifact.checkpoints,
  });
}

function parseCheckpointBodies(
  checkpoints: readonly Omit<WipArtifactCheckpoint, "body">[],
  markdown: string,
): WipArtifactCheckpoint[] {
  const markers = checkpoints
    .flatMap((checkpoint, checkpointIndex) =>
      findCheckpointMarkers(markdown, checkpoint.name).map((marker) => ({
        ...marker,
        checkpointIndex,
      })),
    )
    .sort((left, right) => left.headingStart - right.headingStart);
  const bodies = checkpoints.map(() => "");

  if (markers.length === 0) {
    bodies[0] = markdown;
  } else {
    const first = markers[0]!;
    if (first.sectionStart > 0) {
      bodies[0] = markdown.slice(0, first.sectionStart);
    }
    for (const [markerIndex, marker] of markers.entries()) {
      const nextMarker = markers[markerIndex + 1];
      bodies[marker.checkpointIndex] = markdown.slice(
        marker.contentStart,
        nextMarker?.sectionStart ?? markdown.length,
      );
    }
  }

  return checkpoints.map((checkpoint, index) => ({ ...checkpoint, body: bodies[index]! }));
}

function findCheckpointMarkers(
  markdown: string,
  name: string,
): readonly { sectionStart: number; headingStart: number; contentStart: number }[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^## ${escapedName}\\r?\\n`, "gm");
  return Array.from(markdown.matchAll(matcher), (match) => {
    const headingStart = match.index!;
    return {
      sectionStart: headingStart === 0 ? 0 : headingStart - 1,
      headingStart,
      contentStart: headingStart + match[0].length,
    };
  });
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  candidatePath: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new WipArtifactParseError(candidatePath, `header ${field} must be a non-empty string`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWipCheckpointStatus(value: unknown): value is WipCheckpointStatus {
  return (
    typeof value === "string" && (WIP_CHECKPOINT_STATUSES as readonly string[]).includes(value)
  );
}
