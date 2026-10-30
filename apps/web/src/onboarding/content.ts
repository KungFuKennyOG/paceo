/** Static onboarding copy: §2.4 screen questions and §2.5 / §3.6 per-brand connect instructions. */
import type { WatchBrand } from "./draft";

export const HEALTH_QUESTIONS: string[] = [
  "Has a doctor said you have a heart condition or high blood pressure?",
  "Do you get chest pain at rest, in daily activity or during exercise?",
  "Have you lost balance from dizziness, or lost consciousness, in the last 12 months?",
  "Do you have another diagnosed chronic medical condition?",
  "Do you take prescribed medication for a chronic condition?",
  "Do you have a bone, joint or soft-tissue problem (current or in the last 12 months) that more activity could worsen?",
  "Has a doctor said you should only exercise under medical supervision?",
];

export const SCOPE_QUESTIONS = {
  pregnantOrPostpartum: "Are you pregnant or less than 12 months postpartum?",
  recentSeriousInjuryOrSurgery: "Are you returning from a serious injury or surgery in the last 6 months?",
} as const;

export const PARQ_URL = "https://southlake.ca/wp-content/uploads/2025/02/PARQPlus2025-Form-fillable.pdf";
export const EPARMED_URL = "https://www.eparmedx.com";
export const INTERVALS_URL = "https://intervals.icu";
export const INTERVALS_SETTINGS_URL = "https://intervals.icu/settings";

export interface BrandGuide {
  label: string;
  /** Support level from §3.6. */
  support: "primary" | "supported" | "activities_only" | "partial" | "fit_only" | "out_of_scope";
  /** Can intervals.icu push planned workouts to this watch? */
  receivesWorkouts: boolean;
  connectSteps: string[];
  note?: string;
}

const FOLLOW_IN_APP = "Workouts can't be sent to this watch, so you'll follow each session step by step in Paceo.";

export const BRAND_GUIDES: Record<WatchBrand, BrandGuide> = {
  garmin: {
    label: "Garmin",
    support: "primary",
    receivesWorkouts: true,
    connectSteps: [
      "In intervals.icu open Settings → Connections → Garmin Connect and tap Connect.",
      "Sign in to Garmin and allow access.",
      "Back in intervals.icu, tick “Upload planned workouts” under the Garmin connection.",
    ],
    note: "Best-supported path. Some devices show pace targets differently; the test workout below checks yours.",
  },
  coros: {
    label: "COROS",
    support: "supported",
    receivesWorkouts: true,
    connectSteps: [
      "In intervals.icu open Settings → Connections → COROS and tap Connect.",
      "Sign in to COROS and allow access.",
      "Tick “Upload planned workouts”.",
    ],
    note: "COROS only syncs a short window ahead. If a workout doesn't show up, use Re-send on its card.",
  },
  suunto: {
    label: "Suunto",
    support: "supported",
    receivesWorkouts: true,
    connectSteps: [
      "In intervals.icu open Settings → Connections → Suunto and tap Connect.",
      "Allow access in the Suunto app.",
      "Tick “Upload planned workouts”. Workouts arrive as SuuntoPlus Guides.",
    ],
  },
  wahoo: {
    label: "Wahoo",
    support: "supported",
    receivesWorkouts: true,
    connectSteps: [
      "In intervals.icu open Settings → Connections → Wahoo and tap Connect.",
      "Allow access in Wahoo.",
      "Tick “Upload planned workouts”.",
    ],
    note: "Sync hiccups have been reported. Re-send fixes most of them.",
  },
  polar: {
    label: "Polar",
    support: "activities_only",
    receivesWorkouts: false,
    connectSteps: ["In intervals.icu open Settings → Connections → Polar Flow and tap Connect.", "Allow access in Polar Flow."],
    note: FOLLOW_IN_APP,
  },
  apple: {
    label: "Apple Watch",
    support: "partial",
    receivesWorkouts: false,
    connectSteps: [
      "intervals.icu can't read Apple Health directly. Try a bridge app, in this order: Intervals.icu Companion, HealthFit (exports FIT files), then BreakAway.",
      "Whichever you use, make sure your runs appear in intervals.icu before continuing.",
      "If none works, export FIT files from your iPhone and upload them in Paceo (Settings → Connection).",
    ],
    note: `These bridges are third-party and unverified. ${FOLLOW_IN_APP}`,
  },
  huawei: {
    label: "HUAWEI",
    support: "fit_only",
    receivesWorkouts: false,
    connectSteps: [
      "If intervals.icu lists HUAWEI under Settings → Connections, connect it there.",
      "Otherwise export FIT files from HUAWEI Health and upload them in Paceo.",
    ],
    note: `Details for HUAWEI are unverified. ${FOLLOW_IN_APP}`,
  },
  amazfit: {
    label: "Amazfit",
    support: "fit_only",
    receivesWorkouts: false,
    connectSteps: [
      "If intervals.icu lists Amazfit/Zepp under Settings → Connections, connect it there.",
      "Otherwise export FIT files from Zepp and upload them in Paceo.",
    ],
    note: `Details for Amazfit are unverified. ${FOLLOW_IN_APP}`,
  },
  other: {
    label: "Other",
    support: "fit_only",
    receivesWorkouts: false,
    connectSteps: ["Upload your runs as FIT files in Paceo (Settings → Connection), or connect your watch to intervals.icu if it's listed there."],
    note: FOLLOW_IN_APP,
  },
  none: {
    label: "No watch",
    support: "out_of_scope",
    receivesWorkouts: false,
    connectSteps: [],
    note: "A phone web app can't record runs, so Paceo needs a watch (or another device that makes FIT files). Phone-only running is out of scope for now.",
  },
};

export const BRAND_ORDER: WatchBrand[] = ["garmin", "coros", "suunto", "wahoo", "polar", "apple", "huawei", "amazfit", "other", "none"];

export const TEST_WORKOUT_CHECKLIST = [
  "“Upload planned workouts” is ticked on your watch connection in intervals.icu.",
  "No workout-type filter in intervals.icu is hiding Run workouts.",
  "Your threshold pace is set under Settings → Run sport settings.",
  "Your watch has synced with its phone app since you sent the test.",
];

export const CROSS_ACTIVITIES = [
  { value: "cycling", label: "Cycling" },
  { value: "swimming", label: "Swimming" },
  { value: "paddling", label: "Paddling" },
  { value: "team_sport", label: "Team sport" },
  { value: "hiking", label: "Hiking" },
  { value: "lifting", label: "Lifting" },
  { value: "hiit", label: "HIIT" },
  { value: "other", label: "Other" },
];

export const LEVELS = [
  { value: "beginner", label: "Beginner", hint: "Under 3 months, or under 10 km a week, or can't run 20 min yet" },
  { value: "novice", label: "Novice", hint: "3–12 months of consistent running" },
  { value: "intermediate", label: "Intermediate", hint: "1–3 years, or longer with under 50 km a week" },
  { value: "advanced", label: "Advanced", hint: "3+ years and 50+ km a week" },
] as const;

export const RESULT_DISTANCES = [
  { m: 1609.344, label: "Mile" },
  { m: 3000, label: "3K" },
  { m: 5000, label: "5K" },
  { m: 10000, label: "10K" },
  { m: 15000, label: "15K" },
  { m: 21097.5, label: "Half" },
  { m: 42195, label: "Marathon" },
];
