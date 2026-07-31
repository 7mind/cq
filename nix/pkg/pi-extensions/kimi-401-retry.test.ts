/**
 * Unit tests for kimi-401-retry pattern + backoff helpers.
 * Run: `cd nix/pkg/pi-extensions && bun test kimi-401-retry.test.ts`
 * (standalone; no package.json required if bun is on PATH)
 */

import { describe, expect, test } from "bun:test";
import { __test } from "./kimi-401-retry.ts";

const D201_MESSAGE =
	'401 {"error":{"type":"authentication_error","message":"The API Key appears to be invalid or may have expired. Please verify your credentials and try again."},"type":"error"}';

describe("isKimiSoft401ErrorMessage", () => {
	test("matches the observed D201 Kimi authentication_error body", () => {
		expect(__test.isKimiSoft401ErrorMessage(D201_MESSAGE)).toBe(true);
	});

	test("matches authentication_error with API Key appears to be invalid without leading 401 text", () => {
		expect(
			__test.isKimiSoft401ErrorMessage(
				'{"error":{"type":"authentication_error","message":"The API Key appears to be invalid or may have expired."}}',
			),
		).toBe(true);
	});

	test("does not match a permanent-looking invalid api key (word order of monotykamary blacklist)", () => {
		// Different failure class: classic static-key rejection without Kimi shape.
		expect(__test.isKimiSoft401ErrorMessage("Invalid API key provided")).toBe(false);
	});

	test("does not match generic 500 / rate limit", () => {
		expect(__test.isKimiSoft401ErrorMessage("503 service unavailable")).toBe(false);
		expect(__test.isKimiSoft401ErrorMessage("429 rate limit exceeded")).toBe(false);
	});

	test("does not match empty/undefined", () => {
		expect(__test.isKimiSoft401ErrorMessage(undefined)).toBe(false);
		expect(__test.isKimiSoft401ErrorMessage("")).toBe(false);
	});
});

describe("delayMs", () => {
	test("grows exponentially from BASE and caps at MAX", () => {
		expect(__test.delayMs(1)).toBe(__test.BASE_DELAY_MS);
		expect(__test.delayMs(2)).toBe(__test.BASE_DELAY_MS * 2);
		expect(__test.delayMs(3)).toBe(__test.BASE_DELAY_MS * 4);
		expect(__test.delayMs(10)).toBe(__test.MAX_DELAY_MS);
	});
});

describe("constants", () => {
	test("bounded attempts", () => {
		expect(__test.MAX_ATTEMPTS).toBe(3);
	});
});
