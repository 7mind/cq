/**
 * T1953 — exhaustive workset effect-kind inventory.
 *
 * Every enumerated effect maps to exactly one admission form; forbidden
 * patterns and termination reasons are sealed; broker external kinds stay
 * aligned with the process-control protocol inventory.
 */

import { describe, expect, it } from "bun:test";
import {
  WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS,
  WORKSET_LEDGER_WRITE_MUTATION_KINDS,
  WORKSET_LEDGER_MUTATION_KINDS,
  WORKSET_EXTERNAL_EFFECT_KINDS,
  WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
  WORKSET_EFFECT_KINDS,
  WORKSET_ADMISSION_FORMS,
  WORKSET_FORBIDDEN_ADMISSION_PATTERNS,
  WORKSET_EFFECT_TERMINATION_REASONS,
  admissionFormForEffectKind,
  type WorksetEffectKind,
  type WorksetAdmissionForm,
} from "../src/index.js";
import { WORKSET_BROKER_EXTERNAL_EFFECT_KINDS } from "../../process-control/src/worksetEffectProtocol.ts";

describe("workset effect-kind inventory [T1953]", () => {
  it("enumerates claim/publish/release/finalize as plan-lifecycle mutations", () => {
    expect([...WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS]).toEqual([
      "claim-plan",
      "publish-plan-draft",
      "release-plan-claim",
      "finalize-plan",
    ]);
  });

  it("enumerates generic and owned writes", () => {
    expect([...WORKSET_LEDGER_WRITE_MUTATION_KINDS]).toEqual([
      "generic-write",
      "owned-write",
    ]);
  });

  it("enumerates external effects: child dispatch, worktree/branch create/remove, rebase, merge", () => {
    expect([...WORKSET_EXTERNAL_EFFECT_KINDS]).toEqual([
      "child-dispatch",
      "worktree-create",
      "worktree-remove",
      "branch-create",
      "branch-remove",
      "rebase",
      "merge",
    ]);
  });

  it("enumerates administrative destructive operations", () => {
    expect([...WORKSET_ADMINISTRATIVE_EFFECT_KINDS]).toEqual([
      "restore",
      "reset",
      "erase",
      "backend-migration",
      "divergence-reinitialization",
    ]);
  });

  it("ledger mutation inventory is the plan-lifecycle ∪ write union without duplicates", () => {
    expect([...WORKSET_LEDGER_MUTATION_KINDS]).toEqual([
      ...WORKSET_PLAN_LIFECYCLE_MUTATION_KINDS,
      ...WORKSET_LEDGER_WRITE_MUTATION_KINDS,
    ]);
    expect(new Set(WORKSET_LEDGER_MUTATION_KINDS).size).toBe(
      WORKSET_LEDGER_MUTATION_KINDS.length,
    );
  });

  it("total effect inventory is the disjoint union of the three partitions", () => {
    const all = [
      ...WORKSET_LEDGER_MUTATION_KINDS,
      ...WORKSET_EXTERNAL_EFFECT_KINDS,
      ...WORKSET_ADMINISTRATIVE_EFFECT_KINDS,
    ];
    expect([...WORKSET_EFFECT_KINDS]).toEqual(all);
    expect(new Set(WORKSET_EFFECT_KINDS).size).toBe(WORKSET_EFFECT_KINDS.length);
  });

  it("maps every effect kind to exactly one admission form", () => {
    const expected = new Map<WorksetEffectKind, WorksetAdmissionForm>();
    for (const kind of WORKSET_LEDGER_MUTATION_KINDS) {
      expected.set(kind, "ledger-mutation");
    }
    for (const kind of WORKSET_EXTERNAL_EFFECT_KINDS) {
      expected.set(kind, "external-effect");
    }
    for (const kind of WORKSET_ADMINISTRATIVE_EFFECT_KINDS) {
      expected.set(kind, "exclusive-administrative");
    }
    for (const kind of WORKSET_EFFECT_KINDS) {
      expect(admissionFormForEffectKind(kind)).toBe(expected.get(kind));
    }
  });

  it("seals the four admission forms including exclusive-set", () => {
    expect([...WORKSET_ADMISSION_FORMS]).toEqual([
      "ledger-mutation",
      "external-effect",
      "exclusive-set",
      "exclusive-administrative",
    ]);
  });

  it("forbids prompt-only prechecks, upgrades, caller minting, transfer, and multi-effect admissions", () => {
    expect([...WORKSET_FORBIDDEN_ADMISSION_PATTERNS]).toEqual([
      "prompt-only-precheck",
      "read-to-write-upgrade",
      "caller-minted-admission",
      "transfer-to-children",
      "multiple-observable-effects-under-one-admission",
    ]);
  });

  it("enumerates cleanup-before-release termination reasons", () => {
    expect([...WORKSET_EFFECT_TERMINATION_REASONS]).toEqual([
      "normal",
      "cancel",
      "timeout",
      "parent-death",
      "broker-death",
    ]);
  });

  it("keeps process-control broker external kinds byte-identical to the ledger inventory", () => {
    expect([...WORKSET_BROKER_EXTERNAL_EFFECT_KINDS]).toEqual([
      ...WORKSET_EXTERNAL_EFFECT_KINDS,
    ]);
  });
});
