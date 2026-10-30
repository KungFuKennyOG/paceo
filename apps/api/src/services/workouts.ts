/** Workout list/detail/skip (contract WorkoutItem, WorkoutDetailResponse; spec §3.9, §11.3, §11.4). */
import { stepsToIntervalsText, weekdayOf, type PlannedWorkout, type Units } from "@paceo/engine";
import type { ActivitySummary, CheckInResponse, WorkoutDetailResponse, WorkoutItem } from "@paceo/contracts";
import { activitiesRepo, checkinsRepo, workoutsRepo, type ActivityRow, type PlannedWorkoutRow } from "../repo/index.js";
import { AppError } from "../http/errors.js";
import { localDate } from "../lib/time.js";
import { deriveStatus, matchActivities } from "../plan/matching.js";
import { JOB } from "../jobs/queue.js";
import { userTimezone } from "./connection.js";
import { loadProfile } from "./plan.js";
import { sinkStateOf } from "./push-workouts.js";
import type { Services } from "./context.js";

export function toActivitySummary(a: ActivityRow): ActivitySummary {
  return {
    id: a.id,
    source: a.source === "fit_upload" ? "fit_upload" : "intervals_icu",
    originPlatform: a.originPlatform,
    startUtc: a.startUtc.toISOString(),
    localDate: a.localDate,
    sport: a.sport,
    distanceM: a.distanceM,
    movingS: a.movingS,
    avgHr: a.avgHr,
    isRace: a.isRace,
    name: a.name,
    garminOrigin: a.garminOrigin,
  };
}

function matchable(r: PlannedWorkoutRow) {
  const w = r.workout as PlannedWorkout;
  return { id: r.id, date: r.date, sport: r.sport, plannedMinutes: w.planned?.minutes ?? 0, plannedRunM: w.planned?.run_m ?? 0 };
}

function matchableActivity(a: ActivityRow) {
  return { id: a.id, localDate: a.localDate, sport: a.sport, movingS: a.movingS, distanceM: a.distanceM };
}

export function toWorkoutItem(row: PlannedWorkoutRow, match: ActivityRow | undefined, today: string): WorkoutItem {
  return {
    id: row.id,
    date: row.date,
    workout: row.workout as WorkoutItem["workout"],
    status: deriveStatus(row.status, matchable(row), match ? matchableActivity(match) : undefined, today),
    matchedActivity: match ? toActivitySummary(match) : null,
    sink: sinkStateOf(row),
  };
}

async function itemsFor(svc: Services, userId: string, rows: PlannedWorkoutRow[], from: string, to: string): Promise<WorkoutItem[]> {
  const today = localDate(svc.clock(), await userTimezone(svc, userId));
  const acts = await activitiesRepo.list(svc.db, userId, from, to);
  const byId = new Map(acts.map((a) => [a.id, a]));
  const matches = matchActivities(rows.map(matchable), acts.map(matchableActivity));
  return rows.map((r) => {
    const m = matches.get(r.id);
    return toWorkoutItem(r, m ? byId.get(m.id) : undefined, today);
  });
}

export async function listWorkoutItems(svc: Services, userId: string, from: string, to: string): Promise<WorkoutItem[]> {
  const rows = await workoutsRepo.range(svc.db, userId, from, to);
  return itemsFor(svc, userId, rows, from, to);
}

export async function workoutItem(svc: Services, userId: string, id: string): Promise<WorkoutItem> {
  const row = await workoutsRepo.byId(svc.db, userId, id);
  if (!row) throw new AppError(404, "not_found", "Workout not found.");
  // Matching considers the whole day, so other workouts that day compete for the same activity.
  const sameDay = await workoutsRepo.range(svc.db, userId, row.date, row.date);
  const items = await itemsFor(svc, userId, sameDay, row.date, row.date);
  return items.find((i) => i.id === id) as WorkoutItem;
}

export async function workoutDetail(svc: Services, userId: string, id: string): Promise<WorkoutDetailResponse> {
  const item = await workoutItem(svc, userId, id);
  const row = (await workoutsRepo.byId(svc.db, userId, id)) as PlannedWorkoutRow;
  const units: Units = (await loadProfile(svc, userId))?.units ?? "metric";
  const w = row.workout as PlannedWorkout;
  let deviceText = row.deviceText;
  if (deviceText === null) {
    try {
      deviceText = stepsToIntervalsText(w.steps);
    } catch {
      deviceText = null;
    }
  }
  return { item, explanation: svc.explainer.explain(w, units), deviceText };
}

const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as const;
export const dayName = (date: string) => DAY_NAMES[weekdayOf(date)];

export async function skipWorkout(
  svc: Services,
  userId: string,
  id: string,
  req: { reason: string; note?: string | undefined },
): Promise<CheckInResponse> {
  const row = await workoutsRepo.byId(svc.db, userId, id);
  if (!row) throw new AppError(404, "not_found", "Workout not found.");
  const w = row.workout as PlannedWorkout;
  await workoutsRepo.setStatus(svc.db, userId, id, "skipped", req.reason);
  const planChanges = [`Skipped ${dayName(row.date)}'s ${w.name}.`];
  const advice: string[] = [];
  if (w.flags?.key_session || w.type === "L") {
    advice.push("Don't make it up by doubling another day. Carry on with the next session as planned.");
    // TODO(engine-replan): R-MISS-2/3 may move a key session or long run within the week.
  } else {
    advice.push("Missed easy runs are simply dropped; there's no need to make up the distance.");
  }
  if (req.reason === "sick") advice.push("If you're ill, log it as an illness check-in so the next days adjust too.");
  if (req.reason === "injured") advice.push("If something hurts, log a pain check-in. Sharp or worsening pain is a reason to see a physio.");
  const checkinId = await checkinsRepo.insert(svc.db, userId, {
    type: "skip",
    date: row.date,
    workoutId: id,
    activityId: null,
    payload: req,
    planChanges,
  });
  if (sinkStateOf(row).externalId) {
    await svc.jobs.enqueue(JOB.pushWorkouts, { userId }, { singletonKey: `push:${userId}`, singletonSeconds: 30 });
  }
  return { id: checkinId, planChanges, advice };
}
