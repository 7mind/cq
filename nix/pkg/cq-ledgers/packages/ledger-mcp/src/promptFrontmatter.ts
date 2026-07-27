/**
 * The ONE explicit frontmatter-stripping rule for prompt role assets (T683).
 *
 * Prompt attestation binds the EXACT installed bytes of a rendered role
 * artifact — frontmatter included; stripping never feeds back into a digest.
 * Stripping is purely a consumer-side derivation for the rare legacy path
 * that must present a prompt body without its `---` frontmatter block, and it
 * follows exactly this rule (mirrored by the ledger-web codegen's
 * `parseFrontmatterBlock` fence handling):
 *
 *  1. If the document opens with a fence line matching `^---[ \t]*\r?\n`
 *     (a `---` line with optional trailing horizontal whitespace, LF or
 *     CRLF), and a LATER line is a closing fence (`---` plus optional
 *     trailing whitespace, on its own line), the body is everything after
 *     the closing fence line. The first eligible closing fence ends the
 *     block, so later `---` lines remain body content.
 *  2. Otherwise — no opening fence at offset 0, or no closing fence — the
 *     body is the whole document.
 *  3. The resulting body is `.trim()`med.
 */
export function stripPromptFrontmatter(raw: string): string {
  const fence = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  const body = fence === null ? raw : raw.slice(fence[0].length);
  return body.trim();
}
