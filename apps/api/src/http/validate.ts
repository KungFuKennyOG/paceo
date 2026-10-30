import type { z } from "zod";
import { AppError } from "./errors.js";

/** Parse a request body/query with a contract schema; 400 "validation" on failure. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(400, "validation", "Request did not match the expected shape.", r.error.flatten());
  }
  return r.data;
}

/**
 * Check an outgoing body against its contract schema. A mismatch is a server bug, so it is a 500,
 * not something the client can fix; integration tests catch these.
 */
export function output<S extends z.ZodTypeAny>(schema: S, value: z.input<S>): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(500, "contract_violation", "Response did not match the contract.", r.error.flatten());
  }
  return r.data;
}
