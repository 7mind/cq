/**
 * activityTracker.test.ts — AggregateActivityTracker (ACTIVITY-01).
 *
 * The tracker sums the two compute lanes: chat-busy (0/1) + workflow
 * active-dispatch count. It pushes the CURRENT value to a sink on subscribe
 * (initial state on connect) and again on every change (push-on-every-
 * transition). These tests drive the lanes via mutable closures so each
 * scenario (chat-only=1, workflow-only=1, both=2, parked=0) is exact.
 */

import { describe, it, expect } from "bun:test";
import { AggregateActivityTracker } from "../src/ws/activityTracker";

describe("AggregateActivityTracker", () => {
  it("running() sums chat-busy + workflow active-dispatch count", () => {
    let chatBusy = false;
    let wfCount = 0;
    const tracker = new AggregateActivityTracker({
      isChatBusy: () => chatBusy,
      workflowActiveDispatchCount: () => wfCount,
    });

    expect(tracker.running()).toBe(0); // idle

    chatBusy = true;
    expect(tracker.running()).toBe(1); // chat-only = 1

    chatBusy = false;
    wfCount = 1;
    expect(tracker.running()).toBe(1); // workflow-phase-only = 1

    chatBusy = true;
    expect(tracker.running()).toBe(2); // both = 2

    // A workflow PARKED on answers (no dispatch in flight) drops its
    // contribution to 0 — only what is actually dispatching counts.
    wfCount = 0;
    expect(tracker.running()).toBe(1); // back to chat-only
  });

  it("pushes the current value to a sink on subscribe (initial state on connect)", () => {
    let chatBusy = true;
    const tracker = new AggregateActivityTracker({ isChatBusy: () => chatBusy });
    const seen: number[] = [];
    tracker.subscribe((n) => seen.push(n));
    // Initial push reflects the live state at connect time (chat already busy).
    expect(seen).toEqual([1]);

    // A second, later subscriber gets its own initial push of the current value.
    chatBusy = false;
    const seen2: number[] = [];
    tracker.subscribe((n) => seen2.push(n));
    expect(seen2).toEqual([0]);
  });

  it("pushes on EVERY transition of the chat lane", () => {
    let chatBusy = false;
    const tracker = new AggregateActivityTracker({ isChatBusy: () => chatBusy });
    const seen: number[] = [];
    tracker.subscribe((n) => seen.push(n)); // initial 0

    chatBusy = true;
    tracker.onLaneChange(); // → 1
    chatBusy = false;
    tracker.onLaneChange(); // → 0
    chatBusy = true;
    tracker.onLaneChange(); // → 1

    expect(seen).toEqual([0, 1, 0, 1]);
  });

  it("raises running to >=1 when a workflow phase dispatches and lowers it on settle", () => {
    let wfCount = 0;
    const tracker = new AggregateActivityTracker({
      isChatBusy: () => false,
      workflowActiveDispatchCount: () => wfCount,
    });
    const seen: number[] = [];
    tracker.subscribe((n) => seen.push(n)); // initial 0

    wfCount = 1; // phase dispatch starts
    tracker.onLaneChange();
    wfCount = 0; // phase settles
    tracker.onLaneChange();

    expect(seen).toEqual([0, 1, 0]);
  });

  it("reaches running=2 for concurrent chat + workflow", () => {
    let chatBusy = false;
    let wfCount = 0;
    const tracker = new AggregateActivityTracker({
      isChatBusy: () => chatBusy,
      workflowActiveDispatchCount: () => wfCount,
    });
    const seen: number[] = [];
    tracker.subscribe((n) => seen.push(n)); // initial 0

    chatBusy = true;
    tracker.onLaneChange(); // → 1
    wfCount = 1;
    tracker.onLaneChange(); // → 2 (concurrent)

    expect(seen).toEqual([0, 1, 2]);
    expect(tracker.running()).toBe(2);
  });

  it("de-dupes: does not re-push when the aggregate is unchanged", () => {
    // Two sources that net the same sum across a transition still push at the
    // intermediate (each onLaneChange recomputes), but an onLaneChange that
    // leaves the sum unchanged does not fan out a redundant frame.
    let chatBusy = false;
    let wfCount = 0;
    const tracker = new AggregateActivityTracker({
      isChatBusy: () => chatBusy,
      workflowActiveDispatchCount: () => wfCount,
    });
    const seen: number[] = [];
    tracker.subscribe((n) => seen.push(n)); // initial 0

    // A no-op lane change (still idle) does not push.
    tracker.onLaneChange();
    expect(seen).toEqual([0]);

    chatBusy = true;
    tracker.onLaneChange(); // → 1
    // Swap which lane carries the single unit of work — sum stays 1, no push.
    chatBusy = false;
    wfCount = 1;
    tracker.onLaneChange();
    expect(seen).toEqual([0, 1]);
  });

  it("fans out to every subscribed sink (multi-connection)", () => {
    let chatBusy = false;
    const tracker = new AggregateActivityTracker({ isChatBusy: () => chatBusy });
    const a: number[] = [];
    const b: number[] = [];
    tracker.subscribe((n) => a.push(n)); // initial 0
    tracker.subscribe((n) => b.push(n)); // initial 0

    chatBusy = true;
    tracker.onLaneChange();

    expect(a).toEqual([0, 1]);
    expect(b).toEqual([0, 1]);
  });

  it("unsubscribe stops further pushes to that sink", () => {
    let chatBusy = false;
    const tracker = new AggregateActivityTracker({ isChatBusy: () => chatBusy });
    const seen: number[] = [];
    const unsub = tracker.subscribe((n) => seen.push(n)); // initial 0

    chatBusy = true;
    tracker.onLaneChange(); // → 1
    unsub();
    chatBusy = false;
    tracker.onLaneChange(); // sink already removed

    expect(seen).toEqual([0, 1]);
  });

  it("treats a missing workflow lane as contributing 0 (devServer wiring)", () => {
    let chatBusy = false;
    const tracker = new AggregateActivityTracker({ isChatBusy: () => chatBusy });
    expect(tracker.running()).toBe(0);
    chatBusy = true;
    expect(tracker.running()).toBe(1);
  });
});
