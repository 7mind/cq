import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  ACTIVE_HARNESSES,
  HARNESSES,
  INTENTIONAL_DIFFERENCE_DECLARATION_SCHEMA,
  INTENTIONAL_DIFFERENCE_KINDS,
  PROMPT_SURFACES,
  parseIntentionalDifferenceDeclaration,
  parseIntentionalDifferenceDeclarationJSON,
  serializeIntentionalDifferenceDeclaration,
  type ActiveHarness,
  type Harness,
  type IntentionalDifferenceKind,
  type PromptSurface,
} from "@cq/config";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const promptSurfaceTypeIsClosed: Equal<PromptSurface, "claude" | "codex" | "pi"> = true;
const differenceKindTypeIsClosed: Equal<
  IntentionalDifferenceKind,
  "invocation-syntax" | "dispatch-protocol" | "recursion-protocol" | "tool-vocabulary"
> = true;
const dispatchHarnessRemainsDistinct: Equal<Harness, "claude" | "codex" | "pi"> = true;
/**
 * T861: THREE domains coexist and must not collapse. A prompt surface selects a
 * rendered prompt representation; an ActiveHarness selects which `[harness.*]`
 * config block is in force; a Harness names an EXECUTABLE dispatch transport.
 * Codex participates in all three domains.
 */
const activeSelectorAdmitsCodex: Equal<ActiveHarness, "claude" | "pi" | "codex"> = true;
const codexIsAnExecutableDispatchTransport: Equal<Extract<ActiveHarness, Harness>, "claude" | "codex" | "pi"> =
  true;

const NIX_FIXTURE_URL = new URL("../../../../../lib/prompt-surfaces-fixture.json", import.meta.url);

describe("typed prompt surfaces", () => {
  test("the runtime vocabularies retain their closed compile-time unions", () => {
    expect(promptSurfaceTypeIsClosed).toBe(true);
    expect(differenceKindTypeIsClosed).toBe(true);
    expect(dispatchHarnessRemainsDistinct).toBe(true);
    expect(activeSelectorAdmitsCodex).toBe(true);
    expect(codexIsAnExecutableDispatchTransport).toBe(true);
    expect(PROMPT_SURFACES).toEqual(["claude", "codex", "pi"]);
    expect(ACTIVE_HARNESSES).toEqual(["claude", "pi", "codex"]);
    expect(HARNESSES).toEqual(["claude", "codex", "pi"]);
    expect(INTENTIONAL_DIFFERENCE_KINDS).toEqual([
      "invocation-syntax",
      "dispatch-protocol",
      "recursion-protocol",
      "tool-vocabulary",
    ]);
  });

  test("the Nix JSON fixture round-trips through the typed decoder", async () => {
    const nixJson = (await Bun.file(NIX_FIXTURE_URL).text()).trimEnd();
    const declaration = parseIntentionalDifferenceDeclarationJSON(nixJson);

    expect(declaration).toEqual({
      kind: "dispatch-protocol",
      reason: "Pi routes dispatched roles through the cq-subagent extension.",
      surfaces: ["claude", "pi"],
    });
    expect(serializeIntentionalDifferenceDeclaration(declaration)).toBe(nixJson);
  });

  test("the declaration JSON Schema accepts the complete contract", () => {
    const validate = new Ajv2020({ strict: false }).compile(
      INTENTIONAL_DIFFERENCE_DECLARATION_SCHEMA,
    );

    expect(
      validate({
        kind: "tool-vocabulary",
        reason: "Codex and Pi expose different host tool names.",
        surfaces: ["codex", "pi"],
      }),
    ).toBe(true);
  });
});

describe("intentional-difference boundary validation", () => {
  const known = {
    kind: "invocation-syntax",
    reason: "Codex uses skill invocations while Claude uses slash commands.",
    surfaces: ["claude", "codex"],
  };

  test("rejects an unknown surface", () => {
    expect(() =>
      parseIntentionalDifferenceDeclaration({
        ...known,
        surfaces: ["claude", "terminal"],
      }),
    ).toThrow("intentionalDifference.surfaces[1]: expected one of claude, codex, pi");
  });

  test("rejects an unknown difference kind", () => {
    expect(() => parseIntentionalDifferenceDeclaration({ ...known, kind: "content" })).toThrow(
      "intentionalDifference.kind: expected one of invocation-syntax, dispatch-protocol, recursion-protocol, tool-vocabulary",
    );
  });

  test("rejects duplicate participating surfaces", () => {
    expect(() =>
      parseIntentionalDifferenceDeclaration({
        ...known,
        surfaces: ["codex", "codex"],
      }),
    ).toThrow('intentionalDifference.surfaces[1]: duplicate prompt surface "codex"');
  });

  test("rejects a missing or blank reason", () => {
    const withoutReason = {
      kind: known.kind,
      surfaces: known.surfaces,
    };
    expect(() => parseIntentionalDifferenceDeclaration(withoutReason)).toThrow(
      "intentionalDifference.reason: expected a non-empty string",
    );
    expect(() => parseIntentionalDifferenceDeclaration({ ...known, reason: " \t " })).toThrow(
      "intentionalDifference.reason: expected a non-empty string",
    );
  });

  test("rejects malformed declaration shapes", () => {
    expect(() => parseIntentionalDifferenceDeclaration(null)).toThrow(
      "intentionalDifference: expected an object",
    );
    expect(() => parseIntentionalDifferenceDeclaration([known])).toThrow(
      "intentionalDifference: expected an object",
    );
    expect(() => parseIntentionalDifferenceDeclaration({ ...known, extra: true })).toThrow(
      "intentionalDifference.extra: unexpected property",
    );
    expect(() => parseIntentionalDifferenceDeclaration({ ...known, surfaces: "claude" })).toThrow(
      "intentionalDifference.surfaces: expected an array",
    );
    expect(() =>
      parseIntentionalDifferenceDeclaration({
        ...known,
        surfaces: ["claude"],
      }),
    ).toThrow("intentionalDifference.surfaces: expected at least two participating surfaces");
    expect(() => parseIntentionalDifferenceDeclarationJSON("{not-json")).toThrow(
      "intentionalDifference: expected valid JSON",
    );
  });
});
