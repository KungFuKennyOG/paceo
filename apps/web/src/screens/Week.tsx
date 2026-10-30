import { Link, useSearchParams } from "react-router";
import type { ActivitySummary, WorkoutItem } from "@paceo/contracts";
import { weeklyLoad, type CrossTrainingSession, type Plan, type PlannedWorkout, type WeeklyLoad } from "@paceo/engine";
import { useActivities, usePlan, useProfile, useToday, useUnits, useWorkouts } from "../api/hooks";
import { WorkoutRow } from "../components/WorkoutCard";
import { ActivityLine } from "../components/WorkoutBits";
import { ErrorState, Skeleton } from "../components/States";
import { addDays, formatDay, mondayOf, WEEKDAYS, WEEKDAY_SHORT } from "../lib/dates";
import { formatKm, formatMinutes } from "../lib/units";
import { toViewWorkout } from "../lib/workout";
import { CROSS_ACTIVITIES } from "../onboarding/content";

const isRunSport = (s: string) => /run/i.test(s);

function activityLabel(a: string): string {
  return CROSS_ACTIVITIES.find((c) => c.value === a)?.label ?? a;
}

export function WeekScreen() {
  const today = useToday();
  const units = useUnits();
  const profile = useProfile();
  const [params, setParams] = useSearchParams();
  const requested = params.get("start");
  let start = mondayOf(today);
  try {
    if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) start = mondayOf(requested);
  } catch {
    /* bad date in URL: fall back to this week */
  }
  const end = addDays(start, 6);
  const workouts = useWorkouts(start, end);
  const activities = useActivities(start, end);
  const plan = usePlan();
  const planWeeks = (plan.data?.plan as unknown as Plan | undefined)?.weeks ?? [];
  const planHasXt = planWeeks.some((w) => Array.isArray(w.crossTraining));
  const xtSessions: CrossTrainingSession[] = planWeeks
    .flatMap((w) => w.crossTraining ?? [])
    .filter((x) => x.date >= start && x.date <= end);

  const items = workouts.data?.items ?? [];
  const acts = activities.data?.items ?? [];
  const matchedIds = new Set(items.map((i) => i.matchedActivity?.id).filter(Boolean));
  const extraActs = acts.filter((a) => !matchedIds.has(a.id));

  let plannedM = 0;
  let actualM = 0;
  for (const i of items) {
    const w = toViewWorkout(i.workout);
    if (w.sport === "run" && w.planned) plannedM += w.planned.runM;
    if (i.matchedActivity?.distanceM) actualM += i.matchedActivity.distanceM;
  }
  for (const a of extraActs) if (isRunSport(a.sport) && a.distanceM) actualM += a.distanceM;

  let load: WeeklyLoad | null = null;
  try {
    const ws = items.map((i) => i.workout as unknown as PlannedWorkout).filter((w) => w.planned && typeof w.planned.minutes === "number");
    if (ws.length > 0 || xtSessions.length > 0) load = weeklyLoad({ workouts: ws, crossTraining: xtSessions });
  } catch {
    load = null;
  }

  const shift = (weeks: number) => setParams({ start: addDays(start, 7 * weeks) });
  const isThisWeek = start === mondayOf(today);

  return (
    <main className="page">
      <header className="page-head">
        <div className="stack stack--tight">
          <span className="eyebrow">
            {formatDay(start)} – {formatDay(end)}
          </span>
          <h1>{isThisWeek ? "This week" : "Week"}</h1>
        </div>
        <div className="row row--nowrap">
          <button type="button" className="btn btn--small btn--ghost" onClick={() => shift(-1)} aria-label="Previous week">
            ←
          </button>
          {!isThisWeek && (
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setParams({})}>
              Now
            </button>
          )}
          <button type="button" className="btn btn--small btn--ghost" onClick={() => shift(1)} aria-label="Next week">
            →
          </button>
        </div>
      </header>

      <div className="stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="stat">
          <div className="stat__value">{formatKm(plannedM / 1000, units)}</div>
          <div className="stat__label">Planned running</div>
        </div>
        <div className="stat">
          <div className="stat__value">{formatKm(actualM / 1000, units)}</div>
          <div className="stat__label">Actual running</div>
        </div>
      </div>

      {load && load.totalLoad > 0 && <LoadBar load={load} />}

      {(workouts.isPending || activities.isPending) && <Skeleton height={360} />}
      {workouts.isError && <ErrorState error={workouts.error} onRetry={() => void workouts.refetch()} />}
      {activities.isError && <ErrorState error={activities.error} title="Couldn't load activities" onRetry={() => void activities.refetch()} />}

      {workouts.isSuccess && (
        <div className="card">
          {WEEKDAYS.map((wd, idx) => {
            const date = addDays(start, idx);
            const dayItems = items.filter((i) => i.date === date);
            const dayActs = extraActs.filter((a) => a.localDate === date);
            // Prefer the plan's cross-training sessions (§10.2); older plans fall back to the profile.
            const dayXt = xtSessions.filter((x) => x.date === date);
            const plannedXt = planHasXt ? [] : (profile?.crossTraining ?? []).filter((c) => c.days.includes(wd));
            const empty = dayItems.length === 0 && dayActs.length === 0 && plannedXt.length === 0 && dayXt.length === 0;
            return (
              <section key={date} className={`day ${date === today ? "day--today" : ""}`} aria-label={formatDay(date)} data-testid="week-day">
                <div className="day__date">
                  <span className="tiny">{WEEKDAY_SHORT[wd]}</span>
                  <span className="d">{Number(date.slice(8))}</span>
                </div>
                <div className="day__items">
                  {empty && <span className="small muted">Rest</span>}
                  {dayItems.map((i) => (
                    <DayWorkout key={i.id} item={i} units={units} />
                  ))}
                  {dayXt.map((x) => (
                    <span key={`${x.activity}-${x.date}`} className="small" data-testid="xt-session">
                      <span className="pill tone-other">{x.name || activityLabel(x.activity)}</span>{" "}
                      <span className="muted">
                        {formatMinutes(x.minutes)}
                        {x.hard ? " · hard" : " · easy"}
                        {x.locked ? " · fixed" : ""}
                      </span>
                    </span>
                  ))}
                  {plannedXt.map((c) => (
                    <span key={c.activity} className="small">
                      <span className="pill tone-other">{activityLabel(c.activity)}</span>{" "}
                      <span className="muted">
                        {formatMinutes(c.typicalMinutes)} planned{c.locked ? " · fixed" : ""}
                      </span>
                    </span>
                  ))}
                  {dayActs.map((a) => (
                    <ExtraActivity key={a.id} a={a} units={units} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <p className="small">
        <Link to="/plan">See the whole plan</Link>
      </p>
    </main>
  );
}

function DayWorkout({ item, units }: { item: WorkoutItem; units: ReturnType<typeof useUnits> }) {
  return (
    <div className="stack stack--tight">
      <WorkoutRow item={item} units={units} />
      {item.matchedActivity && <ActivityLine activity={item.matchedActivity} units={units} />}
    </div>
  );
}

function ExtraActivity({ a, units }: { a: ActivitySummary; units: ReturnType<typeof useUnits> }) {
  return (
    <div className="stack stack--tight">
      <span className="row">
        <span className="pill tone-other">{a.sport}</span>
        <span className="badge badge--ok">Done</span>
      </span>
      <ActivityLine activity={a} units={units} />
    </div>
  );
}

/** Total load (sRPE × min) split by runs, strength and cross-training (§10.1). */
function LoadBar({ load }: { load: WeeklyLoad }) {
  const total = Math.max(1, load.totalLoad);
  const parts = [
    { key: "run", label: "Running", v: load.byKind.run, color: "var(--tone-easy)" },
    { key: "strength", label: "Strength", v: load.byKind.strength, color: "var(--tone-strength)" },
    { key: "xt", label: "Cross-training", v: load.byKind.crossTraining, color: "var(--tone-long)" },
  ].filter((p) => p.v > 0);
  return (
    <div className="card card--flat" data-testid="load-bar">
      <div className="row row--between">
        <span className="eyebrow">Planned load</span>
        <span className="small num">{Math.round(load.totalLoad).toLocaleString()} AU</span>
      </div>
      <div className="phase-strip" style={{ height: 12 }} aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} style={{ flex: p.v / total, background: p.color }} />
        ))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.key}>
            <i style={{ background: p.color }} /> {p.label} {Math.round((p.v / total) * 100)}%
          </span>
        ))}
        <span>Key sessions {load.keySessions.toFixed(load.keySessions % 1 ? 1 : 0)}</span>
      </div>
      {load.crossTrainingShare > 0.4 && <span className="tiny muted">Cross-training is over 40% of your load, so cutbacks come every third week.</span>}
    </div>
  );
}
