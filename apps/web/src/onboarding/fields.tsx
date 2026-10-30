/** Profile form sections shared by the onboarding wizard and the Settings profile editor. */
import type { CrossTraining } from "@paceo/contracts";
import type { GoalDistance, Units, Weekday } from "@paceo/engine";
import { ChoiceGroup, DaysPicker, DurationField, Field, NumberField, Scale, YesNo } from "../components/Form";
import { WEEKDAY_LONG, addDays } from "../lib/dates";
import { distanceUnit, kmToUnit, unitToKm } from "../lib/units";
import { CROSS_ACTIVITIES, LEVELS, RESULT_DISTANCES } from "./content";
import type { ProfileDraft } from "./draft";
import type { StepErrors } from "./validation";

export interface SectionProps {
  d: ProfileDraft;
  set: (patch: Partial<ProfileDraft>) => void;
  errors: StepErrors;
  today: string;
}

const kmIn = (u: Units) => (km: number) => kmToUnit(km, u);
const kmOut = (u: Units) => (v: number) => unitToKm(v, u);

export function UnitsToggle({ d, set }: Pick<SectionProps, "d" | "set">) {
  return (
    <ChoiceGroup
      legend="Units"
      value={d.units}
      onChange={(units) => set({ units })}
      options={[
        { value: "metric", label: "km · min/km" },
        { value: "imperial", label: "mi · min/mi" },
      ]}
    />
  );
}

export function ProfileFields({ d, set, errors }: SectionProps) {
  const u = d.units;
  const du = distanceUnit(u);
  return (
    <div className="stack stack--loose">
      <UnitsToggle d={d} set={set} />
      <ChoiceGroup
        legend="Experience"
        value={d.experienceLevel}
        onChange={(experienceLevel) => set({ experienceLevel })}
        options={LEVELS.map((l) => ({ value: l.value, label: l.label }))}
        hint={d.experienceLevel ? LEVELS.find((l) => l.value === d.experienceLevel)?.hint : "Paceo uses the more cautious of your pick and what your numbers say."}
        error={errors.experienceLevel}
      />
      <div className="grid-2 grid-2--stack-sm" key={`vol-${u}`}>
        <NumberField label="Months of consistent running" value={d.monthsRunning} onChange={(monthsRunning) => set({ monthsRunning })} inputMode="numeric" digits={0} error={errors.monthsRunning} />
        <NumberField
          label="Weekly volume (last 4 weeks)"
          value={d.currentWeeklyKm}
          onChange={(currentWeeklyKm) => set({ currentWeeklyKm })}
          suffix={`${du}/wk`}
          toDisplay={kmIn(u)}
          fromDisplay={kmOut(u)}
          error={errors.currentWeeklyKm}
        />
      </div>
      <fieldset>
        <legend>Longest run in the last 30 days (not a race)</legend>
        <div className="grid-2" key={`lr-${u}`}>
          <NumberField label="Distance" value={d.longestRunKm} onChange={(longestRunKm) => set({ longestRunKm })} suffix={du} toDisplay={kmIn(u)} fromDisplay={kmOut(u)} error={errors.longestRunKm} />
          <NumberField label="Time" value={d.longestRunMinutes} onChange={(longestRunMinutes) => set({ longestRunMinutes })} suffix="min" digits={0} inputMode="numeric" error={errors.longestRunMinutes} />
        </div>
      </fieldset>
      <div>
        <YesNo name="run20" question="Can you run 20 minutes without stopping?" value={d.canRun20MinContinuous} onChange={(canRun20MinContinuous) => set({ canRun20MinContinuous })} />
        {errors.canRun20MinContinuous && <p className="error-text">{errors.canRun20MinContinuous}</p>}
      </div>
      <RecentResultFields d={d} set={set} errors={errors} />
      <ChoiceGroup
        legend="Injuries"
        value={d.injury}
        onChange={(injury) => set({ injury })}
        options={[
          { value: "none", label: "None" },
          { value: "past_12_months", label: "In the last 12 months" },
          { value: "current", label: "Current" },
        ]}
        hint={d.injury === "current" ? "A current injury counts as a yes on the health check. If cleared, Paceo starts you in a cautious pain-monitoring mode for 2 weeks." : undefined}
      />
      <details className="disclosure">
        <summary>Optional: age and heart rate</summary>
        <div className="stack">
          <NumberField label="Birth year" value={d.birthYear} onChange={(birthYear) => set({ birthYear })} digits={0} inputMode="numeric" error={errors.birthYear} hint="Used for cutback rhythm and the HR fallback." />
          <div className="grid-2">
            <NumberField label="Max HR" value={d.hrMax} onChange={(hrMax) => set({ hrMax })} suffix="bpm" digits={0} inputMode="numeric" error={errors.hrMax} />
            <NumberField label="Resting HR" value={d.hrRest} onChange={(hrRest) => set({ hrRest })} suffix="bpm" digits={0} inputMode="numeric" error={errors.hrRest} />
          </div>
        </div>
      </details>
    </div>
  );
}

export function RecentResultFields({ d, set, errors }: Omit<SectionProps, "today">) {
  const r = d.recentResult;
  const setR = (patch: Partial<ProfileDraft["recentResult"]>) => set({ recentResult: { ...r, ...patch } });
  return (
    <div className="stack">
      <label className="checkbox">
        <input type="checkbox" checked={d.hasRecentResult} onChange={(e) => set({ hasRecentResult: e.target.checked })} />
        <span>I have a recent race or time trial (ideally in the last 12 weeks)</span>
      </label>
      {d.hasRecentResult && (
        <div className="stack">
          <ChoiceGroup
            legend="Distance"
            value={r.distanceM === null ? null : String(r.distanceM)}
            onChange={(v) => setR({ distanceM: Number(v) })}
            options={RESULT_DISTANCES.map((x) => ({ value: String(x.m), label: x.label }))}
            error={errors.recentDistance}
          />
          <div className="grid-2 grid-2--stack-sm">
            <DurationField label="Time" value={r.timeS} onChange={(timeS) => setR({ timeS })} error={errors.recentTime} />
            <Field label="Date" htmlFor="rr-date" error={errors.recentDate}>
              <input id="rr-date" className="input" type="date" value={r.date} onChange={(e) => setR({ date: e.target.value })} />
            </Field>
          </div>
          <ChoiceGroup
            legend="Kind"
            value={r.kind}
            onChange={(kind) => setR({ kind })}
            options={[
              { value: "race", label: "Race" },
              { value: "time_trial", label: "Time trial" },
            ]}
          />
        </div>
      )}
    </div>
  );
}

const DISTANCES: { value: GoalDistance; label: string }[] = [
  { value: "5k", label: "5K" },
  { value: "10k", label: "10K" },
  { value: "half", label: "Half" },
  { value: "marathon", label: "Marathon" },
];

export function GoalFields({ d, set, errors, today }: SectionProps) {
  return (
    <div className="stack stack--loose">
      <ChoiceGroup
        legend="What are you training for?"
        value={d.goalType}
        onChange={(goalType) => set({ goalType })}
        options={[
          { value: "race", label: "A race" },
          { value: "general_fitness", label: "General fitness" },
        ]}
      />
      {d.goalType === "race" ? (
        <>
          <ChoiceGroup legend="Distance" value={d.distance} onChange={(distance) => set({ distance })} options={DISTANCES} />
          <Field label="Race date" htmlFor="race-date" error={errors.raceDate}>
            <input id="race-date" className="input" type="date" min={addDays(today, 1)} value={d.raceDate} onChange={(e) => set({ raceDate: e.target.value })} />
          </Field>
          <DurationField
            label="Goal time (optional)"
            value={d.goalTimeS}
            onChange={(goalTimeS) => set({ goalTimeS })}
            hint="Leave empty to train from your current fitness."
            error={errors.goalTimeS}
          />
        </>
      ) : (
        <NumberField
          label="Weekly training time (optional)"
          value={d.targetWeeklyMinutes}
          onChange={(targetWeeklyMinutes) => set({ targetWeeklyMinutes })}
          suffix="min/wk"
          digits={0}
          inputMode="numeric"
          hint="Default: your current volume plus 20%, capped for your level."
          error={errors.targetWeeklyMinutes}
        />
      )}
    </div>
  );
}

export function ScheduleFields({ d, set, errors }: SectionProps) {
  const setDays = (daysAvailable: Weekday[]) => {
    const patch: Partial<ProfileDraft> = { daysAvailable };
    if (!daysAvailable.includes(d.longRunDay) && daysAvailable.length > 0) {
      patch.longRunDay = daysAvailable.includes("sun") ? "sun" : (daysAvailable[daysAvailable.length - 1] as Weekday);
    }
    set(patch);
  };
  return (
    <div className="stack stack--loose">
      <DaysPicker legend="Days you can run" value={d.daysAvailable} onChange={setDays} error={errors.daysAvailable} />
      <p className="hint" style={{ marginTop: -12 }}>
        {d.daysAvailable.length} day{d.daysAvailable.length === 1 ? "" : "s"} a week.
        {d.experienceLevel === "beginner" ? " Beginners are capped at 4 run days for the first 4 weeks." : ""}
      </p>
      <ChoiceGroup
        legend="Long-run day"
        value={d.longRunDay}
        onChange={(longRunDay) => set({ longRunDay })}
        options={d.daysAvailable.map((w) => ({ value: w, label: WEEKDAY_LONG[w] }))}
        error={errors.longRunDay}
      />
      {d.goalType === "race" && d.distance === "marathon" && (
        <ChoiceGroup
          legend="Longest long run"
          value={d.longRunMode}
          onChange={(longRunMode) => set({ longRunMode })}
          options={[
            { value: "daniels", label: "Up to 2.5 h (Daniels)" },
            { value: "pfitz", label: "Up to 3 h (Pfitzinger)" },
          ]}
        />
      )}
      <details className="disclosure">
        <summary>Optional: time limits per day</summary>
        <div className="grid-2">
          {d.daysAvailable.map((w) => (
            <NumberField
              key={w}
              label={WEEKDAY_LONG[w]}
              value={d.maxMinutesByDay[w] ?? null}
              onChange={(v) => {
                const next = { ...d.maxMinutesByDay };
                if (v === null) delete next[w];
                else next[w] = Math.round(v);
                set({ maxMinutesByDay: next });
              }}
              suffix="min"
              digits={0}
              inputMode="numeric"
              placeholder="no limit"
              error={errors[`max_${w}`]}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

export function StrengthFields({ d, set, errors, conservative = false }: SectionProps & { conservative?: boolean }) {
  const s = d.strength;
  const setS = (patch: Partial<ProfileDraft["strength"]>) => set({ strength: { ...s, ...patch } });
  return (
    <div className="stack stack--loose">
      {conservative && (
        <div className="banner banner--warn">
          <strong>Conservative mode</strong>
          <span>After your health check, Paceo leaves out plyometrics and heavy strength work.</span>
        </div>
      )}
      <ChoiceGroup
        legend="Strength training"
        value={s.mode}
        onChange={(mode) => setS({ mode, sessionsPerWeek: mode === "off" ? 0 : s.sessionsPerWeek || 2 })}
        options={[
          { value: "running", label: "Running-focused" },
          { value: "full_body", label: "Full body" },
          { value: "external", label: "I follow my own program" },
          { value: "off", label: "Off" },
        ]}
        hint={
          s.mode === "running"
            ? "Lower body, calves and a little core, about 45 min."
            : s.mode === "full_body"
              ? "Adds upper-body push and pull, about 55–60 min."
              : s.mode === "external"
                ? "Paceo schedules runs around your lifting days. Add them as locked cross-training (lifting) next."
                : "Strength cuts injury risk for runners. You can turn it on later."
        }
      />
      {s.mode !== "off" && s.mode !== "external" && (
        <>
          <ChoiceGroup
            legend="Equipment"
            value={s.equipment}
            onChange={(equipment) => setS({ equipment })}
            options={[
              { value: "gym", label: "Gym" },
              { value: "dumbbells", label: "Dumbbells" },
              { value: "bodyweight", label: "Bodyweight" },
            ]}
            hint={s.equipment === "bodyweight" ? "Bodyweight-only is a lighter stimulus; Paceo leans on single-leg work, slow lowering and calves." : undefined}
          />
          <ChoiceGroup
            legend="Sessions per week (upper limit)"
            value={String(s.sessionsPerWeek) as "0" | "1" | "2" | "3"}
            onChange={(v) => setS({ sessionsPerWeek: Number(v) })}
            options={[
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
            error={errors.sessionsPerWeek}
          />
          <ChoiceGroup
            legend="Lifting experience"
            value={s.liftingExperience}
            onChange={(liftingExperience) => setS({ liftingExperience })}
            options={[
              { value: "none", label: "None" },
              { value: "novice", label: "Under 6 months" },
              { value: "experienced", label: "Experienced" },
            ]}
          />
        </>
      )}
    </div>
  );
}

function newCross(): CrossTraining {
  return { activity: "cycling", days: [], typicalMinutes: 45, typicalSrpe: 5, locked: false };
}

export function CrossTrainingFields({ d, set, errors }: SectionProps) {
  const list = d.crossTraining;
  const update = (i: number, patch: Partial<CrossTraining>) => set({ crossTraining: list.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const remove = (i: number) => set({ crossTraining: list.filter((_, j) => j !== i) });
  return (
    <div className="stack">
      {list.length === 0 && <p className="muted">No other sports? That's fine. Add any you do regularly so Paceo can count their load.</p>}
      {list.map((c, i) => {
        const known = CROSS_ACTIVITIES.some((a) => a.value === c.activity);
        return (
          <div key={i} className="card card--flat" data-testid="cross-item">
            <div className="row row--between">
              <h3>Activity {i + 1}</h3>
              <button type="button" className="linkbtn small" onClick={() => remove(i)}>
                Remove
              </button>
            </div>
            <Field label="Activity" htmlFor={`xt-${i}`} error={errors[`xt_${i}_activity`]}>
              <select id={`xt-${i}`} className="input" value={known ? c.activity : "other"} onChange={(e) => update(i, { activity: e.target.value })}>
                {CROSS_ACTIVITIES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
            <DaysPicker legend="Usual days" value={c.days} onChange={(days) => update(i, { days })} error={errors[`xt_${i}_days`]} />
            <NumberField label="Typical session" value={c.typicalMinutes} onChange={(v) => update(i, { typicalMinutes: v === null ? 0 : Math.round(v) })} suffix="min" digits={0} inputMode="numeric" error={errors[`xt_${i}_minutes`]} />
            <Scale label="How hard, usually (session RPE)" value={c.typicalSrpe} min={1} max={10} onChange={(typicalSrpe) => update(i, { typicalSrpe })} />
            <label className="checkbox">
              <input type="checkbox" checked={c.locked} onChange={(e) => update(i, { locked: e.target.checked })} />
              <span>Fixed schedule: plan my runs around it</span>
            </label>
          </div>
        );
      })}
      {errors.crossTraining && <p className="error-text">{errors.crossTraining}</p>}
      {list.length < 10 && (
        <div>
          <button type="button" className="btn btn--ghost" onClick={() => set({ crossTraining: [...list, newCross()] })}>
            + Add activity
          </button>
        </div>
      )}
    </div>
  );
}
