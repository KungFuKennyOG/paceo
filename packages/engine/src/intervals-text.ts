/**
 * Compile the neutral workout DSL into intervals.icu workout text (spec §3.7).
 *
 * ⚠ UNVERIFIED (spec §14): the exact intervals.icu text syntax must be confirmed by round-tripping
 * a builder-made workout through GET /api/v1/athlete/0/events/{id}. The syntax used here follows the
 * intervals.icu workout builder conventions as we understand them:
 *   - "- 15m ..."      time step (m = minutes, s = seconds, h = hours)
 *   - "- 1km ..."      distance step; metres are written "mtr" (e.g. "400mtr") because "m" means minutes
 *   - "5:50-6:07/km Pace"   absolute pace range
 *   - "65-79% HR"     percent of max HR
 *   - "4x" header line followed by its steps, blank lines between blocks
 * scripts/spike-push-workout.ts exists to verify this on a real watch.
 */
import type { Duration, PlannedWorkout, RepeatStep, SimpleStep, Step, Target } from "./workout.js";
import { formatMinSec } from "./units.js";

// Local guard (no runtime zod dependency) so this compiler also runs in lightweight contexts.
const isRepeat = (step: Step): step is RepeatStep => step.kind === "repeat";

function durationText(d: Duration): string {
  switch (d.type) {
    case "time": {
      const s = Math.round(d.s);
      if (s % 3600 === 0) return `${s / 3600}h`;
      if (s % 60 === 0) return `${s / 60}m`;
      if (s > 60) return `${Math.floor(s / 60)}m${s % 60}s`;
      return `${s}s`;
    }
    case "distance": {
      const m = Math.round(d.m);
      if (m % 1000 === 0) return `${m / 1000}km`;
      if (m >= 1000) return `${(m / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}km`;
      return `${m}mtr`;
    }
    case "open":
      // intervals.icu has no explicit "open" duration; use a lap-button-length placeholder.
      return "lap";
  }
}

function targetText(t: Target): string {
  switch (t.type) {
    case "pace": {
      // Watches show the faster bound second; we write slow-fast to match how ranges read.
      const fast = Math.floor(t.lo_s_per_km);
      const slow = Math.ceil(t.hi_s_per_km);
      return `${formatMinSec(slow)}-${formatMinSec(fast)}/km Pace`;
    }
    case "hr_pct_max":
      return `${Math.round(t.lo)}-${Math.round(t.hi)}% HR`;
    case "rpe":
      return ""; // no device target; RPE lives in the step label
    case "open":
      return "";
  }
}

const LABELS: Record<SimpleStep["kind"], string> = {
  warmup: "Warmup",
  work: "",
  recovery: "Recovery",
  rest: "Rest",
  cooldown: "Cooldown",
  run: "Run",
  walk: "Walk",
};

function stepLine(step: SimpleStep): string {
  const parts = ["-"];
  const label = LABELS[step.kind];
  if (label) parts.push(label);
  if (step.target.type === "rpe") parts.push(`RPE ${step.target.value}`);
  parts.push(durationText(step.duration));
  const tgt = targetText(step.target);
  if (tgt) parts.push(tgt);
  return parts.join(" ");
}

export function stepsToIntervalsText(steps: Step[]): string {
  const blocks: string[] = [];
  for (const step of steps) {
    if (isRepeat(step)) {
      blocks.push([`${step.count}x`, ...step.steps.map(stepLine)].join("\n"));
    } else {
      blocks.push(stepLine(step));
    }
  }
  return blocks.join("\n\n");
}

/** intervals.icu `events/bulk` payload for one planned workout (spec §3.2). */
export interface IntervalsEvent {
  category: "WORKOUT";
  start_date_local: string;
  type: "Run" | "WeightTraining";
  name: string;
  description: string;
  external_id: string;
}

export function toIntervalsEvent(w: PlannedWorkout, rev = 0): IntervalsEvent {
  return {
    category: "WORKOUT",
    start_date_local: `${w.date}T00:00:00`,
    type: w.sport === "run" ? "Run" : "WeightTraining",
    name: w.name,
    description: stepsToIntervalsText(w.steps),
    external_id: `${w.user_id}:${w.id}:${rev}`,
  };
}
