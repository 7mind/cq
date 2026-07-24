import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CQ_PROMPT_ROOT_ENV,
  CQ_PROMPT_SURFACE_ENV,
  CQ_PROMPT_SURFACES_ROOT_ENV,
  PromptSurfaceSelectionError,
  resolvePromptSurface,
  type PromptSurface,
} from "../src/promptSurfaceSelection.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SURFACES = ["claude", "codex", "pi"] as const;
const ROLE_ID = "plan-advance";

let fixtureRoot: string;
let surfacesRoot: string;
let explicitRoot: string;

function writePromptRoot(root: string, body: string): void {
  mkdirSync(path.join(root, "roles"), { recursive: true });
  writeFileSync(
    path.join(root, "catalog.json"),
    encoder.encode(
      JSON.stringify([
        {
          roleId: ROLE_ID,
          roleKind: "dispatched-subagent",
          sidecar: { schemaRoleId: ROLE_ID },
        },
      ]),
    ),
  );
  writeFileSync(path.join(root, "roles", `${ROLE_ID}.md`), encoder.encode(body));
}

function resolve(input: {
  readonly promptSurface?: string;
  readonly promptRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}) {
  return resolvePromptSurface({
    promptSurface: input.promptSurface,
    promptRoot: input.promptRoot,
    environment: input.environment ?? {},
  });
}

function promptBody(surface: PromptSurface): string {
  return `${surface}: keep {{cq:literal}} and $ARGUMENTS unchanged\n`;
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "cq-prompt-selection-"));
  surfacesRoot = path.join(fixtureRoot, "prompt-surfaces");
  for (const surface of SURFACES) {
    writePromptRoot(path.join(surfacesRoot, surface), promptBody(surface));
  }
  explicitRoot = path.join(fixtureRoot, "explicit");
  writePromptRoot(explicitRoot, "explicit root bytes\n");
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("prompt surface selection", () => {
  test.each([...SURFACES])("selects exact packaged %s bytes without rendering", (surface) => {
    const resolved = resolve({
      environment: {
        [CQ_PROMPT_SURFACE_ENV]: surface,
        [CQ_PROMPT_SURFACES_ROOT_ENV]: surfacesRoot,
      },
    });
    expect(resolved?.surface).toBe(surface);
    expect(resolved?.root).toBe(path.join(surfacesRoot, surface));
    expect(decoder.decode(resolved?.store.readRole(ROLE_ID).bytes)).toBe(promptBody(surface));
  });

  test("an explicit root wins environment selection and repo-local source hints", () => {
    const resolved = resolve({
      promptRoot: explicitRoot,
      promptSurface: "codex",
      environment: {
        [CQ_PROMPT_ROOT_ENV]: path.join(surfacesRoot, "pi"),
        [CQ_PROMPT_SURFACE_ENV]: "pi",
        [CQ_PROMPT_SURFACES_ROOT_ENV]: surfacesRoot,
        CQ_ASSETS_DIR: path.join(fixtureRoot, "repo", "nix", "pkg", "cq-assets"),
      },
    });
    expect(resolved?.surface).toBe("codex");
    expect(resolved?.root).toBe(explicitRoot);
    expect(decoder.decode(resolved?.store.readRole(ROLE_ID).bytes)).toBe("explicit root bytes\n");
  });

  test("an explicit surface beats an injected environment root", () => {
    const resolved = resolve({
      promptSurface: "codex",
      environment: {
        [CQ_PROMPT_ROOT_ENV]: path.join(surfacesRoot, "pi"),
        [CQ_PROMPT_SURFACE_ENV]: "pi",
        [CQ_PROMPT_SURFACES_ROOT_ENV]: surfacesRoot,
      },
    });
    expect(resolved?.surface).toBe("codex");
    expect(resolved?.root).toBe(path.join(surfacesRoot, "codex"));
    expect(decoder.decode(resolved?.store.readRole(ROLE_ID).bytes)).toBe(promptBody("codex"));
  });

  test("an injected root beats CQ_PROMPT_SURFACE root selection", () => {
    const resolved = resolve({
      environment: {
        [CQ_PROMPT_ROOT_ENV]: explicitRoot,
        [CQ_PROMPT_SURFACE_ENV]: "pi",
        [CQ_PROMPT_SURFACES_ROOT_ENV]: surfacesRoot,
      },
    });
    expect(resolved?.surface).toBe("pi");
    expect(resolved?.root).toBe(explicitRoot);
    expect(decoder.decode(resolved?.store.readRole(ROLE_ID).bytes)).toBe("explicit root bytes\n");
  });

  test("defaults exactly to claude and ignores CQ_HARNESS", () => {
    const resolved = resolve({
      environment: {
        CQ_HARNESS: "pi",
        [CQ_PROMPT_SURFACES_ROOT_ENV]: surfacesRoot,
      },
    });
    expect(resolved?.surface).toBe("claude");
    expect(resolved?.root).toBe(path.join(surfacesRoot, "claude"));
    expect(decoder.decode(resolved?.store.readRole(ROLE_ID).bytes)).toBe(promptBody("claude"));
  });

  test("rejects invalid explicit and environment surfaces", () => {
    expect(() => resolve({ promptSurface: "terminal" })).toThrow(PromptSurfaceSelectionError);
    expect(() =>
      resolve({
        environment: {
          [CQ_PROMPT_SURFACE_ENV]: "terminal",
          [CQ_PROMPT_SURFACES_ROOT_ENV]: surfacesRoot,
        },
      }),
    ).toThrow('unsupported prompt surface "terminal"');
  });

  test("requires a packaged base when only an explicit surface is selected", () => {
    expect(() => resolve({ promptSurface: "codex" })).toThrow(
      `${CQ_PROMPT_SURFACES_ROOT_ENV} is required with an explicit surface`,
    );
  });

  test("returns no store only for the source-run compatibility path with no selector", () => {
    expect(resolve({ environment: { CQ_HARNESS: "codex" } })).toBeUndefined();
  });
});
