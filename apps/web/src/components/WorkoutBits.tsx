import { Link } from "react-router";
import type { ActivitySummary, WorkoutItem } from "@paceo/contracts";
import type { Units } from "@paceo/engine";
import { plannedSummary, typeLabel, typeTone, type ViewWorkout } from "../lib/workout";
import { formatDistance, formatDuration } from "../lib/units";
import { timeAgo } from "../lib/dates";
import { useResend } from "../api/hooks";
import { InlineError } from "./States";

export function TypePill({ type }: { type: string }) {
  return <span className={`pill tone-${typeTone(type)}`}>{typeLabel(type)}</span>;
}

const STATUS_LABEL: Record<WorkoutItem["status"], { label: string; cls: string }> = {
  planned: { label: "Planned", cls: "" },
  completed: { label: "Done", cls: "badge--ok" },
  partial: { label: "Partial", cls: "badge--warn" },
  missed: { label: "Missed", cls: "badge--block" },
  skipped: { label: "Skipped", cls: "" },
};

export function StatusBadge({ status }: { status: WorkoutItem["status"] }) {
  const s = STATUS_LABEL[status] ?? { label: status, cls: "" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

export const GARMIN_ATTRIBUTION = "Data from Garmin";

/**
 * Required wherever data from a Garmin-origin activity is shown (intervals.icu API terms, §3.2):
 * single activities, and totals that include one.
 */
export function GarminAttribution({ activity }: { activity: Pick<ActivitySummary, "garminOrigin"> }) {
  if (!activity.garminOrigin) return null;
  return <span className="attribution">{GARMIN_ATTRIBUTION}</span>;
}

/** Attribution under an aggregate (e.g. weekly totals) when any contributing activity is Garmin-origin. */
export function GarminAttributionAny({ activities }: { activities: ReadonlyArray<Pick<ActivitySummary, "garminOrigin"> | null | undefined> }) {
  if (!activities.some((a) => a?.garminOrigin)) return null;
  return <span className="attribution">{GARMIN_ATTRIBUTION}</span>;
}

export function ActivityLine({ activity, units }: { activity: ActivitySummary; units: Units }) {
  const parts: string[] = [];
  if (activity.distanceM !== null && activity.distanceM > 0) parts.push(formatDistance(activity.distanceM, units));
  if (activity.movingS !== null) parts.push(formatDuration(activity.movingS));
  if (activity.avgHr !== null) parts.push(`${Math.round(activity.avgHr)} bpm avg`);
  return (
    <div className="stack stack--tight">
      <span className="small">
        <strong>{activity.name ?? activity.sport}</strong>
        {parts.length > 0 && <span className="muted"> · {parts.join(" · ")}</span>}
      </span>
      <GarminAttribution activity={activity} />
    </div>
  );
}

/** Planned vs actual distance/time for a run with a matched activity. */
export function PlannedVsActual({ w, activity, units }: { w: ViewWorkout; activity: ActivitySummary | null; units: Units }) {
  if (!w.planned) return null;
  return (
    <dl className="kv small">
      <dt>Planned</dt>
      <dd>{plannedSummary(w, units) || "—"}</dd>
      {activity && (
        <>
          <dt>Actual</dt>
          <dd>
            {[
              activity.distanceM !== null ? formatDistance(activity.distanceM, units) : null,
              activity.movingS !== null ? formatDuration(activity.movingS) : null,
            ]
              .filter(Boolean)
              .join(" · ") || "—"}
          </dd>
        </>
      )}
    </dl>
  );
}

const SINK_TEXT: Record<WorkoutItem["sink"]["status"], { label: string; cls: string }> = {
  pushed: { label: "On your watch calendar", cls: "badge--ok" },
  not_pushed: { label: "Not sent yet", cls: "" },
  missing_on_readback: { label: "Missing on intervals.icu", cls: "badge--warn" },
  error: { label: "Send failed", cls: "badge--block" },
};

/** Watch sync status + "Re-send to watch" (§3.7, §11.3). Strength and unknown sports skip the sink. */
export function SyncStatus({ item, compact = false }: { item: WorkoutItem; compact?: boolean }) {
  const resend = useResend();
  const s = SINK_TEXT[item.sink.status] ?? { label: item.sink.status, cls: "" };
  const sport = (item.workout as Record<string, unknown>).sport;
  if (sport !== undefined && sport !== "run") return null;
  const stuck = item.sink.status === "missing_on_readback" || item.sink.status === "error";
  return (
    <div className="stack stack--tight" data-testid="sync-status">
      <div className="row row--between">
        <span className={`badge ${s.cls}`}>{s.label}</span>
        <button
          type="button"
          className="btn btn--small btn--ghost"
          disabled={resend.isPending}
          onClick={() => resend.mutate(item.id)}
        >
          {resend.isPending ? "Sending…" : item.sink.status === "not_pushed" ? "Send to watch" : "Re-send to watch"}
        </button>
      </div>
      {!compact && (
        <span className="tiny muted">
          {item.sink.lastPushedAt ? `Last pushed ${timeAgo(item.sink.lastPushedAt)}` : "Workouts are sent for the next 14 days."}
        </span>
      )}
      {resend.isSuccess && <span className="tiny" role="status">Sent. Sync your watch to pick it up.</span>}
      {stuck && (
        <span className="tiny">
          Still not on your watch after a re-send? <Link to={`/workouts/${encodeURIComponent(item.id)}?follow=1`}>Follow it in the app</Link>.
        </span>
      )}
      <InlineError error={resend.error} />
    </div>
  );
}
