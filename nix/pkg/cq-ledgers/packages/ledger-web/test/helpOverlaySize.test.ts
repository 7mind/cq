/**
 * T324 — hard 90vw × 90vh help popup with pinned head + scrolling body.
 *
 * Reads styles.css directly (same pattern as holdButtonBorder.test.tsx) and
 * asserts:
 *   - .lw-help uses width:90vw + height:90vh (min() caps gone)
 *   - .lw-help-head carries flex-shrink:0 (pinned tab strip)
 *   - .lw-help-body carries flex:1, min-height:0, overflow-y:auto
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const stylesPath = join(
  dirname(import.meta.url.replace("file://", "")),
  "../src/styles.css",
);
const css = readFileSync(stylesPath, "utf-8");

/** Extract the body of the first rule matching `selector` from a CSS string. */
function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\s*\\{([^}]*)\\}");
  const m = css.match(re);
  return m ? (m[1] ?? null) : null;
}

describe("T324 — .lw-help 90vw×90vh, pinned head, scrolling body", () => {
  it(".lw-help width is 90vw (no min() cap)", () => {
    const body = ruleBody(".lw-help")!;
    expect(body).toContain("width: 90vw");
    expect(body).not.toContain("min(");
  });

  it(".lw-help height is 90vh (no min() cap)", () => {
    const body = ruleBody(".lw-help")!;
    expect(body).toContain("height: 90vh");
  });

  it(".lw-help-head has flex-shrink:0 (pinned)", () => {
    const body = ruleBody(".lw-help-head")!;
    expect(body).toContain("flex-shrink: 0");
  });

  it(".lw-help-body has flex:1, min-height:0, overflow-y:auto (internal scroller)", () => {
    const body = ruleBody(".lw-help-body")!;
    expect(body).toContain("flex: 1");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow-y: auto");
  });
});
