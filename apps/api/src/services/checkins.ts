/**
 * Check-ins (spec §8: sRPE, R-ILL, R-PAIN, cross-training). Stored as the session log.
 * planChanges are applied changes only; guidance goes in `advice`.
 * TODO(engine-replan): hand illness/pain events to replan() instead of the simple skips below.
 */
import { addDays, type PlannedWorkout } from "@paceo/engine";
import type { CheckInRequest, CheckInResponse } from "@paceo/contracts";
import { activitiesRepo, checkinsRepo, workoutsRepo } from "../repo/index.js";
import { AppError } from "../http/errors.js";
import { localDate } from "../lib/time.js";
import { JOB } from "../jobs/queue.js";
import { userTimezone } from "./connection.js";
import { dayName } from "./workouts.js";
import type { Services } from "./context.js";

export type PainZone = "green" | "amber" | "red";

/** Silbernagel pain-monitoring zones (§8 R-PAIN); baseline taken as 0 until baselines are tracked. */
export function painZone(duringRun: number, nextMorning: number | null): PainZone {
  if (duringRun > 5 || (nextMorning !== null && nextMorning > 2)) return "red";
  if (duringRun >= 3 || (nextMorning !== null && nextMorning > 0)) return "amber";
  return "green";
}

/** Skips planned runs in [from, to] that are today or later; returns one sentence per change. */
async function skipRuns(svc: Services, userId: string, from: string, to: string, reason: string, why: string): Promise<string[]> {
  const today = localDate(svc.clock(), await userTimezone(svc, userId));
  const start = from > today ? from : today;
  if (start > to) return [];
  const rows = await workoutsRepo.range(svc.db, userId, start, to);
  const out: string[] = [];
  let pushed = false;
  for (const r of rows) {
    if (r.status !== "planned" || r.sport !== "run") continue;
    await workoutsRepo.setStatus(svc.db, userId, r.id, "skipped", reason);
    out.push(`Removed ${dayName(r.date)}'s ${(r.workout as PlannedWorkout).name}: ${why}.`);
    if ((r.sinkState as { externalId?: string | null } | null)?.externalId) pushed = true;
  }
  if (pushed) await svc.jobs.enqueue(JOB.pushWorkouts, { userId }, { singletonKey: `push:${userId}`, singletonSeconds: 30 });
  return out;
}

export async function recordCheckIn(svc: Services, userId: string, req: CheckInRequest): Promise<CheckInResponse> {
  const planChanges: string[] = [];
  const advice: string[] = [];
  let workoutId: string | null = null;
  let activityId: string | null = null;

  switch (req.type) {
    case "session_rpe": {
      if (req.workoutId) {
        const w = await workoutsRepo.byId(svc.db, userId, req.workoutId);
        if (!w) throw new AppError(404, "not_found", "Workout not found.");
        workoutId = w.id;
        const type = (w.workout as PlannedWorkout).type;
        if ((type === "E" || type === "L" || type === "RW") && req.rpe >= 8) {
          advice.push("That felt very hard for an easy session. Check sleep, heat and illness; if it keeps happening, your paces may need adjusting.");
        }
      }
      if (req.activityId) {
        const a = await activitiesRepo.byId(svc.db, userId, req.activityId);
        if (!a) throw new AppError(404, "not_found", "Activity not found.");
        activityId = a.id;
      }
      break;
    }
    case "illness": {
      if (req.fever || !req.aboveNeckOnly) {
        planChanges.push(
          ...(await skipRuns(svc, userId, req.date, addDays(req.date, 2), "sick", "no running with a fever or below-neck symptoms")),
        );
        advice.push("No running until the fever and any below-neck symptoms are gone.");
        advice.push("Your first run back should be 10–20 minutes at an easy effort. Stop if you get chest pain, palpitations, dizziness or unusual breathlessness, and see a doctor.");
      } else {
        advice.push("Above-the-neck symptoms only: an easy run at 50–70% of the planned time is fine. No hard sessions until the symptoms clear.");
      }
      advice.push("If symptoms last more than 7 days or get worse, see a doctor.");
      break;
    }
    case "pain": {
      const zone = painZone(req.duringRun, req.nextMorning);
      if (zone === "red") {
        planChanges.push(
          ...(await skipRuns(svc, userId, addDays(req.date, 1), addDays(req.date, 2), "injured", `${req.location} pain above the safe range`)),
        );
        advice.push("Take 2–3 days off running, then try a 20–30 minute easy test run. If the pain goes above 5/10 again, see a physio.");
        advice.push("Sharp, localized bone pain can be a stress injury: stop running and see a doctor.");
      } else if (zone === "amber") {
        advice.push("Keep your next 2–3 runs easy and skip intervals, hills and plyometrics. Check how it feels tomorrow morning.");
        // TODO(engine-replan): R-PAIN amber converts the next quality sessions to easy and freezes volume.
      } else {
        advice.push("That's within the safe range. Carry on, and log it again if it gets worse.");
      }
      break;
    }
    case "cross_training":
      break;
  }

  const id = await checkinsRepo.insert(svc.db, userId, {
    type: req.type,
    date: req.date,
    workoutId,
    activityId,
    payload: req,
    planChanges,
  });
  return { id, planChanges, advice };
}
