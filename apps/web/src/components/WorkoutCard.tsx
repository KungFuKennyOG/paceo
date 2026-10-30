import { useState } from "react";
import { Link } from "react-router";
import type { WorkoutItem } from "@paceo/contracts";
import type { Units } from "@paceo/engine";
import { useWorkout } from "../api/hooks";
import { isStrength, plannedSummary, toViewWorkout, typeTone } from "../lib/workout";
import { WorkoutBody } from "./WorkoutSteps";
import { ActivityLine, StatusBadge, SyncStatus, TypePill } from "./WorkoutBits";
import { QuickCheckIn } from "./CheckIn";
import { ErrorState, Loading } from "./States";

/** "Why this workout" (§11.4): loads the explanation lines from the workout detail on first open. */
export function WhyThisWorkout({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const detail = useWorkout(id, open);
  return (
    <details className="disclosure" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Why this workout</summary>
      {open && detail.isPending && <Loading label="Loading…" />}
      {open && detail.isError && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
      {detail.data &&
        (detail.data.explanation.length > 0 ? (
          <ul className="bullets small">
            {detail.data.explanation.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No explanation recorded for this session.</p>
        ))}
    </details>
  );
}

/** Today's workout card: steps, why, watch sync + re-send, and the quick check-in. */
export function WorkoutCard({ item, units, hrMax = null }: { item: WorkoutItem; units: Units; hrMax?: number | null }) {
  const w = toViewWorkout(item.workout);
  const summary = plannedSummary(w, units);
  return (
    <article className={`card card--tone tone-${typeTone(w.type)}`} data-testid="workout-card">
      <div className="row row--between">
        <div className="row">
          <TypePill type={w.type} />
          {w.keySession && <span className="badge badge--accent">Key session</span>}
        </div>
        <StatusBadge status={item.status} />
      </div>
      <div className="stack stack--tight">
        <h2>{w.name}</h2>
        {summary && <span className="num" style={{ fontSize: "1.25rem" }}>{summary}</span>}
      </div>
      <WorkoutBody w={w} units={units} hrMax={hrMax} />
      {item.matchedActivity && <ActivityLine activity={item.matchedActivity} units={units} />}
      <WhyThisWorkout id={item.id} />
      {!isStrength(w) && <SyncStatus item={item} />}
      <div className="row">
        <Link className="btn btn--small btn--ghost" to={`/workouts/${encodeURIComponent(item.id)}${w.steps.length || w.exercises.length ? "?follow=1" : ""}`}>
          {w.steps.length || w.exercises.length ? "Follow in app" : "Details"}
        </Link>
      </div>
      <hr className="divider" />
      <QuickCheckIn item={item} w={w} />
    </article>
  );
}

/** One-line workout link for lists (week view, "next up"). */
export function WorkoutRow({ item, units }: { item: WorkoutItem; units: Units }) {
  const w = toViewWorkout(item.workout);
  return (
    <Link to={`/workouts/${encodeURIComponent(item.id)}`} className="day-item" data-testid="workout-row">
      <span className="row">
        <TypePill type={w.type} />
        <StatusBadge status={item.status} />
      </span>
      <span style={{ fontWeight: 600 }}>{w.name}</span>
      <span className="small muted">{plannedSummary(w, units)}</span>
    </Link>
  );
}
