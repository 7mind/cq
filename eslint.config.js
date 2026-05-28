// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // Global ignores — these are excluded from all configs below
    ignores: ["**/node_modules/**", "**/.cache/**", "**/.direnv/**", "**/dist/**"],
  },
  // Base JS rules
  eslint.configs.recommended,
  // TypeScript recommended rules (non-type-checked — add recommendedTypeChecked in a later PR)
  ...tseslint.configs.recommended,
  // Prettier disables conflicting style rules (must be last)
  prettierConfig,
  {
    // Honour the conventional `_`-prefixed unused-args/vars pattern. Used in
    // interface-implementation methods that must accept parameters they do
    // not use (see e.g. CodexBridge stubs for permission/elicitation/question
    // replies that the Codex CLI does not surface).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Server package: Node/Bun globals
    files: ["packages/server/**/*.{ts,js}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Web package: Browser globals
    files: ["packages/web/**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
);
