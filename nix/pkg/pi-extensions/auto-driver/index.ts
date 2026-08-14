// index.ts — cq auto-driver Pi extension entry point (T468, G-auto-driver).
//
// Exports `registerAllAutoCommands` — the single function that registers ALL
// FIVE `:auto` commands into a live Pi session. Call this from the Pi extension
// default export (T469 will wire it into nix/hm/pi.nix):
//
//   import { registerAllAutoCommands } from "./auto-driver/index.ts";
//   export default function(pi) { registerAllAutoCommands(pi); }
//
// Five commands are registered (names WITHOUT the leading `/`; Pi prepends `/`
// when they appear as slash commands in the session):
//
//   cq:advance:auto      — drains the whole flow  (wraps /cq:advance)
//   cq:plan:auto         — drains plan-flow        (wraps /cq:plan:advance)
//   cq:investigate:auto  — drains investigate-flow  (wraps /cq:investigate:advance)
//   cq:research:auto     — drains research-flow     (wraps /cq:research:advance)
//   cq:implement:auto    — drains implement-flow    (wraps /cq:implement:advance)
//
// Pi host types enter through driver.ts as type-only root-package imports,
// resolved by the Nix check/local script against packages.pi-coding-agent as
// the single source of truth. Runtime delivery remains a bare store-path
// directory with only local value imports. By explicit user directive for
// G136, this supersedes the gen-1 M585–M587/T1402–T1404 manual host-type refresh
// and citation checks; host API drift now fails compilation.

import {
  advanceAutoPreset,
  planAutoPreset,
  investigateAutoPreset,
  implementAutoPreset,
  researchAutoPreset,
} from "./decision";
import {
  registerAutoDriver,
  type DriverRegistrationApi,
} from "./driver";

/**
 * Register all five `:auto` commands into the Pi session.
 *
 * Each command is a thin preset wrapper over the generic `runAutoDriver` loop:
 * it binds the correct `{ wrappedCommand, terminalPredicate }` from the
 * preset descriptors in `./decision`.
 *
 * Pass the Pi `ExtensionAPI` (or any structural equivalent implementing
 * `DriverRegistrationApi`) — this is the `pi` argument passed to the
 * extension factory function by Pi's loader.
 *
 * Options:
 *   `maxIterations` — hard iteration bound for ALL five commands (default:
 *   `DEFAULT_MAX_ITERATIONS` = 25). Override in tests or when a lower budget
 *   is preferred.
 */
export function registerAllAutoCommands(
  api: DriverRegistrationApi,
  options?: { maxIterations?: number },
): void {
  registerAutoDriver(api, advanceAutoPreset, options);
  registerAutoDriver(api, planAutoPreset, options);
  registerAutoDriver(api, investigateAutoPreset, options);
  registerAutoDriver(api, implementAutoPreset, options);
  registerAutoDriver(api, researchAutoPreset, options);
}

// Pi extension default export (T469): the loader calls this with the live Pi
// ExtensionAPI, which satisfies DriverRegistrationApi structurally.
export default function cqAutoDriver(pi: DriverRegistrationApi): void {
  registerAllAutoCommands(pi);
}
