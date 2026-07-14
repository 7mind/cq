/**
 * fsAtomic — the store's atomic-write primitive (tmp + fsync + rename).
 *
 * Factored out of FsLedgerStore so other writers reuse the SAME primitive
 * instead of duplicating the tmp/rename dance.
 * A reader never observes a partially-written file: content is written to a
 * uniquely-named sibling temp file, fsync'd, then atomically renamed over the
 * destination.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Write `text` to `filePath` atomically (tmp + fsync + rename). */
export async function atomicWrite(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}
