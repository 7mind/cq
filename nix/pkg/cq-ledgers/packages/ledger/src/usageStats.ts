/**
 * Per-endpoint MCP usage statistics (I20/G155, T1508): typed snapshot model,
 * pure UTF-8 byte measurement helpers, and an in-memory tracker. Endpoint
 * identity is the canonical unprefixed MCP tool name. No I/O here.
 */

export interface EndpointUsage {
  readonly name: string;
  readonly callCount: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

export interface UsageStatsSnapshot {
  readonly endpoints: readonly EndpointUsage[];
  readonly totals: EndpointUsage;
}

/** UTF-8 byte length of a value's canonical JSON serialization. */
export function measureUtf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** UTF-8 byte length of a text payload. */
export function measureUtf8TextBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** In-memory usage tracker: accumulates calls and bytes per endpoint name. */
export class UsageTracker {
  private readonly usage = new Map<string, { callCount: number; bytesIn: number; bytesOut: number }>();

  record(name: string, bytesIn: number, bytesOut: number): void {
    const current = this.usage.get(name) ?? { callCount: 0, bytesIn: 0, bytesOut: 0 };
    current.callCount += 1;
    current.bytesIn += bytesIn;
    current.bytesOut += bytesOut;
    this.usage.set(name, current);
  }

  snapshot(): UsageStatsSnapshot {
    const endpoints = [...this.usage.entries()]
      .map(([name, usage]) => ({ name, ...usage }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const totals = endpoints.reduce(
      (acc, endpoint) => ({
        name: "totals",
        callCount: acc.callCount + endpoint.callCount,
        bytesIn: acc.bytesIn + endpoint.bytesIn,
        bytesOut: acc.bytesOut + endpoint.bytesOut,
      }),
      { name: "totals", callCount: 0, bytesIn: 0, bytesOut: 0 },
    );
    return { endpoints, totals };
  }
}
