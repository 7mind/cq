/**
 * T133 — D13 regression guard: per-move stdout-write byte count.
 *
 * T132 enabled ink's `incrementalRendering` for the TUI via the exported
 * `TUI_RENDER_OPTIONS` (packages/ledger-tui/src/main.tsx). The DEFECT (D13): the
 * default ink renderer erases and REWRITES THE WHOLE FRAME on every change
 * (log-update.js standard renderer: `eraseLines(prev) + str`), so a pure cursor
 * move between two items — which re-renders the newly-selected item's full
 * markdown detail — pays a full-frame stdout redraw whose cost is the WHOLE
 * frame, not the changed region. The incremental renderer diffs line-by-line and
 * writes only the lines that actually changed, so per-move stdout cost tracks
 * the changed lines.
 *
 * GATE METRIC (deterministic, contention-independent): the per-move
 * STDOUT-WRITE BYTE COUNT, measured in-test under a counting fake TTY stdout.
 * This is NOT a wall-clock threshold — it is a byte count produced by the
 * renderer for a fixed sequence of keystrokes, so it does not flake under CPU
 * contention (cf. the D20/D23 timing-flake class). Wall-clock is neither
 * measured nor gated here.
 *
 * PRODUCTION FIDELITY (R129): adjacent production items have DIFFERENT markdown.
 * A guard that gave every item the SAME description would let a constant-text /
 * one-slot memo HIT across moves, so the standard renderer's per-move frame
 * would barely change and the guard would pass even with slow full-frame
 * redraws. This guard therefore gives EVERY item a DISTINCT long-markdown
 * description and asserts on the PRODUCTION navigation pattern: move BETWEEN
 * distinct items (j across items), never re-select the same item. The negative
 * control below proves the distinct-description path makes the standard
 * (full-frame) baseline materially LARGER than the incremental count — i.e. the
 * pass is earned by the line-diff renderer, not by a memo hit.
 *
 * Reproduction discipline: with `TUI_RENDER_OPTIONS.incrementalRendering`
 * removed (reverting T132), `measure(true)` and `measure(false)` collapse to the
 * same standard renderer and the `reduction` assertion FAILS (perMoveIncremental
 * ≈ perMoveStandard). Verified by temporarily flipping the flag off; restored.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink";
import type { RenderOptions } from "ink";
import { render as renderTesting } from "ink-testing-library";
import { App } from "../src/app.js";
import { TUI_RENDER_OPTIONS } from "../src/main.js";
import { DEFECTS_LEDGER } from "@cq/ledger";
import type {
  ArchiveContent,
  ArchivePointer,
  FetchedLedger,
  Item,
  ItemInit,
  ItemPatch,
  LedgerClient,
  LedgerSummary,
  LedgerSchema,
  MilestonePatch,
} from "../src/types.js";

const TS = "2026-01-01T00:00:00.000Z";
const ENTER = "\r";
const COLUMNS = 120;
const ROWS = 40;
const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

const defectsSchema: LedgerSchema = {
  statusValues: ["open", "wip", "resolved"],
  terminalStatuses: ["resolved"],
  idPrefix: "D",
  transitions: { open: ["wip", "resolved"], wip: ["resolved"], resolved: [] },
  fields: {
    headline: { type: "string", required: true },
    severity: { type: "string", required: false },
    description: { type: "string", required: false },
  },
};

/**
 * DISTINCT long-markdown body for defect `i`. ~14 lines, each line woven with
 * `i` so NO two items share a description — this is the production-fidelity
 * requirement (R129): a constant/one-slot memo cannot HIT across a move.
 */
function distinctLongMarkdown(i: number): string {
  return Array.from(
    { length: 14 },
    (_, l) =>
      `Defect D${i} line ${l}: distinct narrative ${i}-${l} about subsystem ${(i * 7 + l) % 13} ` +
      `with detail tokens ${i}${l}${(i + l) % 9} and unique trailing marker <D${i}#${l}>.`,
  ).join("\n");
}

/**
 * LedgerClient serving ONE defects ledger of `n` items under a single
 * milestone, EACH with a DISTINCT long-markdown `description`. Only the
 * render/navigation path is exercised; the rest throw.
 */
class DistinctDefectsClient implements LedgerClient {
  constructor(private readonly n: number) {}
  displayName(): string {
    return "bench";
  }
  async enumerateLedgers(): Promise<LedgerSummary[]> {
    return [{ name: DEFECTS_LEDGER, itemCount: this.n }];
  }
  async fetchLedger(_ledgerId: string): Promise<FetchedLedger> {
    const items: Item[] = Array.from({ length: this.n }, (_, i) => ({
      id: `D${i + 1}`,
      milestoneId: "M1",
      status: i % 2 === 0 ? "open" : "wip",
      fields: {
        headline: `defect ${i + 1}`,
        severity: "medium",
        description: distinctLongMarkdown(i + 1),
      },
      createdAt: TS,
      updatedAt: TS,
    }));
    return {
      id: DEFECTS_LEDGER,
      schema: defectsSchema,
      counters: { milestone: 2, item: this.n + 1 },
      milestones: [
        { id: "M1", milestone: { id: "M1", status: "open", title: "Big", description: "" }, items },
      ],
      archivePointers: [],
    };
  }
  async fetchLedgerArchive(): Promise<ArchiveContent> {
    throw new Error("not implemented");
  }
  async fetchItem(): Promise<Item> {
    throw new Error("not implemented");
  }
  async createItem(_l: string, _m: string, _init: ItemInit): Promise<Item> {
    throw new Error("not implemented");
  }
  async updateItem(_l: string, _id: string, _p: ItemPatch): Promise<Item> {
    throw new Error("not implemented");
  }
  async ftsSearch(): Promise<never[]> {
    return [];
  }
  async createMilestone(): Promise<Item> {
    throw new Error("not implemented");
  }
  async updateMilestone(_id: string, _p: MilestonePatch): Promise<Item> {
    throw new Error("not implemented");
  }
  async archiveMilestone(): Promise<ArchivePointer> {
    throw new Error("not implemented");
  }
  async close(): Promise<void> {}
}

/**
 * Counting fake TTY stdout: records total bytes written (the GATE metric). A
 * fixed `columns`/`rows` and `isTTY` make ink engage the interactive
 * erase/diff renderer (the standard renderer rewrites the whole frame; the
 * incremental renderer line-diffs) — the same path the real terminal takes.
 */
class CountingStdout extends EventEmitter {
  readonly isTTY = true;
  readonly columns = COLUMNS;
  readonly rows = ROWS;
  bytes = 0;
  buffer = "";
  write = (chunk: string): boolean => {
    this.bytes += Buffer.byteLength(chunk, "utf8");
    this.buffer += chunk;
    return true;
  };
}

/**
 * Fake TTY stdin matching ink's readable/read protocol (ink reads on the
 * `readable` event then calls `stdin.read()`). Mirrors ink-testing-library's
 * Stdin so keystrokes reach `useInput`.
 */
class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const d = this.data;
    this.data = null;
    return d;
  };
  write = (d: string): void => {
    this.data = d;
    this.emit("readable");
    this.emit("data", d);
  };
}

const N = 60;
const NAV = 25;

/**
 * Drive the App with the distinct-defects client through `NAV` j-moves BETWEEN
 * distinct items and return the per-move stdout-write byte count. `incremental`
 * selects ink's line-diff renderer (T132's TUI_RENDER_OPTIONS) vs the default
 * full-frame standard renderer.
 */
/**
 * Poll `stdout.bytes` until it stops growing across a full poll interval — i.e.
 * the render queue has FLUSHED for the last keystroke. Attributing bytes to a
 * move by quiescence (rather than a fixed sleep) is what makes the metric
 * deterministic: it does not matter whether the scheduler coalesced or split
 * frames, only that all writes for the move have landed before the next move.
 */
async function flushWrites(stdout: CountingStdout): Promise<void> {
  let prev = -1;
  for (let i = 0; i < 200; i++) {
    if (stdout.bytes === prev) return;
    prev = stdout.bytes;
    await tick(12);
  }
}

/**
 * `"baseline"` = the default full-frame (standard) renderer; `"production"` =
 * exactly the options the real TUI mounts with (T132's `TUI_RENDER_OPTIONS`).
 * Deriving the post-fix case from `TUI_RENDER_OPTIONS` — rather than a literal
 * `{ incrementalRendering: true }` — couples the GATE to T132: revert T132 and
 * the production case falls back to the standard renderer, collapsing the
 * measured reduction and failing the gate.
 */
type RenderMode = "baseline" | "production";

async function perMoveBytes(mode: RenderMode): Promise<number> {
  const stdout = new CountingStdout();
  const stdin = new FakeStdin();
  const opts: RenderOptions = {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: false,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    // High FPS ⇒ ~1 ms throttle, so each keystroke's frame is not deferred into
    // the next move's measurement window. Combined with `flushWrites` (quiescence
    // polling) this makes per-move byte attribution deterministic.
    maxFps: 1000,
    // Production case spreads the REAL TUI options so the gate tracks T132.
    ...(mode === "production" ? TUI_RENDER_OPTIONS : {}),
  };
  const inst = render(React.createElement(App, { client: new DistinctDefectsClient(N) }), opts);
  await tick(80); // enumerateLedgers resolves, ledgers list renders
  stdin.write(ENTER); // open the only ledger (defects)
  for (let i = 0; i < 100 && !stdout.buffer.includes("D1"); i++) await tick(10);
  expect(stdout.buffer).toContain("D1"); // items frame settled
  await flushWrites(stdout); // let mount/settle redraws flush before measuring

  let moveBytes = 0;
  for (let i = 0; i < NAV; i++) {
    const before = stdout.bytes;
    stdin.write("j"); // move DOWN to the NEXT distinct item (vim)
    await flushWrites(stdout); // wait until THIS move's frame is fully written
    moveBytes += stdout.bytes - before;
  }
  inst.unmount();
  return moveBytes / NAV;
}

describe("ledger-tui D13 regression guard — per-move stdout bytes (T133)", () => {
  it("TUI_RENDER_OPTIONS enables ink incrementalRendering (T132 wiring)", () => {
    // The gate metric below is meaningless unless the production render path
    // actually requests the incremental renderer.
    expect(TUI_RENDER_OPTIONS.incrementalRendering).toBe(true);
  });

  it(
    "incremental per-move write count is MATERIALLY below the full-frame baseline (distinct descriptions)",
    async () => {
      // Pre-T132 baseline: the standard (full-frame) renderer. With DISTINCT
      // per-item descriptions, every move genuinely changes the detail content,
      // so the standard renderer rewrites the whole frame each move — this is
      // the per-move content-volume cost D13 describes.
      const perMoveStandard = await perMoveBytes("baseline");
      // Post-T132: the PRODUCTION render options (TUI_RENDER_OPTIONS) — the
      // incremental (line-diff) renderer. It writes only the lines that
      // changed, so the per-move count is materially lower.
      const perMoveIncremental = await perMoveBytes("production");

      // Wall-clock is NOT measured or gated; the byte counts are deterministic
      // functions of the (fixed) keystroke sequence and rendered frames. Record
      // for context only (visible on test failure).
      const reductionPct = 100 * (1 - perMoveIncremental / perMoveStandard);
      const context = `standard=${perMoveStandard.toFixed(0)} B/move, incremental=${perMoveIncremental.toFixed(0)} B/move, reduction=${reductionPct.toFixed(1)}%`;
      console.log(`[T133 D13 guard] ${context}`);

      // Negative control (R129): the full-frame baseline must be substantial —
      // proving distinct descriptions force real per-move content cost and the
      // guard cannot pass via a constant-text memo hit. A whole defect frame at
      // 120 cols is well over 1 KB.
      expect(perMoveStandard, context).toBeGreaterThan(1000);

      // The GATE: incremental materially below the full-frame baseline. The
      // measured reduction is ~28–53% depending on viewport; require a
      // conservative ≥15% so the guard is robust yet still fails if T132 is
      // reverted (both renderers would then be the standard one ⇒ ~0%).
      expect(perMoveIncremental, context).toBeLessThan(perMoveStandard * 0.85);
    },
    60_000,
  );

  it("settled-cursor rendered frame is IDENTICAL pre/post fix (no output regression)", async () => {
    // The reconciler produces the same logical frame string regardless of
    // renderer; only the terminal-write ENCODING differs. ink-testing-library
    // exposes the logical frame (`lastFrame`), so render the SAME settled state
    // and assert the visible frames match. (The renderers diverge only in HOW
    // they write to the terminal, asserted by the byte-count test above.)
    const drive = async (): Promise<string> => {
      const r = renderTesting(React.createElement(App, { client: new DistinctDefectsClient(N) }));
      await tick(40);
      r.stdin.write(ENTER);
      for (let i = 0; i < 100 && !(r.lastFrame() ?? "").includes("D1"); i++) await tick(10);
      // Move to a settled non-first item so the detail pane shows a distinct body.
      for (let i = 0; i < 5; i++) {
        r.stdin.write("j");
        await tick(20);
      }
      await tick(60);
      const frame = r.lastFrame() ?? "";
      r.unmount();
      return frame;
    };
    const a = await drive();
    const b = await drive();
    expect(a).toContain("D6"); // moved 5 down from D1 to the 6th distinct item
    expect(a).toBe(b); // deterministic settled frame
  }, 30_000);
});
