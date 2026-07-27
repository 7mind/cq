/**
 * T683 — the explicit frontmatter-stripping rule, pinned by tests.
 *
 * Prompt attestation binds the exact installed bytes of a rendered role
 * artifact — frontmatter included. `stripPromptFrontmatter` is the ONE
 * consumer-side rule for deriving a prompt body from those attested bytes
 * (or their canonical sources) when a legacy path needs the body only.
 */

import { describe, expect, test } from "bun:test";
import { stripPromptFrontmatter } from "../src/promptFrontmatter.js";

describe("stripPromptFrontmatter — the explicit stripping rule (T683)", () => {
  test("strips a fenced frontmatter block and returns the trimmed body", () => {
    expect(stripPromptFrontmatter("---\nname: role\n---\nBody text.\n")).toBe("Body text.");
  });

  test("returns the whole trimmed document when no fence opens it", () => {
    expect(stripPromptFrontmatter("  Body only.\n")).toBe("Body only.");
  });

  test("accepts CRLF fences and trailing horizontal whitespace on fence lines", () => {
    expect(stripPromptFrontmatter("--- \r\nname: role\r\n---\t\r\nBody.\r\n")).toBe("Body.");
  });

  test("treats an unclosed fence as no fence at all", () => {
    const document = "---\nname: role\nno closing fence\n";
    expect(stripPromptFrontmatter(document)).toBe(document.trim());
  });

  test("requires the opening fence at document offset 0", () => {
    const document = "\n---\nname: role\n---\nBody.\n";
    expect(stripPromptFrontmatter(document)).toBe(document.trim());
  });

  test("ends the block at the FIRST closing fence; later fences stay body", () => {
    expect(stripPromptFrontmatter("---\nname: role\n---\nBody.\n---\nlater fence\n")).toBe(
      "Body.\n---\nlater fence",
    );
  });

  test("keeps a closing fence inside a frontmatter value when it is not alone on its line", () => {
    expect(stripPromptFrontmatter("---\ndescription: a --- b\n---\nBody.\n")).toBe("Body.");
  });

  test("strips frontmatter from the rendered attested bytes without touching their digest input", () => {
    // The rendered artifact bytes (what the digest binds) keep the fence;
    // stripping is a pure consumer-side derivation over the same string.
    const installed = "---\ndescription: rendered\n---\n\nPrompt body with $ARGUMENTS.\n";
    expect(stripPromptFrontmatter(installed)).toBe("Prompt body with $ARGUMENTS.");
    expect(installed.startsWith("---\n")).toBe(true);
  });
});
