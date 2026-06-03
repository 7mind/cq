/**
 * Acceptance test for T118: the new defect lifecycle statuses (root-caused,
 * inconclusive, wontfix) must render with distinct, correct CSS bucket classes.
 *
 * - root-caused → lw-status-ready  (purple; fix deferred)
 * - inconclusive → lw-status-warning (amber; investigation parked)
 * - wontfix → lw-status-dropped  (muted; not done/green)
 */

import { registerDom } from "./helpers/dom";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { statusBucket } from "../src/status";
import { DEFECTS_SCHEMA } from "@cq/ledger";

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function StatusBadge(props: { status: string }): ReturnType<typeof createElement> {
  return createElement(
    "span",
    {
      className: `lw-status lw-status-${statusBucket(props.status, DEFECTS_SCHEMA)}`,
      "data-testid": "badge",
    },
    props.status,
  );
}

describe("defect lifecycle status buckets (T118)", () => {
  it("root-caused → ready bucket (not progress, not done)", () => {
    // root-caused is non-terminal — root cause captured, fix deferred.
    expect(statusBucket("root-caused", DEFECTS_SCHEMA)).toBe("ready");
    act(() => {
      root.render(createElement(StatusBadge, { status: "root-caused" }));
    });
    const badge = container.querySelector('[data-testid="badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain("lw-status-ready");
    expect(badge!.className).not.toContain("lw-status-done");
    expect(badge!.className).not.toContain("lw-status-progress");
  });

  it("inconclusive → warning bucket (not done, not dropped)", () => {
    // inconclusive is non-terminal — investigation parked/ambiguous.
    expect(statusBucket("inconclusive", DEFECTS_SCHEMA)).toBe("warning");
    act(() => {
      root.render(createElement(StatusBadge, { status: "inconclusive" }));
    });
    const badge = container.querySelector('[data-testid="badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain("lw-status-warning");
    expect(badge!.className).not.toContain("lw-status-done");
    expect(badge!.className).not.toContain("lw-status-dropped");
  });

  it("wontfix → dropped bucket (not done/green)", () => {
    // wontfix is terminal — decided not to fix; rendered muted, not green.
    expect(statusBucket("wontfix", DEFECTS_SCHEMA)).toBe("dropped");
    act(() => {
      root.render(createElement(StatusBadge, { status: "wontfix" }));
    });
    const badge = container.querySelector('[data-testid="badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain("lw-status-dropped");
    expect(badge!.className).not.toContain("lw-status-done");
  });

  it("open → start, wip → progress, resolved → done (unchanged)", () => {
    expect(statusBucket("open", DEFECTS_SCHEMA)).toBe("start");
    expect(statusBucket("wip", DEFECTS_SCHEMA)).toBe("progress");
    expect(statusBucket("resolved", DEFECTS_SCHEMA)).toBe("done");
  });
});
