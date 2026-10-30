import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConnectionStatus } from "@paceo/contracts";
import { api, ApiError, errorMessage } from "../../api/client";
import { qk } from "../../api/hooks";
import { ChoiceGroup, Field } from "../../components/Form";
import { InlineError } from "../../components/States";
import { FitUpload } from "../../components/FitUpload";
import { formatDayLong } from "../../lib/dates";
import { pacesFromResult } from "../../lib/planInput";
import { formatPace, formatPaceRange } from "../../lib/units";
import { BRAND_GUIDES, BRAND_ORDER, INTERVALS_SETTINGS_URL, INTERVALS_URL, TEST_WORKOUT_CHECKLIST } from "../content";
import type { ProfileDraft, WatchBrand } from "../draft";
import { RecentResultFields } from "../fields";
import type { StepErrors } from "../validation";

export interface ConnectStepProps {
  d: ProfileDraft;
  set: (patch: Partial<ProfileDraft>) => void;
  connect: { connected: boolean; skipped: boolean };
  onConnect: (c: { connected: boolean; skipped: boolean }) => void;
  initialStatus: ConnectionStatus | null;
  errors: StepErrors;
}

/** Maps API errors to the §2.5 error-state copy. */
export function connectErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "key_rejected" || err.status === 401 || err.status === 403) return "Key not accepted — copy it again from Developer Settings.";
    if (err.status === 429 || err.code === "rate_limited") return "intervals.icu is busy right now. Paceo will retry by itself; try again in a minute.";
    return err.message;
  }
  return errorMessage(err);
}

function totalActivities(s: ConnectionStatus): number {
  return Object.values(s.activityCounts ?? {}).reduce((a, b) => a + b, 0);
}

/** §2.5 guided connect flow: brand → account → watch link → threshold pace → key → validation → optional test workout. */
export function ConnectStep({ d, set, connect, onConnect, initialStatus, errors }: ConnectStepProps) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [athleteId, setAthleteId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus | null>(initialStatus?.connected ? initialStatus : null);
  const brand = d.watchBrand;
  const guide = brand ? BRAND_GUIDES[brand] : null;

  const connectMut = useMutation({
    mutationFn: () => api.connectIntervals(athleteId.trim() ? { apiKey: apiKey.trim(), athleteId: athleteId.trim() } : { apiKey: apiKey.trim() }),
    onSuccess: (s) => {
      setStatus(s);
      onConnect({ connected: s.connected, skipped: false });
      qc.setQueryData(qk.connection, s);
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });

  const t = d.hasRecentResult && d.recentResult.distanceM && d.recentResult.timeS ? pacesFromResult(d.recentResult.distanceM, d.recentResult.timeS) : null;

  return (
    <div className="stack stack--loose">
      <p className="muted">
        Paceo talks to your watch through <strong>intervals.icu</strong>, a free training site. It reads your runs and sends planned workouts to your
        watch calendar.
      </p>
      <ChoiceGroup<WatchBrand>
        legend="Your watch"
        value={brand}
        onChange={(watchBrand) => set({ watchBrand })}
        options={BRAND_ORDER.map((b) => ({ value: b, label: BRAND_GUIDES[b].label }))}
        error={errors.watchBrand}
      />

      {guide && guide.support === "out_of_scope" && (
        <div className="banner banner--warn">
          <strong>A watch is needed</strong>
          <span>{guide.note}</span>
        </div>
      )}

      {guide && guide.support !== "out_of_scope" && (
        <ol className="substeps">
          <li>
            <div className="stack stack--tight">
              <h3>Create a free intervals.icu account</h3>
              <p className="small">
                <a href={INTERVALS_URL} target="_blank" rel="noreferrer noopener">
                  Open intervals.icu
                </a>{" "}
                and sign up. Skip this if you already have one.
              </p>
            </div>
          </li>
          <li>
            <div className="stack stack--tight">
              <h3>Connect your {guide.label}</h3>
              <ul className="bullets small">
                {guide.connectSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              {guide.note && <p className="small muted">{guide.note}</p>}
            </div>
          </li>
          {guide.receivesWorkouts && (
            <li>
              <div className="stack stack--tight">
                <h3>Set your threshold pace</h3>
                <p className="small">
                  In intervals.icu go to <span className="paths">Settings → Run sport settings → Threshold pace</span>. Pace targets only reach your watch
                  when this is set.
                </p>
                {t ? (
                  <div className="banner banner--accent">
                    <span className="small">Enter this value:</span>
                    <span className="hero-number" style={{ fontSize: "2.4rem" }} data-testid="threshold-pace">
                      {formatPace(t.T.fast, d.units)}
                    </span>
                    <span className="tiny">
                      Your threshold zone is {formatPaceRange(t.T, d.units)} (VDOT {t.vdot.toFixed(1)}). If intervals.icu shows pace in {d.units === "imperial" ? "min/km" : "min/mi"}, use{" "}
                      {formatPace(t.T.fast, d.units === "imperial" ? "metric" : "imperial")}.
                    </span>
                  </div>
                ) : (
                  <div className="card card--flat">
                    <p className="small">Add a recent race or time trial and Paceo will show the value to enter. No result yet? Skip this; Paceo reminds you after your first time trial.</p>
                    <RecentResultFields d={d} set={set} errors={errors} />
                  </div>
                )}
              </div>
            </li>
          )}
          <li>
            <div className="stack">
              <h3>Paste your API key</h3>
              <p className="small">
                In intervals.icu open{" "}
                <a href={INTERVALS_SETTINGS_URL} target="_blank" rel="noreferrer noopener">
                  Settings
                </a>{" "}
                and scroll to <span className="paths">Developer Settings</span> at the bottom. Copy the <strong>API key</strong> and your{" "}
                <strong>athlete ID</strong> (it looks like i12345).
              </p>
              {status?.connected ? (
                <ConnectResult status={status} />
              ) : (
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (apiKey.trim().length >= 10) connectMut.mutate();
                  }}
                >
                  <Field label="API key" htmlFor="api-key" hint="Paceo encrypts it, never logs it, and you can delete it in one tap in Settings.">
                    <div className="input-group">
                      <input
                        id="api-key"
                        className="input"
                        type={showKey ? "text" : "password"}
                        autoComplete="off"
                        spellCheck={false}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                      />
                      <button type="button" className="suffix linkbtn" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
                        {showKey ? "Hide" : "Show"}
                      </button>
                    </div>
                  </Field>
                  <Field label="Athlete ID (optional)" htmlFor="athlete-id" hint="Lets Paceo check the key belongs to you.">
                    <input id="athlete-id" className="input" autoComplete="off" spellCheck={false} placeholder="i12345" value={athleteId} onChange={(e) => setAthleteId(e.target.value)} />
                  </Field>
                  {connectMut.isError && (
                    <div className="banner banner--block" role="alert">
                      <strong>Couldn't connect</strong>
                      <span>{connectErrorMessage(connectMut.error)}</span>
                    </div>
                  )}
                  <button type="submit" className="btn btn--dark" disabled={apiKey.trim().length < 10 || connectMut.isPending}>
                    {connectMut.isPending ? "Checking key…" : "Connect"}
                  </button>
                </form>
              )}
            </div>
          </li>
          {status?.connected && guide.receivesWorkouts && (
            <li>
              <TestWorkout />
            </li>
          )}
        </ol>
      )}

      {status?.connected && <Troubleshooting />}

      {!connect.connected && (
        <div className="card card--flat">
          <label className="checkbox">
            <input type="checkbox" checked={connect.skipped} onChange={(e) => onConnect({ connected: false, skipped: e.target.checked })} />
            <span>Skip for now. I'll upload FIT files or connect later in Settings.</span>
          </label>
          {errors.connection && !connect.skipped && <p className="hint">{errors.connection}</p>}
        </div>
      )}
    </div>
  );
}

function ConnectResult({ status }: { status: ConnectionStatus }) {
  const total = totalActivities(status);
  if (status.status === "rate_limited") {
    return (
      <div className="banner" role="status">
        <strong>Key saved.</strong>
        <span>{status.message ?? "intervals.icu is busy right now. Paceo will finish the first sync by itself shortly."}</span>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="banner banner--ok" role="status">
        <strong>Connected{status.athleteName ? ` as ${status.athleteName}` : ""}.</strong>
        {total > 0 && status.activityCounts && (
          <span data-testid="activity-counts">
            Found{" "}
            {Object.entries(status.activityCounts)
              .filter(([, n]) => n > 0)
              .map(([sport, n]) => `${n} ${sport}`)
              .join(" · ")}{" "}
            in the last 120 days.
          </span>
        )}
      </div>
      {total === 0 && status.activityCounts !== null && (
        <div className="banner banner--warn" role="status">
          <strong>intervals.icu has no activities yet.</strong>
          <span>Check that your watch is connected under Connections, then sync your watch. Or upload a FIT file instead:</span>
          <FitUpload compact />
        </div>
      )}
    </div>
  );
}

/** §2.5 step 8: optional "Setup test" event for tomorrow, then confirm on the watch and delete it. */
function TestWorkout() {
  const [phase, setPhase] = useState<"idle" | "sent" | "confirmed" | "missing" | "removed">("idle");
  const [date, setDate] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: api.testWorkout,
    onSuccess: (r) => {
      setDate(r.date);
      setPhase("sent");
    },
  });
  const remove = useMutation({ mutationFn: api.deleteTestWorkout });

  return (
    <div className="stack">
      <h3>Optional: send a test workout</h3>
      <p className="small">A 10-minute easy “Setup test” goes on your watch calendar for tomorrow, so you can check delivery works before your plan starts.</p>
      {phase === "idle" && (
        <div>
          <button type="button" className="btn btn--ghost" onClick={() => send.mutate()} disabled={send.isPending}>
            {send.isPending ? "Sending…" : "Send a test workout"}
          </button>
        </div>
      )}
      {(phase === "sent" || phase === "missing") && date && (
        <div className="banner banner--accent">
          <span>
            Sync your watch, then look for <strong>Setup test</strong> on {formatDayLong(date)}.
          </span>
          <div className="row">
            <button
              type="button"
              className="btn btn--small btn--dark"
              onClick={() => remove.mutate(undefined, { onSuccess: () => setPhase("confirmed") })}
              disabled={remove.isPending}
            >
              It's on my watch
            </button>
            {phase === "sent" && (
              <button type="button" className="btn btn--small btn--ghost" onClick={() => setPhase("missing")}>
                Not on my watch
              </button>
            )}
          </div>
        </div>
      )}
      {phase === "missing" && (
        <div className="card card--flat">
          <strong>Check these, then re-send:</strong>
          <ul className="bullets small">
            {TEST_WORKOUT_CHECKLIST.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="btn btn--small btn--dark" onClick={() => send.mutate()} disabled={send.isPending}>
              {send.isPending ? "Re-sending…" : "Re-send"}
            </button>
            <button
              type="button"
              className="btn btn--small btn--ghost"
              onClick={() => remove.mutate(undefined, { onSuccess: () => setPhase("removed") })}
              disabled={remove.isPending}
            >
              Remove test and continue
            </button>
          </div>
          <p className="tiny muted">Still missing? You can follow every workout step by step in Paceo instead.</p>
        </div>
      )}
      {phase === "confirmed" && (
        <div className="banner banner--ok" role="status">
          <strong>Delivery works.</strong>
          <span>The test workout has been removed from your calendar.</span>
        </div>
      )}
      {phase === "removed" && <p className="small muted">Test workout removed.</p>}
      <InlineError error={send.error ?? remove.error} />
    </div>
  );
}

function Troubleshooting() {
  return (
    <details className="disclosure">
      <summary>Runs on intervals.icu but missing in Paceo?</summary>
      <ul className="bullets small">
        <li>
          Activities that reached intervals.icu <strong>from Strava</strong> aren't available through its API. Connect your watch brand directly in
          intervals.icu, or upload FIT files.
        </li>
        <li>
          If Garmin activities stop arriving while others still do, Garmin may be withholding data from the API. Upload FIT files instead; your workouts
          still go to the watch through intervals.icu.
        </li>
        <li>No new runs for 14 days? Check the watch connection in intervals.icu, then sync your watch.</li>
      </ul>
    </details>
  );
}
