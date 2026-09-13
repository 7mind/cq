import { SearchProjectionEngine } from "../src/search/DirectSearchProjection.js";
import type { SearchProjectionRequest } from "../src/search/SearchProjection.js";

function serve(): void {
  const engine = new SearchProjectionEngine();
  let held = false;
  self.onmessage = (event: MessageEvent<SearchProjectionRequest>): void => {
    const request = event.data;
    if (held) return;
    if (request.command.kind === "search") {
      switch (request.command.query) {
        case "crash":
          throw new Error("injected search worker crash");
        case "exit":
          self.close();
          return;
        case "timeout":
          held = true;
          return;
        case "out-of-order":
          postMessage({ ...engine.execute(request), commandId: request.commandId + 1 });
          return;
      }
    }
    postMessage(engine.execute(request));
  };
}

serve();
