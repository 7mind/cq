/**
 * packages/web public API.
 * Exports only the symbols needed for cross-package imports
 * (e.g. from packages/server/test/e2e).
 */

export { Manager } from "./ws/Manager";
export type { ManagerOpts, ManagerStats } from "./ws/Manager";
export { Connection } from "./ws/Connection";
export type { ConnectionOpts, ConnectionState, ConnectionStats, SocketLike } from "./ws/Connection";
