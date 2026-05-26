/**
 * UnknownCard.tsx — placeholder card for SDK event types not yet handled.
 *
 * Renders a collapsible <details> block showing the raw SDK event as
 * formatted JSON. PR-23 will replace calls to this component with proper
 * cards for Read / Write / Edit / Bash tool events.
 */

export interface UnknownCardProps {
  sdkEvent: Record<string, unknown>;
}

export function UnknownCard({ sdkEvent }: UnknownCardProps): React.ReactElement {
  const label = typeof sdkEvent["type"] === "string" ? sdkEvent["type"] : "unknown";
  const subtype = typeof sdkEvent["subtype"] === "string" ? ` (${sdkEvent["subtype"]})` : "";

  return (
    <details>
      <summary>
        SDK event: {label}{subtype}
      </summary>
      <pre>{JSON.stringify(sdkEvent, null, 2)}</pre>
    </details>
  );
}
