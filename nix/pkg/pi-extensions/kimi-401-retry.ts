/**
 * kimi-401-retry — bounded turn re-drive when Kimi coding returns a soft 401.
 *
 * Context (D201 / earendil-works/pi#7319):
 *   Pi 0.84.2 excludes HTTP 401 from both retry classifiers, and kimi-coding
 *   OAuth (~15m access tokens) is only refreshed on local expiry — not on a
 *   coding-API 401. The turn therefore stops on:
 *     Error: 401 {"error":{"type":"authentication_error",
 *       "message":"The API Key appears to be invalid or may have expired..."}}
 *   even when the subscription is still valid and the next request succeeds.
 *
 * This extension does NOT patch core. After Pi settles (built-in retry has
 * already declined), it detects the Kimi soft-auth body (optionally correlated
 * with after_provider_response status===401) and re-drives the turn via a
 * hidden custom message, with capped exponential backoff.
 *
 * Scope is intentionally narrow: only the Kimi authentication_error body (and
 * bare "401" + authentication_error). Permanent bad static keys that do not
 * match this shape are not retried. MCP 401 behavior is untouched.
 *
 * Wire-up: listed in nix/hm/pi.nix `programs.pi.settings.extensions`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "cq:kimi-401-retry";

/** Max turn re-drives per consecutive failure streak. */
const MAX_ATTEMPTS = 3;

/** Base backoff before attempt N (ms): base * 2^(n-1), capped. */
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 15000;

/**
 * Match the Kimi coding / Anthropic-shaped soft-auth body observed in D201.
 * Deliberately does NOT use /invalid\s*api\s*key/ (word order differs) and does
 * not treat every bare "401" as retryable.
 */
const KIMI_SOFT_401_PATTERN =
	/401[\s\S]{0,400}authentication_error|authentication_error[\s\S]{0,200}API Key appears to be invalid/i;

function delayMs(attempt: number): number {
	const raw = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
	return Math.min(raw, MAX_DELAY_MS);
}

function isKimiSoft401ErrorMessage(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return KIMI_SOFT_401_PATTERN.test(errorMessage);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI): void {
	/** Last HTTP status seen from after_provider_response (best-effort correlate). */
	let lastProviderStatus: number | undefined;
	/** Consecutive kimi-401 retry attempts in the current failure streak. */
	let attempt = 0;
	/** Mutex: one re-drive loop at a time. */
	let inFlight = false;
	/** Bumped on session_start / user input so in-flight loops can bail. */
	let generation = 0;

	pi.on("session_start", () => {
		generation++;
		attempt = 0;
		lastProviderStatus = undefined;
		inFlight = false;
	});

	pi.on("input", () => {
		// Fresh user activity cancels an in-flight retry streak.
		generation++;
		attempt = 0;
	});

	pi.on("after_provider_response", (event) => {
		lastProviderStatus = event.status;
	});

	// Reset streak on a successful assistant completion.
	pi.on("turn_end", (event) => {
		const msg = event.message as { role?: string; stopReason?: string } | undefined;
		if (msg?.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
			attempt = 0;
			lastProviderStatus = undefined;
		}
	});

	/** Last assistant error from the most recent agent_end (settled has no payload). */
	let lastEndAssistant:
		| { stopReason?: string; errorMessage?: string }
		| undefined;

	pi.on("agent_end", (event) => {
		const messages = event.messages as Array<{
			role?: string;
			stopReason?: string;
			errorMessage?: string;
		}>;
		lastEndAssistant = undefined;
		if (!Array.isArray(messages)) return;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") {
				lastEndAssistant = messages[i];
				break;
			}
		}
	});

	// agent_settled = core will not auto-retry / compact further. Safe to re-drive.
	pi.on("agent_settled", async (_event, ctx) => {
		if (inFlight) return;
		if (!ctx.isIdle()) return;

		// Prefer agent_end stash; fall back to session journal.
		let lastAssistant = lastEndAssistant;
		if (!lastAssistant || lastAssistant.stopReason !== "error") {
			const entries = ctx.sessionManager.getEntries() as Array<{
				type?: string;
				message?: { role?: string; stopReason?: string; errorMessage?: string };
			}>;
			lastAssistant = undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry?.type === "message" && entry.message?.role === "assistant") {
					lastAssistant = entry.message;
					break;
				}
			}
		}
		if (!lastAssistant || lastAssistant.stopReason !== "error") return;
		if (!isKimiSoft401ErrorMessage(lastAssistant.errorMessage)) return;
		// Body match is authoritative. lastProviderStatus is retained for the
		// notify line only (may be undefined when the error path skips the hook).

		if (attempt >= MAX_ATTEMPTS) {
			ctx.ui.notify(
				`kimi-401-retry: giving up after ${MAX_ATTEMPTS} attempts (last: ${(lastAssistant.errorMessage ?? "").slice(0, 120)})`,
				"warning",
			);
			return;
		}

		inFlight = true;
		const myGen = generation;
		attempt += 1;
		const wait = delayMs(attempt);

		try {
			const statusNote =
				lastProviderStatus !== undefined ? ` (http ${lastProviderStatus})` : "";
			ctx.ui.notify(
				`kimi-401-retry: soft 401${statusNote} — retry ${attempt}/${MAX_ATTEMPTS} in ${Math.round(wait / 1000)}s`,
				"info",
			);
			await sleep(wait);
			if (generation !== myGen) return;
			if (!ctx.isIdle()) return;

			// Hidden custom message; Pi strips prior errored assistant messages
			// from LLM context (transform-messages), so the model re-attempts cleanly.
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: "Retry the previous request after a transient provider authentication error.",
					display: false,
					details: {
						attempt,
						maxAttempts: MAX_ATTEMPTS,
						reason: "kimi-soft-401",
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} finally {
			inFlight = false;
		}
	});
}

// Exported for unit tests (pattern + delay only — no ExtensionAPI).
export const __test = {
	KIMI_SOFT_401_PATTERN,
	isKimiSoft401ErrorMessage,
	delayMs,
	MAX_ATTEMPTS,
	BASE_DELAY_MS,
	MAX_DELAY_MS,
	CUSTOM_TYPE,
};
