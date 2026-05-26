/**
 * platform.ts — macOS platform detection for cross-platform key-chord logic.
 *
 * Uses navigator.platform (legacy but widely supported) as the primary signal,
 * and navigator.userAgentData.platform (UACH, Chromium 90+) as a secondary
 * check when the object is present.
 *
 * Takes an optional nav parameter for test injection so callers can stub
 * navigator without touching globalThis.
 */

interface NavLike {
  platform: string;
  userAgentData?: { platform: string };
}

/**
 * Returns true when the current navigator indicates a macOS platform.
 *
 * Priority:
 *   1. nav.userAgentData.platform === 'macOS'  (UACH — reliable on Chromium)
 *   2. nav.platform.startsWith('Mac')           (legacy — works everywhere)
 *
 * If nav is omitted, reads from globalThis.navigator.
 */
export function isMacPlatform(nav?: NavLike): boolean {
  let n: NavLike;
  if (nav !== undefined) {
    n = nav;
  } else if (typeof navigator !== "undefined") {
    const uad = (navigator as unknown as { userAgentData?: { platform: string } }).userAgentData;
    n = uad !== undefined ? { platform: navigator.platform, userAgentData: uad } : { platform: navigator.platform };
  } else {
    n = { platform: "" };
  }

  if (n.userAgentData?.platform === "macOS") return true;
  return n.platform.startsWith("Mac");
}
