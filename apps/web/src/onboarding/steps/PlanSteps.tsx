import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Profile } from "@paceo/contracts";
import type { Alternative, Feasibility, Plan, Units } from "@paceo/engine";
import { api } from "../../api/client";
import { FeasibilityPanel } from "../../components/Feasibility";
import { PaceTable, PhaseLegend, PhaseStrip, PlanSummaryStats, WeeklyBars } from "../../components/PlanViews";
import { Loading } from "../../components/States";
import { TypePill } from "../../components/WorkoutBits";
import { clientFeasibility, clientPreview } from "../../lib/planInput";
import { formatDay } from "../../lib/dates";
import { plannedSummary, toViewWorkout } from "../../lib/workout";
import { formatKm } from "../../lib/units";

/** Authoritative server preview (§2.6). Keyed by the profile so edits refetch. */
export function useServerPreview(profile: Profile | null) {
  const key = profile ? JSON.stringify(profile) : "none";
  return useQuery({
    queryKey: ["planPreview", key],
    queryFn: () => api.planPreview(profile as Profile),
    enabled: profile !== null,
    retry: false,
    staleTime: 60_000,
  });
}

/** Small always-on preview under the goal/schedule steps: changes show instantly (client engine). */
export function LivePreviewStrip({ profile, today, units }: { profile: Profile | null; today: string; units: Units }) {
  const result = useMemo(() => (profile ? clientPreview(profile, today) : null), [profile, today]);
  if (!profile || !result) return null;
  if (!result.ok) return <p className="tiny muted">{result.reason}</p>;
  const { plan } = result.preview;
  const status = plan.feasibility.status;
  return (
    <div className="card card--flat" aria-live="polite" data-testid="live-preview">
      <div className="row row--between">
        <span className="eyebrow">Live preview</span>
        <span className={`badge ${status === "ok" ? "badge--ok" : status === "warn" ? "badge--warn" : "badge--block"}`}>
          {status === "ok" ? "Looks good" : status === "warn" ? "Check the goal" : "Blocked"}
        </span>
      </div>
      {plan.weeks.length > 0 ? (
        <p className="small">
          {plan.weeks.length} weeks · peak {formatKm(plan.summary.peakWeekKm, units, 0)}/wk · longest run {formatKm(plan.summary.peakLongRunKm, units, 1)}
        </p>
      ) : (
        <p className="small">No plan fits these settings yet.</p>
      )}
    </div>
  );
}

export function ReviewStep({
  profile,
  today,
  onPick,
  selectedKind,
  onStatus,
}: {
  profile: Profile | null;
  today: string;
  onPick: (a: Alternative) => void;
  selectedKind: string | null;
  onStatus?: (s: Feasibility["status"] | null) => void;
}) {
  const local = useMemo(() => (profile ? clientFeasibility(profile, today) : null), [profile, today]);
  const server = useServerPreview(profile);
  const serverFeasibility = server.data ? (server.data.plan.feasibility as unknown as Feasibility) : null;
  const shown = serverFeasibility ?? local;
  const source = serverFeasibility ? "server" : "client";
  const shownStatus = shown?.status ?? null;
  useEffect(() => {
    onStatus?.(shownStatus);
  }, [shownStatus, onStatus]);

  if (!profile) return <p className="error-text">Some earlier answers are missing. Go back and check them.</p>;
  if (!shown) {
    if (server.isPending) return <Loading label="Checking your goal…" />;
    return (
      <div className="banner banner--warn">
        <strong>Couldn't check this goal on the device.</strong>
        <span>{server.isError ? "The server check failed too. You can still continue; the plan is checked again when it's created." : "The server will check it when you create the plan."}</span>
      </div>
    );
  }
  return (
    <div className="stack">
      <FeasibilityPanel feasibility={shown} onPick={onPick} selectedKind={selectedKind} source={source} />
      {server.isPending && <p className="tiny muted">Confirming with the server…</p>}
      {server.isError && <p className="tiny muted">Server check unavailable right now; showing the on-device check.</p>}
    </div>
  );
}

export function PlanPreviewBody({ plan, paces, units, today, showWorkouts = true }: { plan: Plan; paces: Record<string, unknown> | null; units: Units; today: string; showWorkouts?: boolean }) {
  if (plan.weeks.length === 0) {
    return <p className="muted">No weeks to show. Check the goal step for what's blocking the plan.</p>;
  }
  const first = plan.weeks.slice(0, 2);
  return (
    <div className="stack stack--loose">
      <PlanSummaryStats plan={plan} units={units} today={today} />
      <div className="card card--flat">
        <span className="eyebrow">Weekly volume</span>
        <WeeklyBars weeks={plan.weeks} units={units} />
        <PhaseStrip weeks={plan.weeks} />
        <PhaseLegend weeks={plan.weeks} />
      </div>
      {paces && (
        <div className="card card--flat">
          <span className="eyebrow">Your paces</span>
          <PaceTable paces={paces} units={units} />
        </div>
      )}
      {showWorkouts &&
        first.map((w) => (
          <div key={w.index} className="card card--flat">
            <div className="row row--between">
              <h3>Week {w.index}</h3>
              <span className="small muted">{formatKm(w.plannedKm, units)}</span>
            </div>
            <ul className="stack stack--tight" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {w.workouts.map((raw) => {
                const vw = toViewWorkout(raw as unknown as Record<string, unknown>);
                return (
                  <li key={vw.id} className="row row--nowrap" style={{ alignItems: "flex-start" }}>
                    <span className="small muted" style={{ width: 84, flex: "none" }}>
                      {formatDay(vw.date)}
                    </span>
                    <span className="grow stack stack--tight">
                      <span className="row">
                        <TypePill type={vw.type} />
                      </span>
                      <span className="small">{vw.name}</span>
                      <span className="tiny muted">{plannedSummary(vw, units)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
    </div>
  );
}
