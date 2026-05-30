import { createRoot } from "react-dom/client";
import { Manager } from "./ws/Manager";
import { ConnectionProvider } from "./ws/ConnectionProvider";
import { defaultCryptoProvider } from "./lib/crypto";
import { initTheme } from "./lib/theme";
import App from "./App";
import "./styles/global.css";

// DARK-01: resolve + apply the theme (light|dark|auto) BEFORE React renders,
// so document.documentElement[data-theme] is set ahead of first paint (no
// flash of wrong theme). Attaches the live OS-change listener for auto mode.
initTheme();

/**
 * Application entry point (PR-17).
 *
 * The Manager is constructed here — once, at the module level — so it is
 * never re-created on re-renders (G2c: F-18 — no module-global Manager inside
 * components). <App> and all descendants access it via useConnection() /
 * useConnectionStats().
 *
 * No teardown is registered: main.tsx mounts the root once for the lifetime of
 * the browser tab. The Manager's destroy() would be called by <App>'s unmount
 * in a test environment, but in production the tab lifecycle owns cleanup.
 */
const manager = new Manager({
  url: `ws://${location.host}/ws`,
  enableTimeJumpDetector: true,
  // Probe-once-and-cache CryptoProvider. Constructed here (not inside
  // Manager defaults) so the production wiring is visible at the entry point
  // and the wiring path matches the one tests exercise.
  crypto: defaultCryptoProvider(),
  // Persistent reconnection: don't give up after the default 15 attempts.
  // Dogfooding showed the page going terminal during long server outages
  // (e.g. while the developer was restarting cq) and never recovering.
  maxAttempts: Number.POSITIVE_INFINITY,
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ConnectionProvider value={manager}>
      <App />
    </ConnectionProvider>,
  );
}
