import { dispatchPayloadDigest } from "@cq/config";
import type { Item } from "./types.js";

export function ledgerItemRevisionV1(ref: string, item: Item): string {
  return dispatchPayloadDigest({ ref, item: { ...item, fields: { ...item.fields } } });
}
