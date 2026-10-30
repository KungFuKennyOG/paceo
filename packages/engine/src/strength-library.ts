/**
 * Strength exercise library (spec §9.3) and plyometric ladder (§9.5).
 *
 * Slot × equipment choices follow the §9.3 table (E families from Blagrove 2018; upper-body slots D).
 * Card text (descriptions, cues, faults) is D content: review with a coach or physio before release.
 * `demoUrl` is optional and unused in v1 (no stored media).
 */

export type StrengthSlot =
  | "SQUAT"
  | "HINGE"
  | "SINGLE_LEG"
  | "CALF_STRAIGHT"
  | "CALF_BENT"
  | "HIP"
  | "CORE"
  | "UPPER_PUSH"
  | "UPPER_PULL"
  | "PLYO";

export type StrengthEquipment = "gym" | "dumbbells" | "bodyweight";

/** §9.3 exercise card. */
export interface ExerciseCard {
  id: string;
  slot: StrengthSlot;
  /** Equipment columns this exercise serves (plyos serve all). */
  equipment: readonly StrengthEquipment[];
  name: string;
  /** 1–2 sentences. */
  description: string;
  /** 3–4 cues. */
  cues: readonly string[];
  /** 1–2 common faults. */
  commonFaults: readonly string[];
  regressionId?: string;
  progressionId?: string;
  demoUrl?: string;
}

const card = (c: ExerciseCard): ExerciseCard => c;

const CARDS: readonly ExerciseCard[] = [
  // ── SQUAT
  card({
    id: "back_squat", slot: "SQUAT", equipment: ["gym"], name: "Back squat",
    description: "Bar on the upper back; squat to at least parallel and stand up.",
    cues: ["Brace before each rep", "Knees track over toes", "Hips and chest rise together", "Drive through mid-foot"],
    commonFaults: ["Knees caving in", "Hips shooting up first"],
    regressionId: "goblet_squat", progressionId: "trap_bar_deadlift",
  }),
  card({
    id: "trap_bar_deadlift", slot: "SQUAT", equipment: ["gym"], name: "Trap-bar deadlift",
    description: "Stand inside a hex bar, grip the handles and stand up with a flat back.",
    cues: ["Shins near vertical, hips back", "Push the floor away", "Neutral spine", "Lock out with glutes, not the lower back"],
    commonFaults: ["Rounding the back at the start", "Jerking the bar off the floor"],
    regressionId: "goblet_squat",
  }),
  card({
    id: "goblet_squat", slot: "SQUAT", equipment: ["dumbbells", "gym"], name: "Goblet squat",
    description: "Hold a DB at the chest; squat between the knees.",
    cues: ["Feet shoulder-width, toes slightly out", "Knees track over toes", "Chest up, elbows inside knees", "Drive through mid-foot"],
    commonFaults: ["Heels lifting", "Chest collapsing forward"],
    regressionId: "tempo_split_squat", progressionId: "back_squat",
  }),
  card({
    id: "tempo_split_squat", slot: "SQUAT", equipment: ["bodyweight"], name: "Tempo split squat",
    description: "Staggered stance; lower the back knee toward the floor over 3 s, then stand.",
    cues: ["3 s down, 1 s up", "Front shin near vertical", "Torso tall", "Back knee just above the floor"],
    commonFaults: ["Rushing the lowering", "Front knee caving in"],
    progressionId: "goblet_squat",
  }),
  // ── HINGE
  card({
    id: "romanian_deadlift", slot: "HINGE", equipment: ["gym"], name: "Romanian deadlift",
    description: "Hip hinge with soft knees, bar close to the legs.",
    cues: ["Push hips back, not down", "Neutral spine", "Stop when hamstrings are tight (about mid-shin)", "Squeeze glutes to stand"],
    commonFaults: ["Rounding the lower back", "Bar drifting away from the legs"],
    regressionId: "single_leg_db_rdl",
  }),
  card({
    id: "single_leg_db_rdl", slot: "HINGE", equipment: ["dumbbells"], name: "Single-leg DB RDL",
    description: "Hold a DB on the standing-leg side; hinge forward as the free leg reaches back.",
    cues: ["Hips stay square to the floor", "Soft standing knee", "Reach the free heel back", "Stand by driving the hips forward"],
    commonFaults: ["Hip opening to the side", "Rounding to reach lower"],
    regressionId: "hip_thrust", progressionId: "romanian_deadlift",
  }),
  card({
    id: "hip_thrust", slot: "HINGE", equipment: ["bodyweight"], name: "Hip thrust / glute bridge",
    description: "Upper back on a bench (or floor for a bridge); drive the hips up to a straight line.",
    cues: ["Chin tucked, ribs down", "Drive through the heels", "Pause 1 s at the top", "Lower under control"],
    commonFaults: ["Arching the lower back at the top", "Pushing through the toes"],
    progressionId: "single_leg_db_rdl",
  }),
  card({
    id: "nordic_eccentric", slot: "HINGE", equipment: ["bodyweight", "dumbbells", "gym"], name: "Nordic eccentric",
    description: "Kneel with heels anchored; lower the torso slowly toward the floor.",
    cues: ["Hips extended, body straight", "Resist as long as possible", "Catch with hands, push back up"],
    commonFaults: ["Bending at the hips", "Dropping fast at the end range"],
    regressionId: "hip_thrust",
  }),
  // ── SINGLE_LEG
  card({
    id: "bulgarian_split_squat", slot: "SINGLE_LEG", equipment: ["gym"], name: "Bulgarian split squat",
    description: "Rear foot on a bench; lower the back knee toward the floor.",
    cues: ["Front foot far enough that the shin stays near vertical", "Torso slightly forward", "Control 2–3 s down"],
    commonFaults: ["Front heel lifting", "Pushing off the back foot"],
    regressionId: "db_reverse_lunge", progressionId: "loaded_step_up",
  }),
  card({
    id: "loaded_step_up", slot: "SINGLE_LEG", equipment: ["gym"], name: "Loaded step-up",
    description: "Box at knee height; step up with a barbell or DBs, lower slowly.",
    cues: ["Whole foot on the box", "Drive through the top leg, not the back toes", "Stand fully tall", "Lower in 2–3 s"],
    commonFaults: ["Bouncing off the floor leg", "Knee caving in"],
    regressionId: "bodyweight_step_up",
  }),
  card({
    id: "db_reverse_lunge", slot: "SINGLE_LEG", equipment: ["dumbbells"], name: "DB reverse lunge",
    description: "Hold DBs at the sides; step back and lower the back knee, then return.",
    cues: ["Step back far enough for a vertical front shin", "Torso tall", "Push through the front heel"],
    commonFaults: ["Short step that drives the knee far forward", "Wobbling hips"],
    regressionId: "bodyweight_step_up", progressionId: "bulgarian_split_squat",
  }),
  card({
    id: "bodyweight_step_up", slot: "SINGLE_LEG", equipment: ["bodyweight"], name: "Bodyweight step-up",
    description: "Step onto a box or stair at about knee height and stand tall.",
    cues: ["Whole foot on the step", "Drive through the top leg", "Lower slowly, 3 s"],
    commonFaults: ["Pushing off the floor leg", "Knee caving in"],
    progressionId: "db_reverse_lunge",
  }),
  // ── CALF_STRAIGHT
  card({
    id: "standing_calf_raise", slot: "CALF_STRAIGHT", equipment: ["gym"], name: "Standing calf raise",
    description: "Standing or Smith machine, heavy, full range off a step.",
    cues: ["Knees straight", "Full stretch at the bottom", "Rise straight over the big toe", "2 s up, 2–3 s down"],
    commonFaults: ["Bouncing at the bottom", "Half range"],
    regressionId: "sl_db_calf_raise",
  }),
  card({
    id: "sl_db_calf_raise", slot: "CALF_STRAIGHT", equipment: ["dumbbells"], name: "Single-leg DB calf raise",
    description: "On a step edge holding a DB; full range on one leg.",
    cues: ["Full stretch at the bottom", "Rise straight over the big toe", "2 s up, 2–3 s down", "Knee straight"],
    commonFaults: ["Rolling to the little toe", "Rushing the lowering"],
    regressionId: "sl_calf_raise", progressionId: "standing_calf_raise",
  }),
  card({
    id: "sl_calf_raise", slot: "CALF_STRAIGHT", equipment: ["bodyweight"], name: "Single-leg calf raise",
    description: "On a step edge, full range.",
    cues: ["Full stretch at the bottom", "Rise straight over the big toe", "2 s up, 2–3 s down", "Knee straight (gastrocnemius)"],
    commonFaults: ["Half range", "Leaning on the hand support"],
    progressionId: "sl_db_calf_raise",
  }),
  // ── CALF_BENT (soleus)
  card({
    id: "seated_calf_machine", slot: "CALF_BENT", equipment: ["gym"], name: "Seated calf raise (machine)",
    description: "Knees bent at about 90°, pad on the thighs; full range.",
    cues: ["Full stretch at the bottom", "Pause 1 s at the top", "2–3 s down"],
    commonFaults: ["Bouncing", "Too much load for full range"],
    regressionId: "seated_db_calf_raise",
  }),
  card({
    id: "seated_db_calf_raise", slot: "CALF_BENT", equipment: ["dumbbells"], name: "Seated calf raise (DB on knees)",
    description: "Seated, balls of the feet on a plate or step, DBs resting on the knees.",
    cues: ["Knees bent about 90°", "Full stretch at the bottom", "2–3 s down"],
    commonFaults: ["Half range", "Lifting the DBs with the hands"],
    regressionId: "bent_knee_calf_raise", progressionId: "seated_calf_machine",
  }),
  card({
    id: "bent_knee_calf_raise", slot: "CALF_BENT", equipment: ["bodyweight"], name: "Bent-knee single-leg calf raise",
    description: "On a step edge with the knee slightly bent throughout (soleus).",
    cues: ["Keep the knee bend constant", "Full stretch at the bottom", "2 s up, 2–3 s down", "Rise over the big toe"],
    commonFaults: ["Straightening the knee to cheat", "Half range"],
    progressionId: "seated_db_calf_raise",
  }),
  // ── HIP
  card({
    id: "copenhagen_plank", slot: "HIP", equipment: ["gym"], name: "Copenhagen plank",
    description: "Side plank with the top leg on a bench; lift the hips in line.",
    cues: ["Body in one straight line", "Squeeze the top leg into the bench", "Short knee lever first"],
    commonFaults: ["Hips sagging", "Rotating the trunk"],
    regressionId: "side_lying_abduction",
  }),
  card({
    id: "banded_lateral_walk", slot: "HIP", equipment: ["dumbbells"], name: "Banded lateral walk",
    description: "Band above the knees or at the ankles; side-step in a quarter squat.",
    cues: ["Toes forward", "Keep band tension the whole time", "Don't let the feet touch"],
    commonFaults: ["Leaning the trunk", "Knees caving in"],
    regressionId: "side_lying_abduction", progressionId: "copenhagen_plank",
  }),
  card({
    id: "side_lying_abduction", slot: "HIP", equipment: ["bodyweight"], name: "Side-lying hip abduction",
    description: "Lying on the side; lift the straight top leg slightly behind the body.",
    cues: ["Toes point forward, not up", "Leg slightly behind the body", "Slow 2 s lower"],
    commonFaults: ["Rolling the hips back", "Swinging the leg"],
    progressionId: "banded_lateral_walk",
  }),
  // ── CORE (1 slot; 2 without trunk-loading cross-training)
  card({
    id: "pallof_press", slot: "CORE", equipment: ["gym"], name: "Pallof press",
    description: "Cable or band at chest height to the side; press out and resist the rotation.",
    cues: ["Feet hip-width, knees soft", "Ribs down", "Press straight out, pause 2 s", "Don't let the hands drift to the anchor"],
    commonFaults: ["Rotating toward the anchor", "Leaning away"],
    regressionId: "dead_bug",
  }),
  card({
    id: "dead_bug", slot: "CORE", equipment: ["dumbbells"], name: "Dead bug",
    description: "On the back, arms and knees up; lower the opposite arm and leg slowly.",
    cues: ["Lower back pressed to the floor", "Exhale as the limbs lower", "Move slowly"],
    commonFaults: ["Back arching off the floor", "Holding the breath"],
    progressionId: "pallof_press",
  }),
  card({
    id: "side_plank", slot: "CORE", equipment: ["bodyweight"], name: "Side plank",
    description: "On the forearm and feet; hold the hips in line.",
    cues: ["Elbow under the shoulder", "Hips high, body straight", "Breathe normally"],
    commonFaults: ["Hips sagging", "Rolling forward"],
    progressionId: "dead_bug",
  }),
  // ── UPPER_PUSH (full-body, D)
  card({
    id: "bench_press", slot: "UPPER_PUSH", equipment: ["gym"], name: "Bench press",
    description: "Lying on a bench; lower the bar to the lower chest and press.",
    cues: ["Shoulder blades pinched", "Feet planted", "Bar to lower chest, elbows ~45°", "Press up and slightly back"],
    commonFaults: ["Flared elbows", "Bouncing off the chest"],
    regressionId: "db_bench_press",
  }),
  card({
    id: "overhead_press", slot: "UPPER_PUSH", equipment: ["gym"], name: "Overhead press",
    description: "Standing; press the bar from the shoulders to overhead.",
    cues: ["Glutes and abs braced", "Bar path close to the face", "Head through at the top"],
    commonFaults: ["Leaning back", "Pressing forward instead of up"],
    regressionId: "db_overhead_press",
  }),
  card({
    id: "db_bench_press", slot: "UPPER_PUSH", equipment: ["dumbbells"], name: "DB bench press",
    description: "Lying on a bench with DBs; lower to the chest and press.",
    cues: ["Shoulder blades pinched", "Elbows ~45° from the torso", "Control 2 s down"],
    commonFaults: ["DBs drifting over the face", "Half range"],
    regressionId: "push_up", progressionId: "bench_press",
  }),
  card({
    id: "db_overhead_press", slot: "UPPER_PUSH", equipment: ["dumbbells"], name: "DB overhead press",
    description: "Seated or standing; press DBs from the shoulders to overhead.",
    cues: ["Ribs down", "Wrists over elbows", "Finish with biceps by the ears"],
    commonFaults: ["Arching the back", "Elbows flaring behind the body"],
    regressionId: "push_up", progressionId: "overhead_press",
  }),
  card({
    id: "push_up", slot: "UPPER_PUSH", equipment: ["bodyweight"], name: "Push-up",
    description: "Plank to chest near the floor. Progress incline → floor → feet-elevated.",
    cues: ["Hands under shoulders", "Body in one line", "Elbows about 45° from the torso"],
    commonFaults: ["Hips sagging", "Head poking forward"],
    progressionId: "db_bench_press",
  }),
  // ── UPPER_PULL (full-body, D)
  card({
    id: "pull_up", slot: "UPPER_PULL", equipment: ["gym"], name: "Pull-up / lat pulldown",
    description: "Hang from a bar and pull the chest toward it (or use a pulldown).",
    cues: ["Start from a dead hang", "Pull elbows down to the ribs", "Chest to the bar, no kipping"],
    commonFaults: ["Half reps", "Swinging"],
    regressionId: "one_arm_db_row",
  }),
  card({
    id: "barbell_row", slot: "UPPER_PULL", equipment: ["gym"], name: "Cable or barbell row",
    description: "Hinged or seated; row the handle or bar to the lower ribs.",
    cues: ["Flat back", "Lead with the elbows", "Squeeze shoulder blades, 1 s pause"],
    commonFaults: ["Jerking with the lower back", "Shrugging"],
    regressionId: "one_arm_db_row",
  }),
  card({
    id: "one_arm_db_row", slot: "UPPER_PULL", equipment: ["dumbbells"], name: "One-arm DB row",
    description: "Hand and knee on a bench; row the DB to the hip.",
    cues: ["Flat back", "Pull the elbow toward the hip", "Don't rotate the torso"],
    commonFaults: ["Twisting to lift", "Shrugging the shoulder"],
    regressionId: "inverted_row", progressionId: "barbell_row",
  }),
  card({
    id: "inverted_row", slot: "UPPER_PULL", equipment: ["bodyweight"], name: "Inverted row",
    description: "Under a sturdy table or low bar, body straight; pull the chest up. A band row works too.",
    cues: ["Body in one line", "Chest to the bar", "Lower in 2 s"],
    commonFaults: ["Hips sagging", "Reaching with the chin"],
    progressionId: "one_arm_db_row",
  }),
  // ── PLYO ladder (§9.5), equipment-independent
  card({
    id: "pogo_hops", slot: "PLYO", equipment: ["gym", "dumbbells", "bodyweight"], name: "Pogo hops",
    description: "Small, fast ankle bounces on the spot.",
    cues: ["Stiff ankles, minimal knee bend", "Quick ground contact", "Land on the forefoot, quietly"],
    commonFaults: ["Sinking into the heels", "Bending the knees to jump higher"],
    progressionId: "skips_height",
  }),
  card({
    id: "skips_height", slot: "PLYO", equipment: ["gym", "dumbbells", "bodyweight"], name: "Skips for height",
    description: "Exaggerated skipping, driving the knee and opposite arm up.",
    cues: ["Punch the ground", "Tall posture", "Drive knee and opposite arm together"],
    commonFaults: ["Skipping for distance instead of height", "Heavy heel landings"],
    regressionId: "pogo_hops", progressionId: "countermovement_jump",
  }),
  card({
    id: "countermovement_jump", slot: "PLYO", equipment: ["gym", "dumbbells", "bodyweight"], name: "Countermovement jump",
    description: "Quick dip and jump as high as possible; land softly and reset.",
    cues: ["Fast dip, arms swing back", "Explode up, full extension", "Land soft, knees over toes", "Reset between reps"],
    commonFaults: ["Knees caving on landing", "Slow, deep dip"],
    regressionId: "skips_height", progressionId: "split_jump",
  }),
  card({
    id: "split_jump", slot: "PLYO", equipment: ["gym", "dumbbells", "bodyweight"], name: "Split jump / single-leg hop in place",
    description: "From a split stance, jump and switch legs (or hop in place on one leg).",
    cues: ["Tall torso", "Land softly in the split", "Knees track over toes"],
    commonFaults: ["Front knee caving", "Losing balance between reps"],
    regressionId: "countermovement_jump", progressionId: "bounds",
  }),
  card({
    id: "bounds", slot: "PLYO", equipment: ["gym", "dumbbells", "bodyweight"], name: "Bounds",
    description: "Exaggerated running strides for distance and air time.",
    cues: ["Drive the knee forward", "Land under the hips", "Short ground contact"],
    commonFaults: ["Over-striding onto the heel", "Collapsing on landing"],
    regressionId: "split_jump", progressionId: "drop_jump_low",
  }),
  card({
    id: "drop_jump_low", slot: "PLYO", equipment: ["gym", "dumbbells", "bodyweight"], name: "Low drop jump (20–40 cm)",
    description: "Step off a 20–40 cm box and rebound up as fast as possible.",
    cues: ["Step off, don't jump off", "Minimal ground time", "Stiff ankles, rebound straight up"],
    commonFaults: ["Box too high", "Long, soft ground contact"],
    regressionId: "bounds", progressionId: "hurdle_hops",
  }),
  card({
    id: "hurdle_hops", slot: "PLYO", equipment: ["gym", "dumbbells", "bodyweight"], name: "Hurdle hops",
    description: "Two-footed hops over a row of low hurdles, rebounding quickly.",
    cues: ["Knees up, feet tucked", "Quick rebound", "Land quietly"],
    commonFaults: ["Pausing between hurdles", "Hurdles too high"],
    regressionId: "drop_jump_low",
  }),
];

const BY_ID = new Map(CARDS.map((c) => [c.id, c]));

export const EXERCISE_LIBRARY: readonly ExerciseCard[] = CARDS;

export function exerciseCard(id: string): ExerciseCard {
  const c = BY_ID.get(id);
  if (!c) throw new RangeError(`unknown exercise "${id}"`);
  return c;
}

/**
 * Primary exercise per slot × equipment, in the §9.3 table's order. The second entry, where the
 * table lists one, is used for B sessions (e.g. full-body B's vertical push, D).
 */
const SLOT_CHOICES: Record<Exclude<StrengthSlot, "PLYO">, Record<StrengthEquipment, readonly string[]>> = {
  SQUAT: { gym: ["back_squat", "trap_bar_deadlift"], dumbbells: ["goblet_squat"], bodyweight: ["tempo_split_squat"] },
  HINGE: { gym: ["romanian_deadlift"], dumbbells: ["single_leg_db_rdl"], bodyweight: ["hip_thrust", "nordic_eccentric"] },
  SINGLE_LEG: { gym: ["bulgarian_split_squat", "loaded_step_up"], dumbbells: ["db_reverse_lunge"], bodyweight: ["bodyweight_step_up"] },
  CALF_STRAIGHT: { gym: ["standing_calf_raise"], dumbbells: ["sl_db_calf_raise"], bodyweight: ["sl_calf_raise"] },
  CALF_BENT: { gym: ["seated_calf_machine"], dumbbells: ["seated_db_calf_raise"], bodyweight: ["bent_knee_calf_raise"] },
  HIP: { gym: ["copenhagen_plank"], dumbbells: ["banded_lateral_walk"], bodyweight: ["side_lying_abduction"] },
  CORE: { gym: ["pallof_press", "dead_bug"], dumbbells: ["dead_bug", "side_plank"], bodyweight: ["side_plank", "dead_bug"] },
  UPPER_PUSH: { gym: ["bench_press", "overhead_press"], dumbbells: ["db_bench_press", "db_overhead_press"], bodyweight: ["push_up"] },
  UPPER_PULL: { gym: ["pull_up", "barbell_row"], dumbbells: ["one_arm_db_row"], bodyweight: ["inverted_row"] },
};

/** Exercise for a slot; `alt` picks the table's second option when there is one. */
export function exerciseFor(slot: Exclude<StrengthSlot, "PLYO">, equipment: StrengthEquipment, alt = false): ExerciseCard {
  const ids = SLOT_CHOICES[slot][equipment];
  return exerciseCard((alt ? ids[1] : undefined) ?? (ids[0] as string));
}

/** §9.5 ladder, bottom to top (D). */
export const PLYO_LADDER: readonly string[] = [
  "pogo_hops",
  "skips_height",
  "countermovement_jump",
  "split_jump",
  "bounds",
  "drop_jump_low",
  "hurdle_hops",
];
