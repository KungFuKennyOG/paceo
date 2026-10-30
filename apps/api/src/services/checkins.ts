/**
 * Check-ins (spec §8: sRPE, R-ILL, R-PAIN, cross-training). Stored as the session log.
 * Illness and pain run the engine's replan() at once (R-ILL / R-PAIN); sRPE and cross-training feed
 * the nightly replan. planChanges are applied changes only; guidance and proposals go in `advice`.
 */
import type { PlannedWorkout } from "@paceo/engine";
import type { CheckInRequest, CheckInResponse } from "@paceo/contracts";
import { activitiesRepo, checkinsRepo, workoutsRepo } from "../repo/index.js";
import { AppError } from "../http/errors.js";
import type { CheckinLike } from "../plan/replan-state.js";
import { runReplan } from "./plan.js";
import type { Services } from "./context.js";

export type PainZone = "green" | "amber" | "red";

/** Silbernagel pain-monitoring zones (§8 R-PAIN); baseline taken as 0 until baselines are tracked. */
export function painZone(duringRun: number, nextMorning: number | null): PainZone {
  if (duringRun > 5 || (nextMorning !== null && nextMorning > 2)) return "red";
  if (duringRun >= 3 || (nextMorning !== null && nextMorning > 0)) return "amber";
  return "green";
}

/** Replan with this check-in included; returns the applied changes and any proposals. */
async function replanWith(svc: Services, userId: string, req: CheckInRequest): Promise<{ changes: string[]; proposals: string[] }> {
  const extra: CheckinLike = { type: req.type, date: req.date, activityId: null, workoutId: null, payload: req };
  try {
    const r = await runReplan(svc, userId, { reason: "replan_checkin", extra: [extra] });
    return { changes: r.changes, proposals: r.proposals };
  } catch (err) {
    // The check-in is still recorded; the nightly replan retries with it.
    svc.log.error({ userId, err }, "check-in replan failed");
    return { changes: [], proposals: [] };
  }
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
      const r = await replanWith(svc, userId, req);
      planChanges.push(...r.changes);
      advice.push(...r.proposals);
      if (req.fever || !req.aboveNeckOnly) {
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
      if (zone !== "green") {
        const r = await replanWith(svc, userId, req);
        planChanges.push(...r.changes);
        advice.push(...r.proposals);
      }
      if (zone === "red") {
        advice.push("Take 2–3 days off running, then try a 20–30 minute easy test run. If the pain goes above 5/10 again, see a physio.");
        advice.push("Sharp, localized bone pain can be a stress injury: stop running and see a doctor.");
      } else if (zone === "amber") {
        advice.push("Keep your next 2–3 runs easy and skip intervals, hills and plyometrics. Check how it feels tomorrow morning.");
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
