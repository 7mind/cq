import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./counts" && context.parentURL?.endsWith("/ledger-status/index.ts")) {
      return { url: new URL("./counts.ts", context.parentURL).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
