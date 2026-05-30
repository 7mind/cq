/**
 * theme.ts — light / dark / auto theme controller (DARK-01).
 *
 * Mechanism:
 *   - The user's mode (light|dark|auto, default auto) persists in
 *     localStorage under `cq.theme`.
 *   - `auto` resolves against the OS via
 *     `matchMedia('(prefers-color-scheme: dark)')`, and the controller
 *     LISTENS for OS changes so the resolved theme tracks the OS live while
 *     mode === 'auto'.
 *   - The resolved theme ('light' | 'dark') is written to
 *     `document.documentElement.dataset.theme`, which global.css's
 *     `[data-theme="dark"]` selector consumes to override the theme variables.
 *
 * All operations are SYNCHRONOUS — DOM and localStorage are synchronous APIs,
 * so there is no Promise anywhere (no sync/async union).
 *
 * `initTheme()` is called once from main.tsx BEFORE React renders, so the
 * `data-theme` attribute is set before first paint (no flash of wrong theme).
 * It returns a controller whose `setMode` is wired to the gear-popup Theme
 * control for live application. `getThemeController()` exposes the singleton
 * created by `initTheme()` to components that need it without prop-drilling
 * the instance.
 */

export type ThemeMode = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "cq.theme";
export const DEFAULT_THEME_MODE: ThemeMode = "auto";

const VALID_MODES: readonly ThemeMode[] = ["light", "dark", "auto"];

/** Narrow an arbitrary string to a ThemeMode, or null if not one. */
function asThemeMode(raw: string | null): ThemeMode | null {
  return raw !== null && VALID_MODES.includes(raw as ThemeMode)
    ? (raw as ThemeMode)
    : null;
}

/**
 * Read the persisted mode. Returns DEFAULT_THEME_MODE when the key is missing,
 * invalid, or localStorage is unavailable (private browsing / SSR / tests).
 */
export function readThemeMode(): ThemeMode {
  try {
    return asThemeMode(localStorage.getItem(THEME_STORAGE_KEY)) ?? DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

/** Persist the mode. Best-effort — swallows localStorage failures. */
export function writeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // best-effort
  }
}

/**
 * Resolve a mode to a concrete theme. `auto` consults the supplied media
 * query list (`prefers-color-scheme: dark`); explicit modes ignore it and
 * override the OS.
 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

/** Apply a resolved theme to the document root. */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

/** A media-query-list shape — the subset of `MediaQueryList` we use. Injectable for tests. */
export interface MediaQueryListLike {
  matches: boolean;
  addEventListener(type: "change", listener: (e: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (e: { matches: boolean }) => void): void;
}

export interface ThemeController {
  /** The persisted mode (light|dark|auto). */
  getMode(): ThemeMode;
  /** The currently-applied resolved theme (light|dark). */
  getResolved(): ResolvedTheme;
  /** Persist + apply a new mode immediately (live). */
  setMode(mode: ThemeMode): void;
  /** Detach the OS-change listener (mainly for tests / teardown). */
  dispose(): void;
}

interface ThemeControllerDeps {
  /** Injectable for tests; defaults to window.matchMedia. */
  mql: MediaQueryListLike;
}

function defaultMql(): MediaQueryListLike {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

/**
 * Construct a theme controller: read the persisted mode, apply the resolved
 * theme, and attach an OS-change listener that re-resolves while mode==='auto'.
 * Exported (with injectable deps) so unit tests can drive it with a mock mql.
 */
export function createThemeController(deps?: Partial<ThemeControllerDeps>): ThemeController {
  const mql: MediaQueryListLike = deps?.mql ?? defaultMql();
  let mode: ThemeMode = readThemeMode();
  let resolved: ResolvedTheme = resolveTheme(mode, mql.matches);

  applyResolvedTheme(resolved);

  // Live OS tracking: when the OS scheme flips and the user is on 'auto',
  // re-resolve and re-apply. Explicit light/dark ignore the OS.
  const onOsChange = (e: { matches: boolean }): void => {
    if (mode !== "auto") return;
    resolved = resolveTheme(mode, e.matches);
    applyResolvedTheme(resolved);
  };
  mql.addEventListener("change", onOsChange);

  return {
    getMode: () => mode,
    getResolved: () => resolved,
    setMode: (next: ThemeMode) => {
      mode = next;
      writeThemeMode(next);
      resolved = resolveTheme(next, mql.matches);
      applyResolvedTheme(resolved);
    },
    dispose: () => {
      mql.removeEventListener("change", onOsChange);
    },
  };
}

// Module-level singleton, set by initTheme(). Components reach it via
// getThemeController() rather than threading the instance through props.
let singleton: ThemeController | null = null;

/**
 * Initialize the theme once, at app entry, before React renders. Idempotent:
 * a second call returns the existing controller (it does not re-attach a
 * listener or re-read).
 */
export function initTheme(): ThemeController {
  if (singleton === null) {
    singleton = createThemeController();
  }
  return singleton;
}

/**
 * Access the singleton created by initTheme(). Throws if called before
 * initialization — a programming error (fail fast), since main.tsx initializes
 * before any component mounts.
 */
export function getThemeController(): ThemeController {
  if (singleton === null) {
    throw new Error("theme controller not initialized — call initTheme() at app entry first");
  }
  return singleton;
}

/** Test-only: reset the singleton so each test constructs a fresh controller. */
export function resetThemeControllerForTests(): void {
  if (singleton !== null) {
    singleton.dispose();
    singleton = null;
  }
}
