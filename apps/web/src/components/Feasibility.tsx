import type { Alternative, Feasibility } from "@paceo/engine";
import { formatDate } from "../lib/dates";
import { formatDuration } from "../lib/units";

const STATUS: Record<Feasibility["status"], { title: string; cls: string; body: string }> = {
  ok: { title: "Goal looks doable", cls: "banner--ok", body: "Your timeline and current fitness fit this goal." },
  warn: { title: "Doable, with caveats", cls: "banner--warn", body: "You can go ahead, but read these first. An alternative may suit you better." },
  block: { title: "Not safe as set", cls: "banner--block", body: "Pick one of the options below, or change your goal, to continue." },
};

const KIND_LABEL: Record<string, string> = {
  later_date: "Later race",
  shorter_distance: "Shorter distance",
  finish_goal: "Finish goal",
  base_block: "Build a base first",
  slower_goal: "Slower goal time",
};

const DISTANCE_LABEL: Record<string, string> = { "5k": "5K", "10k": "10K", half: "Half marathon", marathon: "Marathon" };

export function alternativeDetail(a: Alternative): string | null {
  switch (a.kind) {
    case "later_date":
      return a.raceDate ? `Race on ${formatDate(a.raceDate)}` : null;
    case "shorter_distance":
      return a.distance ? `${DISTANCE_LABEL[a.distance] ?? a.distance} on the same date` : null;
    case "slower_goal":
      return a.goalTimeS ? `Goal ${formatDuration(a.goalTimeS)}` : null;
    case "base_block":
      return a.baseWeeks ? `${a.baseWeeks} weeks of base building, then re-check` : null;
    default:
      return null;
  }
}

/**
 * Feasibility review (§6.2): status, warn/block reasons, and the ranked alternatives the user can pick.
 * `selected` marks an applied alternative; `onPick` is omitted for read-only displays.
 */
export function FeasibilityPanel({
  feasibility,
  onPick,
  selectedKind,
  source,
}: {
  feasibility: Feasibility;
  onPick?: (a: Alternative) => void;
  selectedKind?: string | null;
  source?: "client" | "server";
}) {
  const s = STATUS[feasibility.status] ?? STATUS.warn;
  const reasons = [...(feasibility.reasons ?? [])].sort((a, b) => rank(a.status) - rank(b.status));
  const alternatives = [...(feasibility.alternatives ?? [])].sort((a, b) => a.rank - b.rank);
  return (
    <div className="stack" data-testid="feasibility">
      <div className={`banner ${s.cls}`} role={feasibility.status === "block" ? "alert" : "status"}>
        <strong>{s.title}</strong>
        <span>{s.body}</span>
        {source && <span className="tiny muted">{source === "server" ? "Checked by the Paceo server." : "Instant check on this device; the server confirms when you create the plan."}</span>}
      </div>
      {reasons.length > 0 && (
        <ul className="stack stack--tight" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Reasons">
          {reasons.map((r) => (
            <li key={r.code + r.message} className="row row--nowrap" style={{ alignItems: "flex-start" }}>
              <span className={`badge ${badgeFor(r.status)}`}>{r.status === "info" ? "Note" : r.status === "block" ? "Block" : r.status === "warn" ? "Warn" : "OK"}</span>
              <span className="small grow">{r.message}</span>
            </li>
          ))}
        </ul>
      )}
      {alternatives.length > 0 && (
        <div className="stack">
          <h3>Options instead</h3>
          <ol className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Alternatives">
            {alternatives.map((a) => {
              const detail = alternativeDetail(a);
              const selected = selectedKind === a.kind;
              return (
                <li key={`${a.kind}-${a.rank}`} className="card card--flat" data-testid="alternative" aria-current={selected ? "true" : undefined}>
                  <div className="row row--between row--nowrap">
                    <span className="eyebrow">
                      #{a.rank} · {KIND_LABEL[a.kind] ?? a.kind}
                    </span>
                    {selected && <span className="badge badge--accent">Applied</span>}
                  </div>
                  <p>{a.message}</p>
                  {detail && <p className="small muted">{detail}</p>}
                  {onPick && (
                    <div>
                      <button type="button" className={`btn btn--small ${selected ? "btn--ghost" : "btn--dark"}`} onClick={() => onPick(a)} disabled={selected}>
                        {selected ? "Using this" : "Use this"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

function rank(s: string): number {
  return s === "block" ? 0 : s === "warn" ? 1 : s === "info" ? 2 : 3;
}

function badgeFor(s: string): string {
  return s === "block" ? "badge--block" : s === "warn" ? "badge--warn" : s === "ok" ? "badge--ok" : "";
}
