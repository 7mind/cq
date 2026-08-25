import { describe, expect, test } from "bun:test";
import { CurrentRecoverySealError, selectStrictMaximalRecoverySource } from "../src/index.js";
import {
  RECOVERY_ATTESTATION,
  RECOVERY_BASE,
  RECOVERY_MIDDLE,
  RECOVERY_RECEIPTS,
  RECOVERY_TASK,
  RECOVERY_TIP,
  receipt,
  sourceCandidate,
} from "./recoverySealTestSupport.js";

describe("strict maximal current-recovery source selection", () => {
  test("selects the strict maximal receipt closure", () => {
    const short = sourceCandidate({ generation: 3, receipts: [RECOVERY_RECEIPTS[0]!] });
    const maximal = sourceCandidate({ generation: 2 });

    expect(
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, [short, maximal]),
    ).toEqual(maximal);
  });

  test("equal closure and digest prefer greatest generation, then smallest attestation id", () => {
    const firstId = `att_${"a".repeat(31)}0`;
    const secondId = `att_${"b".repeat(32)}`;
    const candidates = [
      sourceCandidate({ attestationId: secondId, generation: 7 }),
      sourceCandidate({ attestationId: firstId, generation: 7 }),
      sourceCandidate({ attestationId: RECOVERY_ATTESTATION, generation: 6 }),
    ];

    expect(
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, candidates)
        .selectedSourceHandle,
    ).toEqual({ attestationId: firstId, generation: 7 });
  });

  test("attestation-id tie-breaking is ordinal across case and punctuation", () => {
    const ordinalFirst = `att_-${"A".repeat(31)}`;
    const localeFirst = `att_-${"a".repeat(31)}`;

    expect(
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, [
        sourceCandidate({ attestationId: localeFirst, generation: 7 }),
        sourceCandidate({ attestationId: ordinalFirst, generation: 7 }),
      ]).selectedSourceHandle.attestationId,
    ).toBe(ordinalFirst);
  });

  test("persists an independent lineage maximum from a later ineligible generation", () => {
    const olderEligible = sourceCandidate({ generation: 2, lineageMaximumGeneration: 11 });

    expect(
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, [olderEligible])
        .lineageMaximumGeneration,
    ).toBe(11);
  });

  test("refuses incomparable maximal closures", () => {
    const alternate = sourceCandidate({
      generation: 8,
      receipts: [receipt(8, RECOVERY_BASE, RECOVERY_TIP, "alternate")],
    });

    expect(() =>
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, [
        sourceCandidate({ generation: 7 }),
        alternate,
      ]),
    ).toThrow(CurrentRecoverySealError);
  });

  test("rejects malformed closure digests and ineligible reasons", () => {
    const malformed = { ...sourceCandidate({ generation: 4 }), gitReceiptsDigest: "0".repeat(64) };
    expect(() =>
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, [malformed]),
    ).toThrow("closure digest");

    const ineligible = {
      ...sourceCandidate({ generation: 4 }),
      sourceAbortReason: "cancelled",
    };
    expect(() =>
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, [ineligible as never]),
    ).toThrow("abort reason");
  });

  test("rejects a maximal closure whose tip is not live", () => {
    expect(() =>
      selectStrictMaximalRecoverySource(RECOVERY_TASK, RECOVERY_TIP, [
        sourceCandidate({ generation: 1, receipts: [RECOVERY_RECEIPTS[0]!] }),
      ]),
    ).toThrow("live tip");
    expect(RECOVERY_MIDDLE).not.toBe(RECOVERY_TIP);
  });
});
