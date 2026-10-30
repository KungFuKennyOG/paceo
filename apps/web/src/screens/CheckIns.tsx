import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import type { CheckInRequest, CheckInResponse } from "@paceo/contracts";
import { api } from "../api/client";
import { useActivities, useInvalidatePlanData, useProfile, useToday, useUnits } from "../api/hooks";
import { CheckInResult } from "../components/CheckIn";
import { ChoiceGroup, Field, NumberField, Scale, YesNo, painWords, rpeWords } from "../components/Form";
import { ActivityLine } from "../components/WorkoutBits";
import { ErrorState, InlineError, Skeleton } from "../components/States";
import { addDays } from "../lib/dates";
import { CROSS_ACTIVITIES } from "../onboarding/content";

type Tab = "illness" | "pain" | "cross_training" | "session_rpe";
const TABS: { value: Tab; label: string }[] = [
  { value: "illness", label: "Illness" },
  { value: "pain", label: "Pain" },
  { value: "cross_training", label: "Cross-training" },
  { value: "session_rpe", label: "Run effort" },
];

function useCheckIn() {
  const invalidate = useInvalidatePlanData();
  const [result, setResult] = useState<CheckInResponse | null>(null);
  const m = useMutation({
    mutationFn: (body: CheckInRequest) => api.checkIn(body),
    onSuccess: (r) => {
      setResult(r);
      void invalidate();
    },
  });
  return { m, result, reset: () => setResult(null) };
}

function DateField({ value, onChange, today }: { value: string; onChange: (v: string) => void; today: string }) {
  return (
    <Field label="Date" htmlFor="ci-date">
      <input id="ci-date" className="input" type="date" max={today} min={addDays(today, -14)} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function Submit({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button type="submit" className="btn btn--primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export function IllnessForm({ today }: { today: string }) {
  const { m, result, reset } = useCheckIn();
  const [date, setDate] = useState(today);
  const [fever, setFever] = useState<boolean | null>(null);
  const [where, setWhere] = useState<"above" | "below" | null>(null);
  const [note, setNote] = useState("");
  if (result) return <Done result={result} reset={reset} />;
  return (
    <form
      className="stack stack--loose"
      onSubmit={(e) => {
        e.preventDefault();
        if (fever === null || where === null) return;
        m.mutate({ type: "illness", date, fever, aboveNeckOnly: where === "above", ...(note.trim() ? { note: note.trim() } : {}) });
      }}
    >
      <p className="small muted">Paceo adapts your plan; it can't diagnose anything. Fever or whole-body symptoms mean no running.</p>
      <DateField value={date} onChange={setDate} today={today} />
      <YesNo name="fever" question="Do you have a fever?" value={fever} onChange={setFever} />
      <ChoiceGroup
        legend="Where are your symptoms?"
        value={where}
        onChange={setWhere}
        options={[
          { value: "above", label: "Above the neck only" },
          { value: "below", label: "Below the neck or whole-body" },
        ]}
        hint={where === "above" ? "Runny nose, sneezing, mild sore throat." : where === "below" ? "Chest, aches, stomach, fatigue, swollen glands." : undefined}
      />
      <Field label="Note (optional)" htmlFor="ill-note">
        <textarea id="ill-note" className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <InlineError error={m.error} />
      <Submit pending={m.isPending} label="Log illness" />
      {(fever === null || where === null) && <span className="hint">Answer both questions to log.</span>}
    </form>
  );
}

const PAIN_SPOTS = ["Achilles", "Calf", "Shin", "Knee", "Hamstring", "Hip", "Foot", "Lower back", "Other"];

export function PainForm({ today }: { today: string }) {
  const { m, result, reset } = useCheckIn();
  const [date, setDate] = useState(today);
  const [spot, setSpot] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [during, setDuring] = useState(2);
  const [morningKnown, setMorningKnown] = useState(false);
  const [morning, setMorning] = useState(0);
  if (result) return <Done result={result} reset={reset} />;
  const location = spot === "Other" ? other.trim() : spot ?? "";
  return (
    <form
      className="stack stack--loose"
      onSubmit={(e) => {
        e.preventDefault();
        if (!location) return;
        m.mutate({ type: "pain", date, location: location.slice(0, 60), duringRun: during, nextMorning: morningKnown ? morning : null });
      }}
    >
      <p className="small muted">Pain up to 3/10 that settles by the next morning is usually fine. Paceo eases the plan when it's higher or lingers.</p>
      <div className="banner banner--block small">
        Sharp pain in one spot on a bone, or pain that changes how you run: stop running and see a doctor or physio.
      </div>
      <DateField value={date} onChange={setDate} today={today} />
      <ChoiceGroup legend="Where?" value={spot} onChange={setSpot} options={PAIN_SPOTS.map((p) => ({ value: p, label: p }))} />
      {spot === "Other" && (
        <Field label="Describe the spot" htmlFor="pain-other">
          <input id="pain-other" className="input" maxLength={60} value={other} onChange={(e) => setOther(e.target.value)} />
        </Field>
      )}
      <Scale label="Pain during or right after the run (0–10)" value={during} onChange={setDuring} describe={painWords} />
      <label className="checkbox">
        <input type="checkbox" checked={morningKnown} onChange={(e) => setMorningKnown(e.target.checked)} />
        <span>I can rate it the next morning</span>
      </label>
      {morningKnown ? (
        <Scale label="Pain the next morning (0–10)" value={morning} onChange={setMorning} describe={painWords} />
      ) : (
        <p className="hint">No problem. Log again tomorrow morning; Paceo can remind you.</p>
      )}
      <InlineError error={m.error} />
      <Submit pending={m.isPending} label="Log pain" />
    </form>
  );
}

export function CrossTrainingForm({ today }: { today: string }) {
  const profile = useProfile();
  const { m, result, reset } = useCheckIn();
  const first = profile?.crossTraining[0];
  const [date, setDate] = useState(today);
  const [activity, setActivity] = useState(first?.activity ?? "cycling");
  const [minutes, setMinutes] = useState<number | null>(first?.typicalMinutes ?? 45);
  const [rpe, setRpe] = useState(first?.typicalSrpe ?? 5);
  if (result) return <Done result={result} reset={reset} />;
  const options = [...CROSS_ACTIVITIES];
  for (const c of profile?.crossTraining ?? []) if (!options.some((o) => o.value === c.activity)) options.push({ value: c.activity, label: c.activity });
  return (
    <form
      className="stack stack--loose"
      onSubmit={(e) => {
        e.preventDefault();
        if (!minutes || minutes < 1) return;
        m.mutate({ type: "cross_training", date, activity, minutes: Math.round(minutes), rpe });
      }}
    >
      <p className="small muted">Counts toward your training load (minutes × effort), never toward running km.</p>
      <DateField value={date} onChange={setDate} today={today} />
      <Field label="Activity" htmlFor="xt-act">
        <select id="xt-act" className="input" value={activity} onChange={(e) => setActivity(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <NumberField label="Duration" value={minutes} onChange={setMinutes} suffix="min" digits={0} inputMode="numeric" />
      <Scale label="How hard (session RPE)" value={rpe} onChange={setRpe} describe={rpeWords} />
      <InlineError error={m.error} />
      <Submit pending={m.isPending} label="Log session" />
    </form>
  );
}

export function SessionRpeForm({ today }: { today: string }) {
  const { m, result, reset } = useCheckIn();
  const [date, setDate] = useState(today);
  const [minutes, setMinutes] = useState<number | null>(45);
  const [rpe, setRpe] = useState(4);
  if (result) return <Done result={result} reset={reset} />;
  return (
    <form
      className="stack stack--loose"
      onSubmit={(e) => {
        e.preventDefault();
        if (minutes === null) return;
        m.mutate({ type: "session_rpe", date, rpe, minutes: Math.round(minutes) });
      }}
    >
      <p className="small muted">For a run that isn't on your plan. Planned runs have Done on their card.</p>
      <DateField value={date} onChange={setDate} today={today} />
      <NumberField label="Duration" value={minutes} onChange={setMinutes} suffix="min" digits={0} inputMode="numeric" />
      <Scale label="How hard was the whole session?" value={rpe} onChange={setRpe} describe={rpeWords} />
      <InlineError error={m.error} />
      <Submit pending={m.isPending} label="Log run" />
    </form>
  );
}

function Done({ result, reset }: { result: CheckInResponse; reset: () => void }) {
  return (
    <div className="stack">
      <CheckInResult result={result} />
      <div>
        <button type="button" className="btn btn--ghost btn--small" onClick={reset}>
          Log another
        </button>
      </div>
    </div>
  );
}

export function CheckInsScreen() {
  const today = useToday();
  const units = useUnits();
  const [params, setParams] = useSearchParams();
  const raw = params.get("type");
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "illness";
  const recent = useActivities(addDays(today, -13), today);

  return (
    <main className="page">
      <header className="page-head">
        <div className="stack stack--tight">
          <span className="eyebrow">Check in</span>
          <h1>Log</h1>
        </div>
      </header>
      <ChoiceGroup legend={<span className="visually-hidden">What to log</span>} value={tab} onChange={(t) => setParams({ type: t }, { replace: true })} options={TABS} />
      <section className="card" key={tab}>
        {tab === "illness" && <IllnessForm today={today} />}
        {tab === "pain" && <PainForm today={today} />}
        {tab === "cross_training" && <CrossTrainingForm today={today} />}
        {tab === "session_rpe" && <SessionRpeForm today={today} />}
      </section>

      <section className="stack">
        <h2 className="section-title">Recent activities</h2>
        {recent.isPending && <Skeleton height={120} />}
        {recent.isError && <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />}
        {recent.isSuccess && recent.data.items.length === 0 && <p className="small muted">No activities in the last 2 weeks.</p>}
        {recent.isSuccess && recent.data.items.length > 0 && (
          <div className="card" style={{ gap: 14 }}>
            {[...recent.data.items].reverse().map((a) => (
              <div key={a.id} className="row row--nowrap" style={{ alignItems: "flex-start" }}>
                <span className="small muted" style={{ width: 56, flex: "none" }}>
                  {a.localDate.slice(5)}
                </span>
                <div className="grow">
                  <ActivityLine activity={a} units={units} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
