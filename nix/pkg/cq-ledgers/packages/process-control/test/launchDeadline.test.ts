import { expect, test } from "bun:test";
import {
  WorksetEffectLaunchDeadlineError,
  awaitBeforeLaunchDeadline,
} from "../src/launchDeadline.js";

test("an expired deadline observes an already-started operation rejection [Blackbox-Atomic]", async () => {
  const controlledFailure = new Error("controlled publication rejection");
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observeUnhandled);
  try {
    const publication = Promise.reject(controlledFailure);
    await expect(
      awaitBeforeLaunchDeadline(publication, Date.now() - 1, "controlled publication"),
    ).rejects.toBeInstanceOf(WorksetEffectLaunchDeadlineError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", observeUnhandled);
  }
});
