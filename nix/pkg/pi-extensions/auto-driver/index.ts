// index.ts — cq auto-driver Pi extension entry point (T468, G-auto-driver).
//
// Exports `registerAllAutoCommands` — the single function that registers ALL
// FOUR `:auto` commands into a live Pi session. Call this from the Pi extension
// default export (T469 will wire it into nix/hm/pi.nix):
//
//   import { registerAllAutoCommands } from "./auto-driver/index.ts";
//   export default function(pi) { registerAllAutoCommands(pi); }
//
// Four commands are registered (names WITHOUT the leading `/`; Pi prepends `/`
// when they appear as slash commands in the session):
//
//   cq:advance:auto      — drains the whole flow  (wraps /cq:advance)
//   cq:plan:auto         — drains plan-flow        (wraps /cq:plan:advance)
//   cq:investigate:auto  — drains investigate-flow  (wraps /cq:investigate:advance)
//   cq:implement:auto    — drains implement-flow    (wraps /cq:implement:advance)
//
// Pi-typing discipline: this module is a STANDALONE store-path file OUTSIDE the
// cq-ledgers bun workspace; it follows the copy-not-import discipline of
// cq-subagent-dispatch.ts. It MUST NOT import @cq/* or @earendil-works/pi-*.

import {
  advanceAutoPreset,
  planAutoPreset,
  investigateAutoPreset,
  implementAutoPreset,
} from "./decision";
import {
  registerAutoDriver,
  type DriverRegistrationApi,
} from "./driver";

/**
 * Register all four `:auto` commands into the Pi session.
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
 *   `maxIterations` — hard iteration bound for ALL four commands (default:
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
}
