import { expect, test } from "bun:test";
import {
  WorksetEffectLaunchDeadlineError,
  awaitBeforeLaunchDeadline,
  runOwnedLaunchOperationBeforeDeadline,
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

test("an expired deadline does not start owned publication I/O [Blackbox-Atomic]", async () => {
  let starts = 0;
  await expect(
    runOwnedLaunchOperationBeforeDeadline(
      async () => {
        starts += 1;
      },
      Date.now() - 1,
      "controlled publication",
    ),
  ).rejects.toBeInstanceOf(WorksetEffectLaunchDeadlineError);
  expect(starts).toBe(0);
});

test("deadline cleanup waits for started owned publication I/O to settle [Blackbox-Atomic]", async () => {
  const publication = Promise.withResolvers<void>();
  let outcomeSettled = false;
  const outcome = runOwnedLaunchOperationBeforeDeadline(
    () => publication.promise,
    Date.now() + 20,
    "controlled publication",
  ).then(
    () => {
      outcomeSettled = true;
      return undefined;
    },
    (error: unknown) => {
      outcomeSettled = true;
      return error;
    },
  );

  await Bun.sleep(40);
  expect(outcomeSettled).toBe(false);
  publication.reject(new Error("controlled late publication rejection"));
  expect(await outcome).toBeInstanceOf(WorksetEffectLaunchDeadlineError);
});

test("nonexpired owned publication I/O reports its exact failure [Blackbox-Atomic]", async () => {
  const controlledFailure = new Error("controlled nonexpired publication rejection");
  await expect(
    runOwnedLaunchOperationBeforeDeadline(
      () => Promise.reject(controlledFailure),
      Date.now() + 1_000,
      "controlled publication",
    ),
  ).rejects.toBe(controlledFailure);
});
