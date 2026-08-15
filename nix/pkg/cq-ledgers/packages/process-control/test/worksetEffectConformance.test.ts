import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WORKSET_BROKER_EXTERNAL_EFFECT_KINDS,
  WORKSET_BROKER_TERMINATION_REASONS,
  runWorksetEffectProtocol,
  type WorksetBrokerAdmissionHandle,
  type WorksetEffectAdmissionProvider,
} from "../src/worksetEffectProtocol.js";

function recordingProvider(events: string[]): WorksetEffectAdmissionProvider {
  return {
    async acquire(input): Promise<WorksetBrokerAdmissionHandle> {
      events.push(`acquire:${input.kind}:${input.targetRef}`);
      let registered = false;
      let shared = false;
      let settled = false;
      return {
        id: `t1988-${input.kind}`,
        epoch: 1988,
        kind: input.kind,
        targetRef: input.targetRef,
        registerProcessGroup() {
          registered = true;
          events.push("register");
        },
        shareWithGuardian() {
          if (!registered) throw new Error("registration required");
          shared = true;
          events.push("share");
        },
        markSettled() {
          if (!shared) throw new Error("guardian share required");
          settled = true;
          events.push("mark-settled");
        },
        async releaseAfterSettlement() {
          if (!settled) throw new Error("settlement required");
          events.push("close");
        },
        async abandonBeforeRegistration() {
          events.push("abandon");
        },
      };
    },
  };
}

async function ledgerExternalEffectKinds(): Promise<string[]> {
  const source = await readFile(
    join(import.meta.dir, "..", "..", "ledger", "src", "worksetEffectAdmission.ts"),
    "utf8",
  );
  const declaration = source.match(
    /export const WORKSET_EXTERNAL_EFFECT_KINDS = \[([\s\S]*?)\] as const;/,
  );
  if (declaration?.[1] === undefined) {
    throw new Error("ledger external-effect inventory declaration not found");
  }
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

describe("T1988 external-effect conformance [Behavioral-Active Blackbox-Atomic]", () => {
  test("orders every effect and termination row through registration, settlement, then close", async () => {
    expect(await ledgerExternalEffectKinds()).toEqual([
      ...WORKSET_BROKER_EXTERNAL_EFFECT_KINDS,
    ]);
    for (const kind of WORKSET_BROKER_EXTERNAL_EFFECT_KINDS) {
      for (const reason of WORKSET_BROKER_TERMINATION_REASONS) {
        const events: string[] = [];
        const result = await runWorksetEffectProtocol({
          provider: recordingProvider(events),
          kind,
          targetRef: "tasks:T1988",
          registration: { pgid: 1988, leaderPid: 1988 },
          launch: () => {
            events.push("launch");
          },
          settle: (observed) => {
            events.push(`settle:${observed}`);
          },
          reason,
        });
        expect(result, `${kind}/${reason}`).toEqual({
          admissionId: `t1988-${kind}`,
          epoch: 1988,
          reason,
        });
        expect(events, `${kind}/${reason}`).toEqual([
          `acquire:${kind}:tasks:T1988`,
          "register",
          "share",
          "launch",
          `settle:${reason}`,
          "mark-settled",
          "close",
        ]);
      }
    }
  });
});

describe("T1988 Effectual Good-Communication coverage inventory", () => {
  test("keeps cancellation, crash, descendant, Git, and registered-launch suites gate-reachable", async () => {
    for (const file of [
      "worksetEffectBroker.test.ts",
      "worksetGitEffectGate.test.ts",
      "registeredLaunch.test.ts",
    ]) {
      await access(join(import.meta.dir, file));
    }
  });
});
