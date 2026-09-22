import React, { useEffect, useState } from "react";
import type { CohortStatusViewV1 } from "@cq/ledger";
import type { WorksetCapableLedgerClient } from "./types.js";

export function CohortStatus({ client }: { readonly client: Pick<WorksetCapableLedgerClient, "getCohortStatus"> }): React.ReactElement {
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<CohortStatusViewV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setStatus(null);
    setError(null);
    void client.getCohortStatus().then((value) => {
      if (current) setStatus(value);
    }, (reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { current = false; };
  }, [client, generation]);
  return <section data-testid="cohort-status">
    <h3>Cohorts</h3>
    {error !== null && <p className="lw-error" role="alert">{error}</p>}
    {status === null && error === null && <p className="lw-dim">Loading cohort status…</p>}
    {status !== null && <>
      <p>Executor: {status.executor}. {status.status === null ? "No retained cohort metadata." :
        `${status.status.definitions.length} retained definitions; ${status.status.resumeRequired ? "resume required" : "no pending epoch recovery"}.`}</p>
      {status.readyBoundaries.length > 0 && <ul>{status.readyBoundaries.map((boundary) =>
        <li key={boundary.key}>{boundary.phase}: {boundary.total} ready; {boundary.unexamined} unexamined</li>)}</ul>}
      {status.status !== null && <details>
        <summary>Measured cohort counters</summary>
        <dl>{Object.entries(status.status.counters).map(([name, count]) =>
          <React.Fragment key={name}><dt>{name}</dt><dd>{count}</dd></React.Fragment>)}</dl>
      </details>}
    </>}
    <button type="button" onClick={() => setGeneration((value) => value + 1)}>Refresh cohort status</button>
  </section>;
}
