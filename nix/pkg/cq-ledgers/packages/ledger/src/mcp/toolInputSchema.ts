import { z } from "zod";

/** A canonical MCP input may be a legacy raw shape or a complete object schema. */
export type LedgerToolInputSchema = Record<string, z.ZodType> | z.ZodObject;

/** Preserve complete object schemas while normalizing legacy raw shapes. */
export function normalizeLedgerToolInputSchema(inputSchema: LedgerToolInputSchema): z.ZodObject {
  return inputSchema instanceof z.ZodObject ? inputSchema : z.object(inputSchema);
}
