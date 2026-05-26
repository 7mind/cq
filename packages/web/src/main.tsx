import { createRoot } from "react-dom/client";
import { Manager } from "./ws/Manager";
import { ConnectionProvider } from "./ws/ConnectionProvider";
import App from "./App";
import "./styles/global.css";

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
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ConnectionProvider value={manager}>
      <App />
    </ConnectionProvider>,
  );
}
