import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi-xai (npm) hardcodes `contextWindow: 131072` (128k, the stale Grok 4/4.1
// figure) for every grok-build model it registers. The Grok Build Coding Plan
// model actually exposes 256k — Pi's own bundled model table agrees
// (grok-build-0.1 -> 256000) — so the stale value makes Pi report `%/131k` and
// auto-compact at half the real budget. See the upstream bug report in
// docs/drafts/.
//
// We can't fix this from settings: `modelOverrides` (which can set
// contextWindow) only applies to BUILT-IN providers, and `grok-build` is
// registered at runtime by pi-xai. Instead of vendoring pi-xai's source to bump
// the constant, we re-register the provider's model list here with the correct
// figure. We restate the three model definitions exactly as pi-xai declares
// them (pi-xai@0.8.5), changing only `contextWindow`.
//
// IMPORTANT — registerProvider validation (pi-coding-agent ≥0.78.0):
// `ModelRegistry.validateProviderConfig` validates the *incoming* config BEFORE
// the merge step (`upsertRegisteredProvider`) runs. Any config carrying a
// `models[]` array must therefore itself supply `baseUrl` AND (`apiKey` |
// `oauth`), and every model must have a resolvable `api`. A models-ONLY override
// does NOT inherit pi-xai's baseUrl/api for validation — it is rejected with
// `"baseUrl" is required when defining models`. So we must restate those fields:
//   - baseUrl / api / authHeader: copied verbatim from pi-xai's registration.
//   - apiKey: we set it to "$XAI_API_KEY" purely to satisfy the apiKey|oauth
//     validation gate. We deliberately do NOT re-pass `oauth`: applyProviderConfig
//     would call registerOAuthProvider with it and CLOBBER pi-xai's live
//     login/refresh/getApiKey functions (not reachable through pi-xai's exports).
//     By omitting oauth, pi-xai's OAuth provider registration and the persisted
//     `/login grok-build` credentials in authStorage are left intact. At request
//     time getApiKeyAndHeaders resolves authStorage (OAuth) FIRST and only falls
//     back to this apiKey, so OAuth still wins whenever the user is logged in;
//     the $XAI_API_KEY fallback matches pi-xai's own "OAuth or XAI_API_KEY"
//     contract for the not-logged-in case.
//
// Ordering: pi-xai registers grok-build once at extension-load time. We
// re-register on `session_start`, which fires after load, so our override lands
// last and is not clobbered. registerProvider after the initial load phase takes
// effect immediately (no /reload needed) and the call is idempotent across
// session switches.

const PROVIDER_ID = "grok-build";

// Restated from pi-xai@0.8.5 (xai-provider.ts / xai-config.ts XAI_API_BASE).
// Keep in sync if a future pi-xai version changes them.
const GROK_BUILD_BASE_URL = "https://api.x.ai/v1";
const GROK_BUILD_API = "openai-responses";
// Satisfies validateProviderConfig's apiKey|oauth gate without re-registering
// (and thereby clobbering) pi-xai's OAuth resolver. OAuth from authStorage takes
// priority at request time; this is only the not-logged-in env-key fallback.
const GROK_BUILD_APIKEY_FALLBACK = "$XAI_API_KEY";

// Verified against Pi's bundled model table (grok-build-0.1 -> 256000) and
// xAI's Grok Build Coding Plan docs. Replaces pi-xai's stale 131072.
const GROK_BUILD_CONTEXT_WINDOW = 256000;

// pi-xai's per-model cost table (identical across the three models it ships).
const GROK_COST = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const GROK_MAX_TOKENS = 32768;
const GROK_INPUT = ["text", "image"];

// The exact model set pi-xai registers, with only contextWindow corrected. If a
// future pi-xai version changes its model list, update this table to match (and
// re-confirm the upstream bug is still unfixed).
const PATCHED_MODELS = [
  {
    id: "grok-build",
    name: "Grok Build (Coding Plan)",
    reasoning: false,
    input: GROK_INPUT,
    cost: GROK_COST,
    contextWindow: GROK_BUILD_CONTEXT_WINDOW,
    maxTokens: GROK_MAX_TOKENS,
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3 (Build)",
    reasoning: true,
    input: GROK_INPUT,
    cost: GROK_COST,
    contextWindow: GROK_BUILD_CONTEXT_WINDOW,
    maxTokens: GROK_MAX_TOKENS,
  },
  {
    id: "grok-4.3-latest",
    name: "Grok 4.3 Latest (Build)",
    reasoning: true,
    input: GROK_INPUT,
    cost: GROK_COST,
    contextWindow: GROK_BUILD_CONTEXT_WINDOW,
    maxTokens: GROK_MAX_TOKENS,
  },
];

export default function patchGrokBuildContextWindow(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    // Replaces the model list (corrected contextWindow) and restates the
    // fields validateProviderConfig requires on a models-bearing config. We omit
    // `oauth` on purpose so pi-xai's live OAuth registration is preserved — see
    // the header for why and how OAuth still wins at request time.
    pi.registerProvider(
      PROVIDER_ID,
      {
        baseUrl: GROK_BUILD_BASE_URL,
        api: GROK_BUILD_API,
        authHeader: true,
        apiKey: GROK_BUILD_APIKEY_FALLBACK,
        models: PATCHED_MODELS,
      } as never,
    );
  });
}
