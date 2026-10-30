import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useMe, useUnits, useWorkout } from "../api/hooks";
import { ApiError } from "../api/client";
import { WorkoutBody } from "../components/WorkoutSteps";
import { ActivityLine, PlannedVsActual, StatusBadge, SyncStatus, TypePill } from "../components/WorkoutBits";
import { QuickCheckIn } from "../components/CheckIn";
import { FollowMode } from "../components/FollowMode";
import { Empty, ErrorState, Skeleton } from "../components/States";
import { formatDayLong, timeAgo } from "../lib/dates";
import { isStrength, plannedSummary, toViewWorkout, typeTone } from "../lib/workout";
import { PHASE_NAMES } from "../components/PlanViews";

export function WorkoutDetailScreen() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const units = useUnits();
  const me = useMe();
  const q = useWorkout(id);
  const [following, setFollowing] = useState(params.get("follow") === "1");

  if (q.isPending) {
    return (
      <main className="page">
        <Skeleton height={400} />
      </main>
    );
  }
  if (q.isError) {
    return (
      <main className="page">
        <Link to="/" className="small">
          ← Today
        </Link>
        {q.error instanceof ApiError && q.error.isNotFound ? (
          <Empty title="Workout not found">It may have been replaced by a replan.</Empty>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </main>
    );
  }

  const { item, explanation, deviceText } = q.data;
  const w = toViewWorkout(item.workout);
  const hrMax = me.data?.profile?.hrMax ?? null;
  const isRun = w.sport === "run" && !isStrength(w);
  const canFollow = w.steps.length > 0 || w.exercises.length > 0;
  const setFollow = (v: boolean) => {
    setFollowing(v);
    const next = new URLSearchParams(params);
    if (v) next.set("follow", "1");
    else next.delete("follow");
    setParams(next, { replace: true });
  };

  return (
    <main className="page">
      <Link to={`/week?start=${item.date}`} className="small">
        ← Week
      </Link>
      <header className="page-head">
        <div className="stack stack--tight" style={{ minWidth: 0 }}>
          <span className="eyebrow">
            {formatDayLong(item.date)}
            {w.phase ? ` · ${PHASE_NAMES[w.phase] ?? w.phase}` : ""}
          </span>
          <h1 style={{ overflowWrap: "anywhere" }}>{w.name}</h1>
        </div>
      </header>

      {following && canFollow ? (
        <FollowMode w={w} units={units} hrMax={hrMax} onExit={() => setFollow(false)} />
      ) : (
        <article className={`card card--tone tone-${typeTone(w.type)}`}>
          <div className="row row--between">
            <div className="row">
              <TypePill type={w.type} />
              {w.keySession && <span className="badge badge--accent">Key session</span>}
            </div>
            <StatusBadge status={item.status} />
          </div>
          <span className="num" style={{ fontSize: "1.3rem" }}>
            {plannedSummary(w, units)}
          </span>
          <WorkoutBody w={w} units={units} hrMax={hrMax} />
          {canFollow && (
            <button type="button" className="btn btn--dark" onClick={() => setFollow(true)}>
              Follow in app
            </button>
          )}
        </article>
      )}

      <section className="card">
        <h2 className="section-title" style={{ margin: 0 }}>
          Why this workout
        </h2>
        {explanation.length > 0 ? (
          <ul className="bullets small">
            {explanation.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No explanation recorded for this session.</p>
        )}
      </section>

      {item.matchedActivity && (
        <section className="card">
          <h2 className="section-title" style={{ margin: 0 }}>
            Planned vs actual
          </h2>
          <PlannedVsActual w={w} activity={item.matchedActivity} units={units} />
          <ActivityLine activity={item.matchedActivity} units={units} />
        </section>
      )}

      {isRun && (
        <section className="card">
          <h2 className="section-title" style={{ margin: 0 }}>
            Watch
          </h2>
          <SyncStatus item={item} />
          <dl className="kv small">
            <dt>Last pushed</dt>
            <dd>{item.sink.lastPushedAt ? `${new Date(item.sink.lastPushedAt).toLocaleString()} (${timeAgo(item.sink.lastPushedAt)})` : "Never"}</dd>
            {item.sink.externalId && (
              <>
                <dt>Event</dt>
                <dd className="mono">{item.sink.externalId}</dd>
              </>
            )}
          </dl>
          {deviceText && (
            <details className="disclosure">
              <summary>Device text</summary>
              <pre className="device" data-testid="device-text">
                {deviceText}
              </pre>
            </details>
          )}
        </section>
      )}

      <section className="card">
        <h2 className="section-title" style={{ margin: 0 }}>
          Check in
        </h2>
        <QuickCheckIn item={item} w={w} />
      </section>
    </main>
  );
}
