import { useMutation } from "@tanstack/react-query";
import type { HealthScreenResponse } from "@paceo/contracts";
import { api } from "../../api/client";
import { YesNo } from "../../components/Form";
import { InlineError } from "../../components/States";
import { EPARMED_URL, HEALTH_QUESTIONS, PARQ_URL, SCOPE_QUESTIONS } from "../content";
import { screeningRequest, type HealthDraft } from "../draft";
import { formatDate } from "../../lib/dates";

export interface HealthStepProps {
  health: HealthDraft;
  screening: HealthScreenResponse | null;
  onHealth: (h: HealthDraft) => void;
  onScreening: (s: HealthScreenResponse | null) => void;
  error?: string | undefined;
}

/** §2.4 pre-participation screen with every outcome: ok, see_doctor, out_of_scope, cleared, cleared_conservative. */
export function HealthStep({ health, screening, onHealth, onScreening, error }: HealthStepProps) {
  const submit = useMutation({ mutationFn: api.healthScreen, onSuccess: (s) => onScreening(s) });
  const answered = [...health.answers, health.pregnantOrPostpartum, health.recentSeriousInjuryOrSurgery].every((a) => a !== null);

  const change = (h: HealthDraft) => {
    onHealth({ ...h, clearanceConfirmed: false });
    onScreening(null);
  };

  return (
    <div className="stack stack--loose">
      <p className="muted">
        A short screen on the same topics as the PAR-Q+. It isn't the official form. If you answer yes to anything, Paceo points you to the full
        version before you start.
      </p>
      <div className="card card--flat" style={{ gap: 0 }}>
        {HEALTH_QUESTIONS.map((q, i) => (
          <YesNo
            key={i}
            name={`hq${i}`}
            question={`${i + 1}. ${q}`}
            value={health.answers[i] ?? null}
            onChange={(v) => change({ ...health, answers: health.answers.map((a, j) => (j === i ? v : a)) })}
          />
        ))}
      </div>
      <div className="card card--flat" style={{ gap: 0 }}>
        <YesNo name="hq-preg" question={SCOPE_QUESTIONS.pregnantOrPostpartum} value={health.pregnantOrPostpartum} onChange={(v) => change({ ...health, pregnantOrPostpartum: v })} />
        <YesNo
          name="hq-inj"
          question={SCOPE_QUESTIONS.recentSeriousInjuryOrSurgery}
          value={health.recentSeriousInjuryOrSurgery}
          onChange={(v) => change({ ...health, recentSeriousInjuryOrSurgery: v })}
        />
      </div>

      {!screening && (
        <button type="button" className="btn btn--dark btn--block" disabled={!answered || submit.isPending} onClick={() => submit.mutate(screeningRequest(health))}>
          {submit.isPending ? "Checking…" : "Check my answers"}
        </button>
      )}
      <InlineError error={submit.error} />
      {error && !screening && answered && <p className="hint">{error}</p>}

      {screening && (
        <Outcome
          screening={screening}
          confirmed={health.clearanceConfirmed}
          onConfirm={(v) => onHealth({ ...health, clearanceConfirmed: v })}
          pending={submit.isPending}
          onSubmitClearance={() => submit.mutate({ ...screeningRequest(health), clearanceConfirmed: true })}
        />
      )}
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="bullets small">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function Outcome({
  screening,
  confirmed,
  onConfirm,
  onSubmitClearance,
  pending,
}: {
  screening: HealthScreenResponse;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  onSubmitClearance: () => void;
  pending: boolean;
}) {
  switch (screening.outcome) {
    case "ok":
      return (
        <div className="banner banner--ok" role="status">
          <strong>You're good to go.</strong>
          <Notes notes={screening.notes} />
          <span className="tiny">Paceo will ask again in 12 months, or sooner if your health changes.</span>
        </div>
      );
    case "cleared":
      return (
        <div className="banner banner--ok" role="status">
          <strong>Clearance recorded ({formatDate(screening.screenedAt.slice(0, 10))}).</strong>
          <Notes notes={screening.notes} />
        </div>
      );
    case "cleared_conservative":
      return (
        <div className="banner banner--warn" role="status">
          <strong>Conservative mode is on.</strong>
          <span>Paceo will use beginner caps, no plyometrics and no heavy strength work, and will remind you of this on your plan.</span>
          <Notes notes={screening.notes} />
        </div>
      );
    case "see_doctor":
      return (
        <div className="stack">
          <div className="banner banner--block" role="alert">
            <strong>See a doctor or qualified exercise professional first.</strong>
            <span>Plan generation is paused until you confirm you've been cleared. These official tools help that conversation:</span>
            <ul className="bullets">
              <li>
                <a href={PARQ_URL} target="_blank" rel="noreferrer noopener">
                  The full PAR-Q+ form
                </a>
              </li>
              <li>
                <a href={EPARMED_URL} target="_blank" rel="noreferrer noopener">
                  ePARmed-X+ (online follow-up)
                </a>
              </li>
            </ul>
            <Notes notes={screening.notes} />
          </div>
          <Clearance
            label="A doctor or qualified exercise professional has cleared me to start running training."
            confirmed={confirmed}
            onConfirm={onConfirm}
            onSubmit={onSubmitClearance}
            pending={pending}
          />
        </div>
      );
    case "out_of_scope":
      return (
        <div className="stack">
          <div className="banner banner--block" role="alert">
            <strong>This is outside what Paceo can plan safely on its own.</strong>
            <span>
              Pregnancy, the first 12 months postpartum, and coming back from serious injury or surgery need guidance from a health professional.
            </span>
            <span>
              If a professional is guiding you, you can continue. Paceo will then use its most conservative settings: beginner caps, no plyometrics and
              no heavy strength work.
            </span>
            <Notes notes={screening.notes} />
          </div>
          <Clearance
            label="I'm following guidance from a health professional and understand Paceo will use its most conservative settings."
            confirmed={confirmed}
            onConfirm={onConfirm}
            onSubmit={onSubmitClearance}
            pending={pending}
          />
        </div>
      );
    default:
      return (
        <div className="banner" role="status">
          <strong>Screening result: {String(screening.outcome)}</strong>
          <Notes notes={screening.notes} />
        </div>
      );
  }
}

function Clearance({ label, confirmed, onConfirm, onSubmit, pending }: { label: string; confirmed: boolean; onConfirm: (v: boolean) => void; onSubmit: () => void; pending: boolean }) {
  return (
    <div className="card card--flat">
      <label className="checkbox">
        <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
        <span>{label}</span>
      </label>
      <button type="button" className="btn btn--dark" disabled={!confirmed || pending} onClick={onSubmit}>
        {pending ? "Saving…" : "Confirm clearance"}
      </button>
      <span className="tiny muted">Your confirmation is stored with today's date.</span>
    </div>
  );
}
