import { SearchProjectionEngine } from "./DirectSearchProjection.js";
import type { SearchProjectionRequest } from "./SearchProjection.js";

function serve(): void {
  const engine = new SearchProjectionEngine();
  self.onmessage = (event: MessageEvent<SearchProjectionRequest>): void => {
    postMessage(engine.execute(event.data));
  };
}

serve();
