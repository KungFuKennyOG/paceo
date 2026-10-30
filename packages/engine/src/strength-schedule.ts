/**
 * Strength placement (spec §7.1 step 5, §9.5 ST rules, §9.6 external programs) and fallback 4.
 *
 * Runs first, strength second: strength never moves a run, so placement is a pass over the finished
 * run weeks (all LR, quality and race days are then known, including next week's). Hard rules:
 *  - ST-3 no lower/plyo on LR day, LR −1 or LR −2 (race day counts as an LR)
 *  - ST-4 no lower/plyo the day before a quality run (TT included)
 *  - ST-5 ≥ 48 h between lower sessions (app and external lower/full)
 *  - ST-7 no hard cross-training + lower + quality run on the same day
 *  - §10.2 no lower/plyo on a team-sport or HIIT day
 *  - §9.4 nothing inside race −3 days; nothing heavy inside the last-heavy window
 * Soft preferences (scored): ST-1 after a quality run, ST-2 with an easy run, then a rest day;
 * merge into an external upper day (§9.6); avoid hard cross-training days and the day after the LR (D).
 * Any session that can't be placed is dropped: fallback 4 (§7.1), reported in the week notes.
 */
import type { GoalDistance, Level, PlanMode, PlanWeek, ScheduleConflict } from "./plan-types.js";
import type { PlannedWorkout } from "./workout.js";
import type { WorkoutDraft } from "./workouts.js";
import { isLowerLift, recordConflict, type CrossTrainingSession } from "./cross-training.js";
import { fromDayNumber, toDayNumber, WEEKDAYS, type Weekday } from "./dates.js";
import {
  BEGINNER_TECHNIQUE_MAX_MIN,
  MAX_STRENGTH_SESSIONS,
  plyoContacts,
  plyoEntryRung,
  PLYO_WEEKS_PER_RUNG,
  STRENGTH_PHASE_TABLE,
  strengthRowFor,
  strengthSession,
  strengthTaperDays,
  TECHNIQUE_BLOCK_WEEKS,
  type StrengthConfig,
  type StrengthSessionKind,
  type StrengthSessionSpec,
} from "./strength.js";

export interface StrengthPlanContext {
  userId: string;
  config: StrengthConfig | undefined;
  level: Level;
  /** §2.4 out-of-scope user: no plyos, no heavy work. */
  conservative: boolean;
  mode: PlanMode;
  distance: GoalDistance;
  /** Absolute race day (race mode only). */
  raceDay?: number;
  /** No session before this absolute day. */
  firstDay: number;
  /** §9.3: trunk-loading cross-training keeps CORE at 1 slot. */
  trunkLoadingXt: boolean;
}

export interface StrengthScheduleResult {
  weeks: PlanWeek[];
  conflicts: ScheduleConflict[];
  notes: string[];
}

interface Facts {
  lrDays: Set<number>;
  qualityDays: Set<number>;
  runDays: Set<number>;
  /** Easy + strides days: the template's Q slots when no quality fits (§7.2 "Q + Strength A/B"). */
  strideDays: Set<number>;
  recoveryDays: Set<number>;
  hardXtDays: Set<number>;
  plyoLikeDays: Set<number>;
  extLower: CrossTrainingSession[];
  extLowerDays: Set<number>;
  extUpperDays: Set<number>;
}

interface State {
  variant: number;
  upperVariant: number;
  /** Days of app lower sessions placed so far (ST-5 across weeks). */
  lowerDays: number[];
  /** Weeks with at least one app session (technique block length). */
  strengthWeeks: number;
  generalWeeks: number;
  plyoWeeks: number;
  rung: number;
}

const dayOf = (w: { date: string }) => toDayNumber(w.date);
const weekdayOfDay = (day: number): Weekday => WEEKDAYS[(((day + 3) % 7) + 7) % 7] as Weekday;
const WD = (day: number) => weekdayOfDay(day).slice(0, 1).toUpperCase() + weekdayOfDay(day).slice(1);

function collectFacts(weeks: readonly PlanWeek[], xt: readonly CrossTrainingSession[]): Facts {
  const f: Facts = {
    lrDays: new Set(),
    qualityDays: new Set(),
    runDays: new Set(),
    strideDays: new Set(),
    recoveryDays: new Set(),
    hardXtDays: new Set(),
    plyoLikeDays: new Set(),
    extLower: [],
    extLowerDays: new Set(),
    extUpperDays: new Set(),
  };
  for (const w of weeks.flatMap((x) => x.workouts)) {
    if (w.sport !== "run") continue;
    const d = dayOf(w);
    f.runDays.add(d);
    if (w.type === "S") f.strideDays.add(d);
    if (w.rule_trace.includes("W-REC")) f.recoveryDays.add(d);
    if (w.type === "L" || w.type === "RACE") f.lrDays.add(d);
    else if (w.flags.key_session) f.qualityDays.add(d);
  }
  for (const s of xt) {
    const d = dayOf(s);
    if (s.hard) f.hardXtDays.add(d);
    if (s.cls === "team_sport" || s.cls === "hiit") f.plyoLikeDays.add(d);
    if (isLowerLift(s)) {
      f.extLower.push(s);
      f.extLowerDays.add(d);
    } else if (s.lift === "upper") f.extUpperDays.add(d);
  }
  return f;
}

/** Hard-rule violations for lower-body work on `day` (ST-5 against `others` only). */
function lowerViolations(f: Facts, day: number, others: readonly number[], raceDay?: number, noneDays = 3): string[] {
  const v: string[] = [];
  if ([0, 1, 2].some((k) => f.lrDays.has(day + k))) v.push("ST-3");
  if (f.qualityDays.has(day + 1)) v.push("ST-4");
  if (others.some((o) => Math.abs(o - day) < 2)) v.push("ST-5");
  if (f.hardXtDays.has(day) && f.qualityDays.has(day)) v.push("ST-7");
  if (f.plyoLikeDays.has(day)) v.push("§10.2:team_sport_day");
  if (raceDay !== undefined && raceDay - day <= noneDays) v.push("§9.4:race-3");
  return v;
}

/**
 * Soft score (D): ST-1 > ST-2 > rest day; template Q slots (easy + strides) over other easy days;
 * merge with an external upper day; avoid recovery runs, hard cross-training and LR + 1.
 */
function lowerScore(f: Facts, day: number): number {
  let s = f.qualityDays.has(day) ? 3 : f.runDays.has(day) ? 2 : 1;
  if (f.strideDays.has(day)) s += 0.25;
  if (f.recoveryDays.has(day)) s -= 0.5;
  if (f.extUpperDays.has(day)) s += 1;
  if (f.hardXtDays.has(day)) s -= 1;
  if (f.lrDays.has(day - 1)) s -= 0.5;
  return s;
}

function lowerTrace(f: Facts, day: number): string[] {
  const t = [
    f.qualityDays.has(day)
      ? "ST-1:after_quality_run"
      : f.runDays.has(day)
      ? "ST-2:with_easy_run"
      : "ST:rest_day",
  ];
  if (f.runDays.has(day)) t.push("ST-6:run_first_gap>=6h");
  if (f.extUpperDays.has(day)) t.push("§9.6:merge_into_upper_day(lower_lifts_first)");
  t.push("ST-3:ok", "ST-4:ok", "ST-5:ok");
  return t;
}

/** Best set of `k` days from `cands` with pairwise gap ≥ `gap`; max score, then earliest. */
function bestSet(cands: readonly number[], k: number, gap: number, score: (d: number) => number): number[] | undefined {
  let best: number[] | undefined;
  let bestScore = -Infinity;
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === k) {
      const sc = chosen.reduce((a, d) => a + score(d), 0);
      if (sc > bestScore + 1e-9) {
        bestScore = sc;
        best = [...chosen];
      }
      return;
    }
    for (let i = start; i < cands.length; i++) {
      const d = cands[i] as number;
      if (chosen.some((c) => Math.abs(c - d) < gap)) continue;
      chosen.push(d);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return best;
}

function toWorkout(userId: string, week: PlanWeek, day: number, suffix: string, draft: WorkoutDraft): PlannedWorkout {
  const date = fromDayNumber(day);
  return { id: `${userId}-w${String(week.index).padStart(2, "0")}-${date}-${suffix}`, user_id: userId, date, ...draft };
}

/**
 * §7.1 step 5 over a finished plan: app strength sessions, the external add-on, and ST conflicts
 * for external lifting. Returns new weeks; runs are untouched.
 */
export function scheduleStrength(
  ctx: StrengthPlanContext,
  weeks: readonly PlanWeek[],
  xt: readonly CrossTrainingSession[],
): StrengthScheduleResult {
  const f = collectFacts(weeks, xt);
  const conflicts: ScheduleConflict[] = [];
  const notes: string[] = [];
  const cfg = ctx.config;
  const beginner = ctx.level === "beginner";
  const taperDays = strengthTaperDays(ctx.distance);
  const st: State = {
    variant: 0,
    upperVariant: 0,
    lowerDays: [],
    strengthWeeks: 0,
    generalWeeks: 0,
    plyoWeeks: 0,
    rung: plyoEntryRung(cfg?.liftingExperience ?? "none"),
  };

  externalConflicts(ctx, f, weeks, conflicts);

  const out = weeks.map((week) => {
    const start = toDayNumber(week.startDate);
    const isRaceWeek = ctx.raceDay !== undefined && ctx.raceDay >= start && ctx.raceDay <= start + 6;
    const rowId = strengthRowFor(week, ctx.mode, isRaceWeek);
    const row = STRENGTH_PHASE_TABLE[rowId];
    const added: PlannedWorkout[] = [];
    const weekNotes: string[] = [];
    if (!cfg || cfg.mode === "off") return week;

    const days = Array.from({ length: 7 }, (_, i) => start + i).filter((d) => d >= ctx.firstDay);
    const appMode = cfg.mode === "running" || cfg.mode === "full_body";
    const userN = Math.max(0, Math.min(MAX_STRENGTH_SESSIONS, Math.round(cfg.sessionsPerWeek)));
    const wanted = appMode ? Math.min(userN, row.sessions, beginner ? 2 : MAX_STRENGTH_SESSIONS) : 0;
    let plyoThisWeek = false;

    // ── app lower / full / technique sessions
    if (wanted > 0) {
      const priorLower = [...st.lowerDays, ...f.extLowerDays];
      const cands = days.filter((d) => lowerViolations(f, d, priorLower, ctx.raceDay, taperDays.none).length === 0);
      let chosen: number[] = [];
      for (let k = wanted; k > 0; k--) {
        const set = bestSet(cands, k, 2, (d) => lowerScore(f, d));
        if (set) {
          chosen = set;
          break;
        }
      }
      if (chosen.length < wanted) {
        const dropped = wanted - chosen.length;
        weekNotes.push(
          `§7.1 fallback 4: dropped ${dropped} of ${wanted} strength session(s); no day satisfies ST-3/ST-4/ST-5/ST-7 around this week's runs and cross-training.`,
        );
        weekNotes.push("S:fallback4:drop_strength");
      }
      for (const day of chosen) {
        const spec = lowerSpec(ctx, cfg, st, week, rowId, day, taperDays);
        if (spec.plyo) plyoThisWeek = true;
        spec.trace.push(...lowerTrace(f, day));
        added.push(toWorkout(ctx.userId, week, day, "str", strengthSession(spec)));
        st.lowerDays.push(day);
        st.variant += 1;
      }

      // Full-body with separate upper days (§9.2): upper sessions on other days; only ST-7 applies (ST-8 n/a: no trunk work).
      if (cfg.mode === "full_body" && cfg.upperBodyDays === "separate" && chosen.length > 0) {
        const upperCands = days.filter(
          (d) =>
            !chosen.includes(d) &&
            !(f.hardXtDays.has(d) && f.qualityDays.has(d)) &&
            (ctx.raceDay === undefined || ctx.raceDay - d > taperDays.none),
        );
        const score = (d: number) => (f.qualityDays.has(d) ? 1 : f.runDays.has(d) ? 2 : 1.5) - (f.extUpperDays.has(d) ? 2 : 0);
        const set = bestSet(upperCands, chosen.length, 2, score) ?? bestSet(upperCands, chosen.length, 1, score) ?? [];
        for (const day of set) {
          const spec = lowerSpec(ctx, cfg, st, week, rowId, day, taperDays, "upper");
          spec.variant = st.upperVariant % 2 === 0 ? "A" : "B";
          delete spec.plyo;
          spec.trace.push("§9.2:separate_upper_day", "ST-7:ok");
          added.push(toWorkout(ctx.userId, week, day, "up", strengthSession(spec)));
          st.upperVariant += 1;
        }
      }
    }

    // ── external mode add-on after the user's own lower session (§9.6)
    if (cfg.mode === "external" && cfg.externalAddOn && rowId !== "race_week") {
      for (const s of f.extLower) {
        const day = dayOf(s);
        if (day < start || day > start + 6 || day < ctx.firstDay) continue;
        const others = f.extLower.filter((o) => o !== s).map(dayOf);
        if (lowerViolations(f, day, others, ctx.raceDay, taperDays.none).length > 0) {
          weekNotes.push(`§9.6: no running add-on after ${s.name} on ${WD(day)} (it breaks an ST rule; see conflicts).`);
          continue;
        }
        const spec = lowerSpec(ctx, cfg, st, week, rowId, day, taperDays, "addon");
        if (spec.plyo) plyoThisWeek = true;
        spec.trace.push(`§9.6:after_${s.cls}`);
        added.push(toWorkout(ctx.userId, week, day, "addon", strengthSession(spec)));
        st.variant += 1;
      }
    }

    if (added.length > 0) {
      st.strengthWeeks += 1;
      if (rowId === "general") st.generalWeeks += 1;
    }
    if (plyoThisWeek) {
      st.plyoWeeks += 1;
      // Planned ladder progression: one rung every PLYO_WEEKS_PER_RUNG plyo weeks (D); the replan holds it on soreness.
      if (row.advanceRung && st.plyoWeeks % PLYO_WEEKS_PER_RUNG === 0 && st.rung < row.maxRung) st.rung += 1;
    }
    if (added.length === 0 && weekNotes.length === 0) return week;
    const workouts = [...week.workouts, ...added].sort(
      (a, b) => a.date.localeCompare(b.date) || Number(a.sport === "strength") - Number(b.sport === "strength"),
    );
    return { ...week, workouts, notes: [...week.notes, ...weekNotes] };
  });

  if (cfg && cfg.mode !== "off") notes.push(...configNotes(ctx, cfg));
  return { weeks: out, conflicts, notes };
}

function lowerSpec(
  ctx: StrengthPlanContext,
  cfg: StrengthConfig,
  st: State,
  week: PlanWeek,
  rowId: ReturnType<typeof strengthRowFor>,
  day: number,
  taperDays: ReturnType<typeof strengthTaperDays>,
  forced?: StrengthSessionKind,
): StrengthSessionSpec {
  const row = STRENGTH_PHASE_TABLE[rowId];
  const beginner = ctx.level === "beginner";
  const daysToRace = ctx.raceDay === undefined ? Infinity : ctx.raceDay - day;
  const techniqueBlock =
    beginner || ctx.conservative || (cfg.liftingExperience === "none" && st.strengthWeeks < TECHNIQUE_BLOCK_WEEKS);
  const light = daysToRace < taperDays.heavy;
  const kind: StrengthSessionKind =
    forced ??
    (techniqueBlock ? "technique" : cfg.mode === "full_body" && cfg.upperBodyDays !== "separate" ? "full" : "lower");
  const trace: string[] = [];
  if (beginner) trace.push("§9.2:beginner_runner_technique_only");
  else if (ctx.conservative) trace.push("§2.4:conservative_no_plyo_no_heavy");
  else if (techniqueBlock) trace.push(`§9.2:technique_block_wk${st.strengthWeeks + 1}`);
  if (light) trace.push(`§9.4:last_heavy_>=${taperDays.heavy}d_before_race`);

  const plyoAllowed =
    !beginner && !ctx.conservative && !light && daysToRace >= taperDays.plyo && row.plyo[1] > 0 && kind !== "upper";
  const spec: StrengthSessionSpec = {
    kind,
    variant: st.variant % 2 === 0 ? "A" : "B",
    row: rowId,
    intensity: light ? "light" : techniqueBlock ? "technique" : "row",
    equipment: beginner ? "bodyweight" : cfg.equipment,
    experience: cfg.liftingExperience,
    cutback: week.isCutback,
    coreSlots: ctx.trunkLoadingXt ? 1 : 2,
    withUpper: cfg.mode === "full_body" && cfg.upperBodyDays !== "separate",
    generalWeek: st.generalWeeks,
    phase: week.phase,
    trace,
  };
  if (plyoAllowed) spec.plyo = { rung: st.rung, contacts: plyoContacts(cfg.liftingExperience, st.plyoWeeks, row, week.isCutback) };
  if (beginner) spec.maxMinutes = BEGINNER_TECHNIQUE_MAX_MIN;
  return spec;
}

/**
 * §9.6: external lower/full sessions are locked load under ST-3/4/5/7. The scheduler already moved
 * quality runs off ST-4/ST-7 days (qualityBlockedDays); what's left (the LR and race are fixed) is
 * reported with a suggested lifting day. External upper days get the soft ST-8 note.
 */
function externalConflicts(ctx: StrengthPlanContext, f: Facts, weeks: readonly PlanWeek[], out: ScheduleConflict[]): void {
  const weekOf = (day: number) => weeks.find((w) => day >= toDayNumber(w.startDate) && day <= toDayNumber(w.startDate) + 6);
  for (const s of f.extLower) {
    const day = dayOf(s);
    const wk = weekOf(day);
    if (!wk) continue;
    const others = f.extLower.filter((o) => o !== s).map(dayOf);
    const v = lowerViolations(f, day, others);
    for (const rule of v) {
      const start = toDayNumber(wk.startDate);
      const alt = Array.from({ length: 7 }, (_, i) => start + i)
        .filter((d) => d !== day && lowerViolations(f, d, others).length === 0)
        .sort((a, b) => lowerScore(f, b) - lowerScore(f, a) || a - b)[0];
      recordConflict(out, {
        code: `${rule}:external_lift`,
        weekday: s.weekday,
        week: wk.index,
        message: `${s.name} on ${WD(day)} breaks ${rule} (${ruleText(rule)}). Locked sessions aren't moved.`,
        ...(alt !== undefined ? { suggestion: `Move it to ${WD(alt)}${f.qualityDays.has(alt) ? " (after the quality run)" : ""}.` } : {}),
      });
    }
  }
  for (const day of f.extUpperDays) {
    if (!f.qualityDays.has(day + 1) && !f.lrDays.has(day + 1)) continue;
    const wk = weekOf(day);
    if (!wk) continue;
    recordConflict(out, {
      code: "ST-8:soft",
      weekday: weekdayOfDay(day),
      week: wk.index,
      message: `Upper-body lifting on ${WD(day)} is the day before a quality run or long run: keep heavy deadlifts and trunk-dominant work out of it (ST-8, soft).`,
    });
  }
}

function ruleText(rule: string): string {
  switch (rule) {
    case "ST-3":
      return "no lower-body lifting on the long-run day or the 2 days before it";
    case "ST-4":
      return "no lower-body lifting the day before a quality run";
    case "ST-5":
      return "≥ 48 h between lower-body sessions";
    case "ST-7":
      return "no hard cross-training + lower-body lifting + quality run on one day";
    case "§10.2:team_sport_day":
      return "no lower-body lifting on a team-sport or HIIT day";
    default:
      return rule;
  }
}

function configNotes(ctx: StrengthPlanContext, cfg: StrengthConfig): string[] {
  const n: string[] = [];
  if (ctx.level === "beginner") n.push("§9.2: beginner runner: bodyweight technique block only (≤ 30 min, ≤ 2×/week), whatever the strength settings.");
  if (ctx.conservative) n.push("§2.4: conservative settings: no plyometrics and no heavy strength work.");
  if (cfg.equipment === "bodyweight" && ctx.level !== "beginner") {
    n.push("§9.3: bodyweight-only strength is a submaximal stimulus; it didn't improve running economy in the meta-analysis. Sessions lean on single-leg work, slow eccentrics, calves and plyos.");
  }
  if (cfg.mode === "full_body") n.push("§9.1: running blunts strength and hypertrophy gains, so full-body progress will be slower alongside this running block.");
  if (cfg.mode === "external") n.push("§9.6: external program: your own sessions count as locked load; the app doesn't prescribe them.");
  return n;
}
