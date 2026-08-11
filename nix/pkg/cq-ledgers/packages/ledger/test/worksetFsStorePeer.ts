import { promises as fs } from "node:fs";
import { createFsWorksetStore } from "../src/index.js";

interface PeerRequest {
  readonly root: string;
  readonly roots: readonly string[];
  readonly startedFile?: string;
  readonly completedFile?: string;
  readonly readyFile?: string;
  readonly releaseFile?: string;
}

const request = JSON.parse(await Bun.stdin.text()) as PeerRequest;
if (request.startedFile !== undefined) await fs.writeFile(request.startedFile, "started\n");
const readyFile = request.readyFile;
const releaseFile = request.releaseFile;
const store = createFsWorksetStore({
  root: request.root,
  ...(readyFile !== undefined && releaseFile !== undefined
    ? {
        hooks: {
          afterExclusiveReady: async () => {
            await fs.writeFile(readyFile, "ready\n");
            while (!(await Bun.file(releaseFile).exists())) await Bun.sleep(5);
          },
        },
      }
    : {}),
});
const result = await store.setRoots(request.roots);
if (request.completedFile !== undefined) await fs.writeFile(request.completedFile, "completed\n");
process.stdout.write(`${JSON.stringify(result)}\n`);
