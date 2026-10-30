import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionStatus, Profile } from "@paceo/contracts";
import type { Alternative, Feasibility, Plan } from "@paceo/engine";
import { api, errorMessage, isMockMode } from "../api/client";
import { qk, setMeProfile, useConnection, useInvalidatePlanData, useMe, usePlan, useToday, useUnits } from "../api/hooks";
import { ChoiceGroup, Field } from "../components/Form";
import { FeasibilityPanel } from "../components/Feasibility";
import { FitUpload } from "../components/FitUpload";
import { Stat } from "../components/PlanViews";
import { ErrorState, InlineError, Skeleton } from "../components/States";
import { formatDate, timeAgo } from "../lib/dates";
import { clientFeasibility } from "../lib/planInput";
import { formatKm, formatPace } from "../lib/units";
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushAvailability } from "../lib/pwa";
import { connectErrorMessage } from "../onboarding/steps/ConnectStep";
import { BRAND_GUIDES } from "../onboarding/content";
import { applyAlternative, draftFromProfile, profileFromDraft, type ProfileDraft } from "../onboarding/draft";
import { CrossTrainingFields, GoalFields, ProfileFields, ScheduleFields, StrengthFields } from "../onboarding/fields";
import { validateStep, type StepId } from "../onboarding/validation";

export function SettingsScreen() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <main className="page">
      <header className="page-head">
        <div className="stack stack--tight">
          <span className="eyebrow">{me.data.user.displayName}</span>
          <h1>Settings</h1>
        </div>
      </header>
      {me.data.profile && <ProfileSection profile={me.data.profile} />}
      {me.data.profile && <UnitsSection profile={me.data.profile} />}
      <ConnectionSection />
      <NotificationsSection />
      {me.data.user.isAdmin && <InviteSection />}
      <AccountSection email={me.data.user.email} />
    </main>
  );
}

// ── profile edit → feasibility re-check → confirm → replan (§2.3 re-onboarding) ──────────────────
const EDIT_SECTIONS: { id: StepId; label: string }[] = [
  { id: "profile", label: "Running" },
  { id: "goal", label: "Goal" },
  { id: "schedule", label: "Week" },
  { id: "strength", label: "Strength" },
  { id: "cross", label: "Cross-training" },
];

function ProfileSection({ profile }: { profile: Profile }) {
  const [editing, setEditing] = useState(false);
  const units = profile.units;
  const goal =
    profile.goal.type === "race"
      ? `${{ "5k": "5K", "10k": "10K", half: "Half marathon", marathon: "Marathon" }[profile.goal.distance]} on ${formatDate(profile.goal.raceDate)}`
      : "General fitness";
  return (
    <section className="card">
      <div className="row row--between">
        <h2>Profile</h2>
        {!editing && (
          <button type="button" className="btn btn--small btn--ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <ProfileEditor profile={profile} onClose={() => setEditing(false)} />
      ) : (
        <dl className="kv">
          <dt>Goal</dt>
          <dd>{goal}</dd>
          <dt>Level</dt>
          <dd style={{ textTransform: "capitalize" }}>{profile.experienceLevel}</dd>
          <dt>Weekly volume</dt>
          <dd>{formatKm(profile.currentWeeklyKm, units)}</dd>
          <dt>Run days</dt>
          <dd style={{ textTransform: "capitalize" }}>
            {profile.daysAvailable.join(", ")} · long run {profile.longRunDay}
          </dd>
          <dt>Strength</dt>
          <dd>{profile.strength.mode === "off" ? "Off" : `${profile.strength.mode.replace("_", " ")} · ${profile.strength.sessionsPerWeek}/wk`}</dd>
          <dt>Watch</dt>
          <dd>{BRAND_GUIDES[profile.watchBrand]?.label ?? profile.watchBrand}</dd>
        </dl>
      )}
    </section>
  );
}

function ProfileEditor({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const today = useToday();
  const qc = useQueryClient();
  const invalidate = useInvalidatePlanData();
  const [d, setD] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [section, setSection] = useState<StepId>("goal");
  const [reviewing, setReviewing] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const set = (patch: Partial<ProfileDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setReviewing(false);
  };

  const wizardLike = { version: 1 as const, step: 0, profile: d, health: { answers: [], pregnantOrPostpartum: false, recentSeriousInjuryOrSurgery: false, clearanceConfirmed: false }, screening: null, connect: { connected: true, skipped: false }, appliedAlternative: applied };
  const allErrors = Object.assign({}, ...EDIT_SECTIONS.map((s) => validateStep(s.id, wizardLike, { today }))) as Record<string, string>;
  const errorCount = Object.keys(allErrors).length;
  const built = useMemo(() => profileFromDraft(d), [d]);
  const next = built.ok ? built.profile : null;

  const local = useMemo(() => (next && reviewing ? clientFeasibility(next, today) : null), [next, reviewing, today]);
  const server = useQuery({
    queryKey: ["planPreview", next ? JSON.stringify(next) : "none"],
    queryFn: () => api.planPreview(next as Profile),
    enabled: reviewing && next !== null,
    retry: false,
  });
  const serverFeas = server.data ? (server.data.plan.feasibility as unknown as Feasibility) : null;
  const feas = serverFeas ?? local;
  const serverPlan = server.data ? (server.data.plan as unknown as Plan) : null;

  const save = useMutation({
    mutationFn: async () => {
      if (!next) throw new Error("Fix the highlighted fields first.");
      const saved = await api.putProfile(next);
      setMeProfile(qc, saved);
      return api.planGenerate();
    },
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  const props = { d, set, errors: allErrors, today };
  return (
    <div className="stack stack--loose">
      <ChoiceGroup legend="Section" value={section} onChange={setSection} options={EDIT_SECTIONS.map((s) => ({ value: s.id, label: s.label }))} />
      {section === "profile" && <ProfileFields {...props} />}
      {section === "goal" && <GoalFields {...props} />}
      {section === "schedule" && <ScheduleFields {...props} />}
      {section === "strength" && <StrengthFields {...props} />}
      {section === "cross" && <CrossTrainingFields {...props} />}

      {errorCount > 0 && (
        <div className="banner banner--block">
          <strong>Fix these first</strong>
          <ul className="bullets small">
            {Object.values(allErrors).map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {!reviewing ? (
        <div className="row">
          <button type="button" className="btn btn--dark" disabled={errorCount > 0 || !next} onClick={() => setReviewing(true)}>
            Review changes
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="stack">
          <div className="banner banner--accent">
            <strong>Saving replans from today.</strong>
            <span>Past workouts stay as they are. Upcoming workouts are rebuilt and re-sent to your watch.</span>
          </div>
          {server.isPending && <Skeleton height={80} />}
          {feas && (
            <FeasibilityPanel
              feasibility={feas}
              source={serverFeas ? "server" : "client"}
              selectedKind={applied}
              onPick={(a: Alternative) => {
                setD((x) => applyAlternative(x, a));
                setApplied(a.kind);
              }}
            />
          )}
          {serverPlan && serverPlan.weeks.length > 0 && (
            <div className="stats">
              <Stat label="Weeks" value={String(serverPlan.weeks.length)} />
              <Stat label="Peak week" value={formatKm(serverPlan.summary.peakWeekKm, d.units, 0)} />
              <Stat label="Peak long run" value={formatKm(serverPlan.summary.peakLongRunKm, d.units)} />
            </div>
          )}
          {server.isError && <p className="tiny muted">Server preview unavailable: {errorMessage(server.error)}</p>}
          <InlineError error={save.error} />
          <div className="row">
            <button type="button" className="btn btn--primary" disabled={save.isPending || feas?.status === "block"} onClick={() => save.mutate()}>
              {save.isPending ? "Replanning…" : "Save and replan"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setReviewing(false)}>
              Keep editing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function UnitsSection({ profile }: { profile: Profile }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (units: Profile["units"]) => api.putProfile({ ...profile, units }),
    onSuccess: (p) => setMeProfile(qc, p),
  });
  return (
    <section className="card">
      <h2>Units</h2>
      <ChoiceGroup
        legend={<span className="visually-hidden">Units</span>}
        value={save.isPending && save.variables ? save.variables : profile.units}
        onChange={(u) => save.mutate(u)}
        options={[
          { value: "metric", label: "Metric · km, min/km" },
          { value: "imperial", label: "Imperial · mi, min/mi" },
        ]}
        hint="Display only. Paceo stores everything in metric and your watch keeps its own setting."
      />
      <InlineError error={save.error} />
    </section>
  );
}

// ── connection: status, sync now, disconnect, reconnect, FIT upload (§2.5, §11.3) ───────────────
const CONN_BADGE: Record<ConnectionStatus["status"], { label: string; cls: string }> = {
  ok: { label: "Connected", cls: "badge--ok" },
  invalid: { label: "Key not accepted", cls: "badge--block" },
  rate_limited: { label: "Busy, retrying", cls: "badge--warn" },
  never_synced: { label: "Waiting for first sync", cls: "badge--warn" },
  disconnected: { label: "Not connected", cls: "" },
};

function ConnectionSection() {
  const q = useConnection();
  const qc = useQueryClient();
  const plan = usePlan();
  const units = useUnits();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [key, setKey] = useState("");
  const sync = useMutation({ mutationFn: api.sync, onSuccess: () => void qc.invalidateQueries({ queryKey: qk.connection }) });
  const disconnect = useMutation({
    mutationFn: api.disconnectIntervals,
    onSuccess: () => {
      setConfirmDisconnect(false);
      void qc.invalidateQueries({ queryKey: qk.connection });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
  const connect = useMutation({
    mutationFn: () => api.connectIntervals({ apiKey: key.trim() }),
    onSuccess: (s) => {
      setKey("");
      qc.setQueryData(qk.connection, s);
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
  const tPace = (() => {
    const t = (plan.data?.paces as Record<string, unknown> | undefined)?.T;
    if (t && typeof t === "object" && "fast" in t && typeof (t as { fast: unknown }).fast === "number") return (t as { fast: number }).fast;
    return null;
  })();

  return (
    <section className="card">
      <h2>Watch connection</h2>
      {q.isPending && <Skeleton height={80} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <div className="stack">
          <div className="row row--between">
            <span className="small">intervals.icu{q.data.athleteName ? ` · ${q.data.athleteName}` : ""}</span>
            <span className={`badge ${CONN_BADGE[q.data.status]?.cls ?? ""}`}>{CONN_BADGE[q.data.status]?.label ?? q.data.status}</span>
          </div>
          {q.data.message && <p className="small">{q.data.message}</p>}
          {q.data.connected && (
            <dl className="kv small">
              <dt>Last sync</dt>
              <dd>{q.data.lastSyncAt ? timeAgo(q.data.lastSyncAt) : "Not yet"}</dd>
              {q.data.activityCounts && Object.keys(q.data.activityCounts).length > 0 && (
                <>
                  <dt>Activities</dt>
                  <dd>
                    {Object.entries(q.data.activityCounts)
                      .map(([k, v]) => `${v} ${k}`)
                      .join(" · ")}
                  </dd>
                </>
              )}
              {tPace !== null && (
                <>
                  <dt>Threshold pace</dt>
                  <dd>{formatPace(tPace, units)} (set this in intervals.icu)</dd>
                </>
              )}
            </dl>
          )}
          {q.data.connected ? (
            <div className="row">
              <button type="button" className="btn btn--small btn--dark" onClick={() => sync.mutate()} disabled={sync.isPending}>
                {sync.isPending ? "Syncing…" : "Sync now"}
              </button>
              {!confirmDisconnect ? (
                <button type="button" className="btn btn--small btn--danger" onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </button>
              ) : (
                <span className="row">
                  <button type="button" className="btn btn--small btn--danger" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                    {disconnect.isPending ? "Deleting key…" : "Delete key"}
                  </button>
                  <button type="button" className="btn btn--small btn--ghost" onClick={() => setConfirmDisconnect(false)}>
                    Cancel
                  </button>
                </span>
              )}
            </div>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim().length >= 10) connect.mutate();
              }}
            >
              <Field label="intervals.icu API key" htmlFor="set-key" hint="Settings → Developer Settings in intervals.icu.">
                <input id="set-key" className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
              </Field>
              {connect.isError && <p className="error-text">{connectErrorMessage(connect.error)}</p>}
              <div>
                <button type="submit" className="btn btn--small btn--dark" disabled={key.trim().length < 10 || connect.isPending}>
                  {connect.isPending ? "Checking…" : "Connect"}
                </button>
              </div>
            </form>
          )}
          {sync.isSuccess && <p className="small" role="status">Sync started. New activities show up in a minute or two.</p>}
          <InlineError error={sync.error ?? disconnect.error} />
          {confirmDisconnect && <p className="small">This deletes your API key from Paceo. Workouts stop going to your watch until you reconnect.</p>}
        </div>
      )}
      <hr className="divider" />
      <div className="stack stack--tight">
        <strong className="small">Upload a run</strong>
        <span className="small muted">Any watch: export the activity as a .fit file and upload it here.</span>
        <FitUpload />
      </div>
    </section>
  );
}

// ── notifications + install (§2.1, §11.2) ─────────────────────────────────────────────────────────
function NotificationsSection() {
  const [avail, setAvail] = useState(() => pushAvailability());
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void currentSubscription().then((s) => alive && setSubscribed(s !== null));
    return () => {
      alive = false;
    };
  }, []);

  const enable = () => {
    // Called directly from the tap: the permission prompt must come from a user gesture.
    setBusy(true);
    setError(null);
    enablePush()
      .then(() => setSubscribed(true))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        setBusy(false);
        setAvail(pushAvailability());
      });
  };
  const disable = () => {
    setBusy(true);
    disablePush()
      .then(() => setSubscribed(false))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2>Notifications</h2>
      <p className="small muted">Today's workout in the morning, plan changes, check-in prompts, and a nudge when a workout didn't reach your watch.</p>
      {avail.kind === "ios_needs_install" && <IosInstall />}
      {avail.kind === "unsupported" && <p className="small">{avail.reason}</p>}
      {avail.kind === "denied" && <p className="small">Notifications are blocked for Paceo. Allow them in your browser's site settings, then come back.</p>}
      {avail.kind === "ok" &&
        (subscribed ? (
          <div className="row row--between">
            <span className="badge badge--ok">On for this device</span>
            <button type="button" className="btn btn--small btn--ghost" onClick={disable} disabled={busy}>
              Turn off
            </button>
          </div>
        ) : (
          <div>
            <button type="button" className="btn btn--dark" onClick={enable} disabled={busy}>
              {busy ? "Setting up…" : "Enable notifications"}
            </button>
          </div>
        ))}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!isIos() && !isStandalone() && (
        <p className="tiny muted">Tip: install Paceo from your browser menu (“Install app” or “Add to Home screen”) for a full-screen app.</p>
      )}
    </section>
  );
}

function IosInstall() {
  return (
    <div className="banner banner--accent">
      <strong>Add Paceo to your Home Screen first</strong>
      <span className="small">On iPhone and iPad, notifications only work for web apps opened from the Home Screen (iOS 16.4 or later).</span>
      <ol className="bullets small">
        <li>Tap the Share button in Safari's toolbar.</li>
        <li>Choose “Add to Home Screen”, then “Add”.</li>
        <li>Open Paceo from the new icon and come back here.</li>
      </ol>
    </div>
  );
}

function InviteSection() {
  const create = useMutation({ mutationFn: api.createInvite });
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <h2>Invite a friend</h2>
      <p className="small muted">Paceo is invite-only. Each code works once.</p>
      {create.data && (
        <InviteCode code={create.data.code} expiresAt={create.data.expiresAt} copied={copied} setCopied={setCopied} />
      )}
      <InlineError error={create.error} />
      <div>
        <button type="button" className="btn btn--dark" onClick={() => { setCopied(false); create.mutate(); }} disabled={create.isPending}>
          {create.isPending ? "Creating…" : create.data ? "Create another" : "Create invite"}
        </button>
      </div>
    </section>
  );
}

function InviteCode({ code, expiresAt, copied, setCopied }: { code: string; expiresAt: string; copied: boolean; setCopied: (v: boolean) => void }) {
  return (
        <div className="banner banner--ok">
          <span className="hero-number" style={{ fontSize: "2rem" }} data-testid="invite-code">
            {code}
          </span>
          <span className="small">Expires {new Date(expiresAt).toLocaleString()}</span>
          <div>
            <button
              type="button"
              className="btn btn--small btn--ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy code"}
            </button>
          </div>
        </div>
  );
}

function AccountSection({ email }: { email: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      qc.clear();
      void nav("/login", { replace: true });
    },
  });
  return (
    <section className="card">
      <h2>Account</h2>
      <p className="small">{email}</p>
      <div>
        <button type="button" className="btn btn--ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {logout.isPending ? "Signing out…" : "Sign out"}
        </button>
      </div>
      {isMockMode() && <p className="tiny muted">Mock mode: data resets on reload.</p>}
    </section>
  );
}

