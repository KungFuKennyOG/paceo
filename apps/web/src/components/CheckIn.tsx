import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import type { CheckInResponse, SkipWorkoutRequest, WorkoutItem } from "@paceo/contracts";
import { api } from "../api/client";
import { useInvalidatePlanData } from "../api/hooks";
import type { ViewWorkout } from "../lib/workout";
import { ChoiceGroup, NumberField, Scale, rpeWords } from "./Form";
import { InlineError } from "./States";

/** Plan changes and advice returned by any check-in (§8). */
export function CheckInResult({ result }: { result: CheckInResponse }) {
  const nothing = result.planChanges.length === 0 && result.advice.length === 0;
  return (
    <div className="stack" role="status" data-testid="checkin-result">
      {result.planChanges.length > 0 && (
        <div className="banner banner--accent">
          <strong>Plan changes</strong>
          <ul>
            {result.planChanges.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {result.advice.length > 0 && (
        <div className="banner banner--warn">
          <strong>Advice</strong>
          <ul>
            {result.advice.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {nothing && (
        <div className="banner banner--ok">
          <strong>Logged.</strong>
          <span>No changes to your plan.</span>
        </div>
      )}
    </div>
  );
}

const SKIP_REASONS: { value: SkipWorkoutRequest["reason"]; label: string }[] = [
  { value: "busy", label: "Busy" },
  { value: "tired", label: "Tired" },
  { value: "sick", label: "Sick" },
  { value: "injured", label: "Sore / injured" },
  { value: "travel", label: "Travel" },
  { value: "other", label: "Other" },
];

/** Done (session RPE) or skip (with reason) for one workout. */
export function QuickCheckIn({ item, w }: { item: WorkoutItem; w: ViewWorkout }) {
  const invalidate = useInvalidatePlanData();
  const done = item.status === "completed" || item.status === "partial";
  const [mode, setMode] = useState<"idle" | "done" | "skip">("idle");
  const [rpe, setRpe] = useState<number>(Math.round(w.planned?.expectedSrpe ?? 5));
  const [minutes, setMinutes] = useState<number | null>(
    item.matchedActivity?.movingS ? Math.round(item.matchedActivity.movingS / 60) : w.planned?.minutes ? Math.round(w.planned.minutes) : null,
  );
  const [reason, setReason] = useState<SkipWorkoutRequest["reason"] | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<CheckInResponse | null>(null);

  const rpeMut = useMutation({
    mutationFn: () =>
      api.checkIn({
        type: "session_rpe",
        date: item.date,
        workoutId: item.id,
        ...(item.matchedActivity ? { activityId: item.matchedActivity.id } : {}),
        rpe,
        minutes: minutes ?? 0,
      }),
    onSuccess: (r) => {
      setResult(r);
      setMode("idle");
      void invalidate();
    },
  });
  const skipMut = useMutation({
    mutationFn: () => api.skipWorkout(item.id, note.trim() ? { reason: reason ?? "other", note: note.trim() } : { reason: reason ?? "other" }),
    onSuccess: (r) => {
      setResult(r);
      setMode("idle");
      void invalidate();
    },
  });

  if (result) {
    return (
      <div className="stack">
        <CheckInResult result={result} />
        {reason === "sick" && (
          <Link className="small" to="/checkins?type=illness">
            Log illness details
          </Link>
        )}
        {reason === "injured" && (
          <Link className="small" to="/checkins?type=pain">
            Log pain details
          </Link>
        )}
      </div>
    );
  }

  if (item.status === "skipped" || item.status === "missed") {
    return <p className="small muted">{item.status === "skipped" ? "You skipped this one." : "Marked as missed."}</p>;
  }

  return (
    <div className="stack" data-testid="quick-checkin">
      {mode === "idle" && (
        <div className="row">
          <button type="button" className="btn btn--dark" onClick={() => setMode("done")}>
            {done ? "How did it feel?" : "Done"}
          </button>
          {!done && (
            <button type="button" className="btn btn--ghost" onClick={() => setMode("skip")}>
              Skip
            </button>
          )}
        </div>
      )}
      {mode === "done" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            rpeMut.mutate();
          }}
        >
          <Scale label="How hard was the whole session?" value={rpe} onChange={setRpe} describe={rpeWords} />
          <NumberField label="Minutes" value={minutes} onChange={setMinutes} suffix="min" digits={0} inputMode="numeric" />
          <InlineError error={rpeMut.error} />
          <div className="row">
            <button type="submit" className="btn btn--primary" disabled={rpeMut.isPending || minutes === null}>
              {rpeMut.isPending ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setMode("idle")}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === "skip" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason) skipMut.mutate();
          }}
        >
          <ChoiceGroup legend="Why are you skipping?" value={reason} onChange={setReason} options={SKIP_REASONS} />
          <div className="field">
            <label htmlFor={`note-${item.id}`}>Note (optional)</label>
            <textarea id={`note-${item.id}`} className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <InlineError error={skipMut.error} />
          <div className="row">
            <button type="submit" className="btn btn--primary" disabled={!reason || skipMut.isPending}>
              {skipMut.isPending ? "Saving…" : "Skip workout"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setMode("idle")}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
