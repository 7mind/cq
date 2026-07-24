import * as path from "node:path";
import { FileSystemPromptArtifactStore, type PromptArtifactStore } from "./promptArtifactStore.js";

export const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
export type PromptSurface = (typeof PROMPT_SURFACES)[number];

export const DEFAULT_PROMPT_SURFACE: PromptSurface = "claude";
export const CQ_PROMPT_ROOT_ENV = "CQ_PROMPT_ROOT";
export const CQ_PROMPT_SURFACE_ENV = "CQ_PROMPT_SURFACE";
export const CQ_PROMPT_SURFACES_ROOT_ENV = "CQ_PROMPT_SURFACES_ROOT";

export interface PromptSurfaceSelectionInput {
  readonly promptSurface: string | undefined;
  readonly promptRoot: string | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedPromptSurface {
  readonly surface: PromptSurface;
  readonly root: string;
  readonly store: PromptArtifactStore;
}

export class PromptSurfaceSelectionError extends Error {
  constructor(detail: string) {
    super(`prompt surface selection: ${detail}`);
    this.name = "PromptSurfaceSelectionError";
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function hasEnvironmentSelector(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

export function parsePromptSurface(value: string): PromptSurface {
  if ((PROMPT_SURFACES as readonly string[]).includes(value)) {
    return value as PromptSurface;
  }
  throw new PromptSurfaceSelectionError(`unsupported prompt surface "${value}"`);
}

export function resolvePromptSurface(
  input: PromptSurfaceSelectionInput,
): ResolvedPromptSurface | undefined {
  const explicitSurface =
    input.promptSurface !== undefined ? parsePromptSurface(input.promptSurface) : undefined;
  const environmentSurface = nonEmpty(input.environment[CQ_PROMPT_SURFACE_ENV]);
  const surface =
    explicitSurface ??
    (environmentSurface !== undefined
      ? parsePromptSurface(environmentSurface)
      : DEFAULT_PROMPT_SURFACE);

  const explicitRoot = nonEmpty(input.promptRoot);
  const injectedRoot = nonEmpty(input.environment[CQ_PROMPT_ROOT_ENV]);
  const surfacesRoot = nonEmpty(input.environment[CQ_PROMPT_SURFACES_ROOT_ENV]);
  const selectorPresent =
    input.promptSurface !== undefined ||
    input.promptRoot !== undefined ||
    hasEnvironmentSelector(input.environment, CQ_PROMPT_SURFACE_ENV) ||
    hasEnvironmentSelector(input.environment, CQ_PROMPT_ROOT_ENV) ||
    hasEnvironmentSelector(input.environment, CQ_PROMPT_SURFACES_ROOT_ENV);
  let root: string | undefined;
  if (explicitRoot !== undefined) {
    root = path.resolve(explicitRoot);
  } else if (explicitSurface !== undefined) {
    if (surfacesRoot === undefined) {
      throw new PromptSurfaceSelectionError(
        `${CQ_PROMPT_SURFACES_ROOT_ENV} is required with an explicit surface`,
      );
    }
    root = path.resolve(surfacesRoot, surface);
  } else if (injectedRoot !== undefined) {
    root = path.resolve(injectedRoot);
  } else if (surfacesRoot !== undefined) {
    root = path.resolve(surfacesRoot, surface);
  }

  if (root === undefined) {
    if (selectorPresent) {
      throw new PromptSurfaceSelectionError(
        "configured prompt selector does not resolve a prompt artifact root",
      );
    }
    return undefined;
  }
  return Object.freeze({
    surface,
    root,
    store: new FileSystemPromptArtifactStore(root),
  });
}
