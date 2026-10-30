import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Feasibility, Plan, Weekday } from "@paceo/engine";
import { api } from "../api/client";
import { qk, useMe, useToday, useInvalidatePlanData } from "../api/hooks";
import { InlineError } from "../components/States";
import { applyAlternative, initialDraft, profileFromDraft, type ProfileDraft, type WizardDraft } from "./draft";
import { CrossTrainingFields, GoalFields, ProfileFields, ScheduleFields, StrengthFields } from "./fields";
import { HealthStep } from "./steps/HealthStep";
import { ConnectStep } from "./steps/ConnectStep";
import { LivePreviewStrip, PlanPreviewBody, ReviewStep, useServerPreview } from "./steps/PlanSteps";
import { STEP_IDS, STEP_TITLES, validateStep, type StepId } from "./validation";
import { clientPreview } from "../lib/planInput";
import { DaysPicker, ChoiceGroup } from "../components/Form";
import { WEEKDAY_LONG } from "../lib/dates";

const STORAGE_PREFIX = "paceo.onboarding.v1.";

function loadDraft(userId: string): WizardDraft | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + userId);
    if (!raw) return null;
    const d = JSON.parse(raw) as WizardDraft;
    return d && d.version === 1 ? d : null;
  } catch {
    return null;
  }
}

function saveDraft(userId: string, d: WizardDraft): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(d));
  } catch {
    /* storage unavailable: the wizard still works, it just won't resume */
  }
}

export function clearDraft(userId: string): void {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + userId);
  } catch {
    /* ignore */
  }
}

/** §2.3 onboarding: health → connect → profile → goal → schedule → strength → cross-training → feasibility → preview. */
export function OnboardingWizard() {
  const me = useMe();
  const userId = me.data?.user.id ?? "anon";
  const today = useToday();
  const nav = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidatePlanData();
  const [draft, setDraft] = useState<WizardDraft>(() => {
    const saved = loadDraft(userId);
    const fresh = initialDraft(me.data);
    if (!saved) return fresh;
    // Server truth wins for screening/connection; keep the in-progress answers.
    return {
      ...saved,
      screening: saved.screening ?? fresh.screening,
      connect: fresh.connect.connected ? fresh.connect : saved.connect,
    };
  });
  const [showErrors, setShowErrors] = useState(false);
  const [feasibilityStatus, setFeasibilityStatus] = useState<Feasibility["status"] | null>(null);

  useEffect(() => saveDraft(userId, draft), [userId, draft]);
  useEffect(() => {
    window.scrollTo?.({ top: 0 });
  }, [draft.step]);

  const stepId: StepId = STEP_IDS[Math.min(draft.step, STEP_IDS.length - 1)] ?? "health";
  const errors = validateStep(stepId, draft, { today, feasibilityStatus });
  const valid = Object.keys(errors).length === 0;
  const built = useMemo(() => profileFromDraft(draft.profile), [draft.profile]);
  const profile = built.ok ? built.profile : null;

  const setProfile = useCallback((patch: Partial<ProfileDraft>) => {
    setDraft((d) => ({ ...d, profile: { ...d.profile, ...patch }, appliedAlternative: "goalType" in patch || "raceDate" in patch || "distance" in patch || "goalTimeS" in patch ? null : d.appliedAlternative }));
  }, []);

  const go = (delta: number) => {
    setShowErrors(false);
    setDraft((d) => ({ ...d, step: Math.max(0, Math.min(STEP_IDS.length - 1, d.step + delta)) }));
  };

  const next = () => {
    if (!valid) {
      setShowErrors(true);
      return;
    }
    go(1);
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Your profile is incomplete. Go back and check each step.");
      await api.putProfile(profile);
      return api.planGenerate();
    },
    onSuccess: async (plan) => {
      qc.setQueryData(qk.plan, plan);
      clearDraft(userId);
      await invalidate();
      void nav("/", { replace: true });
    },
  });

  const shownErrors = showErrors ? errors : {};
  const sectionProps = { d: draft.profile, set: setProfile, errors: shownErrors, today };
  const conservative = draft.screening?.outcome === "cleared_conservative";

  let body: ReactNode = null;
  switch (stepId) {
    case "health":
      body = (
        <HealthStep
          health={draft.health}
          screening={draft.screening}
          onHealth={(health) => setDraft((d) => ({ ...d, health }))}
          onScreening={(screening) => setDraft((d) => ({ ...d, screening }))}
          error={errors.screening}
        />
      );
      break;
    case "connect":
      body = (
        <ConnectStep
          d={draft.profile}
          set={setProfile}
          connect={draft.connect}
          onConnect={(connect) => setDraft((d) => ({ ...d, connect }))}
          initialStatus={me.data?.connection ?? null}
          errors={shownErrors}
        />
      );
      break;
    case "profile":
      body = <ProfileFields {...sectionProps} />;
      break;
    case "goal":
      body = (
        <>
          <GoalFields {...sectionProps} />
          <LivePreviewStrip profile={profile} today={today} units={draft.profile.units} />
        </>
      );
      break;
    case "schedule":
      body = (
        <>
          <ScheduleFields {...sectionProps} />
          <LivePreviewStrip profile={profile} today={today} units={draft.profile.units} />
        </>
      );
      break;
    case "strength":
      body = <StrengthFields {...sectionProps} conservative={conservative} />;
      break;
    case "cross":
      body = <CrossTrainingFields {...sectionProps} />;
      break;
    case "review":
      body = (
        <>
          <ReviewStep
            profile={profile}
            today={today}
            selectedKind={draft.appliedAlternative}
            onStatus={setFeasibilityStatus}
            onPick={(a) => setDraft((d) => ({ ...d, profile: applyAlternative(d.profile, a), appliedAlternative: a.kind }))}
          />
          {shownErrors.feasibility && <p className="error-text">{shownErrors.feasibility}</p>}
        </>
      );
      break;
    case "preview":
      body = <PreviewStep draft={draft} setProfile={setProfile} today={today} />;
      break;
  }

  return (
    <main className="page page--bare">
      <header className="stack stack--tight">
        <div className="progress" aria-hidden="true">
          {STEP_IDS.map((s, i) => (
            <span key={s} className={i < draft.step ? "done" : i === draft.step ? "current" : undefined} />
          ))}
        </div>
        <span className="eyebrow">
          Step {draft.step + 1} of {STEP_IDS.length}
        </span>
        <h1>{STEP_TITLES[stepId]}</h1>
      </header>
      {conservative && stepId !== "health" && stepId !== "strength" && (
        <div className="banner banner--warn tiny">Conservative mode: beginner caps, no plyometrics, no heavy strength.</div>
      )}
      <section className="stack stack--loose" aria-label={STEP_TITLES[stepId]}>
        {body}
      </section>
      {showErrors && !valid && (
        <div className="banner banner--block" role="alert">
          <strong>Check this step</strong>
          <ul className="bullets small">
            {Object.values(errors).map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {stepId === "preview" && <InlineError error={create.error} />}
      <nav className="wizard-nav" aria-label="Wizard">
        <button type="button" className="btn btn--ghost" onClick={() => go(-1)} disabled={draft.step === 0}>
          Back
        </button>
        {stepId === "preview" ? (
          <button type="button" className="btn btn--primary" onClick={() => create.mutate()} disabled={create.isPending || !profile}>
            {create.isPending ? "Creating…" : "Create plan"}
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={next}>
            Next
          </button>
        )}
      </nav>
    </main>
  );
}

/** Live client-side preview with instant tweaks; the server's preview is shown as the authoritative check. */
function PreviewStep({ draft, setProfile, today }: { draft: WizardDraft; setProfile: (p: Partial<ProfileDraft>) => void; today: string }) {
  const built = useMemo(() => profileFromDraft(draft.profile), [draft.profile]);
  const profile = built.ok ? built.profile : null;
  const local = useMemo(() => (profile ? clientPreview(profile, today) : null), [profile, today]);
  const server = useServerPreview(profile);
  const d = draft.profile;

  if (!profile) {
    return (
      <div className="banner banner--block">
        <strong>Some answers are missing</strong>
        <ul className="bullets small">
          {!built.ok && built.issues.slice(0, 5).map((i) => <li key={i.path.join(".") + i.message}>{`${i.path.join(".")}: ${i.message}`}</li>)}
        </ul>
      </div>
    );
  }

  const serverFeas = server.data?.plan.feasibility.status;
  return (
    <div className="stack stack--loose">
      <div className="card card--flat">
        <span className="eyebrow">Tweak and watch it change</span>
        <DaysPicker
          legend="Run days"
          value={d.daysAvailable}
          onChange={(daysAvailable: Weekday[]) => {
            const patch: Partial<ProfileDraft> = { daysAvailable };
            if (!daysAvailable.includes(d.longRunDay) && daysAvailable.length) patch.longRunDay = daysAvailable[daysAvailable.length - 1] as Weekday;
            setProfile(patch);
          }}
        />
        <ChoiceGroup legend="Long-run day" value={d.longRunDay} onChange={(longRunDay) => setProfile({ longRunDay })} options={d.daysAvailable.map((w) => ({ value: w, label: WEEKDAY_LONG[w] }))} />
      </div>
      {local && local.ok ? (
        <PlanPreviewBody plan={local.preview.plan} paces={local.preview.paces as unknown as Record<string, unknown>} units={d.units} today={today} />
      ) : server.data ? (
        <PlanPreviewBody plan={server.data.plan as unknown as Plan} paces={server.data.paces} units={d.units} today={today} />
      ) : (
        <p className="muted">{local && !local.ok ? local.reason : "Building your preview…"}</p>
      )}
      <div className="banner" role="status">
        {server.isPending && <span className="small">Confirming with the server…</span>}
        {server.isError && <span className="small">Server preview unavailable right now. The plan is checked again when you create it.</span>}
        {server.data && (
          <span className="small">
            Server check: <strong>{serverFeas}</strong>
            {local && local.ok && local.preview.plan.weeks.length !== server.data.plan.weeks.length
              ? `. The server plan has ${server.data.plan.weeks.length} weeks; it wins when they differ.`
              : ". Matches this preview."}
          </span>
        )}
      </div>
    </div>
  );
}
