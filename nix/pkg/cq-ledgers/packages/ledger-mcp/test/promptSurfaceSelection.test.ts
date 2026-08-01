import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { serializePromptSurfaceManifest } from "@cq/config";
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
let explicitPiRoot: string;

function writePromptRoot(root: string, surface: PromptSurface, body: string): void {
  mkdirSync(path.join(root, "roles"), { recursive: true });
  const roleBytes = encoder.encode(body);
  const catalogBytes = encoder.encode(
    JSON.stringify([
      {
        roleId: ROLE_ID,
        roleKind: "dispatched-subagent",
        sidecar: { schemaRoleId: ROLE_ID },
      },
    ]),
  );
  const roles = [
    {
      roleId: ROLE_ID,
      version: 1,
      sha256: createHash("sha256").update(roleBytes).digest("hex"),
    },
  ];
  const surfaceJson = serializePromptSurfaceManifest(
    surface,
    createHash("sha256").update(catalogBytes).digest("hex"),
    roles,
  );
  writeFileSync(path.join(root, "surface.json"), surfaceJson);
  writeFileSync(path.join(root, "catalog.json"), catalogBytes);
  writeFileSync(path.join(root, "roles", `${ROLE_ID}.md`), roleBytes);
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
    writePromptRoot(path.join(surfacesRoot, surface), surface, promptBody(surface));
  }
  explicitRoot = path.join(fixtureRoot, "explicit");
  writePromptRoot(explicitRoot, "codex", "explicit root bytes\n");
  explicitPiRoot = path.join(fixtureRoot, "explicit-pi");
  writePromptRoot(explicitPiRoot, "pi", "explicit Pi root bytes\n");
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
        [CQ_PROMPT_ROOT_ENV]: explicitPiRoot,
        [CQ_PROMPT_SURFACE_ENV]: "pi",
        [CQ_PROMPT_SURFACES_ROOT_ENV]: surfacesRoot,
      },
    });
    expect(resolved?.surface).toBe("pi");
    expect(resolved?.root).toBe(explicitPiRoot);
    expect(decoder.decode(resolved?.store.readRole(ROLE_ID).bytes)).toBe(
      "explicit Pi root bytes\n",
    );
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

  test("rejects every present selector when no usable prompt root resolves", () => {
    for (const environment of [
      { [CQ_PROMPT_SURFACE_ENV]: "codex" },
      { [CQ_PROMPT_SURFACE_ENV]: "codex", [CQ_PROMPT_ROOT_ENV]: "" },
      { [CQ_PROMPT_ROOT_ENV]: "" },
      { [CQ_PROMPT_SURFACES_ROOT_ENV]: "" },
    ]) {
      expect(() => resolve({ environment })).toThrow("does not resolve a prompt artifact root");
    }
  });

  test("returns no store only for the source-run compatibility path with no selector", () => {
    expect(resolve({ environment: { CQ_HARNESS: "codex" } })).toBeUndefined();
  });
});
