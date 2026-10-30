/**
 * Health screen outcome (spec §2.4). Paraphrased 7-question screen + two scope questions; the app
 * links to the official PAR-Q+ rather than embedding a modified copy.
 */
import type { HealthScreenRequest, ScreeningOutcome } from "@paceo/contracts";

export const PARQ_LINKS = "Official PAR-Q+ and ePARmed-X+: https://www.eparmedx.com";
/** Re-screen every 12 months (§2.3). */
export const RESCREEN_DAYS = 365;

export interface ScreeningResult {
  outcome: ScreeningOutcome;
  canProceed: boolean;
  notes: string[];
}

export interface ScreeningContext {
  /** From the stored profile, when present. */
  age: number | null;
  currentInjury: boolean;
}

export function evaluateScreening(req: HealthScreenRequest, ctx: ScreeningContext): ScreeningResult {
  const anyYes = req.answers.some(Boolean) || ctx.currentInjury;
  const outOfScope = req.pregnantOrPostpartum || req.recentSeriousInjuryOrSurgery;
  const notes: string[] = [];

  if (outOfScope) {
    if (req.pregnantOrPostpartum) {
      notes.push("Pregnancy and postpartum training are outside what this app can plan safely. Please follow your doctor's or physio's guidance.");
    }
    if (req.recentSeriousInjuryOrSurgery) {
      notes.push("Returning from a serious injury or surgery needs a professional's return-to-run plan.");
    }
    if (req.clearanceConfirmed) {
      notes.push("Thanks for confirming professional clearance. Your plan uses the most conservative settings: beginner caps, no plyometrics and no heavy strength work.");
      return { outcome: "cleared_conservative", canProceed: true, notes };
    }
    notes.push("You can continue once a professional has cleared you; confirm that here and the plan will use conservative settings.");
    return { outcome: "out_of_scope", canProceed: false, notes };
  }

  if (anyYes) {
    if (ctx.currentInjury && !req.answers.some(Boolean)) {
      notes.push("You told us you have a current injury, which counts the same as a 'yes' on the screen.");
    }
    if (req.clearanceConfirmed) {
      notes.push("Clearance confirmed and dated. If anything changes, please re-take the screen.");
      if (ctx.currentInjury) notes.push("Because of your current injury, your first two weeks follow the cautious pain-monitoring rules.");
      return { outcome: "cleared", canProceed: true, notes };
    }
    notes.push("See a doctor or qualified exercise professional before starting.");
    notes.push(PARQ_LINKS);
    return { outcome: "see_doctor", canProceed: false, notes };
  }

  if (ctx.age !== null && ctx.age >= 45) {
    notes.push("At 45 and over, consider a check with a qualified exercise professional if you're not used to vigorous exercise.");
  }
  notes.push("We'll ask these questions again in 12 months.");
  return { outcome: "ok", canProceed: true, notes };
}

export function screeningExpired(screenedAt: Date, now: Date): boolean {
  return now.getTime() - screenedAt.getTime() > RESCREEN_DAYS * 86_400_000;
}
