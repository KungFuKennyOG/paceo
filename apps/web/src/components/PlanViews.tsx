import type { Plan, PlanWeek, PaceSet, ScheduleConflict, Units } from "@paceo/engine";
import { daysBetween, formatDate } from "../lib/dates";
import { formatKm, formatPaceRange, kmToUnit, distanceUnit } from "../lib/units";

export const PHASE_NAMES: Record<string, string> = {
  BASE: "Base",
  FI: "Foundation",
  EQ: "Early quality",
  TQ: "Transition quality",
  FQ: "Final quality",
};

export function PhaseLegend({ weeks }: { weeks: PlanWeek[] }) {
  const phases = [...new Set(weeks.map((w) => w.phase))];
  return (
    <div className="legend" aria-label="Legend">
      {phases.map((p) => (
        <span key={p} className={`phase-${p}`}>
          <i /> {PHASE_NAMES[p] ?? p}
        </span>
      ))}
      <span>
        <i style={{ background: "repeating-linear-gradient(135deg, var(--ink-2) 0 3px, transparent 3px 5px)" }} /> Taper
      </span>
      <span>
        <i style={{ opacity: 0.55 }} /> Cutback
      </span>
    </div>
  );
}

/** Weekly km bars coloured by phase; taper hatched, cutbacks faded, the current week ringed. */
export function WeeklyBars({
  weeks,
  units,
  currentIndex,
  onSelect,
}: {
  weeks: PlanWeek[];
  units: Units;
  currentIndex?: number | null;
  onSelect?: (w: PlanWeek) => void;
}) {
  const max = Math.max(1, ...weeks.map((w) => w.plannedKm || w.targetKm || 0));
  return (
    <div className="stack stack--tight">
      <div className="bars" role="list" aria-label={`Weekly volume in ${distanceUnit(units)}`}>
        {weeks.map((w) => {
          const km = w.plannedKm || w.targetKm || 0;
          const cls = ["bar", `phase-${w.phase}`, w.isTaper && "bar--taper", w.isCutback && "bar--cutback", currentIndex === w.index && "bar--current"]
            .filter(Boolean)
            .join(" ");
          const label = `Week ${w.index}: ${formatKm(km, units)}${w.isTaper ? ", taper" : ""}${w.isCutback ? ", cutback" : ""}`;
          return (
            <button
              key={w.index}
              type="button"
              role="listitem"
              className={cls}
              title={label}
              aria-label={label}
              onClick={onSelect ? () => onSelect(w) : undefined}
            >
              <span className="bar__fill" style={{ height: `${Math.max(2, (km / max) * 100)}%` }} />
            </button>
          );
        })}
      </div>
      <div className="row row--between tiny muted">
        <span>Wk 1</span>
        <span>
          peak {kmToUnit(max, units).toFixed(0)} {distanceUnit(units)}
        </span>
        <span>Wk {weeks.length}</span>
      </div>
    </div>
  );
}

export function PhaseStrip({ weeks }: { weeks: PlanWeek[] }) {
  const runs: Array<{ phase: string; n: number }> = [];
  for (const w of weeks) {
    const last = runs[runs.length - 1];
    if (last && last.phase === w.phase) last.n++;
    else runs.push({ phase: w.phase, n: 1 });
  }
  return (
    <div className="stack stack--tight">
      <div className="phase-strip" aria-hidden="true">
        {runs.map((r, i) => (
          <span key={i} className={`phase-${r.phase}`} style={{ flex: r.n }} />
        ))}
      </div>
      <div className="row tiny muted" style={{ gap: 4 }}>
        {runs.map((r, i) => (
          <span key={i} style={{ flex: r.n, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.phase} · {r.n}w
          </span>
        ))}
      </div>
    </div>
  );
}

export function isGeneralFitnessPlan(plan: Plan): boolean {
  return plan.summary?.mode === "general_fitness";
}

/**
 * Summary card: race date, countdown, peak week, peak long run (§2.1). Tolerates partial summaries.
 * General-fitness plans have no race: they show the end date and no countdown.
 */
export function PlanSummaryStats({ plan, units, today }: { plan: Plan; units: Units; today: string }) {
  const s = plan.summary ?? ({} as Plan["summary"]);
  const gf = isGeneralFitnessPlan(plan);
  const raceDate = !gf && typeof s.raceDate === "string" ? s.raceDate : null;
  const endDate = gf ? (typeof s.endDate === "string" ? s.endDate : typeof s.raceDate === "string" ? s.raceDate : null) : null;
  let daysOut: number | null = null;
  if (raceDate) {
    try {
      daysOut = daysBetween(today, raceDate);
    } catch {
      daysOut = null;
    }
  }
  return (
    <div className="stack">
      {raceDate && daysOut !== null && (
        <div className="row row--between" style={{ alignItems: "flex-end" }}>
          <div>
            <div className="eyebrow">Race day</div>
            <div className="num" style={{ fontSize: "1.3rem" }}>
              {formatDate(raceDate)}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="hero-number" data-testid="countdown">
              {daysOut > 0 ? daysOut : daysOut === 0 ? "Today" : "Done"}
            </div>
            {daysOut > 0 && <div className="eyebrow">days to go</div>}
          </div>
        </div>
      )}
      {gf && (
        <div className="row row--between" style={{ alignItems: "flex-end" }}>
          <div>
            <div className="eyebrow">General fitness</div>
            <div className="num" style={{ fontSize: "1.3rem" }}>
              {endDate ? `Block ends ${formatDate(endDate)}` : "Rolling blocks"}
            </div>
          </div>
        </div>
      )}
      <div className="stats">
        <Stat label="Weeks" value={String(s.weeks ?? plan.weeks.length)} />
        <Stat label="Peak week" value={typeof s.peakWeekKm === "number" ? formatKm(s.peakWeekKm, units, 0) : "—"} />
        <Stat label="Peak long run" value={typeof s.peakLongRunKm === "number" ? formatKm(s.peakLongRunKm, units, 1) : "—"} />
      </div>
    </div>
  );
}

const WEEKDAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

/** Locked-session conflicts and the engine's suggested fixes (§7.1 fallbacks 5–6, §9.6). */
export function ConflictList({ conflicts }: { conflicts: ScheduleConflict[] | undefined }) {
  if (!conflicts || conflicts.length === 0) return null;
  return (
    <div className="banner banner--warn" data-testid="conflicts">
      <strong>Schedule conflicts</strong>
      <ul>
        {conflicts.map((c) => (
          <li key={`${c.code}-${c.weekday}`}>
            <span>{c.message}</span>
            <span className="tiny muted">
              {" "}
              ({WEEKDAY_NAMES[c.weekday] ?? c.weekday}
              {c.weeks.length > 0 ? `, week${c.weeks.length > 1 ? "s" : ""} ${c.weeks.join(", ")}` : ""})
            </span>
            {c.suggestion && <div className="small">Try: {c.suggestion}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

const PACE_ROWS: Array<{ key: keyof PaceSet; label: string }> = [
  { key: "E", label: "Easy" },
  { key: "LR", label: "Long run" },
  { key: "M", label: "Marathon" },
  { key: "T", label: "Threshold" },
  { key: "I", label: "Interval" },
  { key: "R", label: "Repetition" },
];

/** Training paces in the user's units. Accepts the engine PaceSet or the server's loosely typed paces. */
export function PaceTable({ paces, units }: { paces: Partial<PaceSet> | Record<string, unknown>; units: Units }) {
  const rows = PACE_ROWS.flatMap((r) => {
    const v = (paces as Record<string, unknown>)[r.key];
    if (v && typeof v === "object" && "fast" in v && "slow" in v) {
      const range = v as { fast: number; slow: number };
      if (typeof range.fast === "number" && typeof range.slow === "number") {
        return [{ label: r.label, text: formatPaceRange(range, units) }];
      }
    }
    return [];
  });
  if (rows.length === 0) return null;
  return (
    <table className="pace-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            <td>{r.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
