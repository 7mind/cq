/**
 * The production dispatch-attestation construction-matrix GATE (T686, goal G94).
 *
 * Unit-level: the registration gate itself, its two-dimensional coverage
 * self-check, namespace derivation exactness/ordering, and prototype-pollution
 * resistance of the closed-set membership checks. The per-construction store
 * factory is exercised end-to-end (against the SHARED T720 contract) in
 * `attestationConstruction-singleProject.test.ts` and
 * `attestationConstruction-postgresHub.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ATTESTATION_IN_MEMORY_BACKEND, AttestationBackendUnsupportedError, LEDGER_BACKENDS } from "@cq/config";
import {
  ATTESTATION_CONSTRUCTION_COVERAGE,
  ATTESTATION_HUB_CONSTRUCTION,
  ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION,
  AttestationConstructionUnsupportedError,
  LEDGER_SERVER_CONSTRUCTIONS,
  SINGLE_PROJECT_CONSTRUCTIONS,
  assertAttestationConstructionSupported,
  attestationNamespaceForTrustedHubProject,
  isLedgerServerConstruction,
  isSingleProjectConstruction,
  resolveProjectKey,
  resolveSingleProjectAttestationNamespace,
  supportedConstructionCells,
} from "../src/index.js";

const ALL_BACKEND_NAMES: readonly string[] = [
  ...LEDGER_BACKENDS,
  ATTESTATION_IN_MEMORY_BACKEND,
  "postgres",
];

// ---------------------------------------------------------------------------
// The exhaustive supported/excluded cell table (T686 acceptance, verbatim)
// ---------------------------------------------------------------------------

/**
 * The exact expected verdict for every `{construction, backend}` cell, hand
 * derived from the task's own prose: "XDG/SQLite and filesystem support the
 * approved single-project constructions using resolveProjectKey; PostgreSQL
 * additionally supports trusted projects.project_key multi-project routing.
 * Git-object, user-facing in-memory, and unsupported local multi-project
 * construction fail". Asserting against a SEPARATELY hand-built table (rather
 * than re-deriving from the same code under test) is what makes this a real
 * check on the matrix rather than a tautology.
 */
function expectedSupported(construction: string, backend: string): boolean {
  if (construction === ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION) return false;
  if (construction === ATTESTATION_HUB_CONSTRUCTION) return backend === "postgres";
  return backend === "xdg" || backend === "fs";
}

describe("the two-dimensional construction x backend coverage matrix", () => {
  test("decides EVERY cell — 6 constructions x 6 backends = 36", () => {
    expect(LEDGER_SERVER_CONSTRUCTIONS.length).toBe(6);
    expect(ALL_BACKEND_NAMES.length).toBe(6);
    expect(ATTESTATION_CONSTRUCTION_COVERAGE.length).toBe(36);
  });

  test("matches the hand-built expectation table for every cell", () => {
    for (const verdict of ATTESTATION_CONSTRUCTION_COVERAGE) {
      expect(verdict.supported).toBe(expectedSupported(verdict.construction, verdict.backend));
    }
  });

  test("every excluded cell carries a non-empty reason", () => {
    for (const verdict of ATTESTATION_CONSTRUCTION_COVERAGE) {
      if (verdict.supported) continue;
      expect(typeof verdict.reason).toBe("string");
      expect((verdict.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  test("exactly 9 supported cells: 4 single-project constructions x 2 backends, plus the hub", () => {
    const cells = supportedConstructionCells();
    expect(cells.size).toBe(9);
    for (const construction of SINGLE_PROJECT_CONSTRUCTIONS) {
      for (const backend of ["xdg", "fs"]) {
        expect(cells.has(`${construction}:${backend}`)).toBe(true);
      }
      expect(cells.has(`${construction}:postgres`)).toBe(false);
      for (const backend of ["git-object", "remote", ATTESTATION_IN_MEMORY_BACKEND]) {
        expect(cells.has(`${construction}:${backend}`)).toBe(false);
      }
    }
    expect(cells.has("postgres-hub:postgres")).toBe(true);
    for (const backend of ["xdg", "fs", "git-object", "remote", ATTESTATION_IN_MEMORY_BACKEND]) {
      expect(cells.has(`postgres-hub:${backend}`)).toBe(false);
    }
  });

  test("the local xdg multi-project catalog hub is excluded for EVERY backend, including postgres", () => {
    for (const backend of ALL_BACKEND_NAMES) {
      expect(
        supportedConstructionCells().has(`${ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION}:${backend}`),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The gate function directly
// ---------------------------------------------------------------------------

describe("assertAttestationConstructionSupported", () => {
  test("returns the narrowed backend for a supported cell", () => {
    expect(assertAttestationConstructionSupported("direct", "xdg")).toBe("xdg");
    expect(assertAttestationConstructionSupported("postgres-hub", "postgres")).toBe("postgres");
  });

  test("refuses an unknown construction name, distinctly from a bare-backend refusal", () => {
    expect(() => assertAttestationConstructionSupported("some-future-construction", "xdg")).toThrow(
      AttestationConstructionUnsupportedError,
    );
    try {
      assertAttestationConstructionSupported("some-future-construction", "xdg");
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(AttestationConstructionUnsupportedError);
      expect((error as AttestationConstructionUnsupportedError).message).toContain(
        "unknown ledger server construction",
      );
    }
  });

  test("refuses postgres-hub for every non-postgres backend, by name", () => {
    for (const backend of ["xdg", "fs", "git-object", "remote", ATTESTATION_IN_MEMORY_BACKEND]) {
      expect(() => assertAttestationConstructionSupported("postgres-hub", backend)).toThrow(
        AttestationConstructionUnsupportedError,
      );
    }
  });

  test("refuses the local catalog hub even for the otherwise-supported postgres backend", () => {
    expect(() =>
      assertAttestationConstructionSupported(
        ATTESTATION_UNSUPPORTED_LOCAL_HUB_CONSTRUCTION,
        "postgres",
      ),
    ).toThrow(AttestationConstructionUnsupportedError);
  });

  test("delegates git-object/remote to the bare-backend guard for every single-project construction", () => {
    for (const construction of SINGLE_PROJECT_CONSTRUCTIONS) {
      expect(() => assertAttestationConstructionSupported(construction, "git-object")).toThrow(
        /row-level compare-and-set/,
      );
      expect(() => assertAttestationConstructionSupported(construction, "remote")).toThrow(
        /ledger-service client/,
      );
      expect(() => assertAttestationConstructionSupported(construction, ATTESTATION_IN_MEMORY_BACKEND)).toThrow(
        /test double/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Prototype-pollution resistance (D169-class: four prior instances)
// ---------------------------------------------------------------------------

const PROTOTYPE_POISON = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

describe("closed-set membership is immune to Object.prototype names", () => {
  test("isLedgerServerConstruction / isSingleProjectConstruction never match a prototype member name", () => {
    for (const poison of PROTOTYPE_POISON) {
      expect(isLedgerServerConstruction(poison)).toBe(false);
      expect(isSingleProjectConstruction(poison)).toBe(false);
    }
  });

  test("assertAttestationConstructionSupported refuses every prototype member name as a construction", () => {
    for (const poison of PROTOTYPE_POISON) {
      expect(() => assertAttestationConstructionSupported(poison, "xdg")).toThrow(
        AttestationConstructionUnsupportedError,
      );
    }
  });

  test("a prototype member name as the BACKEND is refused too (delegated, but still refused)", () => {
    for (const poison of PROTOTYPE_POISON) {
      expect(() => assertAttestationConstructionSupported("direct", poison)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Namespace derivation: exactness + fail-before-any-resolution ordering
// ---------------------------------------------------------------------------

describe("resolveSingleProjectAttestationNamespace", () => {
  test("projectKey is BIT-IDENTICAL to resolveProjectKey's own result for the same input", async () => {
    const opts = { repoRoot: "/does/not/need/to/exist", projectId: "fixed-project-id-686" };
    const namespace = await resolveSingleProjectAttestationNamespace({
      construction: "direct",
      backend: "xdg",
      ...opts,
    });
    const direct = await resolveProjectKey(opts);
    expect(namespace.projectKey).toBe(direct);
    expect(namespace.backend).toBe("xdg");
  });

  test("an excluded backend refuses BEFORE any project-key resolution touches git", async () => {
    // No [ledger].projectId, and a repoRoot that would explode if resolveProjectKey
    // actually ran its git plumbing against it. If the gate ran AFTER resolution
    // this would surface a git/ENOENT-flavoured error instead of the declared
    // backend-exclusion error.
    await expect(
      resolveSingleProjectAttestationNamespace({
        construction: "direct",
        backend: "git-object",
        repoRoot: "/definitely/does/not/exist/anywhere/on/this/machine",
        projectId: null,
      }),
    ).rejects.toBeInstanceOf(AttestationBackendUnsupportedError);
  });

  test("every single-project construction derives the SAME namespace for the same repo/projectId", async () => {
    const opts = { repoRoot: "/irrelevant", projectId: "same-project-686" };
    const namespaces = await Promise.all(
      SINGLE_PROJECT_CONSTRUCTIONS.map((construction) =>
        resolveSingleProjectAttestationNamespace({ construction, backend: "fs", ...opts }),
      ),
    );
    for (const namespace of namespaces) {
      expect(namespace).toEqual({ backend: "fs", projectKey: "same-project-686" });
    }
  });
});

describe("attestationNamespaceForTrustedHubProject", () => {
  test("builds a postgres namespace from ONLY the trusted key — no other parameter exists to inject one", () => {
    const namespace = attestationNamespaceForTrustedHubProject("tenant-a");
    expect(namespace).toEqual({ backend: "postgres", projectKey: "tenant-a" });
  });

  test("refuses an empty or blank trusted key", () => {
    expect(() => attestationNamespaceForTrustedHubProject("")).toThrow();
    expect(() => attestationNamespaceForTrustedHubProject("   ")).toThrow();
  });

  test("two distinct trusted keys never collapse to the same namespace", () => {
    const a = attestationNamespaceForTrustedHubProject("tenant-a");
    const b = attestationNamespaceForTrustedHubProject("tenant-b");
    expect(a.projectKey).not.toBe(b.projectKey);
  });
});
