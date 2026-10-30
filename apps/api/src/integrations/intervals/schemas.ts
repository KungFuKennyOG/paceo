/**
 * Loose zod schemas for intervals.icu responses (spec §2.6: validate adapter responses at the
 * boundary). Only the fields the app reads are declared; everything else passes through.
 */
import { z } from "zod";

const optStr = z.string().nullish();
const optNum = z.number().nullish();

export const IcuAthlete = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: optStr,
  })
  .passthrough();

export const IcuActivity = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    start_date_local: optStr,
    start_date: optStr,
    type: optStr,
    name: optStr,
    distance: optNum,
    moving_time: optNum,
    elapsed_time: optNum,
    average_heartrate: optNum,
    icu_average_hr: optNum,
    device_name: optStr,
    source: optStr,
    race: z.boolean().nullish(),
    sub_type: optStr,
    _note: optStr,
  })
  .passthrough();
export type IcuActivity = z.infer<typeof IcuActivity>;

export const IcuEvent = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    external_id: optStr,
    start_date_local: optStr,
    name: optStr,
    category: optStr,
  })
  .passthrough();
export type IcuEvent = z.infer<typeof IcuEvent>;
