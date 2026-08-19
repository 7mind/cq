import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

function src(rel: string): string {
  return readFileSync(path.resolve(import.meta.dir, rel), "utf8");
}

describe("T735 non-serve clients do not open PostgreSQL [BA]", () => {
  test("stdio proxy, remote launch, and frontend serve do not import postgres primitives", () => {
    const files = [
      src("../src/stdioRemoteProxy.ts"),
      src("../../ledger/src/store/remote/remoteLaunch.ts"),
      src("../../ledger/src/store/remote/RemoteLedgerClient.ts"),
      src("../../ledger-tui/src/main.tsx"),
    ];
    for (const body of files) {
      expect(body).not.toContain("openPgPool");
      expect(body).not.toContain("PostgresLedgerStore");
      expect(body).not.toContain("ensureSchema");
      expect(body).not.toMatch(/postgres\.listen|LISTEN |NOTIFY /);
    }
  });
});
