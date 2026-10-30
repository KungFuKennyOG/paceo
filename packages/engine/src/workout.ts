/**
 * Neutral planned-workout DSL (spec §3.8).
 * Targets are stored in SI (s/km); HR as %HRmax. Converted per sink at push time.
 */
import { z } from "zod";

export const DurationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("time"), s: z.number().positive() }),
  z.object({ type: z.literal("distance"), m: z.number().positive() }),
  z.object({ type: z.literal("open") }),
]);
export type Duration = z.infer<typeof DurationSchema>;

export const TargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pace"),
    /** faster bound, s/km */
    lo_s_per_km: z.number().positive(),
    /** slower bound, s/km */
    hi_s_per_km: z.number().positive(),
  }),
  z.object({
    type: z.literal("hr_pct_max"),
    lo: z.number().min(40).max(100),
    hi: z.number().min(40).max(100),
  }),
  z.object({ type: z.literal("rpe"), value: z.string() }),
  z.object({ type: z.literal("open") }),
]);
export type Target = z.infer<typeof TargetSchema>;

const StepKind = z.enum(["warmup", "work", "recovery", "rest", "cooldown", "run", "walk"]);

export const SimpleStepSchema = z.object({
  kind: StepKind,
  duration: DurationSchema,
  target: TargetSchema,
  fallback: TargetSchema.optional(),
  rpe: z.string().optional(),
  note: z.string().optional(),
});
export type SimpleStep = z.infer<typeof SimpleStepSchema>;

export const RepeatStepSchema = z.object({
  kind: z.literal("repeat"),
  count: z.number().int().min(1).max(50),
  steps: z.array(SimpleStepSchema).min(1),
});
export type RepeatStep = z.infer<typeof RepeatStepSchema>;

export const StepSchema = z.union([RepeatStepSchema, SimpleStepSchema]);
export type Step = z.infer<typeof StepSchema>;

export const WorkoutTypeSchema = z.enum([
  "E", // easy
  "L", // long
  "M", // marathon pace
  "T", // threshold
  "I", // intervals
  "R", // repetitions
  "S", // strides / easy + strides
  "H", // hills
  "TT", // time trial
  "RW", // run/walk
  "RACE",
  "STRENGTH",
]);
export type WorkoutType = z.infer<typeof WorkoutTypeSchema>;

/**
 * One exercise inside a strength session (§9.3). Additive to the §3.8 DSL: runs never carry it and
 * old workout JSON stays valid. `id` points into the exercise library (strength-library.ts), which
 * holds the full card (description, faults, regression/progression).
 */
export const ExerciseSchema = z.object({
  id: z.string(),
  /** §9.3 slot: SQUAT, HINGE, SINGLE_LEG, CALF_STRAIGHT, CALF_BENT, HIP, CORE, UPPER_PUSH, UPPER_PULL, PLYO. */
  slot: z.string(),
  name: z.string(),
  sets: z.number().int().min(1).max(10),
  /** Per set, as text: "3–5", "8–12 / leg", "30–45 s / side", "10 contacts". */
  reps: z.string(),
  /** Load guidance: "RPE 8 (~85% 1RM)", "bodyweight, 3 s lowering", "≤ 40% 1RM, no failure". */
  load: z.string(),
  rest_s: z.number().nonnegative().optional(),
  /** Plyometrics only: foot contacts for the whole exercise (§9.5). */
  contacts: z.number().int().nonnegative().optional(),
  cues: z.array(z.string()).default([]),
  note: z.string().optional(),
});
export type Exercise = z.infer<typeof ExerciseSchema>;

export const PlannedWorkoutSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  /** Local date, YYYY-MM-DD */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sport: z.enum(["run", "strength"]),
  type: WorkoutTypeSchema,
  name: z.string(),
  phase: z.string().optional(),
  prescription_mode: z.enum(["pace", "time_rpe", "run_walk"]),
  steps: z.array(StepSchema),
  planned: z.object({
    run_m: z.number().nonnegative(),
    minutes: z.number().nonnegative(),
    expected_srpe: z.number().min(0).max(10),
  }),
  flags: z
    .object({
      heat_adjusted: z.boolean().default(false),
      key_session: z.boolean().default(false),
    })
    .default({}),
  rule_trace: z.array(z.string()).default([]),
  /** Strength sessions only (sport "strength"): the exercises, in order (§9.3). */
  exercises: z.array(ExerciseSchema).optional(),
});
export type PlannedWorkout = z.infer<typeof PlannedWorkoutSchema>;

export function isRepeat(step: Step): step is RepeatStep {
  return step.kind === "repeat";
}
