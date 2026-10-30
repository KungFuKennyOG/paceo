/**
 * "Why this workout": rule traces → deterministic plain-English lines (spec §11.4, D).
 *
 * Every planned session carries rule_trace[] (rule IDs plus the values that triggered them). Each
 * ID's prefix (the text before the first ":", or the whole ID) selects a template; the rest fills its
 * slots. No LLM: output is reproducible and testable. Units are formatted per user. Unknown IDs
 * degrade to a neutral line instead of failing. Templates are versioned with the engine.
 */
import { formatDistance, type Units } from "./units.js";

export const EXPLAIN_VERSION = 1;

type Tpl = (rest: string[], id: string, u: Units) => string | undefined;

const PHASE: Record<string, string> = {
  BASE: "base-building",
  FI: "Foundation (easy volume)",
  EQ: "Early Quality",
  TQ: "Transition Quality",
  FQ: "Final Quality",
};
const DIST: Record<string, string> = { "5K": "5K", "10K": "10K", HM: "half-marathon", M: "marathon", "5k": "5K", "10k": "10K", half: "half-marathon", marathon: "marathon" };
const KIND: Record<string, string> = {
  T: "threshold work",
  I: "interval (VO2max) work",
  R: "repetition (speed) work",
  H: "hill repeats",
  M: "marathon-pace work",
  GP: "goal-pace work",
  TT: "a time trial",
};
const TYPE: Record<string, string> = { E: "easy run", S: "easy run with strides", L: "long run", T: "threshold session", I: "interval session", R: "repetition session", H: "hill session", M: "marathon-pace run", TT: "time trial", RW: "run/walk session" };
const LEVEL: Record<string, string> = { beginner: "beginner", novice: "novice", intermediate: "intermediate", advanced: "advanced" };

/** Human names for replan rules, used by the shared modification templates. */
const RULE_NAME: Record<string, string> = {
  "R-MISS": "missed sessions",
  "R-MISS-1": "a missed easy run",
  "R-MISS-2": "a missed key session",
  "R-MISS-3": "a missed long run",
  "R-MISS-4": "realignment after missed training",
  "R-BREAK": "your return from a break",
  "R-ILL": "illness",
  "R-ILL-1": "illness",
  "R-ILL-2": "your first run back after illness",
  "R-ILL-3": "the graduated return after illness",
  "R-ILL-4": "your return after illness",
  "R-ILL-5": "a long or worsening illness",
  "R-PAIN": "pain you reported",
  "R-PAIN-4": "pain you reported",
  "R-HRV": "your HRV trend",
  "R-HRV-2": "your HRV trend",
  "R-HRV-3": "two low HRV nights",
  "R-LOAD": "your training load",
  "R-LOAD-1": "the single-run safety limit",
  "R-LOAD-2": "a jump in training load",
  "R-LOAD-4": "your cross-training share",
  "R-RACE": "your race date",
  "R-RACE-1": "your race date",
  "R-RACE-2": "your race date",
  "R-RACE-3": "your race date",
  "R-RACE-4": "your race date",
  "R-PERF": "your recent session paces",
  "FIT-UPDATE": "a fitness update",
  SCHED: "the 48-hour rule between hard days",
  REPLAN: "a plan rebuild",
  HALT: "a paused plan",
};

function km(x: string | undefined, u: Units): string {
  const n = Number(x);
  return Number.isFinite(n) ? formatDistance(n * 1000, u) : String(x);
}

function args(s: string): string[] {
  const m = /\(([^)]*)\)/.exec(s);
  return m && m[1] !== undefined ? m[1].split(/<=|,/) : [];
}

/** Shared modification markers written by the replanner: "<RULE>:<suffix>". */
function modification(rule: string, suffix: string, u: Units): string | undefined {
  const why = RULE_NAME[rule] ?? RULE_NAME[rule.replace(/-\d+$/, "")] ?? rule;
  let m: RegExpExecArray | null;
  if ((m = /^vol×([\d.]+)$/.exec(suffix))) return `Volume set to ${Math.round(Number(m[1]) * 100)}% because of ${why}.`;
  if ((m = /^pace×([\d.]+)$/.exec(suffix))) return `Paces are ${((1 / Number(m[1]) - 1) * 100).toFixed(1)}% slower because of ${why}.`;
  if ((m = /^easy\(was:(\w*)\)$/.exec(suffix))) return `Now an easy run instead of the planned ${TYPE[m[1] ?? ""] ?? "session"}, because of ${why}.`;
  if ((m = /^shorten×([\d.]+)$/.exec(suffix))) return `Shortened by ${Math.round((1 - Number(m[1])) * 100)}% because of ${why}.`;
  if ((m = /^LR≤([\d.]+)$/.exec(suffix))) return `Long run held at ${km(m[1], u)} because of ${why}.`;
  if ((m = /^week≤([\d.]+)$/.exec(suffix))) return `This week's volume is held at ${km(m[1], u)} because of ${why}.`;
  if (suffix === "trim") return `Shortened to keep this week's load within 30% of your recent weeks (${why}).`;
  if ((m = /^test\((\d+)min\)$/.exec(suffix))) return `A ${m[1]}-min very easy test run because of ${why}: stop if anything feels wrong.`;
  if ((m = /^from\(([\d-]+)\)$/.exec(suffix))) return `Moved here from ${m[1]} because of ${why}.`;
  if (suffix === "no_quality") return `Kept easy because of ${why}.`;
  return undefined;
}

function replanRule(rule: string): Tpl {
  return (rest, id, u) => {
    const suffix = rest.join(":");
    const mod = modification(rule, suffix, u);
    if (mod) return mod;
    const why = RULE_NAME[rule] ?? rule;
    if (suffix === "") return `Adjusted because of ${why}.`;
    return `Adjusted because of ${why}.`;
  };
}

const TEMPLATES: Record<string, Tpl> = {
  // ── plan generator (§6–7) ──
  P3: (r) => {
    if (r[0] === "sub") {
      const m = /^(\w+)->(\w+)\((.*)\)$/.exec(r[1] ?? "");
      if (!m) return "A different session type was swapped in for your level.";
      const why = m[3] === "beginner" ? "beginners get one short threshold-style session" : m[3] === "novice<TQ" ? "intervals start later in the plan for newer runners" : "your paces aren't confirmed by a race or time trial yet";
      return `${cap(KIND[m[2] ?? ""] ?? "This session")} replaces ${KIND[m[1] ?? ""] ?? "the planned session"}: ${why}.`;
    }
    const [phase, dist, kind] = r;
    return `${cap(KIND[kind ?? ""] ?? "quality work")}: this is the ${PHASE[phase ?? ""] ?? phase} phase of a ${DIST[dist ?? ""] ?? dist} plan, where it's the main stimulus (Daniels).`;
  },
  I2: (r) => {
    const q = r[2] === "Q2" ? "your second quality session this week" : "your main quality session this week";
    return `As an ${LEVEL[r[0] ?? ""] ?? r[0]} runner on ${r[1]?.replace("d", "") ?? "?"} days a week, this is ${q}.`;
  },
  C1: (r) => {
    const s = r.join(":");
    if (s === "cutback_quality") return "Cutback week: the session is shorter so you absorb recent training.";
    if (s === "cutback_LR-30%") return "Cutback week: the long run is about 30% shorter.";
    if (s === "cutback_LR_raised_to_fill_week") return "Cutback week: the long run is a little longer than a normal cutback so the week keeps its volume.";
    if (s === "ladder_no_cutback") return "Run/walk weeks have no cutbacks; a stage is repeated instead if needed.";
    return `Lighter weeks come more often for you (${s.replace(">=", " ≥ ").replace(/_/g, " ")}).`;
  },
  C2: () => "A time-trial week counts as a cutback week.",
  T3: (r) => {
    const s = r.join(":");
    if (s === "goal_pace") return "Taper: a short session at goal pace keeps you sharp.";
    if (s === "shakeout") return "Day before the race: a short shake-out with a few strides.";
    const m = /^LR×([\d.]+)$/.exec(s);
    if (m) return `Taper: the long run is ${Math.round(Number(m[1]) * 100)}% of your peak.`;
    return "Taper rule applied.";
  },
  L1: (r) => {
    const s = r[0];
    if (s === "time_cap") return "Long run capped by time: longer than this adds fatigue more than fitness at your pace.";
    if (s === "distance_cap") return "Long run at the distance cap for this race.";
    if (s === "pct_hard") return "Long run capped as a share of your weekly volume.";
    if (s === "warn_daniels_soft_cap") return "This long run is above Daniels' 25–30% of the week (a convention warning, not a safety limit).";
    return "Long-run cap applied.";
  },
  L2: (r) => {
    const s = r[0];
    if (s === "+10%") return "Long run grows at most 10% over your recent longest run.";
    if (s === "+2km") return "Long run grows at most 2 km over your recent longest run.";
    if (s === "peak_3-5wk_out") return "Your longest run falls 3–5 weeks before the race, so this one is a little shorter.";
    return "Long-run progression rule applied.";
  },
  L3: (r) => {
    const s = r[0];
    if (s === "easy") return "Long run at an easy, conversational effort.";
    if (s === "fast_finish") return "Long run with a faster finish.";
    if (s === "m_segment") return "Long run with a block at marathon pace.";
    return "Long-run content chosen for this phase.";
  },
  V1: (r, id, u) => {
    const s = r.join(":");
    if (s.startsWith("ok(")) {
      const [a, b] = args(s);
      if (a?.endsWith("min")) return `${a.replace("min", " min")} is within your safe single-run limit of ${b?.replace("min", " min")}.`;
      return `${km(a, u)} is within your safe single-run limit of ${km(b, u)} (10% over your longest run in the last 30 days).`;
    }
    if (s === "cap" || s === "time_cap") return "Held to your safe single-run limit: 10% over your longest run in the last 30 days.";
    if (s === "short_walk_warmup") return "The walking warm-up is shorter so the session fits your safe limit.";
    if (s.startsWith("shortened_in_week") || s === "shortened") return "Shortened to stay within your safe single-run limit.";
    if (s === "Q->E+S") return "Your quality session became easy running with strides: it wouldn't fit your safe single-run limit yet.";
    if (s === "trimmed_warm_cool") return "Warm-up and cool-down are shorter so the session fits your safe single-run limit.";
    return "Single-run safety limit applied.";
  },
  V2: () => "This week grows less than 30% over last week.",
  V3: () => "Starting volume adjusted to what your run days can hold.",
  LR: () => "No other run this week is longer than the long run.",
  TT: () => "The time trial is a fixed session, so this week's volume follows it.",
  S: (r) => {
    const s = r.join(":");
    if (s.startsWith("fallback1")) return "Moved to another day to keep 48 h between hard sessions.";
    if (s.startsWith("fallback2")) return "No day kept 48 h between hard sessions, so this is easy running with strides.";
    if (s === "no_LR_near_race") return "No long run this close to the race.";
    return "Scheduling rule applied.";
  },
  S3: (r) => {
    const s = r.join(":");
    if (s === "raised_to_min") return "Easy runs are at least 20 minutes (15 for beginners).";
    if (s.startsWith("needs_more_days") || s === "easy_capacity") return "Your run days can't hold all of this week's easy volume; more run days would help.";
    if (s.startsWith("drop_d")) return "One easy day was dropped so the others stay a useful length.";
    return "Easy volume is spread across your run days.";
  },
  CAP: (r) => {
    const s = r.join(":");
    if (s.endsWith("low_volume_floor")) return "At your weekly volume, this is the minimum useful session.";
    const m = /^(\w+)(<=|<)([\d.]+%|\d+min)$/.exec(s);
    if (m) return `${cap(KIND[m[1] ?? ""] ?? "Work")} is capped at ${m[3]?.replace("min", " min")}${m[3]?.endsWith("%") ? " of your weekly volume" : ""} (Daniels).`;
    if (s === "M:floor20min") return "At least 20 minutes at marathon pace, or it isn't a quality session.";
    return "Session size capped (Daniels).";
  },
  Q: (r) => {
    const m = /^work×([\d.]+)$/.exec(r.join(":"));
    return m ? `The work part is ${Math.round(Number(m[1]) * 100)}% of normal this week.` : "Session size adjusted.";
  },
  "§4.2": () => "A time trial sets your training paces from a real result.",
  "§6.9": (r) => `Run/walk stage ${r[0]?.replace("stage", "") ?? ""}: build up to 20 minutes of continuous running.`,
  RACE: (r) => (r[0] === "goal_time" ? "Race day: target your goal time." : r[0] === "predicted" ? "Race day: target the time your current fitness predicts." : "Race day."),
  PM: (r) => (r[0]?.startsWith("time_rpe") ? "Sessions are by time and effort until your paces are confirmed." : r[0] === "minutes" ? "Easy and long runs are by time." : "Sessions use pace targets."),
  "W-E": () => "Easy run: conversational pace to build aerobic base.",
  "W-S": () => "Easy run plus short relaxed strides for leg speed.",
  "W-REC": () => "Recovery run: very easy, to loosen up.",
  "W-T": (r) => `${r.join(":") || "Threshold session"}: comfortably hard, the pace you could hold for about an hour.`,
  "W-I": () => "Intervals at about 5K pace or a little faster, for VO2max.",
  "W-R": () => "Short fast repetitions for speed and economy, with full recoveries.",
  "W-H": () => "Hill repeats: strength and power without the pounding of fast flat running.",
  "W-M": (r, id, u) => `Marathon-pace block of about ${km(r[0]?.replace("km", ""), u)}.`,
  "W-GP": (r) => `Goal-pace work for your ${DIST[r[0] ?? ""] ?? "race"}.`,
  "W-TT": () => "Time trial: a 3K all-out effort to set your paces.",

  // ── strength (§9), cross-training (§10), general fitness (§6.1) ──
  ST: (r) => {
    const s = r.join(":");
    if (s === "rest_day") return "Strength on a rest day from running.";
    if (s.startsWith("dropped(")) return "A strength session was dropped so it doesn't sit too close to a hard run after replanning.";
    return "Strength placement rule applied.";
  },
  "ST-1": () => "Strength comes after a hard run, on the same day, so the next day stays easy.",
  "ST-2": () => "Strength paired with an easy run.",
  "ST-3": () => "No heavy lower-body strength in the 2 days before a long run.",
  "ST-4": () => "No heavy lower-body strength the day before a hard run.",
  "ST-5": () => "At least 48 hours between lower-body strength sessions.",
  "ST-6": () => "Run first, then lift at least 6 hours later if you can.",
  "ST-7": () => "Strength kept apart from hard cross-training days.",
  "ST-8": () => "Core work kept light because your cross-training already loads the trunk.",
  XT: (r) => {
    const s = r[0] ?? "";
    if (s === "hard_day_before_LR") return "Your fixed hard cross-training falls the day before a long run; we kept it and flagged it.";
    if (s === "hard_in_race_week") return "Hard cross-training in race week: consider keeping it light.";
    if (s.endsWith("blocks_quality")) return "No hard run the day of or after your hard cross-training.";
    return "Cross-training rule applied.";
  },
  "§10.2": (r) => {
    const s = r.join(":");
    if (s === "team_sport_day") return "Team-sport day: no heavy legs or plyometrics.";
    if (s === "locked" || s === "flexible") return `This cross-training is ${s === "locked" ? "fixed in your week" : "flexible"}.`;
    if (s.startsWith("hard_rule") || s.startsWith("user_")) return "Cross-training intensity classified as hard or easy for scheduling.";
    return "Cross-training counted in your training load (never as running km).";
  },
  "§6.4": () => "A hard cross-training day counts as half a key session this week.",
  "§6.1": () => "General-fitness plan: volume set from your target.",
  "§2.4": () => "Conservative settings: no plyometrics and no heavy strength work.",
  "§9.2": (r) => (r[0]?.startsWith("dropped_") ? "An exercise was left out to fit the time you have." : r[0]?.startsWith("technique") || r[0]?.startsWith("beginner") ? "Technique block: learn the movements before adding load." : "Strength session layout for your settings."),
  "§9.4": (r) => (r[0] === "cutback_-40%_sets" ? "Cutback week: 40% fewer sets." : r[0] === "race-3" ? "No strength in the last 3 days before the race." : r[0]?.startsWith("last_heavy") ? "Heavy strength stops well before the race." : "Strength intensity set by the training phase."),
  "§9.3": () => "Exercises chosen from the strength library for this session's focus.",
  "§9.5": (r) => {
    const m = /^plyo_rung(\d+)_(\d+)$/.exec(r.join(":"));
    return m ? `Plyometrics: stage ${m[1]}, about ${m[2]} contacts.` : "Plyometric progression.";
  },
  "§9.6": () => "Fits around your own lifting program.",

  // ── replanning (§8), FIT-UPDATE (§4.10) ──
  "R-MISS": () => "Missed sessions are dropped, not made up.",
  "R-MISS-1": () => "A missed easy run is dropped, not made up.",
  "R-MISS-2": replanRule("R-MISS-2"),
  "R-MISS-3": replanRule("R-MISS-3"),
  "R-MISS-4": () => "Rebuilt from the training you actually did after several missed sessions.",
  "R-BREAK": (r, id, u) => {
    const s = r.join(":");
    const m = /^(\d+)d\(x([\d.]+)/.exec(s);
    if (m) return `After ${m[1]} days off, you restart gradually; paces are ${((1 / Number(m[2]) - 1) * 100).toFixed(1)}% slower for now.`;
    return modification("R-BREAK", s, u) ?? "Adjusted for your return from a break.";
  },
  "R-ILL": () => "Adjusted for illness.",
  "R-ILL-1": replanRule("R-ILL-1"),
  "R-ILL-2": replanRule("R-ILL-2"),
  "R-ILL-3": replanRule("R-ILL-3"),
  "R-ILL-4": replanRule("R-ILL-4"),
  "R-ILL-5": () => "Paused: please see a doctor before running again.",
  "R-PAIN": (r, id, u) => {
    const s = r.join(":");
    const m = /^(green|amber|red|bone)\((.*)\)$/.exec(s);
    if (m) return `Pain check (${m[2]}): ${m[1]} zone.`;
    return modification("R-PAIN", s, u) ?? "Adjusted for pain you reported.";
  },
  "R-PAIN-4": replanRule("R-PAIN-4"),
  "R-HRV": (r) => (r[0]?.startsWith("disabled") ? "HRV readiness is off until enough nights are recorded." : `HRV trend: ${r[0]}.`),
  "R-HRV-2": replanRule("R-HRV-2"),
  "R-HRV-3": replanRule("R-HRV-3"),
  "R-LOAD-1": (r, id, u) => {
    const [a, b] = args(r.join(":"));
    return `Shortened to ${km(a, u)}: within 10% of the longest run you actually did in the last 30 days (limit ${km(b, u)}).`;
  },
  "R-LOAD-2": replanRule("R-LOAD-2"),
  "R-LOAD-4": () => "Lighter weeks come every third week because cross-training is a big share of your load.",
  "R-RACE": () => "Checked against your race date.",
  "R-RACE-1": () => "Your taper is kept in full; the build is shortened instead.",
  "R-RACE-2": (r) => {
    const s = r.join(":");
    if (s === "rebuild_week") return "A rebuild week of easy running after your long break, before the plan picks up its phases again.";
    if (s === "restart") return "After a long break the build starts again from the Foundation phase; the taper and race date stay.";
    if (s === "phase_reset") return "After your break, the current training phase starts over.";
    if (s.startsWith("rebuild_weeks(")) return `After a long break, ${args(s)[0] ?? "1"} easy rebuild week(s) come first; the taper and race date stay.`;
    if (s.startsWith("continue(")) return "Rebuilt from your actual training, continuing your plan's phases and taper.";
    return "Rebuilt around your race date, keeping your plan's phases and taper.";
  },
  "R-RACE-4": () => "Few build weeks are left before your race.",
  "R-PERF": (r) => `Recent quality sessions: ${r[0]?.replace(/\(.*$/, "") ?? "checked"}.`,
  "FIT-UPDATE": (r) => {
    const s = r.join(":");
    const m = /^vdot\(([\d.]+)->([\d.]+)\)$/.exec(s);
    if (m) return `Paces updated for your new fitness (VDOT ${m[1]} → ${m[2]}).`;
    return "Fitness check applied.";
  },
  REPLAN: () => "Rebuilt from your actual training.",
  SCHED: (r) => (r[0] === "lr_longest" ? "Shortened so the long run stays the longest run of the week." : r[0] === "max_3_keys" ? "Easy, so the week has at most three hard sessions." : r[0]?.startsWith("easy(") ? undefined : "Easy, to keep 48 hours between hard days."),
  HALT: () => "Plan paused.",
};

/** Every prefix with a template (used by the coverage test). */
export const EXPLAINED_PREFIXES: readonly string[] = Object.keys(TEMPLATES);

/** "P3:EQ:M:T" → "P3"; "W-E" → "W-E"; "§6.9:stage6" → "§6.9". */
export function rulePrefix(id: string): string {
  const i = id.indexOf(":");
  return i < 0 ? id : id.slice(0, i);
}

export interface Explained {
  id: string;
  prefix: string;
  text: string | undefined;
  known: boolean;
}

export function explainOne(id: string, units: Units = "metric"): Explained {
  const prefix = rulePrefix(id);
  const tpl = TEMPLATES[prefix];
  if (!tpl) return { id, prefix, text: `Rule ${prefix} applied.`, known: false };
  const rest = id.indexOf(":") < 0 ? [] : id.slice(id.indexOf(":") + 1).split(":");
  return { id, prefix, text: tpl(rest, id, units), known: true };
}

/** Short plain-English lines for a workout's rule trace, deduplicated, in trace order. */
export function explain(ruleTrace: readonly string[], units: Units = "metric"): string[] {
  const out: string[] = [];
  for (const id of ruleTrace) {
    const t = explainOne(id, units).text;
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
