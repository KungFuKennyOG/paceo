/**
 * View model for planned workouts. The API sends the engine's PlannedWorkout JSON loosely typed
 * (contracts use passthrough), and other agents are adding sports and types (strength, cross-training),
 * so everything here is parsed defensively: unknown types get a generic label, invalid steps are
 * skipped, and an optional `exercises` array is rendered when present.
 */
import { StepSchema, type Duration, type SimpleStep, type Step, type Target } from "@paceo/engine";
import type { WorkoutItem } from "@paceo/contracts";
import {
  formatDistance,
  formatLongRunDistance,
  formatMinutes,
  formatPaceTarget,
  formatRepDistance,
  formatSeconds,
  type Units,
} from "./units";

export interface Exercise {
  name: string;
  slot?: string;
  sets?: number;
  reps?: string;
  durationS?: number;
  rpe?: string;
  loadKg?: number;
  restS?: number;
  description?: string;
  cues: string[];
  commonFaults: string[];
  notes?: string;
  demoUrl?: string;
}

export interface ViewWorkout {
  id: string;
  date: string;
  sport: string;
  type: string;
  name: string;
  phase?: string;
  prescriptionMode?: string;
  steps: Step[];
  /** Steps that failed to parse (rendered as a hint rather than crashing). */
  skippedSteps: number;
  planned?: { runM: number; minutes: number; expectedSrpe?: number };
  keySession: boolean;
  ruleTrace: string[];
  exercises: Exercise[];
}

type Loose = Record<string, unknown>;

const isObj = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function pick(o: Loose, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

export function parseExercise(raw: unknown): Exercise | null {
  if (typeof raw === "string") return { name: raw, cues: [], commonFaults: [] };
  if (!isObj(raw)) return null;
  const name = str(pick(raw, "name", "title", "exercise"));
  if (!name) return null;
  const repsRaw = pick(raw, "reps", "rep_range", "repRange");
  const ex: Exercise = {
    name,
    cues: strList(pick(raw, "cues")),
    commonFaults: strList(pick(raw, "common_faults", "commonFaults", "faults")),
  };
  const slot = str(pick(raw, "slot"));
  if (slot) ex.slot = slot;
  const sets = num(pick(raw, "sets"));
  if (sets !== undefined) ex.sets = sets;
  if (typeof repsRaw === "number") ex.reps = String(repsRaw);
  else if (typeof repsRaw === "string") ex.reps = repsRaw;
  const dur = num(pick(raw, "duration_s", "durationS", "seconds", "hold_s"));
  if (dur !== undefined) ex.durationS = dur;
  const rpeRaw = pick(raw, "rpe", "intensity");
  if (typeof rpeRaw === "number" || typeof rpeRaw === "string") ex.rpe = String(rpeRaw);
  const load = num(pick(raw, "load_kg", "loadKg", "weight_kg"));
  if (load !== undefined) ex.loadKg = load;
  const rest = num(pick(raw, "rest_s", "restS"));
  if (rest !== undefined) ex.restS = rest;
  const desc = str(pick(raw, "description", "desc"));
  if (desc) ex.description = desc;
  const notes = str(pick(raw, "notes", "note"));
  if (notes) ex.notes = notes;
  const demo = str(pick(raw, "demo_url", "demoUrl"));
  if (demo && /^https?:\/\//.test(demo)) ex.demoUrl = demo;
  return ex;
}

/** Normalise a WorkoutItem's (or a client-generated) workout JSON into a ViewWorkout. */
export function toViewWorkout(raw: WorkoutItem["workout"] | Loose): ViewWorkout {
  const o = raw as Loose;
  const steps: Step[] = [];
  let skipped = 0;
  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  for (const s of rawSteps) {
    const parsed = StepSchema.safeParse(s);
    if (parsed.success) steps.push(parsed.data);
    else skipped++;
  }
  const exercises: Exercise[] = [];
  if (Array.isArray(o.exercises)) {
    for (const e of o.exercises) {
      const ex = parseExercise(e);
      if (ex) exercises.push(ex);
    }
  }
  const plannedRaw = isObj(o.planned) ? o.planned : undefined;
  const flags = isObj(o.flags) ? o.flags : {};
  const vw: ViewWorkout = {
    id: str(o.id) ?? "unknown",
    date: str(o.date) ?? "",
    sport: str(o.sport) ?? (str(o.type) === "STRENGTH" ? "strength" : "run"),
    type: str(o.type) ?? "UNKNOWN",
    name: str(o.name) ?? "Workout",
    steps,
    skippedSteps: skipped,
    keySession: flags.key_session === true,
    ruleTrace: strList(o.rule_trace),
    exercises,
  };
  const phase = str(o.phase);
  if (phase) vw.phase = phase;
  const mode = str(o.prescription_mode);
  if (mode) vw.prescriptionMode = mode;
  if (plannedRaw) {
    const p: NonNullable<ViewWorkout["planned"]> = {
      runM: num(plannedRaw.run_m) ?? 0,
      minutes: num(plannedRaw.minutes) ?? 0,
    };
    const srpe = num(plannedRaw.expected_srpe);
    if (srpe !== undefined) p.expectedSrpe = srpe;
    vw.planned = p;
  }
  return vw;
}

const TYPE_LABELS: Record<string, string> = {
  E: "Easy",
  L: "Long run",
  M: "Marathon pace",
  T: "Threshold",
  I: "Intervals",
  R: "Repetitions",
  S: "Easy + strides",
  H: "Hills",
  TT: "Time trial",
  RW: "Run/walk",
  RACE: "Race day",
  STRENGTH: "Strength",
  XT: "Cross-training",
  CROSS: "Cross-training",
  REST: "Rest",
};

/** Human label for a workout type; unknown types are humanised rather than hidden. */
export function typeLabel(type: string): string {
  const known = TYPE_LABELS[type];
  if (known) return known;
  const words = type.replace(/[_-]+/g, " ").toLowerCase().trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Workout";
}

/** CSS tone token for a type (colour-coded intensity). */
export function typeTone(type: string): string {
  switch (type) {
    case "E":
    case "S":
    case "RW":
      return "easy";
    case "L":
      return "long";
    case "M":
      return "marathon";
    case "T":
      return "threshold";
    case "I":
    case "H":
      return "interval";
    case "R":
    case "TT":
    case "RACE":
      return "rep";
    case "STRENGTH":
      return "strength";
    default:
      return "other";
  }
}

export function isStrength(w: Pick<ViewWorkout, "sport" | "type">): boolean {
  return w.sport === "strength" || w.type === "STRENGTH";
}

export function isRepeatStep(step: Step): step is Extract<Step, { kind: "repeat" }> {
  return step.kind === "repeat";
}

const STEP_LABELS: Record<SimpleStep["kind"], string> = {
  warmup: "Warm-up",
  work: "Work",
  recovery: "Recovery",
  rest: "Rest",
  cooldown: "Cool-down",
  run: "Run",
  walk: "Walk",
};

export function stepLabel(step: SimpleStep): string {
  return STEP_LABELS[step.kind] ?? step.kind;
}

export interface DescribeContext {
  units: Units;
  /** A step inside a repeat block: distance reps keep metric track units (§5). */
  inRepeat?: boolean;
  /** Long runs round distance to 0.5 km/mi (§5). */
  longRun?: boolean;
  hrMax?: number | null;
}

export function describeDuration(d: Duration, ctx: DescribeContext): string {
  switch (d.type) {
    case "time":
      return formatSeconds(d.s);
    case "distance":
      if (ctx.inRepeat || d.m < 1000) return formatRepDistance(d.m, ctx.units);
      if (ctx.longRun) return formatLongRunDistance(d.m, ctx.units);
      return formatDistance(d.m, ctx.units);
    case "open":
      return "Until lap press";
    default:
      return "";
  }
}

export function describeTarget(t: Target, ctx: DescribeContext): string {
  switch (t.type) {
    case "pace":
      return formatPaceTarget(t.lo_s_per_km, t.hi_s_per_km, ctx.units);
    case "hr_pct_max": {
      const pct = `${Math.round(t.lo)}–${Math.round(t.hi)}% HRmax`;
      if (ctx.hrMax) {
        return `${pct} (${Math.round((t.lo / 100) * ctx.hrMax)}–${Math.round((t.hi / 100) * ctx.hrMax)} bpm)`;
      }
      return pct;
    }
    case "rpe":
      return `RPE ${t.value.replace("-", "–")}`;
    case "open":
      return "Easy / open";
    default:
      return "";
  }
}

/** One flattened step for the in-app "follow" mode (§3.6): repeats are unrolled. */
export interface FlatStep {
  step: SimpleStep;
  label: string;
  /** e.g. "Rep 2 of 4" */
  repLabel?: string;
  inRepeat: boolean;
}

export function flattenSteps(steps: Step[]): FlatStep[] {
  const out: FlatStep[] = [];
  for (const s of steps) {
    if (isRepeatStep(s)) {
      for (let i = 1; i <= s.count; i++) {
        for (const inner of s.steps) {
          out.push({ step: inner, label: stepLabel(inner), repLabel: `Rep ${i} of ${s.count}`, inRepeat: true });
        }
      }
    } else {
      out.push({ step: s, label: stepLabel(s), inRepeat: false });
    }
  }
  return out;
}

/** "10.5 km · 62 min" style summary of what's planned. */
export function plannedSummary(w: ViewWorkout, units: Units): string {
  const parts: string[] = [];
  if (w.planned) {
    if (w.planned.runM > 0) {
      parts.push(w.type === "L" ? formatLongRunDistance(w.planned.runM, units) : formatDistance(w.planned.runM, units));
    }
    if (w.planned.minutes > 0) parts.push(formatMinutes(w.planned.minutes));
  }
  if (isStrength(w) && w.exercises.length > 0) parts.push(`${w.exercises.length} exercises`);
  return parts.join(" · ");
}

export function exercisePrescription(ex: Exercise): string {
  const parts: string[] = [];
  if (ex.sets !== undefined && ex.reps) parts.push(`${ex.sets} × ${ex.reps}`);
  else if (ex.sets !== undefined && ex.durationS !== undefined) parts.push(`${ex.sets} × ${formatSeconds(ex.durationS)}`);
  else if (ex.reps) parts.push(`${ex.reps} reps`);
  else if (ex.durationS !== undefined) parts.push(formatSeconds(ex.durationS));
  else if (ex.sets !== undefined) parts.push(`${ex.sets} sets`);
  if (ex.rpe) parts.push(`RPE ${ex.rpe}`);
  return parts.join(" @ ");
}
