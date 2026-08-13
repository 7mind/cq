import { describe, expect, test } from "bun:test";
import {
  WorksetInvocationAuthorityError,
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  isTrustedWorksetManagementAuthority,
} from "../src/index.js";

describe("workset invocation authority", () => {
  test("observe-only and forged authorities deny set before store access", async () => {
    let storeAccesses = 0;
    const touchStore = (): string => {
      storeAccesses += 1;
      return "written";
    };
    const observeOnly = createObserveOnlyWorksetInvocationAuthority();

    expect(observeOnly.get(() => "observed")).toBe("observed");
    expect(await observeOnly.fetch(async () => "fetched")).toBe("fetched");
    await expect(observeOnly.set(touchStore)).rejects.toBeInstanceOf(
      WorksetInvocationAuthorityError,
    );
    expect(storeAccesses).toBe(0);

    const forged = {
      get: observeOnly.get,
      fetch: observeOnly.fetch,
      set: async <T>(operation: () => T): Promise<T> => operation(),
    };
    expect(isTrustedWorksetManagementAuthority(forged)).toBe(false);
  });

  test("the dedicated trusted constructor yields non-transferable management set authority", async () => {
    let storeAccesses = 0;
    const management = createTrustedWorksetManagementAuthority();

    expect(isTrustedWorksetManagementAuthority(management)).toBe(true);
    expect(
      await management.set(async () => {
        storeAccesses += 1;
        return "written";
      }),
    ).toBe("written");
    expect(storeAccesses).toBe(1);
    expect(isTrustedWorksetManagementAuthority({ ...management })).toBe(false);
  });
});
