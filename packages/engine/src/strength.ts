/**
 * Strength module (spec §9): configuration (§9.2), phase table (§9.4), plyo dosing (§9.5) and the
 * session builder that turns one placed session into a PlannedWorkout draft (§9.3).
 * Placement against runs and cross-training (ST-1…ST-8) lives in strength-schedule.ts.
 *
 * Evidence: heavy (≥ 85–90% 1RM) and combined heavy + plyometric work improve running economy
 * (Llanos-Lagos 2024, Eihara 2022, E); submaximal/bodyweight programs did not (E). Session
 * structure, loads per phase and every number below not marked otherwise are D.
 */
import type { Phase, PlanMode } from "./plan-types.js";
import type { Exercise, Step } from "./workout.js";
import type { WorkoutDraft } from "./workouts.js";
import { exerciseFor, exerciseCard, PLYO_LADDER, type ExerciseCard, type StrengthEquipment, type StrengthSlot } from "./strength-library.js";

export type { StrengthEquipment } from "./strength-library.js";

/** §9.2 mode: running-focused = lower body + core; full-body adds upper push/pull. */
export type StrengthMode = "off" | "running" | "full_body" | "external";
/** §9.2: none / novice (< 6 months consistent) / experienced. */
export type LiftingExperience = "none" | "novice" | "experienced";

export interface StrengthConfig {
  mode: StrengthMode;
  equipment: StrengthEquipment;
  /** 0–3; an upper bound the phase table may lower, never raise (§9.2). */
  sessionsPerWeek: number;
  liftingExperience: LiftingExperience;
  /** Full-body only: merge upper work into the strength sessions (default) or put it on separate days. */
  upperBodyDays?: "merge" | "separate";
  /**
   * External mode only: the app adds CALF + PLYO + one SINGLE_LEG slot (~15 min) after each of the
   * user's own lower/full sessions (§9.6 "running-focused add-on").
   */
  externalAddOn?: boolean;
}

/** §9.2 defaults: running-focused, bodyweight, 2/week, no lifting experience. */
export const DEFAULT_STRENGTH_CONFIG: StrengthConfig = {
  mode: "running",
  equipment: "bodyweight",
  sessionsPerWeek: 2,
  liftingExperience: "none",
  upperBodyDays: "merge",
};

export const MAX_STRENGTH_SESSIONS = 3;

// ── §9.4 phase table ─────────────────────────────────────────────────────────────────────────────

export type StrengthRowId = "general" | "base" | "build" | "peak" | "taper" | "race_week";

export interface StrengthRow {
  id: StrengthRowId;
  /** Sessions/week cap (≤ the user's setting). */
  sessions: number;
  /** Plyo contacts per session [low, high]. */
  plyo: readonly [number, number];
  /** Highest plyo rung (index into PLYO_LADDER) this row may reach (D). */
  maxRung: number;
  /** Whether the plyo rung may advance in this row (peak and taper hold it, D). */
  advanceRung: boolean;
}

/** §9.4 (D on E principles). Taper "1 light → 0": 1 in taper weeks, 0 in race week. */
export const STRENGTH_PHASE_TABLE: Record<StrengthRowId, StrengthRow> = {
  general: { id: "general", sessions: 3, plyo: [30, 50], maxRung: 1, advanceRung: true },
  base: { id: "base", sessions: 2, plyo: [40, 80], maxRung: 3, advanceRung: true },
  build: { id: "build", sessions: 2, plyo: [60, 120], maxRung: 6, advanceRung: true },
  peak: { id: "peak", sessions: 1, plyo: [40, 60], maxRung: 6, advanceRung: false },
  taper: { id: "taper", sessions: 1, plyo: [40, 60], maxRung: 6, advanceRung: false },
  race_week: { id: "race_week", sessions: 0, plyo: [0, 0], maxRung: 0, advanceRung: false },
};

/** Phase-table row for a plan week. BASE weeks (> 24-week plans) and general-fitness weeks use the off-season row. */
export function strengthRowFor(week: { phase: Phase; isTaper: boolean }, mode: PlanMode, isRaceWeek: boolean): StrengthRowId {
  if (isRaceWeek) return "race_week";
  if (week.isTaper) return "taper";
  if (mode === "general_fitness" || week.phase === "BASE") return "general";
  if (week.phase === "FI") return "base";
  if (week.phase === "EQ" || week.phase === "TQ") return "build";
  return "peak";
}

/**
 * Last heavy session and last plyos, in days before the race (§9.4): marathon/half −10 to −14 d,
 * so nothing heavy inside 10 days; 5K/10K −7 to −10 d. Race −3 to 0: no strength (D: we skip the
 * optional ≤ 10 min activation).
 */
export function strengthTaperDays(distance: "5k" | "10k" | "half" | "marathon"): { heavy: number; plyo: number; none: number } {
  return distance === "marathon" || distance === "half" ? { heavy: 10, plyo: 10, none: 3 } : { heavy: 7, plyo: 7, none: 3 };
}

/** Technique block length for lifters with no experience: 4–6 weeks → 5 (D). */
export const TECHNIQUE_BLOCK_WEEKS = 5;
/** General mode: 3 × 8–10 for the first weeks, then 3 × 6 (§9.4 "→ 3 × 6"; switch point D). */
export const GENERAL_HEAVIER_FROM_WEEK = 6;
/** Running cutback weeks deload strength by ~40% fewer sets (§9.4, D). */
export const STRENGTH_CUTBACK_SET_FACTOR = 0.6;
/** Beginner runners: technique block only, ≤ 30 min (§9.2). */
export const BEGINNER_TECHNIQUE_MAX_MIN = 30;

// ── §9.5 plyo dosing ─────────────────────────────────────────────────────────────────────────────

/**
 * Planned rung progression: one rung per 3 weeks with plyos (D). §9.5 advances on "no soreness 24 h
 * later and good quality", which only logs can show; the plan assumes a conservative pace and the
 * replan (§8) holds the rung when the user reports soreness.
 */
export const PLYO_WEEKS_PER_RUNG = 3;

/** Plyo hard cap per session (§9.5). */
export const PLYO_CONTACT_CAP = 150;
/** +10–20 contacts per week → 15 (D). */
export const PLYO_WEEKLY_STEP = 15;

/** Entry rung by lifting experience (§9.5): none → pogo, novice → skips, experienced → CMJ. */
export function plyoEntryRung(experience: LiftingExperience): number {
  return experience === "none" ? 0 : experience === "novice" ? 1 : 2;
}

/**
 * Contacts for a session: start 40–60 (none 30–40) → 50 (35), +15 per plyo week, capped by the
 * row's range and 150. Rounded to 5. A cutback week takes 60% (D).
 */
export function plyoContacts(experience: LiftingExperience, plyoWeek: number, row: StrengthRow, cutback: boolean): number {
  const start = experience === "none" ? 35 : 50;
  const raw = Math.min(PLYO_CONTACT_CAP, row.plyo[1], start + PLYO_WEEKLY_STEP * plyoWeek);
  const dosed = cutback ? raw * STRENGTH_CUTBACK_SET_FACTOR : raw;
  return Math.max(10, Math.round(dosed / 5) * 5);
}

// ── session builder (§9.3) ───────────────────────────────────────────────────────────────────────

/**
 * - lower:     running-focused Lower A/B (~45 min)
 * - full:      full-body A/B (~55–60 min)
 * - upper:     upper-only day (full-body with separate upper days)
 * - technique: technique block (beginner runners, no-experience lifters, conservative users)
 * - addon:     CALF + PLYO + SINGLE_LEG after the user's own lower session (§9.6, ~15 min)
 */
export type StrengthSessionKind = "lower" | "full" | "upper" | "technique" | "addon";

/** "row" = the phase table's main-lift prescription; "light" = taper ≤ 40% 1RM × 2, no failure. */
export type StrengthIntensity = "technique" | "row" | "light";

export interface StrengthSessionSpec {
  kind: StrengthSessionKind;
  variant: "A" | "B";
  row: StrengthRowId;
  intensity: StrengthIntensity;
  equipment: StrengthEquipment;
  experience: LiftingExperience;
  /** Running cutback / TT week: −40% sets. */
  cutback: boolean;
  /** Plyo block, first while fresh; absent = no plyos this session. */
  plyo?: { rung: number; contacts: number };
  /** 2 when the user has no trunk-loading cross-training (§9.3). */
  coreSlots: 1 | 2;
  /** Full-body technique sessions keep their upper slots. */
  withUpper: boolean;
  /** Weeks of general-mode strength so far (0-based), for 3 × 8–10 → 3 × 6. */
  generalWeek: number;
  /** Max minutes (beginner technique ≤ 30). */
  maxMinutes?: number;
  phase: Phase;
  trace: string[];
}

interface Scheme {
  sets: number;
  reps: string;
  load: string;
  rpe: string;
  srpe: number;
}

/** Main-lift prescription by row and lifting experience (§9.2 intensity ceiling, §9.4). */
export function mainScheme(spec: Pick<StrengthSessionSpec, "intensity" | "row" | "experience" | "generalWeek">): Scheme {
  if (spec.intensity === "technique") return { sets: 3, reps: "8–12", load: "RPE 6–7, technique first", rpe: "6-7", srpe: 5 };
  if (spec.intensity === "light") return { sets: 2, reps: "5", load: "≤ 40% 1RM, no failure", rpe: "4-5", srpe: 4 };
  const exp = spec.experience === "experienced";
  switch (spec.row) {
    case "general":
      return spec.generalWeek < GENERAL_HEAVIER_FROM_WEEK
        ? { sets: 3, reps: "8–10", load: "RPE 7", rpe: "7", srpe: 6 }
        : { sets: 3, reps: "6", load: "RPE 7–8", rpe: "7-8", srpe: 6 };
    case "base":
      return { sets: exp ? 4 : 3, reps: "5–6", load: "RPE 7–8 (~80–85% 1RM)", rpe: "7-8", srpe: 7 };
    case "build":
      // Novices (and no-experience lifters after the technique block) are capped at RPE 8 / ~85%.
      return exp
        ? { sets: 4, reps: "3–5", load: "RPE 8–9 (~90% 1RM)", rpe: "8-9", srpe: 7 }
        : { sets: 3, reps: "4–6", load: "RPE 8 (~85% 1RM, no ≥ 90% singles)", rpe: "8", srpe: 7 };
    case "peak":
    case "taper":
      // Rønnestad 2011 (E, soccer): 1×/week at the same load maintained strength.
      return exp
        ? { sets: 3, reps: "3–5", load: "same load as build (~90% 1RM)", rpe: "8", srpe: 7 }
        : { sets: 2, reps: "3–5", load: "same load as build (~85% 1RM)", rpe: "8", srpe: 7 };
    case "race_week":
      return { sets: 2, reps: "5", load: "≤ 40% 1RM, no failure", rpe: "4-5", srpe: 4 };
  }
}

interface SlotPick {
  slot: Exclude<StrengthSlot, "PLYO">;
  alt?: boolean;
  optional?: boolean;
}

const s = (slot: SlotPick["slot"], alt = false, optional = false): SlotPick => ({ slot, alt, optional });

/** §9.3 templates (plyo block is prepended separately). */
function template(spec: StrengthSessionSpec): SlotPick[] {
  const a = spec.variant === "A";
  const core2 = spec.coreSlots === 2;
  switch (spec.kind) {
    case "lower":
      return a
        ? [s("SQUAT"), s("SINGLE_LEG"), s("CALF_STRAIGHT"), s("HIP", false, true), ...(core2 ? [s("CORE", false, true)] : [])]
        : [s("HINGE"), s("SINGLE_LEG", true), s("CALF_BENT"), s("CORE", false, true), ...(core2 ? [s("CORE", true, true)] : [])];
    case "full":
      return a
        ? [s("SQUAT"), s("SINGLE_LEG"), s("UPPER_PUSH"), s("UPPER_PULL"), s("CALF_STRAIGHT"), s("CORE"), ...(core2 ? [s("CORE", true, true)] : [])]
        : [s("HINGE"), s("SINGLE_LEG", true), s("UPPER_PULL", true), s("UPPER_PUSH", true), s("CALF_BENT"), s("CORE"), ...(core2 ? [s("CORE", true, true)] : [])];
    case "upper":
      return a ? [s("UPPER_PUSH"), s("UPPER_PULL"), s("UPPER_PUSH", true, true)] : [s("UPPER_PULL", true), s("UPPER_PUSH", true), s("UPPER_PULL", false, true)];
    case "technique":
      return [
        a ? s("SQUAT") : s("HINGE"),
        s("SINGLE_LEG"),
        a ? s("CALF_STRAIGHT") : s("CALF_BENT"),
        ...(spec.withUpper ? [s("UPPER_PUSH"), s("UPPER_PULL")] : []),
        s("CORE", false, true),
      ];
    case "addon":
      return [s("SINGLE_LEG"), a ? s("CALF_STRAIGHT") : s("CALF_BENT")];
  }
}

/** Minutes per exercise, rest included (D). */
const SLOT_MINUTES: Record<StrengthSlot, number> = {
  SQUAT: 10,
  HINGE: 10,
  SINGLE_LEG: 8,
  CALF_STRAIGHT: 5,
  CALF_BENT: 5,
  HIP: 4,
  CORE: 4,
  UPPER_PUSH: 7,
  UPPER_PULL: 7,
  PLYO: 6,
};
const WARMUP_MIN = 8;

const isMain = (slot: StrengthSlot) => slot === "SQUAT" || slot === "HINGE" || slot === "UPPER_PUSH" || slot === "UPPER_PULL";

/** One exercise's prescription. */
function prescribe(spec: StrengthSessionSpec, pick: SlotPick, scheme: Scheme): { ex: Exercise; card: ExerciseCard; minutes: number } {
  const card = exerciseFor(pick.slot, spec.equipment, pick.alt);
  const bw = spec.equipment === "bodyweight";
  const light = spec.intensity === "light";
  const tech = spec.intensity === "technique";
  const cut = (n: number) => (spec.cutback ? Math.max(1, Math.round(n * STRENGTH_CUTBACK_SET_FACTOR)) : n);
  let sets = scheme.sets;
  let reps = scheme.reps;
  let load = scheme.load;
  let rest = 120;
  let note: string | undefined;

  if (isMain(pick.slot)) {
    rest = tech || light ? 90 : 150;
    if (bw && !light) {
      // Bodyweight can't reach heavy loads: more reps, slow eccentrics (§9.3 bodyweight-only mode).
      reps = card.id === "push_up" || card.id === "inverted_row" ? "8–15" : tech ? "8–12" : spec.row === "general" ? "10–12" : spec.row === "base" ? "8–10 / leg" : "6–8 / leg";
      if (card.id === "hip_thrust") reps = "10–15";
      load = `bodyweight, 3 s lowering; add a loaded backpack once it feels easier than RPE ${scheme.rpe.replace("-", "–")}`;
    } else if (spec.equipment === "dumbbells" && !light && !tech) {
      load = `${scheme.load}: heaviest DBs that reach it`;
    }
  } else if (pick.slot === "SINGLE_LEG") {
    sets = Math.min(3, scheme.sets);
    reps = light ? "6 / leg" : tech || bw ? "8–12 / leg" : spec.row === "general" ? "8–10 / leg" : spec.row === "base" ? "6–8 / leg" : "5–6 / leg";
    rest = 90;
    load = `RPE ${scheme.rpe.replace("-", "–")}`;
    if (bw && !light && !tech) load = "bodyweight, 3 s lowering; hold DBs or a backpack when easy";
    if (light) load = scheme.load;
  } else if (pick.slot === "CALF_STRAIGHT" || pick.slot === "CALF_BENT") {
    sets = light ? 2 : 3;
    const straight = pick.slot === "CALF_STRAIGHT";
    reps = bw ? "15–25 / leg" : spec.equipment === "dumbbells" ? "10–15 / leg" : straight ? "8–12" : "8–15";
    load = bw ? "bodyweight, 2 s up / 3 s down" : light ? "moderate, no failure" : "heavy, RPE 8";
    rest = 60;
    if (bw) note = "Calf benchmark: ≥ 25 single-leg raises per side (§9.3)";
  } else if (pick.slot === "HIP") {
    sets = 2;
    reps = card.id === "copenhagen_plank" ? "20–30 s / side" : "10–15 / side";
    load = "controlled";
    rest = 45;
  } else if (pick.slot === "CORE") {
    sets = 2;
    reps = card.id === "side_plank" ? "30–45 s / side" : card.id === "pallof_press" ? "10 / side" : "8 / side";
    load = "controlled, no breath-holding";
    rest = 45;
  }
  // The §9.6 add-on is ~15 min after the user's own session (already warm): 2 sets, short rests (D).
  if (spec.kind === "addon") sets = Math.min(sets, 2);
  const ex: Exercise = {
    id: card.id,
    slot: pick.slot,
    name: card.name,
    sets: cut(sets),
    reps,
    load,
    rest_s: rest,
    cues: [...card.cues],
  };
  if (note) ex.note = note;
  // Lighter work needs less rest: technique and light sessions run at 80% of the slot time; add-on 60% (D).
  const scale = (spec.cutback ? 0.75 : 1) * (tech || light ? 0.8 : 1) * (spec.kind === "addon" ? 0.6 : 1);
  return { ex, card, minutes: SLOT_MINUTES[pick.slot] * scale };
}

function plyoExercise(spec: StrengthSessionSpec, plyo: { rung: number; contacts: number }): { ex: Exercise; minutes: number } {
  const id = PLYO_LADDER[Math.max(0, Math.min(PLYO_LADDER.length - 1, plyo.rung))] as string;
  const card = exerciseCard(id);
  const perSet = plyo.rung <= 1 ? 20 : 10;
  const sets = Math.max(1, Math.min(10, Math.round(plyo.contacts / perSet)));
  const ex: Exercise = {
    id: card.id,
    slot: "PLYO",
    name: card.name,
    sets,
    reps: `${Math.round(plyo.contacts / sets)} contacts`,
    load: "fast, quiet contacts; stop when quality drops",
    rest_s: 60,
    contacts: plyo.contacts,
    cues: [...card.cues],
    note: "First, while fresh. Advance a rung only with no soreness 24 h later (§9.5).",
  };
  return { ex, minutes: Math.min(10, 3 + plyo.contacts / 15) * (spec.kind === "addon" ? 0.8 : 1) };
}

const KIND_LABEL: Record<StrengthSessionKind, string> = {
  lower: "lower body",
  full: "full body",
  upper: "upper body",
  technique: "technique",
  addon: "running add-on",
};

/** Build one strength session as a WorkoutDraft (sport "strength", type "STRENGTH"). */
export function strengthSession(spec: StrengthSessionSpec): WorkoutDraft {
  const scheme = mainScheme(spec);
  const items: Array<{ ex: Exercise; minutes: number; optional: boolean }> = [];
  if (spec.plyo) items.push({ ...plyoExercise(spec, spec.plyo), optional: false });
  for (const pick of template(spec)) {
    const p = prescribe(spec, pick, scheme);
    items.push({ ex: p.ex, minutes: p.minutes, optional: pick.optional ?? false });
  }
  if ((spec.kind === "lower" || spec.kind === "full") && spec.equipment === "bodyweight" && spec.variant === "B" && spec.intensity === "row") {
    // Bodyweight bias toward slow eccentrics (§9.3): Nordic eccentric 2–3 × 3–5 on B days.
    const p = prescribe(spec, s("HINGE", true), scheme);
    items.push({ ex: { ...p.ex, sets: Math.min(3, p.ex.sets), reps: "3–5", load: "as slow as you can control" }, minutes: 4, optional: true });
  }

  const warm = spec.kind === "addon" ? 0 : spec.intensity === "row" ? WARMUP_MIN : WARMUP_MIN - 3;
  let total = warm + items.reduce((a, x) => a + x.minutes, 0);
  const trace = [...spec.trace];
  if (spec.maxMinutes !== undefined) {
    // Drop optional slots from the end until the session fits (beginner technique ≤ 30 min).
    for (let i = items.length - 1; i >= 0 && total > spec.maxMinutes; i--) {
      const it = items[i] as (typeof items)[number];
      if (!it.optional) continue;
      total -= it.minutes;
      items.splice(i, 1);
      trace.push(`§9.2:dropped_${it.ex.slot}_for_time`);
    }
  }
  const minutes = Math.round(Math.min(total, spec.maxMinutes ?? Infinity));

  const steps: Step[] = [];
  if (warm > 0) {
    steps.push({
      kind: "warmup",
      duration: { type: "time", s: warm * 60 },
      target: { type: "open" },
      note: "Easy cardio + dynamic mobility (leg swings, hip openers, ankle rocks)",
    });
  }
  for (const it of items) {
    steps.push({
      kind: "work",
      duration: { type: "time", s: Math.round(it.minutes * 60) },
      target: { type: "rpe", value: it.ex.slot === "PLYO" ? "7" : scheme.rpe },
      note: `${it.ex.name}: ${it.ex.sets} × ${it.ex.reps} @ ${it.ex.load}`,
    });
  }

  const variant = spec.kind === "addon" ? "" : ` ${spec.variant}`;
  const tag = spec.intensity === "light" ? " (light taper)" : spec.cutback ? " (deload)" : "";
  const name = `Strength${variant}: ${KIND_LABEL[spec.kind]}${tag}`;
  const kindTrace = spec.kind === "addon" ? "§9.6:running_add_on" : `§9.3:${spec.kind}_${spec.variant}`;
  return {
    sport: "strength",
    type: "STRENGTH",
    name,
    phase: spec.phase,
    prescription_mode: "time_rpe",
    steps,
    planned: { run_m: 0, minutes, expected_srpe: spec.kind === "addon" ? 5 : scheme.srpe },
    flags: { heat_adjusted: false, key_session: false },
    rule_trace: [
      kindTrace,
      `§9.4:${spec.row}`,
      ...(spec.intensity !== "row" ? [`§9.4:${spec.intensity}`] : []),
      ...(spec.cutback ? ["§9.4:cutback_-40%_sets"] : []),
      ...(spec.plyo ? [`§9.5:plyo_rung${spec.plyo.rung}_${spec.plyo.contacts}`] : []),
      ...trace,
    ],
    exercises: items.map((x) => x.ex),
  };
}

/** Lower-body content (anything but an upper-only day) is subject to ST-3/4/5/7. */
export function isLowerStrength(w: { sport: string; exercises?: readonly Exercise[] | undefined }): boolean {
  if (w.sport !== "strength") return false;
  return (w.exercises ?? []).some((e) => e.slot !== "UPPER_PUSH" && e.slot !== "UPPER_PULL" && e.slot !== "CORE");
}

/** Plyo contacts in a strength session (§9.5, lower_body_load). */
export function plyoContactsOf(w: { exercises?: readonly Exercise[] | undefined }): number {
  return (w.exercises ?? []).reduce((a, e) => a + (e.slot === "PLYO" ? (e.contacts ?? 0) : 0), 0);
}
