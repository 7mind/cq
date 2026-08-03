import { describe, expect, it } from "bun:test";
import {
  parseWipArtifact,
  serializeWipArtifact,
  WipArtifactParseError,
  type WipArtifact,
} from "../src/index.js";

const CANDIDATE_PATH = "WIP-T1284.md";

function artifact(checkpoints: WipArtifact["checkpoints"]): WipArtifact {
  return {
    id: "T1284",
    role: "implement-worker",
    baseCommit: "2f74217a08ad6af624b60da19ec69017c7ecb4f1",
    startedAt: "2026-08-03T14:00:00.000Z",
    checkpoints,
    complete: checkpoints.every((checkpoint) => checkpoint.status === "done"),
    openCheckpoints: checkpoints
      .filter((checkpoint) => checkpoint.status !== "done")
      .map((checkpoint) => checkpoint.name),
  };
}

function handwrittenHeader(header: Record<string, unknown>, body = ""): string {
  return "```json\n" + JSON.stringify(header, null, 2) + "\n```\n" + body;
}

describe("WIP artifacts (T1284)", () => {
  for (const fixture of [
    artifact([{ name: "implementation", status: "todo", body: "" }]),
    artifact([
      { name: "implementation", status: "todo", body: "" },
      { name: "verification", status: "todo", body: "" },
    ]),
    artifact([
      { name: "implementation", status: "done", body: "observed result" },
      { name: "verification", status: "done", body: "green" },
    ]),
    artifact([
      { name: "implementation", status: "done", body: "completed" },
      { name: "measurement", status: "unmeasured", body: "timed out" },
      { name: "review", status: "todo", body: "" },
    ]),
  ]) {
    it("round-trips the declared checkpoint table", () => {
      expect(parseWipArtifact(CANDIDATE_PATH, serializeWipArtifact(fixture))).toEqual(fixture);
    });
  }

  it("preserves arbitrary interleaved prose and fenced code byte-for-byte", () => {
    const prose =
      "Intro prose.\n\n### incidental heading\n\n```ts\nconst value = { nested: true };\n```\n\nConclusion.\n";
    const fixture = artifact([{ name: "evidence", status: "done", body: prose }]);
    expect(
      parseWipArtifact(CANDIDATE_PATH, serializeWipArtifact(fixture)).checkpoints[0]!.body,
    ).toBe(prose);
  });

  it("does not treat declared checkpoint headings in prose or fenced code as boundaries", () => {
    const fixture = artifact([
      {
        name: "implementation",
        status: "done",
        body:
          "A prose heading follows.\n\n## verification\n\nIt remains implementation evidence.\n\n```md\n## verification\n```\n",
      },
      { name: "verification", status: "todo", body: "Run the full gate.\n" },
    ]);
    expect(parseWipArtifact(CANDIDATE_PATH, serializeWipArtifact(fixture))).toEqual(fixture);
  });

  for (const [name, content] of [
    [
      "missing id",
      handwrittenHeader({
        role: "worker",
        baseCommit: "base",
        startedAt: "now",
        checkpoints: [{ name: "a", status: "todo" }],
      }),
    ],
    [
      "unknown status",
      handwrittenHeader({
        taskId: "T1284",
        role: "worker",
        baseCommit: "base",
        startedAt: "now",
        checkpoints: [{ name: "a", status: "partial" }],
      }),
    ],
    ["malformed json", "```json\n{ invalid\n```\n"],
    [
      "omitted checkpoints",
      handwrittenHeader({ taskId: "T1284", role: "worker", baseCommit: "base", startedAt: "now" }),
    ],
    [
      "empty checkpoints",
      handwrittenHeader({
        taskId: "T1284",
        role: "worker",
        baseCommit: "base",
        startedAt: "now",
        checkpoints: [],
      }),
    ],
  ] as const) {
    it(`throws a typed, path-bearing error for ${name}`, () => {
      try {
        parseWipArtifact(CANDIDATE_PATH, content);
        throw new Error("expected parseWipArtifact to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(WipArtifactParseError);
        expect((error as WipArtifactParseError).candidatePath).toBe(CANDIDATE_PATH);
        expect((error as WipArtifactParseError).reason).toEqual(expect.any(String));
      }
    });
  }

  for (const [name, invalidArtifact] of [
    [
      "omitted checkpoints",
      { ...artifact([{ name: "a", status: "todo", body: "" }]), checkpoints: undefined },
    ],
    ["empty checkpoints", artifact([])],
  ] as const) {
    it(`serializer throws a typed, path-bearing error for ${name}`, () => {
      try {
        serializeWipArtifact(invalidArtifact as unknown as WipArtifact);
        throw new Error("expected serializeWipArtifact to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(WipArtifactParseError);
        expect((error as WipArtifactParseError).candidatePath).toBe("artifact");
        expect((error as WipArtifactParseError).reason).toEqual(expect.any(String));
      }
    });
  }

  it("calculates incomplete checkpoints in declaration order", () => {
    const parsed = parseWipArtifact(
      CANDIDATE_PATH,
      serializeWipArtifact(
        artifact([
          { name: "first", status: "done", body: "" },
          { name: "second", status: "done", body: "" },
          { name: "timing", status: "unmeasured", body: "" },
          { name: "review", status: "todo", body: "" },
          { name: "publish", status: "todo", body: "" },
          { name: "follow-up", status: "todo", body: "" },
        ]),
      ),
    );
    expect(parsed.complete).toBe(false);
    expect(parsed.openCheckpoints).toEqual(["timing", "review", "publish", "follow-up"]);
  });

  it("parses a valid hand-written artifact without body restrictions", () => {
    const content = handwrittenHeader(
      {
        hypothesisId: "H123",
        role: "investigate-prober",
        baseCommit: "base",
        startedAt: "now",
        checkpoints: [{ name: "probe", status: "unmeasured" }],
      },
      "\nA manually written paragraph.\n\n## arbitrary heading\n\n```sh\nprintf '%s\\n' okay\n```\n",
    );
    expect(parseWipArtifact("evidence-H123.md", content)).toEqual({
      id: "H123",
      role: "investigate-prober",
      baseCommit: "base",
      startedAt: "now",
      checkpoints: [
        {
          name: "probe",
          status: "unmeasured",
          body: "\nA manually written paragraph.\n\n## arbitrary heading\n\n```sh\nprintf '%s\\n' okay\n```\n",
        },
      ],
      complete: false,
      openCheckpoints: ["probe"],
    });
  });
});
