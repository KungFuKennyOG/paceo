import { Link, useNavigate } from "react-router";
import type { Feasibility, Plan } from "@paceo/engine";
import { usePlan, useToday, useUnits } from "../api/hooks";
import { FeasibilityPanel } from "../components/Feasibility";
import { ConflictList, PaceTable, PHASE_NAMES, PhaseLegend, PhaseStrip, PlanSummaryStats, WeeklyBars } from "../components/PlanViews";
import { Empty, ErrorState, Skeleton } from "../components/States";
import { ProposalList } from "../components/Proposals";
import { addDays, formatDay } from "../lib/dates";
import { formatKm } from "../lib/units";

export function PlanScreen() {
  const q = usePlan();
  const today = useToday();
  const units = useUnits();
  const nav = useNavigate();

  if (q.isPending) {
    return (
      <main className="page">
        <Skeleton height={420} />
      </main>
    );
  }
  if (q.isError) {
    return (
      <main className="page">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </main>
    );
  }
  if (!q.data) {
    return (
      <main className="page">
        <Empty title="No plan yet">
          <Link to="/onboarding">Set up your plan</Link>
        </Empty>
      </main>
    );
  }
  const plan = q.data.plan as unknown as Plan;
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : [];
  const current = weeks.find((w) => today >= w.startDate && today <= addDays(w.startDate, 6));
  const feas = plan.feasibility as Feasibility | undefined;
  const notes = Array.isArray(plan.summary?.notes) ? plan.summary.notes : [];

  return (
    <main className="page">
      <header className="page-head">
        <div className="stack stack--tight">
          <span className="eyebrow">{current ? `Week ${current.index} of ${weeks.length}` : `${weeks.length} weeks`}</span>
          <h1>Plan</h1>
        </div>
        {current && <span className={`pill phase-${current.phase}`}>{PHASE_NAMES[current.phase] ?? current.phase}</span>}
      </header>

      <ProposalList />

      <section className="card">
        <PlanSummaryStats plan={plan} units={units} today={today} />
      </section>

      {weeks.length > 0 && (
        <section className="card">
          <span className="eyebrow">Weekly volume · tap a week</span>
          <WeeklyBars weeks={weeks} units={units} currentIndex={current?.index ?? null} onSelect={(w) => void nav(`/week?start=${w.startDate}`)} />
          <PhaseStrip weeks={weeks} />
          <PhaseLegend weeks={weeks} />
        </section>
      )}

      <ConflictList conflicts={plan.summary?.conflicts} />

      {feas && feas.status !== "ok" && (
        <section className="card">
          <FeasibilityPanel feasibility={{ ...feas, alternatives: [] }} />
        </section>
      )}

      <section className="card">
        <span className="eyebrow">Your paces</span>
        <PaceTable paces={q.data.paces} units={units} />
      </section>

      {notes.length > 0 && (
        <section className="card card--flat">
          <span className="eyebrow">Notes</span>
          <ul className="bullets small">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack">
        <h2 className="section-title">All weeks</h2>
        <div className="card" style={{ gap: 0, padding: "4px 16px" }}>
          {weeks.map((w) => (
            <Link
              key={w.index}
              to={`/week?start=${w.startDate}`}
              className="row row--between row--nowrap"
              style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}
              aria-current={current?.index === w.index ? "true" : undefined}
            >
              <span className="row row--nowrap grow">
                <span className="num" style={{ width: 34, fontSize: "1.2rem", color: current?.index === w.index ? "var(--accent)" : undefined }}>
                  {w.index}
                </span>
                <span className="stack stack--tight grow">
                  <span className="small">
                    {formatDay(w.startDate)} · {PHASE_NAMES[w.phase] ?? w.phase}
                  </span>
                  <span className="tiny muted">
                    Long run {formatKm(w.longRunKm, units)}
                    {w.isCutback ? " · cutback" : ""}
                    {w.isTaper ? " · taper" : ""}
                    {w.isLadder ? " · run/walk" : ""}
                  </span>
                </span>
              </span>
              <span className="num">{formatKm(w.plannedKm, units, 0)}</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
