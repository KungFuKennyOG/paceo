import { Link } from "react-router";
import { useMe, usePlan, useToday, useUnits, useWorkouts } from "../api/hooks";
import { WorkoutCard, WorkoutRow } from "../components/WorkoutCard";
import { Empty, ErrorState, Skeleton } from "../components/States";
import { ProposalList } from "../components/Proposals";
import { addDays, formatDay, formatDayLong } from "../lib/dates";
import type { Plan } from "@paceo/engine";
import { daysBetween } from "../lib/dates";

export function TodayScreen() {
  const today = useToday();
  const units = useUnits();
  const me = useMe();
  const plan = usePlan();
  const list = useWorkouts(today, addDays(today, 7));
  const hrMax = me.data?.profile?.hrMax ?? null;
  const items = list.data?.items ?? [];
  const todays = items.filter((i) => i.date === today);
  const next = items.find((i) => i.date > today);
  const summary = (plan.data?.plan as unknown as Plan | undefined)?.summary;
  // General-fitness plans have no race: summary.raceDate is just the plan's last day.
  const raceDate = summary?.mode === "general_fitness" ? undefined : summary?.raceDate;
  let daysOut: number | null = null;
  try {
    daysOut = typeof raceDate === "string" ? daysBetween(today, raceDate) : null;
  } catch {
    daysOut = null;
  }
  const conservative = me.data?.screening?.outcome === "cleared_conservative";

  return (
    <main className="page">
      <header className="page-head">
        <div className="stack stack--tight">
          <span className="eyebrow">{formatDayLong(today)}</span>
          <h1>Today</h1>
        </div>
        {daysOut !== null && daysOut >= 0 && (
          <div style={{ textAlign: "right" }}>
            <div className="num" style={{ fontSize: "1.8rem", fontStyle: "italic", lineHeight: 1 }}>
              {daysOut}
            </div>
            <div className="eyebrow">days to race</div>
          </div>
        )}
      </header>
      {conservative && <div className="banner banner--warn small">Conservative mode from your health check: beginner caps, no plyometrics, no heavy strength.</div>}
      <ProposalList />
      {list.isPending && <Skeleton height={280} />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && todays.length === 0 && (
        <div className="card">
          <Empty title="Rest day">Nothing planned today. Recovery is training too.</Empty>
        </div>
      )}
      {todays.map((item) => (
        <WorkoutCard key={item.id} item={item} units={units} hrMax={hrMax} />
      ))}
      {list.isSuccess && next && (
        <section className="stack">
          <h2 className="section-title">Next up · {formatDay(next.date)}</h2>
          <div className="card">
            <WorkoutRow item={next} units={units} />
          </div>
        </section>
      )}
      <section className="card card--flat">
        <div className="row row--between">
          <span className="small">Feeling ill or sore?</span>
          <div className="row">
            <Link className="btn btn--small btn--ghost" to="/checkins?type=illness">
              Illness
            </Link>
            <Link className="btn btn--small btn--ghost" to="/checkins?type=pain">
              Pain
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
