# Running training engine spec: evidence-labelled rules for any runner

This spec turns the research notes into rules for a Runna-style training app built as a **TypeScript pnpm monorepo**: a pure TS engine package, a Node + Fastify + Postgres API, and a React + Vite **PWA**. The app serves **a small closed group, designed for up to about 10 users**, and must work for any runner in it: a first-time 5K runner, a recreational marathoner who also cross-trains and lifts, or an experienced runner chasing a PR. No rule, default or threshold depends on one specific person. Everything that varies between runners (experience, volume, goal, days available, cross-training, strength preferences, watch, units) is a per-user input (§2.3), and the rules scale from those inputs.

Some rules rest on evidence, but most are coaching convention or designer defaults. The spec says which is which, so they can be tuned without guilt.

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **E** | Evidence: peer-reviewed. The study type is noted, e.g. RCT, meta-analysis, observational cohort (E-obs). |
| **C** | Convention: coaching texts (Daniels, Pfitzinger, Hansons, Higdon, NHS Couch to 5K) or documented product or platform behavior (Runna, TrainAsONE, TrainingPeaks, intervals.icu). |
| **D** | Designer default: an inference or engineering choice that does not come from the literature. Tune it. |

"D on E" or "D on C" marks a designer choice anchored to evidence or convention. "Policy" and "Platform" mark third-party terms and documented API behavior.

---

## 1. Summary: design decisions

1. **Multi-user from day one, but small (D).**
   - Every table is keyed by `user_id`, and all settings, tokens, plans and engine state are per user.
   - The engine is a pure function of `(user profile, user history)`.
   - There are no cross-user views by default. An optional friends feed is opt-in per user and limited to non-Strava data (§11).
2. **The stack is TypeScript end to end (D).** It's a pnpm monorepo:
   - `packages/engine`: a pure TS engine. The API and the web app share it, so plan previews run client-side during onboarding.
   - `apps/api`: Fastify + Postgres (Drizzle), with pg-boss jobs.
   - `apps/web`: a React + Vite PWA.
   Details in §2.6.
3. **The client is a PWA (D).** It is an installable React web app with a home-screen icon and web push (iOS 16.4+ for home-screen web apps). There is no native app in v1. As a result there is no phone GPS recording and no HealthKit or WorkoutKit (§2.1).
4. **The default data path has no Strava (D on Platform).**
   - **Activities:** watch → **intervals.icu** → app. Fallbacks are the Garmin Personal API (own key) and manual FIT upload.
   - **Planned workouts:** app → intervals.icu calendar events → vendor calendar → watch.
   - **In-run guidance:** the watch executes the structured workout.
   - **Garmin is the primary target.** COROS is supported but slightly less proven. Wahoo and Suunto are supported via intervals.icu. Polar and Apple Watch get no automatic workout delivery (§3.6).
   - **Strava is an optional fallback adapter only.** Without it there is no Strava developer subscription and no 7-day cache constraint on the canonical store.
5. **One fitness scalar per user: VDOT (C).** Every pace comes from the Daniels–Gilbert equations. M pace for a goal race is goal-time pace. Users without a race result go through a **cold-start** path (§4.2): a guided time trial, a conservative fallback estimate, or a **run/walk beginner path** with time- and RPE-based prescriptions before VDOT paces apply.
6. **Fitness evidence follows a hierarchy:** race > time trial > critical speed > HR–pace trend > HR-ratio estimate (C/D).
   - A race result raises VDOT immediately.
   - Training-derived increases need several qualifying runs, a VDOT gap and user acceptance.
   - Slowing down is easier to trigger than speeding up.
   - Predicting a longer race from a shorter one applies a **fade exponent** k (default 1.08–1.15, interpolated by level).
7. **Goal feasibility is checked at onboarding and replanning (D on C).** The checks cover minimum weeks, entry volume and longest run per distance, and an aggressive-goal flag when goal VDOT exceeds current VDOT by more than 1.5. The app always offers an alternative.
8. **The per-session spike cap is the hard progression validator (E-obs).** No run may exceed 110% of the longest non-race run in the prior 30 days. The weekly % cap is secondary.
   - Long runs are capped by **time and distance** together, by level and goal, because time caps bind for slower runners.
   - Quality-session counts scale with experience and days per week.
   - Cutback frequency scales with level, age and load.
9. **Phases follow the Daniels weeks-to-phase table, and the taper is carved from the end (C/E).** The taper is never shorter than 7 days. When time is short, compress the build, never the taper.
10. **Adaptation is rule-based and keeps the user in the loop (C/D).**
   - Missed runs are dropped, not crammed.
   - Breaks use the Daniels pace table and a 50%→75% ramp.
   - Illness uses the neck check plus the IOC exercise challenge.
   - Niggles use Silbernagel pain monitoring.
   - HRV is an optional soft modifier.
   - Each planned session carries a **rule trace** that renders a deterministic "why this workout" explanation.
11. **Strength and cross-training are configurable (D on E).**
    - **Strength mode:** off, running-focused (lower body + core) or full-body. Equipment, sessions per week and lifting experience are set per user. An external lifting program can be declared as locked load.
    - **Cross-training:** activities map through a table (§10.2). They never count toward running km and always count toward `total_load = sRPE × minutes`. Some of them count as hard days.
12. **Units are per user, metric or imperial (D).** Internal storage is SI only: m, s, s/km, kg, °C. Conversion and rounding happen at display time.

---

## 2. Platform, accounts, onboarding and setup

### 2.1 Client platform: PWA (D on Platform)

**What the PWA does in v1:**
- Plan calendar, today's workout, step-by-step workout view (a fallback for watches without a delivery path), and logging of sRPE, pain, illness and cross-training.
- Strength sessions with exercise cards (§9.3).
- Settings, the connect flow (§2.5) and push notifications (§11).

**Web push.** Push works on iOS/iPadOS **16.4 and later**, but only for a web app the user has **added to the Home Screen**. The manifest `display` must be `standalone` or `fullscreen`, and the permission request must come from a direct user gesture, such as tapping a button ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), Platform).
- It uses the standard Push API, Notifications API and Service Workers, delivered via APNs. No Apple Developer Program membership is needed. If the server allow-lists push endpoints, include `*.push.apple.com`.
- Android Chrome supports web push without installation.
- The onboarding step must detect a non-installed iOS browser session and show "Add to Home Screen" instructions before asking for push permission.

**PWA limits, stated as product constraints:**

| Limit | Consequence |
|---|---|
| No reliable background geolocation in a PWA | **The phone cannot record runs.** Phone-only users without a watch are out of scope for v1 (§11). |
| No HealthKit access | Apple Watch activities can't be read directly. Apple users must get activities into intervals.icu or use FIT export or Strava (§3.6). |
| No WorkoutKit | **No automatic workout delivery to Apple Watch.** Apple users follow workouts from the PWA, or via a third-party bridge (§3.6, unverified). |
| iOS push needs a home-screen install | Covered by the onboarding check above. |

**Future: native app (out of scope for v1, D).**
- Expo/React Native would add HealthKit reading, WorkoutKit scheduling (`CustomWorkout` + `WorkoutScheduler`, iOS 17 / watchOS 10+) and phone GPS recording.
- Distributing to iPhones via TestFlight requires a **paid Apple Developer Program membership**. Android builds can be sideloaded as an APK.
- Keep the neutral workout DSL (§3.8) sink-agnostic, so that a `WorkoutKitSink` and `HealthKitSource` can be added later without engine changes.
- A React Native app would reuse `packages/engine` unchanged (§2.6).

### 2.2 Multi-user model and schema (D)

- **Accounts:** simple auth in Fastify (e.g. `@fastify/session` or JWT with argon2-hashed passwords), or a magic link. There is no self-signup; the admin invites users.
- **Tenancy:** every table carries `user_id`, and every query is scoped by it. Enforce this at the repository layer, or with Postgres row-level security.
- **Per-user state:** profile, sources and sinks, credentials, plans and engine state (VDOT, k_user, HRmax, HRV baseline, CS) are all per user.
- **Scheduling:** sync jobs and plan regeneration run per user and staggered. One shared rate limiter applies per external platform, because all calls come from one server IP (§3.2).
- **No cross-user views by default.** The opt-in feed (§11) shows only fields the owner has chosen to share, and never Strava-sourced data.
- **External accounts are isolated.** Revoking one user's key or token affects only that user's data.

```
users(id, email, password_hash, created_at, invited_by)
user_profile(user_id, experience_level, months_running, units /*metric|imperial*/,
             birth_year?, sex?, hrmax?, hrmax_source /*measured|age_formula*/, hrrest?,
             injury_history_flag, injury_notes?, screening_status, screening_date,
             watch_brand, activity_source, workout_sink, timezone)
user_goal(user_id, goal_type /*race|general_fitness*/, distance_m?, race_date?, goal_time_s?,
          target_weekly_minutes?, created_at, feasibility_json)
user_schedule(user_id, days_available[], long_run_day, max_session_minutes_by_day json)
user_strength(user_id, mode /*off|running|full_body|external*/, equipment /*gym|dumbbells|bodyweight*/,
              sessions_per_week, lifting_experience /*none|novice|experienced*/, external_program_json?)
user_crosstraining(user_id, activity_type, days[], typical_minutes, typical_srpe, locked bool)
credentials(user_id, provider /*intervals_icu|garmin_personal|strava*/, secret_enc, kind /*api_key|oauth*/,
            athlete_ext_id, expires_at?, scope?, last_validated_at, status)
raw_files(user_id, source, source_id, object_key, sha256, received_at)
activities(id, user_id, source, source_id, origin_platform /*garmin|coros|...|strava*/, start_utc, sport,
           distance_m, moving_s, elapsed_s, device, is_race, temp_c, flags, strava_derived bool, purge_after?)
laps(activity_id, idx, start_idx, end_idx, distance_m, time_s, avg_hr, …)
samples(activity_id, t_s, dist_m, lat, lng, alt_m, speed_ms, hr, cad, power, temp)
planned_workouts(id, user_id, date, type, json_steps, status, rule_trace json, sink_state json /*ext ids, last push*/)
session_log(id, user_id, date, modality, minutes, srpe, run_km, plyo_contacts, pain_json, illness_json)
fitness_state(user_id, vdot, vdot_source, vdot_date, ewma, cs, k_user, hrv_baseline_json, updated_at)
consents(user_id, kind /*feed_share|llm_features*/, scope_json, granted_at, revoked_at?)
```

### 2.3 Onboarding and user profile (D unless labelled)

Onboarding is a short wizard: health screen (§2.4) → connect (§2.5) → profile → goal → schedule → strength/cross-training → feasibility review (§6.2) → plan preview. Where synced history exists, the app pre-fills inputs from it and shows the derived values for the user to confirm.

| Input | Req. | Type / allowed values | Validation | Default / derivation | Used by |
|---|---|---|---|---|---|
| Experience level | ✔ | beginner / novice / intermediate / advanced (definitions below) | — | Engine uses **min(self-report, derived level)** | Quality count, caps, cutbacks, feasibility |
| Months of consistent running | ✔ | integer | 0–600 | — | Level derivation |
| Current weekly volume | ✔ | km or minutes per week, last 4 weeks | 0–250 km; if history exists, warn when entry differs from computed by >25% | **Computed** when ≥4 weeks of history exist: median of the last 4 non-cutback weeks | V2/V3 start, feasibility |
| Longest run, last 30 days | ✔ | km or minutes, **non-race** | ≤ weekly volume; ≤ 45 km | Computed from history when available | V1 spike cap, L1, feasibility |
| Can run 20 min continuously? | ✔ if beginner | yes / no | — | — | Beginner path gate (§6.9) |
| Recent race or time trial | opt. | distance, time, date, conditions (temp, course) | 1,500 m ≤ distance ≤ 42,195 m; date ≤ 12 weeks old for full weight; implied VDOT 15–85 | none → cold start (§4.2) | VDOT |
| Days/week available | ✔ | set of weekdays | Race plans 3–7; general fitness 2–7. Beginners are capped at 4 run days in the first 4 weeks. | — | Templates, quality count |
| Long-run day | ✔ | weekday ∈ days_available | — | Sun | Scheduler |
| Max minutes per weekday | opt. | minutes | ≥ 20 | unlimited | Scheduler (S3) |
| Goal type | ✔ | race / general fitness (base building) | — | — | Plan mode |
| Race distance | if race | 5K / 10K / HM / M (custom distance 3–42.2 km maps to the nearest template) | — | — | Phase emphasis, caps |
| Race date | if race | date | ≥ minimum weeks (§6.2), else feasibility flow | — | Phases, taper |
| Goal time | opt. | duration | Implied VDOT within ±10 of current | none → paces from current VDOT | M pace, aggressive-goal flag |
| Target weekly time (general fitness) | opt. | minutes | 60–600 | current + 20%, capped by level ceiling | Open-ended plan |
| Units | ✔ | metric / imperial | — | From browser locale (US → imperial) | Display only |
| Age (birth year) | opt. | — | 16–90. Under 18: out of scope for v1. | none → no age-based rules | Cutback 2:1 at ≥40, HRmax fallback, screening note at ≥45 |
| Sex | opt. | — | — | none | **No v1 rule uses it.** Stored for future norms only. |
| HRmax | opt. | bpm, measured or estimated | 140–220 | Measured value preferred. Fallback Tanaka `208 − 0.7·age` (E, meta-analysis), flagged `age_formula`. | HR zones, HR fallback targets |
| HRrest | opt. | bpm | 30–100 | — | Uth sanity check only |
| Injury history flag | ✔ | none / past 12 months / current | "Current" → screening branch (§2.4) | — | Cutback 2:1, cautious caps |
| Cross-training activities | opt. | list of type, days, minutes, typical sRPE, locked? | sRPE 1–10 | none | Load model, scheduler |
| Strength preferences | ✔ | mode, equipment, sessions/week (0–3), lifting experience; or "I follow my own program" | — | running-focused, bodyweight, 2, none | Strength module |
| Watch brand | ✔ | Garmin / COROS / Suunto / Wahoo / Polar / Apple / Huawei / Amazfit / other / none | "none" → out of scope warning | — | Source/sink binding (§3.6) |
| Data source | ✔ | derived from brand (§3.6) | Validated by a test call (§2.5) | — | Adapters |

**Experience level derivation (D on C):**

| Level | Rule (all conditions) |
|---|---|
| Beginner | < 3 months consistent running **or** can't run 20 min continuously **or** weekly < 10 km |
| Novice | 3–12 months, weekly ≥ 10 km |
| Intermediate | 1–3 years, **or** > 3 years with weekly < 50 km |
| Advanced | > 3 years **and** weekly ≥ 50 km (or a completed race at the goal distance plus weekly ≥ 40 km) |

Rationale:
- Novice runners carry about 2.3× the injury incidence per 1,000 h of recreational runners: 17.8 vs 7.7 ([Videbæk 2015](https://pubmed.ncbi.nlm.nih.gov/25951917/), E meta-analysis). The engine is therefore conservative at the low end.
- Higdon's tiers (Novice 0 quality, Intermediate 1, Advanced 1–2) are the conventional anchor for the quality caps in §6.4 (C).

**Re-onboarding.** Profile edits trigger a feasibility re-check and replan from today. Every 12 months, and on any reported health change, the app re-asks the screening questions (§2.4).

### 2.4 Pre-participation health screen and scope (C/D)

The validated tool is the PAR-Q+. Its form **must be used in full, with no changes** ([PAR-Q+ 2025 form](https://southlake.ca/wp-content/uploads/2025/02/PARQPlus2025-Form-fillable.pdf), Policy). So the app does **not** embed a modified "PAR-Q+". It asks a short screen paraphrasing the same topics and links to the official PAR-Q+ and [ePARmed-X+](https://www.eparmedx.com) for anyone who answers yes.

**Screen: 7 yes/no questions (C, paraphrased topics):**
1. Has a doctor said you have a heart condition or high blood pressure?
2. Do you get chest pain at rest, in daily activity or during exercise?
3. Have you lost balance from dizziness, or lost consciousness, in the last 12 months?
4. Do you have another diagnosed chronic medical condition?
5. Do you take prescribed medication for a chronic condition?
6. Do you have a bone, joint or soft-tissue problem (current or in the last 12 months) that more activity could worsen?
7. Has a doctor said you should only exercise under medical supervision?

Plus two scope questions (D): "Are you pregnant or less than 12 months postpartum?" and "Are you returning from a serious injury or surgery in the last 6 months?"

| Outcome | Action |
|---|---|
| All no | Proceed. If age ≥45 and not used to vigorous exercise, show a "consider a check with a qualified exercise professional" note (C, PAR-Q+ guidance). Re-screen after 12 months. |
| Any yes on Q1–Q7 | **"See a doctor or qualified exercise professional first."** Show links to the full PAR-Q+ / ePARmed-X+. Plan generation is blocked until the user confirms clearance; the confirmation is stored with a date. (D) |
| Pregnant/postpartum, or recent serious injury/surgery | Out of scope (below). The user may continue only after confirming professional guidance; the app then uses the most conservative settings (beginner caps, no plyos, no heavy strength) and shows a persistent note. (D) |
| Injury flag "current" | Same as Q6 = yes. If cleared, start in R-PAIN amber mode (§8) for 2 weeks. (D) |

**Out of scope (the app points the user to a professional):**
- Medical diagnosis of any kind: pain, chest symptoms, illness red flags. R-ILL and R-PAIN only route to "see a doctor/physio".
- Pregnancy and postpartum programming.
- Return-to-run from serious injury, surgery or bone-stress injury.
- Under-18 users.
- Eating, weight-loss or nutrition prescriptions.
- Phone-only users without a supported watch (§11).

### 2.5 User setup flow: connect via intervals.icu (D on Platform)

This guided flow is the main mitigation for setup friction (§11). It is written for the default Garmin path; COROS, Wahoo and Suunto use the same flow with their own connection inside intervals.icu.

| Step | User action | App action / check |
|---|---|---|
| 0 | Install the PWA (iOS: Add to Home Screen), allow push | Detect standalone mode; request push only on button tap |
| 1 | Health screen (§2.4) | Block or continue |
| 2 | Create a free intervals.icu account (deep link to intervals.icu) | — |
| 3 | In intervals.icu, **Settings → Connections → Garmin** (or COROS/Wahoo/Suunto): authorize, and tick **"Upload planned workouts"** | Show screenshots per brand |
| 4 | In intervals.icu **Settings → Run sport settings**, set a **threshold pace** (the app shows the value to enter: the user's T pace, §4.1) | Needed so pace targets survive delivery (§3.2, Platform) |
| 5 | In intervals.icu **Settings → Developer Settings** (bottom of the page), copy the **API key** and athlete ID | — |
| 6 | Paste them into the app | Encrypt and store. Call `GET /api/v1/athlete/0` with Basic auth `API_KEY:<key>`; expect 200 and an athlete id matching the pasted one (endpoint path to verify, §14). |
| 7 | — | Pull `GET /api/v1/athlete/0/activities?oldest=<today−120d>&newest=<today>` and show a count by sport and origin |
| 8 | Optional: "Send a test workout" | Bulk-upsert a 10-min easy "Setup test" event for tomorrow with a known `external_id`. The user confirms it appears on the watch calendar, then the app deletes it via `events/bulk-delete`. |
| 9 | Onboarding questionnaire (§2.3), pre-filled from history | Compute volume, longest run and VDOT candidates; run the feasibility check |

**Error states:**

| State | Detection | Message / recovery |
|---|---|---|
| Bad or revoked key | 401/403 on the test call | "Key not accepted — copy it again from Developer Settings." Stop sync and mark the credential `invalid`. |
| Blocked by Cloudflare | 403 HTML challenge page | Server-side fix: send a browser-like User-Agent (Platform). Never show this to the user. |
| Rate limited | 429 + `Retry-After` | Back off and retry silently; alert the admin on repeats |
| No activities yet | 200, empty list | "intervals.icu has no activities yet. Check that your watch is connected under Connections, then sync your watch." Offer FIT upload as an alternative. |
| Watch not connected | No activities newer than 14 days while the user says they ran | Same guidance plus a re-check button. After 48 h, push a reminder. |
| Activities visible on intervals.icu but missing in the app | User report; origin shows Strava | **Strava-sourced activities are not available through the intervals.icu API** (Platform). Connect the watch brand directly in intervals.icu, or upload FIT. |
| Garmin-origin data withheld by the API (possible after Oct 2026, §3.2) | Garmin activities missing or redacted while COROS/manual uploads arrive | Switch the source to the Garmin Personal API (own key) or FIT upload. Keep intervals.icu as the workout sink. |
| Test workout never appears on the watch | User taps "not on watch" | Checklist: "Upload planned workouts" ticked; workout-type filter; threshold pace set; watch synced. Offer **Re-send** (§3.7). |

**OAuth is the better option (Platform, verified).** intervals.icu supports OAuth for third-party apps:
- Authorize at `https://intervals.icu/oauth/authorize`; exchange the code at `https://intervals.icu/api/oauth/token` within 2 minutes.
- Scopes are `ACTIVITY`, `WELLNESS`, `CALENDAR`, `LIBRARY`, `SETTINGS` and `CHATS`, each `:READ` or `:WRITE`.
- PKCE (S256) is supported. Revocation is `DELETE /api/v1/disconnect-app`. Webhooks are configured per app.
- **The app must be applied for at `/oauth/apply` and stays "Pending" until approved** ([OAuth thread](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759)).
- Forum replies (unofficial) say there are no refresh tokens.
- The API-access post says apps serving several people should use OAuth rather than shared keys ([API forum](https://forum.intervals.icu/t/api-access-to-intervals-icu/609)).

**Decision (D):**
- v1 ships with **per-user API keys**. Each user pastes their own key, nobody shares keys, and the API terms don't prohibit this.
- Apply for OAuth in parallel and migrate when approved. The gains are scoped tokens (`ACTIVITY:READ,CALENDAR:WRITE,SETTINGS:WRITE`) instead of a full-account key, a one-tap connect, and webhooks instead of polling.
- A personal API key grants full account access, so encrypt it at rest, never log it, and let the user delete it in one tap.

### 2.6 Code architecture: TypeScript pnpm monorepo (D)

```
repo/
├─ packages/engine/      pure TS, no I/O: VDOT math, cold start, feasibility, plan generator, scheduler,
│                        replanning rules, load model, strength templates, rule-trace text, unit conversion.
│                        Exports zod schemas + inferred types (profile, goal, activity summary, planned workout DSL §3.8).
├─ apps/api/             Node + Fastify + Postgres (Drizzle ORM + drizzle-kit migrations), pg-boss jobs,
│                        adapters (intervals.icu, Garmin Personal, FIT upload, optional Strava), web-push, FIT parsing.
└─ apps/web/             React + Vite PWA (vite-plugin-pwa: manifest, service worker, push handler), imports packages/engine.
```

| Concern | Choice | Notes |
|---|---|---|
| Engine | `packages/engine`, pure functions `(profile, history) → plan` | **Deterministic**: no `Date.now()` and no randomness inside, so "today" and the timezone are inputs. The **same code runs in the browser** for instant plan previews during onboarding and in the API for authoritative plans. The API result is canonical; the client preview is advisory. |
| Validation and types | zod schemas in `packages/engine`, `z.infer` types shared by api and web | Validate every API body, adapter response (intervals.icu, Garmin), and stored JSON column (`json_steps`, `rule_trace`) at the boundary |
| API | Fastify + `fastify-type-provider-zod` (or equivalent) | Per-request `user_id` comes from the session; repository functions take `userId` as a required parameter, and/or Postgres RLS via `SET app.user_id` |
| DB | Postgres 16 + Drizzle ORM; migrations via drizzle-kit, checked into git | Schema §2.2. `jsonb` for DSL steps, rule traces and settings. |
| Jobs | **pg-boss** (Postgres-backed queue; cron schedules, retries with backoff, dead-letter queue) | No Redis. Requires Postgres ≥ 13 and Node ≥ 22.12 for current versions ([pg-boss README](https://github.com/timgit/pg-boss), Platform). Use a per-user `singletonKey` to avoid overlapping syncs. Job list in §12.1. |
| Web push | `web-push` npm library (VAPID) | Subscriptions table §11.2 |
| FIT parsing | **`@garmin/fitsdk`**: Garmin's official JavaScript FIT SDK (npm; ESM; Node ≥ 14 or browser). `Decoder` + `Stream.fromBuffer()`; `read()` returns `{messages, errors}`. Includes an `Encoder`. | Verified package name ([GitHub](https://github.com/garmin/fit-javascript-sdk), [npm](https://npmjs.com/package/@garmin/fitsdk)). Whether the Encoder can emit **workout** files (for `FitFileSink`) is unverified, so test it or clone a Connect-exported layout (§14). Check the licence in LICENSE.txt. |
| HTTP client | `undici`/`fetch` with a browser-like `User-Agent` for intervals.icu, plus a shared token-bucket limiter | §3.2 |
| Crypto | Node `crypto` AES-256-GCM for per-user secrets | §12.2 |
| Web | React + Vite + vite-plugin-pwa; TanStack Query; units formatting from `packages/engine` | Static build served by the API container (`@fastify/static`) or Cloudflare Pages |
| Tests | Vitest. Engine unit tests: VDOT 50 → 5K 19:56, M 3:10:39–3:10:40; persona fixtures §4.3; V1/L1 property tests. | Engine tests need no DB |

The engine's public API (sketch):
- `computeVdot(d_m, t_s)`
- `paces(vdot, goal?)`
- `coldStart(profile, history)`
- `checkFeasibility(profile, goal, history)`
- `generatePlan(input): PlannedWorkout[]`
- `replan(state, events)`
- `explain(trace, units)`
- `toIntervalsText(workout)`
- `formatPace(s_per_km, units)`

---
## 3. Data sources and integrations (per user)

### 3.1 Architecture: default path without Strava (D on Platform)

```
            ACTIVITIES (in)                                   WORKOUTS (out)
 Garmin/COROS/Suunto/Wahoo/Polar/Huawei watch        app planned_workouts (neutral DSL, §3.8)
        │ vendor sync (configured by user in intervals.icu)        │ IntervalsIcuSink: events/bulk?upsert=true
        ▼                                                          ▼
   intervals.icu  ──API (per-user key or OAuth)──►  app      intervals.icu calendar
        ▲                                                          │ "Upload planned workouts"
 fallbacks: GarminPersonalApiSource (own key),                    ▼
            FitUploadSource (manual), StravaSource (optional) Garmin Connect / COROS / Suunto / Wahoo calendar → watch
                                                     fallbacks: FitFileSink (Garmin USB), ManualSink (PWA view)
```

```
ActivitySource (interface, bound per user)     WorkoutSink (interface, bound per user)
 ├─ IntervalsIcuSource      (default)           ├─ IntervalsIcuSink   (default; Garmin/COROS/Suunto/Wahoo via intervals.icu)
 ├─ GarminPersonalApiSource (Garmin fallback)   ├─ FitFileSink        (Garmin USB fallback)
 ├─ FitUploadSource         (any watch)         └─ ManualSink         (PWA step view; any user)
 └─ StravaSource            (OPTIONAL, off by default; §3.5)
 [future native app: HealthKitSource, WorkoutKitSink]
            │
            ▼
 raw_files (object storage, key = user_id/source/source_id) → parser → Postgres (§2.2)
```

The rules:
- **The app works fully with no Strava connection.** The canonical store is built from data fetched through intervals.icu, the Garmin Personal API, or user-uploaded FIT files. None of these is "Strava Data".
- **Skipping Strava removes two constraints** (Policy):
  - The **paid Strava subscription** that Standard-tier API developers must hold.
  - The **7-day cache / no persistent index** constraint on the canonical store. Those rules govern only data obtained from Strava's API.
- **Every activity row records its provenance:** `source` (which adapter) and `origin_platform` (which device platform). Third-party rules attach to the provenance:
  - Garmin attribution and terms (§3.2).
  - Strava rules for `strava_derived = true` rows only (§3.5).

### 3.2 intervals.icu adapter (first-class; default source and sink)

Verified against the [API access thread](https://forum.intervals.icu/t/api-access-to-intervals-icu/609), the [OAuth thread](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759), the [Integration Cookbook](https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090) and the [API terms](https://forum.intervals.icu/t/intervals-icu-api-terms-and-conditions/114087), all Platform.

| Item | Spec | Source |
|---|---|---|
| Auth, v1 | Per-user API key from **Settings → Developer Settings**. HTTP Basic with username **`API_KEY`** and the key as password. Athlete id **`0`** = the key's own athlete. | API thread |
| Auth, later | OAuth Bearer. Apply at `/oauth/apply`; the app is "Pending" until approved. Authorize at `https://intervals.icu/oauth/authorize`; token at `https://intervals.icu/api/oauth/token` (POST form; exchange the code within 2 min). Scopes `ACTIVITY`, `WELLNESS`, `CALENDAR`, `LIBRARY`, `SETTINGS`, `CHATS`, each `:READ` or `:WRITE`. PKCE S256 supported. Revoke with `DELETE /api/v1/disconnect-app`. Webhooks are configured per app. No refresh token (forum reply, unofficial). | OAuth thread |
| Multi-user guidance | Personal keys are for your own data. Apps serving other people "should" use OAuth. There is no explicit ban on users entering their own key into a small app (§14). | API thread, OAuth thread |
| List activities | `GET /api/v1/athlete/0/activities?oldest=YYYY-MM-DD&newest=YYYY-MM-DD` (JSON summaries). CSV variant: `/activities.csv`. | Cookbook |
| Activity detail | `GET /api/v1/activity/{id}?intervals=true` (laps/intervals included) | API thread |
| Streams | `GET /api/v1/activity/{id}/streams.json`, optional `?types=…`. Confirmed type names: `heartrate`, `watts`, `cadence`; the full list comes from the activity's `stream_types`. | [Streams thread](https://forum.intervals.icu/t/access-activities-streams-via-api/101065) |
| Original file | `GET /api/v1/activity/{id}/file`: the original upload (gzipped FIT/GPX/TCX). Preferred for the canonical store. | Cookbook |
| Normalized FIT | `GET /api/v1/activity/{id}/fit-file`: an intervals.icu-generated FIT with edits and laps | Cookbook |
| Planned workouts | `POST /api/v1/athlete/0/events/bulk?upsert=true` with an array of events. Fields: `category: "WORKOUT"`, `start_date_local` (`YYYY-MM-DDT00:00:00`), `type` (`Run`, `WeightTraining`, …), `name`, `description` (intervals.icu workout text), **`external_id`** (the upsert key, matched only against events this app created). Or attach a file via `filename` + `file_contents_base64` (`.fit/.zwo/.mrc/.erg`). | Cookbook, [upload thread](https://forum.intervals.icu/t/uploading-planned-workouts-to-intervals-icu/63624) |
| Delete workouts | `PUT /api/v1/athlete/0/events/bulk-delete` with `[{external_id}|{id}]` | Upload thread |
| Read calendar | `GET /api/v1/athlete/0/events?oldest=&newest=` (required range) | API thread |
| Rate limits | API key: **5,000/day and 2,500 per rolling 15 min**. OAuth apps: default 100/day per user (minimum 5,000 total), 15-min limit = daily/8. **10 req/s per IP**, with no headers on that limit. Headers `X-RateLimit-Limit/Remaining`; 429 + `Retry-After`. Daily reset at 00:00 UTC. | API thread |
| Client quirks | Cloudflare may challenge default library user agents, so send a browser-like `User-Agent`. | API thread |
| **Strava-sourced activities** | **Not returned by the API**, and activity webhooks are not delivered for them, because of Strava's terms. Users must connect their watch platform directly in intervals.icu. | API thread, Cookbook |
| Terms | The API terms grant a broad licence, including commercial use. There are **no caching or AI clauses**. **Garmin attribution** is required when showing Garmin-derived data (identify it by `device_name` containing "garmin"). intervals.icu may suspend access for abuse with about 7 days' notice. | API terms |

**Platforms intervals.icu syncs activities from directly** (its [integrations page](https://www.intervals.icu/integrations/) lists them): Garmin, COROS, Polar, Suunto, Wahoo, HUAWEI Health, Amazfit, Concept2, Zwift, MyWhoosh, Hammerhead, SIGMA, iGPSPORT, Rouvy, Dropbox, Oura and WHOOP. Strava is also listed, but Strava-sourced data is not exposed via the API. The page does not break down direction per platform. **Apple is not listed.**

**Planned-workout push from intervals.icu** (per platform, from forum reports, so the evidence varies):

| Platform | Status | Evidence | Notes |
|---|---|---|---|
| Garmin | **Works**: "Upload planned workouts" setting; about a 1-week window | [Garmin upload thread](https://forum.intervals.icu/t/upload-planned-workouts-to-garmin-connect/1521) (2020+) | Pace targets need a **threshold pace set in intervals.icu** or they arrive as "No Target" ([pace thread](https://forum.intervals.icu/t/fit-import-strips-pace-targets/120680), Jan 2026). An Aug 2026 report says API-created pace workouts still showed duration-only on Garmin ([thread](https://forum.intervals.icu/t/api-create-or-update-workout-without-using-description-text-syntax/124215)). **Test on device (§14).** |
| COROS | **Works, slightly less proven** | [COROS sync thread](https://forum.intervals.icu/t/coros-sync-from-intervals-not-working/132316) (Sept 2026, Vertix 2S); [plan-sync thread](https://forum.intervals.icu/t/coros-training-plan-is-created-but-planed-workouts-are-not-syncing/131097) (Aug 2026) | Only the **next couple of days** appear to upload. Stuck workouts were fixed by removing and re-adding the workout, or moving it a day and back. Wrong workout syntax or a type filter fails silently. |
| Suunto | Works (SuuntoPlus Guides, about 1 week ahead) | [Suunto thread](https://forum.intervals.icu/t/upload-workouts-to-suunto-watches/9560) (2022) | Supports pace/HR/power/cadence targets and distance steps; ramps are shown as an average. Current-model behavior is unverified. |
| Wahoo | Works, including the ELEMNT RIVAL running watch | [Wahoo thread](https://forum.intervals.icu/t/planned-workouts-with-wahoo-now-supported/54795) (2024–2026) | Sync outages and duplicates have been reported |
| HUAWEI | Stated on the integrations page ("send planned runs to your HUAWEI watch") | Integrations page | Details unverified |
| Polar | **No push.** The Polar API has no planned-workout upload. | [Polar thread](https://forum.intervals.icu/t/load-the-programmed-training-in-polar-flow/6064) (2023–2025) | Polar users follow workouts in the PWA |
| Amazfit, others | Unknown | — | PWA |

**Garmin data-sharing risk (Platform, Oct 2026, unresolved).**
- Garmin's updated partner terms bar licensees from passing Garmin-origin data to services Garmin hasn't approved.
- intervals.icu's developer expects it will have to restrict Garmin-sourced data in its API: FIT files, streams and wellness, possibly including history.
- **User-uploaded FIT files are expected to be unaffected**, and COROS, Suunto, Polar and similar data stays under those vendors' terms.
- Garmin says the change is part of reopening its developer program, with "an easier path" for individuals and apps. No effective date or details have been published ([API thread](https://forum.intervals.icu/t/api-access-to-intervals-icu/609), [the5krunner](https://the5krunner.com/2026/10/14/garmin-api-intervals-third-party-apps/)).
- Workout push to Garmin is a separate direction (intervals.icu → Garmin Connect) and isn't described as affected.

The design response (D):
- For Garmin users, `IntervalsIcuSource` is the default. **`GarminPersonalApiSource` (§3.3) is built in v1 as a hot fallback.** It is selected automatically, with the user's consent, when intervals.icu returns no or redacted Garmin-origin activities.
- `IntervalsIcuSink` stays the Garmin workout path either way.

**Sync strategy (D).**
- Per user, poll the activities list every **15 min** during the user's waking hours with `oldest = last_seen_date − 1 d`.
- For each new id, fetch detail with intervals, then `/file` (canonical FIT) and streams only if parsing the FIT fails. That is about 3 calls per new activity.
- Run a nightly 7-day reconciliation per user.
- Budget at 10 users × (64 polls + 2 activities × 3) ≈ **700 calls/day total, about 70 per key**, far under 5,000/day per key. The binding constraint is the **10 req/s per-IP** limit, so use one global token-bucket limiter at ≤5 req/s and stagger users.
- After OAuth approval, switch to webhooks and keep only the nightly reconciliation.

**Workout push strategy (D).**
- On every plan (re)generation, bulk-upsert the next **14 days** of the user's workouts. Each `external_id = "{user_id}:{planned_workout_id}:{rev}"`.
- Bulk-delete events whose planned workout was removed.
- Vendors pull only their own near window (Garmin about 7 d, COROS about 2–3 d), so the 14-day push is complete for every target.
- After a push, read the calendar back and store intervals.icu event ids in `planned_workouts.sink_state`.

### 3.3 Garmin Personal API (fallback source for Garmin users; pull-only)

How it works:
- The user creates a key at `connect.garmin.com/app/settings/personalApiToken`. Expiry is 30, 90, 180 or 365 days, and the key is shown once.
- Exchange it with `POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token` and header `Authorization: ApiKey <key>`.
- That returns an OAuth2 access token **valid 24 h, with no refresh token**.
- Scope is the Activity API (JSON + full .FIT) and Health. There is no Training API, so it **cannot push workouts**.
- Source: [Garmin Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/), [the5krunner](https://the5krunner.com/2026/10/22/garmin-personal-api/). Platform.

Implementation (D):
- Each Garmin user generates **their own** key and pastes it in. Store it encrypted per user.
- Re-mint the token daily, alert 14 days before key expiry, poll every 15–30 min, and reconcile nightly.

**Multi-user caveat (UNVERIFIED).** Garmin's FAQ describes the Personal API as "not intended for commercial applications serving multiple end users" ([FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)). Whether a small private app may hold several users' personal keys is unconfirmed (§14). If it's not permitted, Garmin users fall back to FIT upload, or to the "easier path" Garmin has announced once it exists.

### 3.4 Manual FIT upload (any watch)

- The PWA accepts `.fit` (and `.fit.gz`), GPX and TCX. FIT is preferred because it carries laps, HR and device fields.
- Users can bulk-upload a vendor export for history backfill.
- Optionally, the app forwards the uploaded file to the user's intervals.icu account (`POST /api/v1/athlete/0/activities`, multipart; endpoint to verify), so intervals.icu has it too. User-uploaded files are expected to stay outside Garmin's re-sharing restriction (§3.2).

### 3.5 Strava adapter (OPTIONAL fallback; off by default)

**When to offer it (D):** only when the user's watch can't reach intervals.icu directly and FIT export is impractical. The main case is Apple Watch users without a working bridge (§3.6). Everyone else is told the app doesn't need Strava.

**These constraints apply only if the adapter is enabled for at least one user** ([Strava API Policy](https://www.strava.com/legal/api_policy), effective June 1, 2026):

| Constraint | Rule | Implementation |
|---|---|---|
| §6.2 cache | No Strava data cached "for longer than seven (7) days" | Strava-derived rows live in a separate schema with `purge_after = fetched_at + 7 d`, deleted by a nightly TTL job |
| §5.5 persistent index | No Strava data, or data derived from it, in a persistent index | Strava-derived activities **never feed durable aggregates** (VDOT history, PB table, load history). For plan purposes they are summarized into transient weekly features that expire with the rows. Pragmatic alternative: see the posture note below. |
| §5.3 AI | No use "in connection with … any AI Application", including RAG, embeddings and context-window ingestion | **Never pass Strava-derived rows to any LLM feature** (§11.6). Enforce this with the `strava_derived` flag in the query layer. |
| §5.4 analytics | "Analytics" processing is restricted; how it applies to personal derived metrics is ambiguous | Open item (§14) |
| §5.16 | No MCP or agent interface exposing Strava data | No export of Strava rows via any API |
| §6.3 / §7.4 | Reflect deletions within **48 h**; purge within **30 days** after revocation | Handle webhook `delete` / deauth events |
| Display | Strava data may be shown only to the athlete it belongs to | Excluded from the opt-in feed (§11) |
| Developer subscription | Standard-tier developers must hold a paid Strava subscription (new developers from June 1, 2026). §3.3 accepts one "held by the developer or specified end users". | Needed **only if** the adapter is enabled. The Agreement says "no charge" (unresolved conflict, §14). |
| Intermediaries | Routing Strava data through third-party platforms has been unsupported since June 2026 | This is why intervals.icu won't return Strava-sourced activities |

**Posture (pick one and document it):**
- **Strict:** the 7-day TTL as above. Long-term trends for a Strava-only user are limited to what the user logs manually plus transient features.
- **Pragmatic:** keep Strava-derived summaries. This conflicts with a literal reading of §6.2/§5.5, and the risk is low but non-zero.

The default is Strict, because the default path makes Strava rare.

**Strava API v3 essentials (Platform):**
- **Authorize:** `GET https://www.strava.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope=activity:read_all&approval_prompt=auto&state`. Check the returned `scope` string, because users can untick scopes.
- **Tokens:** `POST /api/v3/oauth/token` with a 6-h access token. **Refresh tokens rotate, and the old one is invalidated immediately**, so persist the new one atomically per user.
- **Auth header and host:** use the `Authorization: Bearer` header. Header-only auth is required by June 1, 2027. The base URL is `https://www.strava.com/api/v3` today; the new host (`api-v3.strava.com`) is mandatory by June 1, 2027. Keep the host in config.
- **Endpoints:**
  - List: `GET /athlete/activities?after&before&page&per_page`.
  - Detail: `GET /activities/{id}` (`external_id`, `device_name`, `laps`).
  - Laps: `GET /activities/{id}/laps`.
  - Streams: `time, distance, latlng, altitude, velocity_smooth, heartrate, cadence, watts, temp, moving, grade_smooth`.
  - Revoke: `POST /oauth/revoke`.
- **Webhooks:** one subscription per app. Echo `hub.challenge` within 2 s. Events carry IDs only; route them by `owner_id`.
- **Limits are per app:** 200 req/15 min and 2,000/day overall; 100/15 min and 1,000/day read. Capacity starts at **1 athlete**. A self-service upgrade raises it to **10 athletes** with doubled limits. Do the upgrade before the second Strava user.
- **Sync:** poll every 15 min with `after = last_seen − 1 d` (about 4 calls per new activity), or use webhooks above 5 Strava users.
- **No workout push exists in the public API.**
- Sources: [Auth](https://developers.strava.com/docs/authentication/), [Reference](https://developers.strava.com/docs/reference/), [Webhooks](https://developers.strava.com/docs/webhooks/), [Rate limits](https://developers.strava.com/docs/rate-limits/), [Changelog](https://developers.strava.com/docs/changelog/), [Developer program update](https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428).

### 3.6 Brand → source / sink defaults (D on Platform)

| Watch | Activity source (default → fallback) | Workout sink (default → fallback) | Support level |
|---|---|---|---|
| **Garmin** | intervals.icu → Garmin Personal API (own key) → FIT upload | intervals.icu → Garmin Connect calendar → watch → `FitFileSink` (USB `GARMIN/NewFiles`) → PWA | **Primary target.** Best proven. Pace-target behavior must be verified per device (§14). |
| **COROS** | intervals.icu → FIT upload | intervals.icu → COROS calendar → PWA | **Supported, slightly less proven.** Short sync window; use the re-send action (§3.7). |
| Suunto | intervals.icu → FIT upload | intervals.icu → SuuntoPlus Guides → PWA | Supported; current models unverified |
| Wahoo (RIVAL) | intervals.icu → FIT upload | intervals.icu → Wahoo → PWA | Supported; sync hiccups reported |
| HUAWEI | intervals.icu → FIT upload | intervals.icu (stated) → PWA | Unverified details |
| Polar | intervals.icu → FIT upload | **PWA only** (no push API) | Activities yes, workouts no |
| Amazfit | intervals.icu → FIT upload | PWA | Unverified |
| **Apple Watch** | Third-party bridge into intervals.icu (below; **unverified**) → FIT export (e.g. HealthFit) + upload → **Strava adapter (optional)** | **PWA only** (no WorkoutKit in a PWA). A third-party companion may deliver intervals.icu workouts to the Workout app (unverified). | Partially supported |
| Other / none | FIT upload → Strava adapter (optional) | PWA | Phone-only (no watch) is out of scope for v1 |

**Apple Watch without Strava (UNVERIFIED, Platform/C):** intervals.icu has no native Apple Health integration. The reported paths are:
- **Intervals.icu Companion** (third-party iOS app). An Oct 2026 forum post says it syncs Apple Health workouts and metrics to intervals.icu and sends structured intervals.icu workouts to the Apple Watch Workout app. Its Feb 2026 thread still listed both features as TestFlight goals ([Apple Watch thread](https://forum.intervals.icu/t/integration-with-apple-watch/113470), [Companion thread](https://forum.intervals.icu/t/a-new-intervals-companion-app-with-widgets/92334)).
- **HealthFit** (third-party iOS app). It exports Apple Watch workouts as FIT files; a 2021 beta synced them to intervals.icu directly ([HealthFit thread](https://forum.intervals.icu/t/healthfit-sync-for-activities-and-health-metrics/2718)). Apple Health doesn't store running power.
- **BreakAway.** Its developer reports syncing Apple Health workouts to intervals.icu (Oct 2025).

The setup flow should list these as "try in this order, then the Strava adapter if none works". The app does not depend on any of them.

### 3.7 Workout delivery details

**Through intervals.icu (default sink):**
- **Encoding.** Compile the neutral DSL (§3.8) into intervals.icu workout text in `description`. Use absolute pace ranges for pace steps, and %HRmax or bpm ranges for HR steps, as documented in the intervals.icu workout builder. **The exact text syntax must be verified** by round-tripping a builder-made workout through `GET …/events/{id}` (§14).
- **Alternative encoding.** Attach a FIT workout via `file_contents_base64`. A March 2026 report says intervals.icu re-parses it into its own format anyway.
- **Threshold pace prerequisite.** Pace targets need the user's **threshold pace set in intervals.icu**: set it to the user's T pace (§4.1) during setup.
  - With OAuth `SETTINGS:WRITE`, or with the API key, keep it in sync after each VDOT change. The athlete-settings endpoint is to be verified.
- **Single target per step.** Watches reject stacked primary targets, so each step carries one target. Default to **pace for T/I/M/R steps and HR for easy/long steps** (D). The DSL keeps the fallback, and the PWA shows both.
- **Pace-strip fallback (D).** If setup step 8 shows targets stripped on the device, set the user's `target_mode = hr` and send HR ranges from the zone's %HRmax. This requires a measured or confirmed HRmax.

**Re-send for stuck workouts (D, prompted by COROS reports).**
- Each workout card has **"Re-send to watch"**. It bulk-deletes the event by `external_id`, then upserts it with an incremented `rev`, which forces a new event id and a fresh vendor upload.
- The app shows the "Last pushed" time.
- If a workout is still missing after a re-send, the card offers "Follow in app" (PWA step view).
- A nightly job re-sends any workout in the next 3 days whose intervals.icu event is missing on read-back.

**FIT file sink (Garmin fallback, USB)** ([FIT workout file type](https://developer.garmin.com/fit/articles/file-types/workout.html), Platform). Build files with the `Encoder` in `@garmin/fitsdk` (§2.6); its support for workout files is unverified (§14).
- **Message order:** File Id (type 5) → Workout (`num_valid_steps`, `sport`, `wkt_name`) → Workout Steps (`message_index`, `duration_type`, `duration_value`, `target_type`).
- **`intensity` values:** 0 active, 1 rest, 2 warmup, 3 cooldown, 4 recovery, 5 interval.
- **HR targets:** absolute bpm is stored with a +100 offset.
- **Repeats:** `duration_type=6`, `duration_value` = first step index, `target_value` = rep count.
- **Pace targets:** `target_type=speed` with `custom_target_value_low/high` in m/s. The ×1000 scale is **unverified**.
- **Newer firmware:** some models reject SDK-made files ([Garmin forum](https://forums.garmin.com/developer/fit-sdk/f/discussion/396686/epix-pro-ii-stopped-processing-workout-fit-files)). Clone the field layout from a Garmin-Connect-exported workout.

**Not used (C/Policy):**
- Unofficial `python-garminconnect` upload/schedule: violates Garmin ToS and is fragile.
- Garmin Training API: requires Business approval.
- COROS, Polar and Suunto partner APIs: company-only.

### 3.8 Neutral workout JSON (D)

Store targets as **s/km ranges** (SI), HR as %HRmax plus resolved bpm, and durations in s or m. Convert per sink at push time, and to the user's units only for display. Every workout carries its **rule trace** (§11.4).

```json
{
  "id": "wk-2026-W47-tue",
  "user_id": "u_123",
  "date": "2026-11-17",
  "sport": "run",
  "type": "T",
  "name": "Cruise intervals 4 × 8 min @ T",
  "phase": "EQ",
  "prescription_mode": "pace",            // pace | time_rpe | run_walk   (§4.2, §6.9)
  "steps": [
    {"kind": "warmup",   "duration": {"type": "time", "s": 900}, "target": {"type": "hr_pct_max", "lo": 65, "hi": 79}},
    {"kind": "repeat", "count": 4, "steps": [
      {"kind": "work",     "duration": {"type": "time", "s": 480},
       "target": {"type": "pace", "lo_s_per_km": 350, "hi_s_per_km": 367},
       "fallback": {"type": "hr_pct_max", "lo": 88, "hi": 92}, "rpe": "7-8"},
      {"kind": "recovery", "duration": {"type": "time", "s": 60}, "target": {"type": "open"}}
    ]},
    {"kind": "cooldown", "duration": {"type": "time", "s": 600}, "target": {"type": "open"}}
  ],
  "planned": {"run_m": 10500, "minutes": 62, "expected_srpe": 6},
  "flags": {"heat_adjusted": false, "key_session": true},
  "rule_trace": ["P3:EQ:HM:T", "I2:intermediate:5d:Q1", "W-T:prog+5min", "V1:ok(10.5<=12.1)"]
}
```

- **Run/walk steps:** `{"kind":"run","duration":{"type":"time","s":60},"target":{"type":"rpe","value":"3-4"}}` alternating with `{"kind":"walk",…}`. Map them to FIT `active`/`rest`.
- **FIT intensity mapping:** warmup 2, cooldown 3, work 5, recovery 4, rest/walk 1; `repeat` becomes a type-6 step.
- **Display:** the PWA converts s/km to min/km or min/mi, and m to km or mi. Imperial distances are rounded to 0.1 mi, and imperial interval reps use sensible equivalents (e.g. 800 m shown as "800 m (½ mi)"). Prescriptions stay in SI.

### 3.9 Dedup and plan matching (D)

- **Unique key:** `(user_id, source, source_id)`.
- **Cross-source match:** start time within ±60 s **and** distance within ±2%. Prefer the row with a FIT file (intervals.icu `/file`, Garmin Personal API or upload) over Strava.
- **Idempotency:** ingestion must be idempotent, because webhook and poll overlaps and Strava `update`/`delete` events all occur.
- **Plan matching:** match each completed activity to a planned workout by local date and sport. When the watch ran the structured workout, laps map 1:1 onto steps, which gives per-step compliance (§8).

---
## 4. Pace and fitness model

### 4.1 Daniels–Gilbert VDOT (exact equations)

All units are fixed: velocity **v in m/min**, race duration **t in min**. One commonly copied calculator page wrongly labels them m/s and seconds.

```
VO2(v)   = −4.60 + 0.182258·v + 0.000104·v²                          [ml·kg⁻¹·min⁻¹]
%max(t)  = 0.8 + 0.1894393·e^(−0.012778·t) + 0.2989558·e^(−0.1932605·t)
VDOT     = VO2(d/t) / %max(t)

Training pace at intensity fraction f:
  v(f) = (−0.182258 + √(0.182258² − 4·0.000104·(−4.60 − f·VDOT))) / (2·0.000104)
  pace_s_per_km = 60000 / v(f)

Race-equivalent time at distance d: solve VDOT(d, t) = VDOT_current for t (bisection, 1–900 min).
```

Sources: the equations come from secondary transcriptions of Daniels & Gilbert 1979 that agree across independent calculators ([Bill Mill notes](https://notes.billmill.org/fitness/calculating_v02_max.html), [RunBundle](https://runbundle.com/tools/race-predictors/general-race-predictors)). VDOT is a performance-equivalent "pseudo-VO2max" that already folds in running economy ([Wikipedia](https://en.wikipedia.org/wiki/Jack_Daniels_(coach))). **Label:** C. It is a published model that hasn't been validated in recreational runners. Valid input range for the app (D): **VDOT 15–85**, race duration 3.5–360 min. Outside that range, the app falls back to cold-start handling.

**Race-equivalence unit test (done).** At VDOT 50 the equations give 5K **19:56** (table 19:57) and marathon **3:10:39–3:10:40** (table 3:10:49). Both match within 10 s; the marathon solution is 11,439.7 s. Keep both as unit tests.

**Zone-pace check (still open).** The per-zone *training* paces haven't been checked against the official tables. Add checks at VDOT 25, 34, 50 and 60 (§14).

**Zone fractions** ([CoachRay](https://www.coachray.nz/2023/05/03/jack-daniels-running-intensity/), C):

| Zone | %VO2max | %HRmax | RPE (CR-10, D) |
|---|---|---|---|
| E/L | 59–74% | 65–79% | 2–4, conversational |
| M | 75–84% | 80–90% | 5 |
| T | 83–88% | 88–92% | 6–7, "comfortably hard" |
| I | **95–100%** | 98–100% | 8–9 |
| R | >100% (mile race solution) | — | 9, fast but relaxed |

[Wikipedia](https://en.wikipedia.org/wiki/Jack_Daniels_(coach)) gives slightly different HR bands (E 60–79, M 80–85, T 82–88, I 97–100). Use one set consistently. The RPE column exists for the time/RPE prescription mode (§4.2, §6.9).

**M pace, in priority order (D):**
1. **Goal race with a goal time:** M = goal-time pace = `goal_time_s / goal_distance_km`. MP workouts, MP long-run segments and race-pace touches target this. For non-marathon goals, the same rule defines "goal pace" (GP) for race-specific sessions.
2. **No goal time:** M = the marathon race-time solution at the current VDOT.
3. **Fallback only:** the 75–84% band, used when a plan needs an M zone and no VDOT race solution is available.

The band is only a fallback because it is wide and its midpoint misses real marathon pace. At VDOT 33.7 it spans 6:37–6:04/km, and 79% gives 6:22/km, while the race solution is 6:15/km (about 80.6%). At VDOT 50, 79% gives 4:38/km against a race solution of 4:31/km (81.7%).

**Aggressive-goal flag (D):** if the goal time implies a VDOT more than **1.5 points** above the current one, flag it (§6.2). Never silently re-derive the E, T and I paces from the goal.

**R pace = the mile race-time solution at the current VDOT** (D). This implements Daniels' "R ≈ mile pace" ([Running with Rock](https://runningwithrock.com/training-explained-jack-daniels-running-formula/)).

**VDOT sensitivity varies with level (computed).** One VDOT point moves pace by about **3.0% at VDOT 25, 2.3% at 34, 1.65% at 50 and 1.4% at 60**. So fitness step sizes are defined in **% pace**, not raw VDOT points (§4.10).

### 4.2 Cold start: users without a usable race result

A race counts as usable when it is ≤12 weeks old, all-out, on a measured course, and not heat-flagged. Without one, the app picks a path from experience level and the "can run 20 min continuously" answer.

| Path | Who | How VDOT is set | Prescription mode until VDOT is trusted | Label |
|---|---|---|---|---|
| **A. Guided time trial** | Can run 20 min continuously, and not beginner | Scheduled in week 1 or 2 after ≥3 easy runs. User picks: **3K TT**, **5K TT** (or parkrun), or **30-min test** (run as far as possible in 30 min; distance is read from the watch). Feed (d, t) to the VDOT equation; the 30-min test uses d = distance, t = 30. Warm-up 10–15 min easy + 4 strides; flat route or track; not in heat (WBGT >20 °C → reschedule). | Provisional VDOT until the TT, then pace mode | VDOT from TT: C. Test protocols: D. |
| **B. Conservative fallback** | Has history but skips the TT | From ≥4 weeks of easy runs: `VDOT_fallback = VO2(v_typical)/0.78 − 1`, where v_typical is the median moving speed of non-race runs of ≥20 min, GAP-adjusted. Treat typical runs as about 74–78% effort, then subtract 1 point as a safety margin. Cap at the Uth estimate if HR data exist. | Pace mode, with paces tagged "estimated" and a TT prompt every 4 weeks | **D** (unvalidated) |
| **C. Beginner path** | Beginner level (§2.3) | No VDOT until the user can run 20–30 min continuously, then path A. | **Run/walk and time/RPE** (§6.9): durations in minutes, effort by RPE and talk test, HR cap at 79% HRmax if HRmax is known | C (NHS C25K) / D |

Rules (D):
- **TT replaces the estimate.** A TT result overrides a fallback VDOT in both directions; this is the only automatic downgrade allowed.
- **Shorter tests read slightly optimistic for endurance.** 3K and 30-min tests sit near the top of the %max curve (%max(12 min) ≈ 0.99, %max(30 min) ≈ 0.93). For goals of half marathon or longer, apply PACE-FADE (§4.4) from the test result rather than raw VDOT.
- **Provisional VDOT freezes quality paces.** While VDOT is `estimated`, I and R work is not prescribed. Only E, strides, T by RPE ("comfortably hard, 6–7/10") and hills are used.
- **Re-test cadence.** Prompt a TT or race every 4–6 weeks in base and early quality phases, and never in the final 3 weeks before a race (C, Daniels: update after tune-up races or TTs).

**Evidence honesty:**
- Using the Daniels equation on a 3K or 5K time trial is the same model as for races (C).
- The 30-min test as an input to VDOT is a designer choice (D). It is similar to the Cooper-test family, but the app doesn't use Cooper's VO2 regression.
- The fallback from easy pace is unvalidated (D). That is why it is conservative and labelled.

### 4.3 Worked personas (computed from §4.1 with Python; display rounded to the second)

These three generic personas span the range. They serve as fixtures for engine tests.

**Persona A: beginner, first 5K or 10K.**
- Running 3×/week for 2 months, 12 km/week, longest run 5 km (about 45 min run/walk). Can just run 20 min continuously. No race.
- Goal: first 5K in 10 weeks, no goal time. Run/walk alternatives are offered for a first 10K.
- Path: §4.2 C, then A. Weeks 1–3 run/walk (§6.9); a 3K TT in week 4 gives 21:00.
- v = 3000/21 = 142.86 m/min; VO2 = 23.57; %max(21) = 0.950. **VDOT = 24.8**.

**Persona B: recreational marathoner, cross-trains and lifts.**
- Marathon 4:24:00 last season. 40–45 km/week, 4 run days, plus 2 dragon-boat/paddling sessions (one hard) and 2 upper-body gym days on their own program. Strength mode: running-focused (lower + core), gym.
- Goal: marathon in 18 weeks, goal 4:15:00.
- v = 42,195/264 = 159.83 m/min; VO2 = 27.19; %max(264) = 0.8065. **VDOT = 33.7**.

**Persona C: experienced runner, half-marathon PR.**
- 5 years running, 60–65 km/week, 6 run days, HM PR 1:31:31 (≙ VDOT 50; 5K 19:56, M 3:10:40).
- Goal: sub-1:30 half in 14 weeks (1:29:59). Full-body strength, gym, 2×/week.
- **VDOT = 50.0**.

| Output | A (VDOT 24.8) | B (VDOT 33.7) | C (VDOT 50.0) |
|---|---|---|---|
| Mile (R basis) | 10:48 | 8:17 | 5:50 |
| 5K / 10K equiv. | 35:53 / 1:14:45 | 27:50 / 57:51 | 19:56 / 41:20 |
| HM / M equiv. (raw VDOT) | 2:44:58 / 5:36:19 | 2:08:12 / 4:24:00 | 1:31:31 / 3:10:40 |
| **E** 59–74% | 10:01–8:29 /km (16:07–13:38 /mi) | 7:58–6:42 /km (12:50–10:46 /mi) | 5:52–4:54 /km (9:26–7:52 /mi) |
| **M** race solution | 7:58 /km | 6:15 /km (10:04 /mi) | 4:31 /km (7:16 /mi) |
| M at goal (priority 1) | n/a (no goal time) | **6:03 /km (9:44 /mi)** for 4:15:00 | HM GP **4:16 /km (6:52 /mi)** |
| M by 79% band (fallback) | 8:04 /km | 6:22 /km | 4:38 /km |
| **T** 83–88% | 7:46–7:26 /km | 6:07–5:50 /km (9:51–9:24 /mi) | 4:28–4:15 /km (7:11–6:51 /mi) |
| **I** 95–100% | 7:00–6:44 /km | **5:30–5:16 /km** (95% = 329.6 s/km) | 4:00–3:50 /km (6:26–6:10 /mi) |
| **R** (mile solution) | 6:43 /km | 5:09 /km | 3:37 /km |
| Goal VDOT / Δ | 5K 35:00 → 25.6 / +0.8 (ok) | 4:15:00 → 35.2 / **+1.48** (just under flag) | 1:29:59 → 51.0 / +0.99 (ok) |
| Long-run pace | E (RPE 3–4) | GP +10–20%, clamped to the E band: 6:42–7:15 /km | E band 4:54–5:52; default 4:54–5:26 (65–74%) |
| LR at 150 min ≈ | n/a (beginner cap 90 min ≈ 9.6–10.6 km at E) | 20.7–22.4 km | 27.6–30.7 km |
| 1 VDOT ≈ | 3.0% pace | 2.3% | 1.65% |

Notes for the engine:
- **Persona B, VDOT 34.7 (+1):** M solution 6:07/km (4:17:50), T 5:59–5:42, I 5:22–5:09.
- **Persona B's goal check.** Goal 4:15 needs VDOT 35.2, which is +1.48: inside the flag threshold but at the edge. A 4:10 goal (+2.35) would be flagged.
- **Persona C's goal check.** Sub-1:30 needs +0.99, so it's feasible. A 1:28 goal (+2.32) would be flagged.
- **I-pace correction kept.** At VDOT 33.7, 95% gives 329.6 s/km = **5:30/km** (5:29.6). The original research notes' lower bound of "5:21" was wrong. Use 5:30–5:16 (displayed rounding; 329.6 s internally).
- **Consistency check.** At each persona's marathon duration, the equation's own %max is 80.3% (A), 80.6% (B) and 81.7% (C), all inside Daniels' 75–84% M band. This is a consistency check, not validation.
- **Rounding.** Round paces at display time only, and keep s/km internally. Imperial pace = s/km × 1.609344.

### 4.4 Race-equivalence models and their bias

| Model | Formula | Bias for recreational runners |
|---|---|---|
| Riegel | `T2 = T1·(D2/D1)^k`, k = 1.06 (T in s, D in m) | **Too fast for the marathon.** With k = 1.07, the median prediction was 10:09 too fast and about 25% of runners were more than 20 min too fast. 10K and half predictions were fine (n=2,303) ([Vickers & Vertosick 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5000509/), E). |
| Riegel, empirical k | k ≈ 1.15 at the center. About 1.10 for 1:20 half-marathoners, about 1.19 for 2:00 half-marathoners. Under 5% fit 1.06. | Self-selected sample of 1,071 runners ([Fetcheveryone](https://www.fetcheveryone.com/article/marathon-predictions-3-0-116), C) |
| Cameron | `T2 = (T1/D1)·D2·f(D1)/f(D2)`, `f(x) = 13.49681 − 0.000030363·x + 835.7114/x^0.7905` (x in m) | No evidence it beats VDOT for recreational runners. The RunBundle page has a typo in the linear term. |
| VDOT | §4.1 | Behaves like Riegel ≈ 1.05 across levels, so it shares the fast bias for the marathon |
| Riegel + weekly mileage | Vickers Model 1 | Median error fell to −1:47. With two races plus a personal k (Model 2), median error was +0:23 (E). Coefficients are in an unretrieved supplement. |

**Rule PACE-FADE (D on E/C).** Applies when the anchor race or TT is shorter than the goal race **and** the goal is HM or M:

```
goal_time = T_anchor · (D_goal/D_anchor)^k_user
k_default = clamp(1.10 + 0.05·(T_HM_equiv_min − 80)/40, 1.08, 1.15)     // faster runners fade less (Fetcheveryone gradient)
k_user    = k_default + 0.03 if typical weekly volume < 60% of the plan's peak ceiling (Vickers volume effect), max 1.19
once two races exist: k_user = ln(T2/T1)/ln(D2/D1), clamped 1.03–1.20
```

5K/10K goals from a shorter anchor use raw VDOT. Vickers found 10K and half predictions well calibrated.

Persona examples (computed):
- **Persona C.** HM 1:31:31 → raw VDOT marathon 3:10:40. k_default = 1.114 → 3:18:09.
- **Persona B with a hypothetical 2:00 half.** VDOT 36.5, raw marathon 4:07:44 (implied k ≈ 1.046). k = 1.10 → 4:17:14; 1.15 → 4:26:18; 1.19 → 4:33:47. The penalty is worth 9–26 min, which brackets Vickers' median miss.

### 4.5 Critical speed (CS) from training data

Model: `D = CS·t + D′` fitted to best grade-adjusted efforts over 400, 800, 1,000, 1,500, 3,000 and 5,000 m in the trailing **16 weeks**. The best subset was 400/800/5,000 m, and the method needs at least 24 activities in the window.

How it performed (31,190 marathoners, [Smyth & Muniz-Pumares 2020](https://uhra.herts.ac.uk/id/eprint/8225/1/Calculation_of_Critical_Speed_from_Raw_Training.96275.pdf), E):
- Marathon-prediction error was 7.67% (R² 0.695).
- Marathons were run at a mean 84.8% of CS: about 93% for 150-min finishers and 78.9% for finishers over 300 min.

Engine use (D):
- **Prior.** `CS ≈ v_M / f(T_M)`, with f interpolated from 0.93 at 150 min to 0.789 at ≥300 min. That gives: A ≈ 6:17/km (f 0.789), B ≈ 5:09/km (f 0.82), C ≈ 4:02/km (f 0.89).
- **Update CS upward only from genuinely hard efforts** (intervals, parkruns, TTs). Use it as a cross-check, not a driver.
- **Disable CS for beginners.** Their efforts are rarely maximal.

### 4.6 HR-based fitness methods and their error

| Method | Formula / approach | Error | Use |
|---|---|---|---|
| Uth ratio | `VO2max ≈ 15.3 × HRmax/HRrest` | SEE 2.7 ml/kg/min with measured HRmax, 4.7 with age-predicted. Derived in 46 trained men ([Uth 2004](https://www.springermedizin.de/estimation-of-vo2max-from-the-ratio-between-hrmax-and-hrrest-the/8478242), E). | Sanity check and fallback cap only |
| Watch VO2max (e.g. Garmin/Firstbeat) | Proprietary | FR245 vs lab: bias −4.73, MAPE 7.9% ([EJAP 2025](https://link.springer.com/article/10.1007/s00421-025-05923-x)). Firstbeat field test: MAPE 4.1% ([Gao 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8283806)). E. | Trend display only. Not available from every source. |
| HR–speed regression | Fit `GAP_speed = a + b·HR` on steady 60-s windows with HR > 70% HRmax; extrapolate to HRmax | Unvalidated; HRmax error dominates (D) | Feeds the training EWMA (§4.10). **Requires measured HRmax.** |
| Efficiency Factor | `EF = normalized graded pace / avg HR` | Coaching metric ([TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204071724-Aerobic-Decoupling-and-Efficiency-Factor), C) | Trend |
| Aerobic decoupling | % change in EF from first half to second half | Under 5% is "good"; steady efforts of 20 min or more only (C) | Long-run quality marker |

**HRmax policy (D on E):**
- Prefer a measured value: the peak 30-s HR in a race finish or hill repeats, auto-detected from history as the 99th percentile of the max of the last 6 months.
- Fallback is **Tanaka `208 − 0.7·age`** ([Tanaka 2001](https://pubmed.ncbi.nlm.nih.gov/11153730/), E meta-analysis), flagged `age_formula`.
- With an age-formula HRmax, HR zones are shown as guidance only, and **HR is never used to change VDOT**.
- Without age or HRmax, HR features are off and the app relies on pace and RPE.

### 4.7 Grade-adjusted pace

Minetti 2002 energy cost: `Cr(i) = 155.4i⁵ − 30.4i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6` ([Minetti JAP 2002](https://iris.unibs.it/retrieve/ddc633e4-3c03-4e2e-e053-3705fe0a4c80/Minetti%20JAP%202002.pdf), E). It **over-rewards downhills** as an effort measure. Strava's HR-calibrated model has its downhill minimum at 0.88 at −9% ([Strava Engineering](https://medium.com/strava-engineering/an-improved-gap-model-8b07ae8886c3), C).

**Engine GAP (D):** `GAP_speed = speed × F(g)` with the Ultrapacer quadratic `F(g) = 0.0021g² + 0.034g + 1` (g in %) ([Educated Guesswork](https://educatedguesswork.org/posts/grade-vs-pace/)).
- Its minimum is about 0.86 at −8%.
- Clamp grade to ±25%, and compute it from elevation smoothed over 50–100 m.
- Prefer barometric altitude. Disable GAP for GPS-only elevation, track or treadmill runs.
- Use Minetti only for energy cost (CS inputs).

### 4.8 Heat adjustment

Evidence:
- Marathon slowing rises with WBGT. Top-3 men slowed 1.7 / 2.5 / 3.3 / 4.5% across WBGT quartiles of 5–10 / 10–15 / 15–20 / 20–25 °C, **and slower finishers slowed more** ([Ely 2007](https://experts.umn.edu/en/publications/impact-of-weather-on-marathon-running-performance/), E).
- The optimum is 3.8–9.9 °C by level. Humidity and dew point were not significant across 1.79M performances ([El Helou 2012](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0037407), E).
- Above 20 °C WBGT is effectively "do not race" ([Gasparetto 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7350124), E).

**Rule HEAT (D, scaled from Ely by level):**

```
slope = 0.35 %/°C  if VDOT ≥ 50           (near elite-ish slope)
      = 0.5  %/°C  if 40 ≤ VDOT < 50
      = 0.65 %/°C  if VDOT < 40           (slower runners slow more; extrapolated)
penalty% = 0 if WBGT ≤ 10 °C, else slope × (WBGT − 10)
```

- Approximate WBGT from air temperature + dew point from a weather API. Keep dew point as a secondary low-evidence term. The temp+dew-point (°F) table works as a cross-check: <130 no change, 130–150 2–3%, 150–165 3–5%, 165–180 5–8%, >180 8–10%+ ([TrainingPeaks](https://www.trainingpeaks.com/blog/running-in-the-heat-how-to-adjust-training-and-race-pace/), C). Display it in °F for imperial users.
- Apply it both ways: slow prescribed quality and goal paces, and normalize completed runs before fitness estimation.
- **Exclude runs above 20 °C WBGT from fitness updates.**
- On easy runs and in beginner mode, switch to an HR cap or RPE cap instead of a pace offset.
- Examples at WBGT 20 °C: persona B's goal MP 6:03 → +6.5% → **6:26/km**; persona C's HM GP 4:16 → +3.5% → **4:25/km**.

### 4.9 GPS and sensor cleaning (all D)

| Step | Default |
|---|---|
| Distance source | Use device cumulative distance (from the FIT file), not recomputed lat/lng |
| Point rejection | Drop points where implied speed > 8 m/s, \|accel\| > 4–5 m/s², or accuracy > 20–25 m. Interpolate gaps under 10 s and flag longer ones. |
| Speed smoothing | Centered rolling median over 5–9 s, then a mean or Savitzky–Golay filter. **Splits and laps always use Δdist/Δtime.** |
| Auto-pause | Honor device pauses. Otherwise moving if smoothed speed ≥ 0.8–1.0 m/s; stopped after 3–5 s below. **Run/walk sessions: keep walk segments as moving time** (they are prescribed). |
| HR | Drop samples below 40 bpm or above HRmax+5. Skip the first 5–10 min for EF and regression. Flag cadence lock. |
| Qualifying steady segment | Run ≥ 20 min; 60-s windows with speed CV < 8% and HR CV < 5%; temperature-normalized; not intervals |

### 4.10 When fitness changes paces (rule FIT-UPDATE, D)

**Evidence hierarchy:** race (all-out, verified distance, heat-adjusted) > TT or hard best effort > CS fit > HR–pace trend > Uth ratio > easy-pace fallback.

Step size is defined in pace: **one step = the VDOT change that moves T pace by about 1.2%**. That is ≈ +0.4 VDOT at VDOT 25, +0.5 at 34, +0.75 at 50 and +0.9 at 60. Compute it with the equations rather than looking it up.

| Trigger | Action |
|---|---|
| Race or TT result with new VDOT > current | Set VDOT immediately (Runna's benchmark-override pattern, C) |
| Race result ≥ 2 steps below and not explained by heat, illness or course | Prompt the user; never auto-drop. **Exception:** a TT replacing an `estimated` VDOT (§4.2). |
| Training EWMA (τ = 21–28 d, qualifying runs only) ≥ current + 1–2 steps | Requires ≥3 qualifying runs over ≥14 d and user acceptance. Step +1. Cap at +2 steps per 2–3 weeks. |
| Training EWMA ≤ current − 4 steps for ≥3 weeks, or >2 weeks below 50% of planned volume | Prompt for a downgrade, or apply R-BREAK |
| Final 4–6 weeks before a race | Never change goal/M pace from HR data alone; races and TTs only |
| First 7 days after a break or illness | Ignore HR-derived estimates; blood volume falls within days, so HR runs high ([Mujika & Padilla 2000](https://runpanel.co.il/wp-content/uploads/2023/08/Detraining-Loss-of-Training-Induced-Physiological-and-Performance-Adaptations.-Part-I.pdf)) |
| Beginner mode | Only a TT can set or change VDOT |

On any VDOT change, re-sync the intervals.icu threshold pace (§3.7) and re-push the next 14 days.

---

## 5. Units and display (D)

- **Internal storage is SI only:** m, s, s/km, m/s, kg, °C, bpm. Never store display-unit values.
- **`user_profile.units`** (`metric` | `imperial`) controls display only:
  - Pace min/km ↔ min/mi (× 1.609344).
  - Distance km ↔ mi.
  - Elevation m ↔ ft.
  - Temperature °C ↔ °F.
  - Load kg ↔ lb.
- **Rounding at display time:**
  - Pace to 1 s; ranges rounded outward (slow end up, fast end down) so the displayed range never narrows.
  - Run distances to 0.1 km/mi; long-run prescriptions to 0.5 km/mi.
  - Rep distances keep metric track units (200/400/800/1,000 m) for all users, with mile equivalents in brackets (C: track distances are metric worldwide).
  - Strength loads: lb users get increments of 5 lb (squat/hinge) and 2.5–5 lb (small lifts), mirroring +5 kg / +2.5 kg.
- **Caps are stored once in SI.** The constants table (§13) lists metric values. Imperial equivalents: 16 km ≈ 9.9 mi, 20 ≈ 12.4, 22 ≈ 13.7, 32 ≈ 19.9, 35 ≈ 21.7.
- **Watch delivery is always SI** (m/s, m, s). Units on the watch follow the watch's own setting. Distance-step units on Suunto/Garmin via intervals.icu follow the sport's pace units in intervals.icu (Platform).

---
## 6. Plan generator

### 6.1 Inputs and plan modes

All inputs come from that user's own profile, goal, schedule and history (§2.2–2.3). The generator never reads another user's data.

**Derived inputs:**
- `level`: min(self-report, derived), from §2.3.
- `current_weekly_km`: median of the last 4 non-cutback weeks. Entered value when there is no history.
- `longest_run_30d`: longest non-race run in the last 30 days, in both distance and duration.
- `VDOT` and `vdot_status`: `race` | `tt` | `estimated` | `none`.
- `k_user`.
- `HRmax` and its source.
- `locked_events[]`: cross-training and external lifting (§10.2).
- `strength_config` (§9).
- `prescription_mode` (§6.6).

| Mode | When | Structure |
|---|---|---|
| **Race** | goal_type = race | Daniels phases (§6.3) ending in a taper (§6.8) |
| **General fitness / base building** | goal_type = general_fitness | Rolling 4-week blocks (3 build + 1 cutback; 2 + 1 under C1 risk flags). Weekly target time or volume. Phase content cycles FI → EQ-style, with a TT every 6–8 weeks. No taper. (D on C) |
| **Beginner ladder** | level = beginner and can't yet run 20 min continuously | Run/walk progression (§6.9), then hands over to Race or General mode |

### 6.2 Goal feasibility checks (mostly D on C)

These run at onboarding, on goal or profile edits, and in R-RACE replans. Each check returns `ok` | `warn` | `block`, plus an alternative.

**Minimum plan length and entry fitness per distance.** "Entry" means what the user should already have at week 1.

| Distance | Min weeks (all levels) | Ideal weeks | Extra weeks for beginner / novice | Entry weekly volume | Entry longest run (30 d) | Other | Label |
|---|---|---|---|---|---|---|---|
| 5K | 6 (from running 20 min continuously); **9 from run/walk** | 8–12 | Ladder first (§6.9) | ≥ 6 km or 60 min | ≥ 2.5 km or 20 min continuous (or the run/walk ladder) | — | C (C25K 9 wk) / D |
| 10K | 8 | 10–12 | +4 (12) if beginner | ≥ 12 km or 90 min | ≥ 5 km or 35 min | Beginner: suggest a 5K first | D on C |
| HM | 10 (8 if intermediate+ with entry met) | 12–14 | +2 novice; beginner → block | ≥ 20 km or 2.5 h | ≥ 10 km or 70 min | ≥ 6 months running | D on C |
| M | **12** | 16–20 (18 canonical) | +4 novice (16 min); beginner → block | ≥ 30 km or 4 h | ≥ 14 km or 100 min | ≥ 12 months running recommended; ≥ 6 months required; an HM finished is recommended | D on C |

Rationale:
- The minimum and ideal weeks come from the original P1 values (5K/10K 6 / 8–12, half 8 / 10–14, marathon 12 / 16–20), adjusted by level.
- Entry minimums are designer defaults chosen so that V1 (+10% per long run) plus normal progression can reach the L1 peak inside the available build weeks. The engine checks reachability directly with R-RACE-2. The table gives fast pre-checks.
- Novices carry roughly 2.3× the injury rate of recreational runners per hour ([Videbæk 2015](https://pubmed.ncbi.nlm.nih.gov/25951917/), E), which is why the novice and beginner rows are stricter.

**Reachability check (D, authoritative).** Simulate long runs from `longest_run_30d`:
- Step +10% per long run (V1), with the cutback pattern (§6.7), across `weeks_available = weeks_to_race − taper_weeks`.
- If the simulated peak long run is below **85% of the plan's own L1 target** (§6.6), the result is `warn`. Below 70% it is `block`.

**Goal-time checks (D on C):**

| Check | Threshold | Result |
|---|---|---|
| Goal VDOT − current VDOT (after PACE-FADE for HM/M) | ≤ 1.5 | ok |
| | > 1.5 and ≤ 3.0 | **warn "aggressive"**: show the realistic band (current VDOT + 0 to + 1.0, as times) |
| | > 3.0 | **warn "unrealistic in this block"**: default the goal to current + 1.0, user can override |
| Beginner / novice with `estimated` VDOT | any goal time | Treat the goal time as informational until a TT exists; no pace targets from it |
| Weeks < 12 and Δ > 1.0 | — | warn |
| Goal time entered without any VDOT evidence | — | Prompt a TT (§4.2) |

The +1.5 threshold carries over from the original spec (D). Beginners improve faster than trained runners: a vendor claims +10–20% VO2max in 4–10 weeks ([Firstbeat](https://www.firstbeat.com/en/science-and-physiology/fitness-level/), vendor, weak). Even so, the threshold is **not** raised for them. Their goal times are informational until a TT anchors them.

**What the app recommends instead.** It always offers 2–3 options, ranked:
1. **A later race date:** the earliest date satisfying min weeks and reachability.
2. **A shorter distance on the same date**, e.g. HM instead of M, or 5K instead of 10K.
3. **A finish or run/walk goal:** no goal time, M pace replaced by an RPE 5 target, and run/walk race strategy offered (§6.9).
4. **A base-building block first:** General mode for N weeks, then re-check.
5. **A slower goal time:** the time at current VDOT + 1.0, with fade for HM/M.

**Persona outcomes (computed):**

| Persona | Goal | Checks | Result |
|---|---|---|---|
| A | 5K in 10 wk, no time | Beginner from run/walk needs 9 wk; entry ok (12 km/wk, 5 km run/walk) | ok. Ladder → TT → 5K block. Later goal check: 35:00 → Δ +0.8, ok. |
| B | M in 18 wk, 4:15:00 | Weeks ok; entry 40–45 km and 14+ km long run ok; Δ **+1.48** | ok, with a note that the goal is at the edge of the flag. A 4:10 goal (Δ +2.35) would warn. |
| C | HM in 14 wk, 1:29:59 | Weeks ok; entry ok; Δ +0.99 | ok. A 1:28 goal (Δ +2.32) would warn. |

### 6.3 Phase lengths (Daniels table, C)

Weeks are allocated as FI (Foundation/Injury-prevention), EQ (Early Quality), TQ (Transition Quality) and FQ (Final Quality). They are filled in the order FI up to 3, then FQ, then TQ, then EQ ([Coach Ray](https://coachray.nz/2021/10/11/jack-daniels-phd-formulaic-approach-to-periodisation)):

| Weeks | FI | EQ | TQ | FQ |
|---|---|---|---|---|
| 4 | 3 | 0 | 0 | 1 |
| 6 | 3 | 0 | 0 | 3 |
| 8 | 3 | 0 | 2 | 3 |
| 10 | 3 | 1 | 3 | 3 |
| 12 | 3 | 3 | 3 | 3 |
| 14 | 4 | 3 | 4 | 3 |
| 16 | 4 | 3 | 6 | 3 |
| 18 | 4 | 4 | 6 | 4 |
| 20 | 4 | 6 | 6 | 4 |
| 22 | 5 | 6 | 6 | 5 |
| 24 | 6 | 6 | 6 | 6 |

Rules:
- **P1 (D on C):**
  - Plans shorter than the §6.2 minimum get the feasibility flow.
  - Plans longer than 24 weeks get base/maintenance weeks prepended (General mode).
  - Beginners and novices get FI extended by 1–2 weeks, taken from EQ, so EQ ≥ 0.
- **P2:** the taper is carved from the end of FQ (§6.8).
- **P3 emphasis by phase (C, Daniels):**

| Distance | FI | EQ | TQ | FQ |
|---|---|---|---|---|
| Marathon | E + strides, steady long runs | R/I then T; keep LR | I or T + LR (M secondary) | T + M + LR |
| Half | E + strides | R + T | I/H + T | T dominant + GP |
| 10K | E + strides | R/hills, T | I, R | T + some I + GP |
| 5K | E + strides | R | I | T + maintenance I + GP |

For beginners and novices, R/I content is replaced by hills, strides and T-by-RPE until VDOT status is `tt` or `race`, and I work starts no earlier than TQ (D).

Persona phase splits:
- A: 10 weeks = 3/1/3/3, preceded by ladder weeks counted inside FI.
- B: 18 weeks = 4/4/6/4.
- C: 14 weeks = 4/3/4/3.

Pfitzinger's marathon mesocycles, for reference: Endurance → LT + endurance → race prep → 3-week taper → **5-week post-race recovery** ([Running with Rock](https://runningwithrock.com/pfitz-marathon-training-explained/)). A user starting a block within 5 weeks after a marathon starts with the recovery template. The race itself is excluded from the V1 reference (§6.5).

### 6.4 Intensity distribution and quality count

**I1, pyramidal by running time (E → D):** ≥75–80% Z1 (E/L/recovery), 10–15% Z2 (T/M), 5–10% Z3 (I/R).
- The 2025 IPD network meta-analysis found no difference between polarized and pyramidal (VO2max SMD −0.06, TT SMD −0.05). A post hoc subgroup suggests recreational athletes may do better on pyramidal ([Rosenblat 2025](https://www.stir.ac.uk/research/hub/publication/2095779), E).
- Elite marathoners train pyramidally ([Casado 2022](https://lida.sport-iat.de/ta/Record/4076169?lng=en), E).
- Measure the easy share by pace or RPE, not HR alone. HR understates Z3 time, 3.4% vs 14.7% in one dataset ([Bellinger 2019 via Outside](https://www.outsideonline.com/health/training-performance/training-distribution-study/?scope=anon), E).
- Run/walk sessions count as Z1.

**I2, maximum quality sessions per week by level × run days (C/D).** Quality means T, I, R, hills, an M/GP block of 20 min or more, or a long run with M or fast-finish segments. Strides are not quality. There are **never more than 3 key sessions a week, counting the LR** (C).

| Level | 2–3 run days | 4 | 5 | 6–7 |
|---|---|---|---|---|
| Beginner | 0 (strides from ladder graduation on) | 0–1: one short T/fartlek **by RPE** after graduation | same as 4 | n/a (beginners capped at 4 days) |
| Novice (3–12 mo) | 1 + easy LR | 1 + easy LR | 1 + LR (quality LR every other week from TQ) | 1 + LR; a 2nd quality only if > 6 months running and ≥ 48 h between all key sessions |
| Intermediate | 1 + easy LR | 1 + LR. A 2nd quality only if the LR is easy and ≥48 h separate them. | 2 + easy LR, **or** 1 + quality LR | 2 + LR |
| Advanced | 1 + LR (quality LR allowed) | 2 + easy LR (48 h rule) | 2 + LR (quality LR alternate weeks) | 2 + LR; 3 key max |

Basis: Higdon's tiers (Novice 0 quality, Intermediate 1, Advanced 1–2) and Hansons' 3 SOS/week as the upper bound ([Running with Rock](https://runningwithrock.com/hal-higdon-marathon-training-plan/), [Marathon Handbook](https://marathonhandbook.com/hansons-marathon-method/), C). The original rule "under 6 months running: 1 quality + LR" is preserved in the novice row.

**Hard cross-training counts against the key-session budget (D).** A cross-training session that is a "hard day" under §10.2 counts as **half a key session**. Two hard cross-training days in a week therefore remove one quality run. This is how persona B's hard paddling session is handled.

Persona outcomes:
- A: 0 quality, strides from week 4; after graduation, 1 RPE-based T session.
- B: intermediate at 4 days → 1 Q + LR (a 2nd Q only on easy-LR weeks). The hard paddle (½) plus Q + LR gives 2.5 of 3 key sessions.
- C: advanced at 6 days → 2 Q + LR.

### 6.5 Volume progression

The evidence:
- **The 10% rule is unsupported.** A graded 10% program didn't reduce injuries in novices ([Buist 2008](https://bjsm.bmj.com/content/43/2/155), E RCT).
- Weekly increases above 30% showed a non-significant signal for distance-related injuries: HR 1.59, CI 0.96–2.66 ([Nielsen 2014](https://vbn.aau.dk/da/publications/excessive-progression-in-weekly-running-distance-and-risk-of-runn), E).
- **The strongest signal is per session.** In 5,205 runners over 588k sessions, runs **more than 10% longer than the longest run of the prior 30 days** carried HRs of 1.64 (>10–30%), 1.52 (>30–100%) and 2.28 (>100%). Weekly ACWR showed no clear association ([Frandsen 2025, BJSM blog](https://blogs.bmj.com/bjsm/?p=11751), E-obs; cohort 78% men, mean age 46).
- ACWR is methodologically compromised ([Impellizzeri 2020](https://opus.lib.uts.edu.au/handle/10453/141898), [Lolli 2019](https://bjsm.bmj.com/content/53/15/921)).

| ID | Rule | Label |
|---|---|---|
| **V1** (hard validator) | Every planned run: `distance ≤ 1.10 × max(single non-race run distance, prior 30 days)`. In time mode, also `duration ≤ 1.10 × max non-race run duration, prior 30 d`. Run/walk sessions count by total duration. **Races are excluded** from the reference. With no history, the reference is the entered longest run. | E-obs (distance). Time variant, race exclusion and run/walk handling are D. |
| V2 | Weekly growth target 5–10%, hard cap 15%, absolute never above 30%. At low volume (< 25 km/wk), allow +1.5–3 km per run day per build week instead. Beginners: ≤ +10% weekly running *time* inside the ladder. | C/D (Nielsen signal for the 30%) |
| V3 | `peak_weekly = min(start × 1.08^net_build_weeks, start + Δmax, ceiling[level][distance])`. Δmax = 15 km (novice), 25 km (intermediate), 30 km (advanced). Week 1 starts at current volume. | D |
| V4 | ACWR, if shown, is uncoupled EWMA and informational only | E (critique) |
| V5 | Alternative step-loading: hold volume about 4 weeks, then raise it (Daniels) ([Canadian Running](https://runningmagazine.ca/?p=99607)) | C |

**Peak weekly ceilings by level (km/week, D):**

| Level | 5K / 10K | HM | M |
|---|---|---|---|
| Beginner | 15–25 | — (blocked) | — (blocked) |
| Novice | 20–40 | 30–45 | 40–55 |
| Intermediate | 30–55 | 40–65 | 50–80 |
| Advanced | 45–80 | 55–95 | 65–110 |

- The engine picks the ceiling as min(range max, max(range min, 1.5 × entry volume)).
- In time mode, ceilings convert to minutes at the user's E-pace midpoint.
- Context: 4:40–4:59 marathoners averaged about 45 km/week over 16 weeks ([Fetcheveryone](https://www.fetcheveryone.com/article/marathon-predictions-3-0-116)), and volume predicts marathon outcome independently of race times ([Vickers 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5000509/), E).
- Hansons' tiers run from about 20 to 55 mpw for beginners, and Pfitzinger's peaks run from 55 to 105+ mpw (C).

### 6.6 Long run, and time- vs distance-based prescriptions

The conventions (all C; no experimental optimum exists):
- **Daniels:** at most 30% of weekly volume below 64 km/week, otherwise the lesser of 25% or 150 min ([Canadian Running](https://runningmagazine.ca/?p=99607)).
- **Higdon:** peaks at 20 mi.
- **Pfitzinger:** up to 21–22 mi at 10–20% slower than MP.
- **Hansons:** caps at 16 mi.

Sources: [Higdon](https://runningwithrock.com/hal-higdon-marathon-training-plan/), [Pfitz](https://runningwithrock.com/pfitz-marathon-training-explained/), [Hansons](https://runningwithrock.com/pros-and-cons-of-the-hanson-marathon-training-plan/).

**L1 (D on C). Caps by time AND distance, because time caps bind for slower runners and distance caps for faster ones:**

```
LR_max = min( 1.10 × longest_nonrace_30d,                        // V1, hard
              time_cap[level][distance] / LR_pace,               // converts minutes → km at the user's LR pace
              distance_cap[level][distance],
              pct_hard[distance] × planned_weekly_km )           // pct_hard = 0.45 M, 0.35 others
warn if LR > 0.30 × weekly (weekly < 64 km) or > 0.25 × weekly (≥ 64 km)       // Daniels, soft
```

| Cap | 5K | 10K | HM | M | Label |
|---|---|---|---|---|---|
| time_cap: beginner | 60 min | 75 min | — | — | D |
| time_cap: novice | 75 min | 90 min | 120 min | 150 min | D |
| time_cap: intermediate | 90 min | 105 min | 150 min | 150 min; **180 min in Higdon/Pfitz mode** | C (Daniels 150) / D |
| time_cap: advanced | 100 min | 120 min | 150 min | 150 min; 180 min in Higdon/Pfitz mode | C / D |
| distance_cap (all levels) | 16 km | 20 km | 22 km | 32 km (advanced 35 km in Pfitz mode) | D on C (Higdon 20 mi, Pfitz 22 mi) |

**LR pace for the time→km conversion (C/D):**
- Marathon plans: MP + 10–20% (Pfitzinger), where MP is the goal pace if one is set, clamped so it is never faster than the fast end of E.
- Other distances: the E band, using 65–74% as the default sub-band.
- Beginners: E or RPE 3–4.

Persona outcomes (computed):

| Persona | LR pace | Time cap → km | Distance cap | Binding cap at peak |
|---|---|---|---|---|
| A (5K, beginner) | E 8:29–9:20 /km | 60 min → 6.4–7.1 km | 16 km | **Time** (and V1 week to week) |
| B (M, intermediate) | 6:42–7:15 /km (goal MP 6:03 + 10–20%, clamped to E) | 150 min → 20.7–22.4 km; 180 min → 24.8–26.9 km | 32 km | **Time**. At a 50 km peak, pct_hard 0.45 → 22.5 km, also near-binding. |
| C (HM, advanced) | 4:54–5:26 /km | 150 min → 27.6–30.7 km | 22 km | **Distance** (22 km). pct_hard 0.35 × 65 → 22.75 km. |

The UI presents the marathon trade-off explicitly: Daniels mode (150 min) vs Higdon/Pfitz mode (180 min, which surfaces a Daniels 25–30% soft-cap breach as a convention warning).

**L2 progression (D on E):**
- At most +10% or +2 km (+10 min in time mode) over the 30-day longest run.
- −25 to −35% in cutback weeks.
- Peak long run 3–5 weeks before the race.

**L3 content (C):**
- From EQ on, alternate easy long runs with M-segment or fast-finish long runs about every other week, for intermediate and advanced runners.
- Novices: fast finish only, from TQ.
- Beginners: always easy.

**Prescription mode (D).** This sets how a session is expressed; caps and validators always run in SI.

| Condition | Easy runs | Long run | Intervals | Label |
|---|---|---|---|---|
| Beginner, or `vdot_status` ∈ {none, estimated} | minutes + RPE | minutes | minutes by RPE | D |
| Novice, or E pace slower than 7:30/km (12:04/mi) | minutes | minutes (km shown as an estimate) | time-based reps | D |
| Intermediate | user choice (default minutes) | km with time cap shown | distance or time reps by rule below | D |
| Advanced | km | km | distance reps | D |

Rationale: distance-based prescriptions give slower runners more time on their feet for the same "session". Time-based prescriptions equalize stimulus duration and are standard in beginner programs (C, NHS C25K is entirely time-based).

**Rep-length rule (D on C):**
- I reps stay within Daniels' 3–5 min window.
- R reps are ≤ 2 min.
- Distance reps are chosen so the rep duration at the user's pace falls in that window. Otherwise the app switches to time reps.
- Examples:
  - I: A gets 600 m ≈ 4:02–4:12 (1 km would be 6:44–7:00, too long); C gets 1,200 m ≈ 4:36–4:48.
  - R: A gets 200–300 m (400 m ≈ 2:41, too long); C gets 400 m ≈ 87 s.

### 6.7 Cutbacks (C/D; no trials exist)

**C1 frequency:**

| Condition (any) | Pattern |
|---|---|
| Default | 3:1 (every 4th week) |
| Age ≥ 40 (if provided), injury flag past 12 months or current, beginner or novice, heavy cross-training (cross-training `total_load` > 40% of total over the last 4 weeks), or R-LOAD-4 | **2:1** (every 3rd week) |
| Advanced, age < 40 (or not given), no flags, opt-in | 4:1 allowed |
| Beginner ladder | No cutbacks. Repeat the stage instead (§6.9). |

Basis: the original "over 40, injury-prone, under 1 year, heavy cross-training → 2:1" rule ([RunnersConnect](https://runnersconnect.net/?p=6471), C), now driven by profile fields. Age is optional. If it isn't given, no age rule applies. The 40% cross-training threshold is D.

**Cutback size:**
- Weekly volume −20 to −30%; long run −25 to −35%.
- Keep one shortened quality session at 60–70% of its normal work volume.
- Resume at the pre-cutback level (e.g. 40-44-48-**34**-48-52).
- The "3 up / 1 down" convention runs about a 15–17% drop (C).

**C2:**
- No cutback in the week right before the taper.
- Align cutbacks to phase boundaries.
- A tune-up race or TT week counts as a cutback.

Persona outcomes:
- A: ladder, then 2:1 (beginner).
- B: 2:1. The paddling + lifting share is likely > 40% of `total_load`; confirm with actual sRPE logs.
- C: 3:1 (4:1 opt-in if under 40).

### 6.8 Taper

The evidence:
- A meta-analysis of 27 studies found about 2 weeks best, with **volume −41–60% reduced exponentially and intensity and frequency kept** ([Bosquet 2007](https://pubmed.ncbi.nlm.nih.gov/17762369/), E).
- 8–14 days was best; ≥22 days was not significant ([Wang 2023](https://www.fisiologiadelejercicio.com/wp-content/uploads/2023/05/Effects-of-tapering-on-performance-in-endurance-athletes.pdf), E).
- In about 158k Strava marathoners, **strict 3-week tapers** beat relaxed 1-week tapers by about 5.5 min ([Smyth & Lawlor 2021](https://marathonhandbook.com/optimal-marathon-taper-length/), E-obs).

**T1 length:**
- Marathon: 3 weeks (2 if peak < 50 km/week).
- Half: 2 weeks.
- 10K: 7–10 days.
- 5K: 5–7 days.
- **Never under 7 days** (R-RACE-1). For a 5K the 7-day minimum governs volume, and the last hard session stays at 4–6 days out.
- Beginner first races: 7 days.

**T2 volume multipliers** vs the peak week, strictly monotonic (C, [RunnersConnect](https://runnersconnect.net/running-training-articles/how-to-taper-for-a-marathon/)):

| Taper | Wk −3 | Wk −2 | Race week |
|---|---|---|---|
| Marathon | 0.80–0.85 | 0.65–0.70 | 0.40–0.50 (excl. race) |
| Half | — | 0.70–0.75 | 0.45–0.55 |
| 5K/10K | — | — | 0.55–0.65 |

**T3 intensity and long runs:**
- Same run days, or drop at most one.
- One quality session per week at goal pace, with 30–50% less work volume.
- Long run at −2 weeks is about 50–60% of peak.
- Last hard session 7–10 days out (M/HM) or 4–6 days out (5K/10K). After that, only strides and goal-pace touches.

Example: persona B at a 50 km peak → weeks −3 / −2 / −1 = **40–43 / 33–35 / 20–25 km**.

### 6.9 Beginner path: run/walk ladder (C/D)

Basis:
- NHS Couch to 5K: 9 weeks, 3 runs a week with rest days between, starting with 1-min runs alternating with 1:30 walks, ending at 30 min continuous. Users may take longer ([NHS](https://www.nhs.uk/live-well/exercise/get-running-with-couch-to-5k/), C).
- In an RCT of 42 non-elite marathoners, run/walk gave a similar finish time (4:14 vs 4:08, ns) with **less muscle pain and fatigue** ([Hottenrott 2016](https://edoc.unibas.ch/57171), E). Run/walk is therefore a legitimate race strategy, not just a training crutch.

**Ladder (D, modeled on C25K; the exact NHS week-by-week schedule wasn't retrieved).** Each stage is 3 sessions in one week. Every session = 5 min brisk walk + block + 5 min walk.

| Stage | Block | Run time |
|---|---|---|
| 1 | 8 × (1:00 run / 1:30 walk) | 8 min |
| 2 | 6 × (1:30 / 2:00) | 9 min |
| 3 | 6 × (2:00 / 1:30) | 12 min |
| 4 | 5 × (3:00 / 1:30) | 15 min |
| 5 | 4 × (5:00 / 2:00) | 20 min |
| 6 | 2 × (10:00 / 2:00) | 20 min |
| 7 | 2 × (12:30 / 2:00) | 25 min |
| 8 | 20 min continuous | 20 min |
| 9 | 25 min continuous | 25 min |
| 10 | 30 min continuous | 30 min |

Rules (D):
- **Entry stage** comes from the onboarding answers. "Can run 20 min continuously" means the user skips the ladder.
- **Advance** when all 3 sessions of the stage were completed with RPE ≤ 5 and R-PAIN green.
- **Repeat** the stage on any amber pain or RPE ≥ 7.
- **Step back** one stage after a red pain or a missed week.
- **Pace:** none. Runs are at RPE 3–4 (talk test). If HRmax is known (measured), there's an HR cap at 79% HRmax.
- **Graduation:** at stage 8 or later, schedule the 3K/30-min TT (§4.2 path A) within 2 weeks. Then hand over to the Race or General plan with VDOT paces.
- **Strength for beginners:** bodyweight technique block only (§9).
- **Race-day option:** for any user whose expected marathon is slower than about 4:30, or who is a novice, offer a run/walk race strategy (e.g. 4–9 min run / 0.5–1 min walk) as an alternative to continuous running. This is D on E (Hottenrott).

### 6.10 Workout library

Paces come from §4.1. Caps are Daniels %-of-weekly limits ([Coach Ray](https://www.coachray.nz/2023/05/03/jack-daniels-running-intensity/), [Running with Rock](https://runningwithrock.com/training-explained-jack-daniels-running-formula/)); formats come from Pfitzinger and Hansons ([Pfitz](https://runningwithrock.com/pfitz-marathon-training-explained/), [Luke Humphrey](https://lukehumphreyrunning.com/the-classic-hanson-marathon-training-programs/)), C.

| Type | Format by level (D on C) | Progression (D) | Hard cap (C) | Pace: A / B / C |
|---|---|---|---|---|
| Easy | 20–75 min (beginner 20–35 min) | grows with volume | — | 8:29–10:01 / 6:42–7:58 / 4:54–5:52 |
| Recovery | 20–40 min, slower than E | — | — | RPE 2 |
| Strides | 4–8 × 15–20 s, relaxed ≈ R, after an easy run | 4 → 8 | ≤ 2×/wk | — |
| Long | §6.6 | +≤10% / +≤2 km or +10 min | L1 | §6.6 |
| T | Novice: 2–3 × 8 min, or 15–20 min by RPE 6–7. Intermediate: 20 → 30 min continuous, or cruise 3–6 × 5–10 min with 1-min jog. Advanced: up to 40 min cruise. | +5 min T per 1–2 wk | ≤ 10% weekly | 7:26–7:46 / 5:50–6:07 / 4:15–4:28 |
| I | 4–6 reps of 3–5 min (rep-length rule §6.6), jog ≈ rep time. Not for beginners; novices from TQ. | +1 rep or +1 min/rep every 1–2 wk | ≤ 8% weekly; reps 3–5 min | 6:44–7:00 / 5:16–5:30 / 3:50–4:00 |
| R | 8–12 reps of ≤ 2 min (200–400 m), full recovery (2–3 × rep time) | +2 reps | ≤ 5% weekly | 6:43 / 5:09 / 3:37 |
| Hills | 6–10 × 30–60 s up at hard effort, walk down. Allowed for novices and beginners (post-ladder, 4–6 reps). | +2 reps | counts as R/I | RPE 8 |
| M / GP | 20 min → 90–110 min, standalone or inside the LR (Hansons tempo 5 → 10 mi). HM/10K/5K GP blocks: race-specific row. | +1–2 km per exposure | ≤ 110 min per session; < 20% weekly | goal pace: — / 6:03 / HM 4:16 |
| Fast-finish LR | last 15–25% at M or HM pace | — | counts as quality | — |
| Race-specific | 5K: 5 × 1 km (or 5 × 4–6 min) at GP. 10K: 3 × 2 km. HM: 2–3 × 3–5 km. | — | counted under the I or T caps | — |
| Time trial | 3K / 5K / 30 min (§4.2) | every 4–6 wk in base/EQ | counts as a key session | all-out |

Caps at 50 km/week: T 5 km (~30 min), I 4 km, R 2.5 km, M 10 km. Below 30 km/week, a minimum session of 2 × 8 min T or 4 × 3 min I is allowed even if it exceeds the % cap (D: % caps produce unusable micro-sessions at low volume).

Pace targets on the watch are sent as ranges (e.g. T 5:50–6:07/km for persona B), with an HR fallback in the DSL (§3.8) and display in the user's units.

---

## 7. Weekly scheduler

### 7.1 Placement algorithm (C/D)

Hard/easy alternation is standard ([Casado 2022](https://lida.sport-iat.de/ta/Record/4076169?lng=en)). Hansons deliberately breaks it for cumulative fatigue ([Marathon Handbook](https://marathonhandbook.com/hansons-marathon-method/)).

1. Place `locked_events` first: cross-training with fixed days and external lifting (§9.6). Classify each as hard or easy per §10.2.
2. Put the LR on `long_run_day`.
3. Put Q1 at least 2 days after the LR. Put Q2 at least 2 days after Q1 and at least 2 days before the LR (48 h rule, C).
4. Hard constraints:
   - No two quality runs on consecutive days.
   - The day before the LR is easy or rest.
   - The day after the LR is easy, recovery or rest.
   - **No quality run within 24 h after a hard cross-training session** (§10.2).
   - **No hard cross-training session on the day before the LR**, and no team-sport or HIIT session within 24 h before a quality run.
   - Beginners: no consecutive run days in the first 4 weeks (C25K rest days).
   - Respect `max_session_minutes_by_day`.
5. Place strength sessions (§9.5).
6. Spread easy volume (S3): `easy_total = weekly − LR − quality`. No easy run longer than 60–70% of the LR or shorter than 20 min (beginner 15 min). If that can't be satisfied, flag "needs more days".
7. Validate every run against V1 and every week against V2.
8. **Fallbacks, in order:**
   1. Move Q2 to another legal day.
   2. Convert Q2 to easy + strides.
   3. Shorten the LR to the largest legal value.
   4. Drop one strength session.
   5. Suggest moving a non-locked cross-training session.
   6. Report the infeasibility to the user.
   Never stack two key sessions to fit.

### 7.2 Templates (Sunday long run)

| Days | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|---|
| 2 (general fitness only) | – | E (+ strength) | – | – | – | – | L |
| 3 | – | Q + Strength A (PM) | – | E + Strength B (PM) | – | – | L |
| 3 (beginner ladder) | Run/walk | – | Run/walk | – | – | Run/walk | – |
| 4 | – | Q1 + Strength A | – | E or Q2* + Strength B | – | E | L |
| 5 | – | Q1 + Strength A | E | Q2 + Strength B | – | E | L |
| 6 | E (recovery) | Q1 + Strength A | E | Q2 + Strength B | – | E | L |
| 7 | E (recovery) | Q1 + Strength A | E | Q2 + Strength B | E (short) | E | L |

\*In the 4-day template, Q2 goes in only when the LR is easy; Thu→Sun gives 72 h. This **keeps the earlier correction to the source notes' 4-day template**, which put Q2 on Saturday, the day before the long run, in breach of their own 48 h rule. For any other long-run day, rotate the whole template so the LR lands on that day.

Where Q is absent for the level (§6.4), the Q slot becomes E + strides. "Strength A/B" = lower-body or full-body sessions per §9. With strength off, the slots are empty.

---

## 8. Adaptive replanning

Commercial apps don't publish thresholds; what they do publish is summarized below. All numeric thresholds in this section are **D unless labelled otherwise**.
- **Runna:** explicit skip; a realignment prompt after more than 3 missed runs or a missed week; a 3–14-day "Not Feeling 100%" mode; opt-in pace insights that need "a clear trend" ([Runna realignment](https://support.runna.com/en/articles/10026375-how-to-use-the-plan-realignment-feature), [Pace Insights](https://support.runna.com/en/articles/10854865-what-are-pace-insights-and-how-do-pace-recommendations-work), [Feeling unwell](https://intercom.help/runna/en/articles/12809806-feeling-unwell-how-to-adapt-your-training-plan)).
- **TrainAsONE:** deletes missed runs and re-plans overnight ([FAQ](https://trainasone.com/faqs/2025/i-missed-a-workout-and-now-it-has-disappeared-how-can-i-do-it-today)).

**Compliance classification:** completed as a % of planned duration or distance. Green 80–120%, yellow 50–79% or 121–150%, orange <50% or >150%, red missed ([TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204861204), C). If weekly compliance is **≥90%**, make no structural change (Pfitzinger, [Human Kinetics](https://us.humankinetics.com/blogs/excerpt/what-to-do-when-your-marathon-training-gets-interrupted), C). For run/walk sessions, compliance is measured on total duration.

Every replan writes new rule traces (§11.4) and re-pushes the next 14 days (§3.2).

### R-MISS: missed sessions

| ID | Trigger | Action | Label |
|---|---|---|---|
| R-MISS-1 | Missed easy or recovery run | Drop it. Never add its km elsewhere. | C (Runna, TrainAsONE) |
| R-MISS-2 | Missed key session | Move it within the same week only if all §7.1 constraints still hold. Otherwise drop it. | C/D |
| R-MISS-3 | Missed LR | Re-insert only if it lands ≥4 days from the next LR and passes V1 | D on E (Frandsen) |
| R-MISS-4 | More than 3 missed, or a full week missed | Prompt realignment. Fixed-date plan: rebuild from today to the race. Open plan: extend. Never "repeat a week"; re-anchor to the load actually completed over the last 2–3 weeks. Beginner ladder: step back one stage. | C (Runna) |

### R-BREAK: consecutive days with no running

Daniels' pace multiplier on prior training velocity ([RunnersTribe](https://runnerstribe.com/?p=8591), C, secondary):

| Days off | 5 | 7 | 10 | 14 | 21 | 28 | 35 | 42 | 56 | 70 | ≥72 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| No cross-training | 1.000 | 0.994 | 0.985 | 0.973 | 0.952 | 0.931 | 0.910 | 0.889 | 0.847 | 0.805 | 0.80 |
| Aerobic cross-training | 1.000 | 0.997 | 0.992 | 0.986 | 0.976 | 0.965 | 0.955 | 0.944 | 0.923 | 0.900 | 0.90 |

- Interpolate linearly between columns. Every pace velocity is multiplied by the factor; equivalently, divide paces in seconds by it.
- This is consistent with VO2max falling about 7% at 21 days and about 16% at 56 days, then plateauing ([Coyle via TrainingPeaks](https://www.trainingpeaks.com/blog/what-happens-to-your-body-during-a-training-break/); [Mujika & Padilla](https://paulogentil.com/pdf/Detraining%20-%20Loss%20of%20Training-Induced%20Physiological%20and%20Performance%20Adaptations.%20Part%20II.pdf), E).
- **The "aerobic cross-training" column applies** when the user logged ≥ 3 sessions/week of activities marked aerobic in §10.2 during the break (D).

| Break | Action |
|---|---|
| ≤5 d | Resume at the calendar position with unchanged paces |
| 6–28 d | 50% of pre-break weekly volume for `ceil(d/2)` days, then 75% for `ceil(d/2)` days, all easy, no quality during the 50% phase. Apply the pace multiplier. LR capped by V1. (Daniels, secondhand paraphrase; C weak.) Beginner ladder: step back 1 stage per 7 days off. |
| >28 d | Rebuild plus a re-test (TT). Treat it as a new plan if the date allows (C, Runna). |

- HR runs high for 1–2 weeks after a break, so **suppress HR-based downgrades for 7 days** (E physiology, D rule).
- Examples:
  - Persona B, 14 days off, no cross-training: goal MP 6:03 → **6:13/km**; 21 days → **6:21/km**.
  - Persona C, 14 days off: T 4:15–4:28 → **4:22–4:35/km**.

### R-ILL: illness

| ID | Rule | Label |
|---|---|---|
| R-ILL-1 | Check-in asks three things: fever? below-neck or systemic symptoms? above-neck only? **Fever or systemic** → no running; the return clock starts once fever-free and systemic symptoms are gone. **Above-neck only** → optional easy run at ≤50–70% of planned duration, no quality until symptoms clear. | C (neck check is expert opinion, [IOC 2022](https://bjsm.bmj.com/content/early/2022/07/21/bjsports-2022-105759)) |
| R-ILL-2 | First run back is an **exercise challenge**: 10–20 min at 60–70% effort. Red flags during the run or within 24 h (chest pain, palpitations, dizziness, unusual breathlessness, RPE far above normal for the pace, dark urine) → stop the plan and show "see a doctor". | C (IOC consensus) |
| R-ILL-3 | Suspected COVID or flu-like illness with below-neck symptoms: at least **10 days** from onset to normal training. Above-neck only: at least **5 days** ([BJSM GRTP](https://blogs.bmj.com/bjsm/?p=10084)). | C |
| R-ILL-4 | Feed sick days into R-BREAK. For a systemic illness, start at the 50% phase even after 4–5 days off. | D |
| R-ILL-5 | Symptoms lasting more than 7 days, or worsening → recommend a doctor and stop auto-replanning | C (IOC severity marker) |

### R-PAIN: niggles (Silbernagel pain-monitoring model)

Pain up to 5/10 during activity is acceptable if it settles by the next morning and doesn't trend upward week to week. In the Achilles RCT, continued running under this model did as well as active rest ([Silbernagel 2007 summary](https://physicaltherapyfirst.com/blog/continued-sports-activity-using-a-pain-monitoring-model-during-rehabilitation-in-patients-with-achilles-tendinopathy/), E single RCT, tendon-specific). Inputs per body part: a 0–10 score during/after the run, the next-morning score, and an altered-gait flag.

| Zone | Trigger | Action |
|---|---|---|
| Green | During ≤2–3 and next morning back at baseline | Continue |
| Amber | During 3–5, **or** next morning above baseline by ≤2 | Next 2–3 runs easy only. Freeze weekly km and LR. Drop intervals, hills and plyos. |
| Red | During >5, not settled by morning, rising weekly trend, altered gait, **or sharp localized bone pain** (any score) | 2–3 days no running, then a 20–30 min easy test (10–15 min in the ladder). Pain >5 again → "see a physio" + cross-training-only mode (cross-trained R-BREAK column). **Suspected bone-stress pain → out of scope (§2.4); stop the plan and refer.** |

R-PAIN-4: any amber or red week counts as "not progressing", so the next week's volume is capped at the last completed week. The bone-pain override is D.

### R-PERF: performance-based pace changes

1. **Eligible sessions:** fully completed T, I or TT sessions with good GPS. Exclude heat-flagged sessions, large elevation gain, any illness or pain flag in the prior 3 days, the first 7 days after a break, and all sessions while `vdot_status = estimated` (only a TT can change those).
2. **Per-rep score:** `delta = (target_s_per_km − actual)/target`. Discard reps with |delta| > 10%. Session score = median delta, plus sRPE versus the expected sRPE.
3. **Faster:** at least 3 of the last 4 eligible sessions spanning ≥2 weeks show delta ≥ +2% **and** sRPE ≤ expected → offer +1 step (§4.10, ≈1.2% pace). **Always requires user acceptance.**
4. **Slower:** at least 2 of the last 4 show delta ≤ −2% **or** RPE ≥ expected + 2 → first check readiness, heat and sleep, then offer −1 step. This side triggers more easily (asymmetry).
5. **Mixed results:** no change (Runna's "Variable").
6. **After any change:** freeze for 2 weeks (Runna's "Monitoring" reset).
7. **Override:** a race or TT overrides all of the above.

All D, modeled on Runna's documented behavior (C).

### R-LOAD: load guardrails

| ID | Rule | Label |
|---|---|---|
| R-LOAD-1 | The V1 per-session spike cap is the only hard injury constraint | E-obs |
| R-LOAD-2 | Planned weekly `total_load` > 1.25–1.30 × the mean of the previous 4 weeks → trim easy running first, then downgrade Q2 to easy. Never trim the LR first. Locked cross-training is never trimmed by the engine; it is reported. | D |
| R-LOAD-3 | Monotony = mean ÷ SD of daily load; strain = weekly load × monotony ([Haddad 2017](https://www.frontiersin.org/articles/10.3389/fnins.2017.00612/full)). **Display only.** No universal threshold exists ([Foster 1998](https://sponet.de/sponet/Record/4001707)); the popular "monotony > 2.0" is unsourced. | E (metric) / D (use) |
| R-LOAD-4 | Two consecutive weeks of R-LOAD-2 triggers, or cross-training > 40% of `total_load` → switch cutbacks to 2:1 | D |

### R-HRV: optional readiness modifier

The evidence:
- HRV-guided training shows small, inconsistent benefits: VO2max ES 0.40 vs 0.22 ([Granero-Gallegos 2020](https://www.mdpi.com/1660-4601/17/21/7999)); performance not significant, g = 0.079 ([Manresa-Rocamora 2021](https://pubmed.ncbi.nlm.nih.gov/34489178/)). Both E.
- Its main value is fewer non-responders. Vesterinen's recreational-runner RCT used a 4-week baseline, a 7-day rolling RMSSD and an SWC of mean ± 0.5 SD ([Vesterinen 2016](https://jyx.jyu.fi/bitstream/handle/123456789/50625/vesterinenetalindividualendurancemsse.pdf?sequence=1), E).

HRV is only available if the user's source provides nightly HRV. That may come from the intervals.icu wellness endpoints; whether Garmin-origin wellness data stays available is unclear (§3.2).

| ID | Rule |
|---|---|
| R-HRV-1 | Enable only after 21–28 valid nights. Use ln(rMSSD), a 7-day rolling mean, and a 60-day band of mean ± 0.5 SD. Recompute weekly. |
| R-HRV-2 | Rolling mean below the band, or above it together with high fatigue or RPE → downgrade today's quality session to easy and try to move it later in the week (R-MISS-2). Never skip the LR on HRV alone; shorten it ≤20% or move it. Never change weekly volume. |
| R-HRV-3 | A single-day drop only prompts "how do you feel?". Exception: ≥1 SD below the 10-day baseline on 2 consecutive days acts like R-HRV-2 (Kiviniemi rule, [Altini](https://marcoaltini.substack.com/p/a-brief-history-of-heart-rate-variability)). |

The core engine must work with HRV disabled.

### R-RACE: fixed race date

The evidence:
- Breaks of 7 days or more, 3–12 weeks before the race, were associated with about 4.25% slower finishes at 7–13 days off, rising to about 8% at 28 days. Late breaks were worse than early ones ([Feely 2023](https://www.frontiersin.org/articles/10.3389/fspor.2022.1096124/full), E-obs, survivor bias).
- Pfitzinger: losing 10 or more days in the last 8 weeks means revising the goal ([Human Kinetics](https://us.humankinetics.com/blogs/excerpt/what-to-do-when-your-marathon-training-gets-interrupted), C).

| ID | Rule | Label |
|---|---|---|
| R-RACE-1 | The taper is never compressed below 7 days. Compress the build, not the taper. | E (Wang/Bosquet) / D |
| R-RACE-2 | `weeks_available = weeks_to_race − taper_weeks`. Start at the R-BREAK return level and progress under V1/V2. Achievable peak LR = stepping +10% per LR with the user's cutback pattern (§6.7). | D |
| R-RACE-3 | Prompt a goal revision if any of: (a) ≥10 cumulative days lost in the final 8 weeks; (b) achievable peak LR is below **85% of this plan's own L1 target**; (c) the R-BREAK multiplier implies goal pace >2% slower. Offer `new_goal = old_goal / multiplier`, sanity-checked against Feely's 4–8%, plus the §6.2 alternatives. | C (a) / D |
| R-RACE-4 | Fewer than about 4 build weeks and no run of ≥ 75% of the plan's L1 peak LR in the last 30 days → offer a finish or run/walk goal, a shorter distance, or a later race (§6.2) | D |

Why R-RACE-3(b) and R-RACE-4 are relative to the plan's own L1 (kept from the original fix):
- An absolute threshold (the notes proposed 26–28 km, and "24 km" for R-RACE-4) contradicts L1 for any runner whose **time cap** binds below it.
- For example, persona B's 150-min cap is about 21–22 km, so an absolute rule would fire on every plan. Persona A never reaches it at all.

---
## 9. Strength module (fully configurable)

### 9.1 Why, and how much it buys

- Heavy and combined heavy + plyometric training improve running economy (RE) and time trials without changing VO2max:
  - **RE:** high-load ES −0.27, combined −0.43, plyometric −0.31. Submaximal and isometric programs did **not** beat controls ([Llanos-Lagos 2024a](https://repository.essex.ac.uk/37272/), E).
  - **Performance:** high-load ES −0.47, **combined −1.04**, plyometric not significant ([Llanos-Lagos 2024b](https://repository.essex.ac.uk/37960), E, GRADE very low–moderate).
- Loads of **≥90% 1RM** beat lighter ones, and programs of **10–14 weeks** beat 6–8 weeks (g −0.45 vs −0.21) ([Eihara 2022](https://sportsmedicine-open.springeropen.com/articles/10.1186/s40798-022-00511-1), E).
- Injury reduction is proven for sports in general (RR 0.32; overuse 0.53, [Lauersen 2014](https://bjsm.bmj.com/content/48/11/871)). It is **not** shown for runners specifically, except with supervised programs ([Wu 2024 summary](https://marathonhandbook.com/injury-prevention-strength-training/)).
- So the app frames strength as a performance and tissue-capacity investment, not an injury guarantee.
- Running blunts strength and hypertrophy gains more than cycling does ([Wilson 2012](https://search.pedro.org.au/search-results/record-detail/34457), E). A full-body or hypertrophy goal will progress more slowly alongside a running block, and the app should say so.

### 9.2 Configuration (D)

| Setting | Values | Default | Effect |
|---|---|---|---|
| `mode` | **off** / **running-focused** (lower body + core) / **full-body** (lower + upper push/pull + core) / **external** (user follows their own program) | running-focused | Session templates (§9.3); external → §9.6 |
| `equipment` | gym / dumbbells (home) / bodyweight | bodyweight | Exercise choice per slot |
| `sessions_per_week` | 0–3 (phase table caps it) | 2 | Upper bound. The phase table (§9.4) may lower it, never raise it. |
| `lifting_experience` | none / novice (< 6 months consistent) / experienced | none | Intensity ceiling, plyo entry rung, progression speed |
| `upper_body_days` (full-body only) | merge into strength sessions / separate days | merge | Separate upper days are unconstrained vs runs except ST-7/ST-8 |

**Intensity ceiling by lifting experience (D on E):**
- **none:** 4–6 weeks of technique (3 × 8–12 @ RPE 6–7), then the phase table. Plyos start at the bottom rung with 30–40 contacts.
- **novice:** the phase table, capped at RPE 8 / ~85% (no ≥90% singles). Plyos up to bounds.
- **experienced:** the full phase table, including ≥90% work in build. The full plyo ladder.

Beginner runners (§6.9) get the bodyweight technique block only, 1–2×/week and ≤ 30 min, until ladder graduation, whatever the settings.

### 9.3 Session templates and exercise library

**Running-focused (Lower A/B):** SQUAT or HINGE (alternate as primary) + SINGLE_LEG + CALF_STRAIGHT or CALF_BENT (alternate) + PLYO block first, while fresh + optional HIP or CORE. About 45 min.

**Full-body (A/B), D:**
- A: PLYO → SQUAT + SINGLE_LEG + UPPER_PUSH + UPPER_PULL + CALF + CORE.
- B: PLYO → HINGE + SINGLE_LEG + UPPER_PULL + UPPER_PUSH (vertical) + CALF + CORE.
- About 55–60 min. Upper sets follow the same phase intensity; there are no upper-body restrictions relative to runs except ST-8.

| Slot | Gym | Dumbbells | Bodyweight |
|---|---|---|---|
| SQUAT | Back squat / trap-bar deadlift | Heavy goblet squat | Tempo split squat |
| HINGE | Romanian deadlift | Single-leg DB RDL | Hip thrust / glute bridge; Nordic eccentric 2–3 × 3–5 |
| SINGLE_LEG | Bulgarian split squat / loaded step-up (box at knee height) | DB reverse lunge | Bodyweight step-up |
| CALF_STRAIGHT | Standing or Smith calf raise, 3 × 8–12 heavy | Single-leg DB calf raise off a step | Single-leg calf raise off a step |
| CALF_BENT (soleus) | Seated calf machine, 3 × 8–15 | Seated with DB on knees | Bent-knee single-leg raise, 3 × 15–25 |
| HIP | Copenhagen plank | Banded lateral walk | Side-lying abduction, 2 × 10–15 |
| CORE (1 slot max) | Pallof press | Dead bug | Side plank, 2 × 30–45 s |
| UPPER_PUSH (full-body) | Bench press / overhead press | DB bench / DB overhead press | Push-up (incline → feet-elevated) |
| UPPER_PULL (full-body) | Pull-up / cable or barbell row | One-arm DB row | Inverted row (table/bar) / band row |

Basis:
- Exercise families come from the study protocols ([Blagrove 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC5889786), E).
- The calf/soleus emphasis is mechanistic: the plantarflexors produce the largest muscle forces in running ([Barbell Medicine](https://www.barbellmedicine.com/blog/a-case-for-training-calves/), weak).
- Hamstring work: hamstring was the most common diagnosis in NYC Marathon runners ([Fontana 2024](https://doaj.org/article/80f466f2048a4466b4b0b58097124c93)), and Nordics cut hamstring injuries in football ([Petersen via Barbell Medicine](https://www.barbellmedicine.com/blog/strength-training-for-endurance-athletes-part-i-resistance-training-and-injury-risk/)).
- Upper-body slots are D: no running-performance evidence.
- Core is capped at one slot because many users' cross-training (paddling, rowing, climbing, external upper programs) already loads the trunk. It rises to 2 slots if the user has no trunk-loading cross-training (D).

**Exercise cards (product gap (d), §11).** Each exercise in the library carries `{id, slot, equipment, name, description (1–2 sentences), cues[3–4], common_faults[1–2], regression_id, progression_id, demo_url?}`. Example cards (D content; review with a coach or physio before release):

| Exercise | Description | Cues |
|---|---|---|
| Goblet squat | Hold a DB at the chest; squat between the knees. | Feet shoulder-width, toes slightly out · Knees track over toes · Chest up, elbows inside knees · Drive through mid-foot |
| Romanian deadlift | Hip hinge with soft knees, bar or DBs close to the legs. | Push hips back, not down · Neutral spine · Stop when hamstrings are tight (about mid-shin) · Squeeze glutes to stand |
| Bulgarian split squat | Rear foot on a bench; lower the back knee toward the floor. | Front foot far enough that the shin stays near vertical · Torso slightly forward · Control 2–3 s down |
| Single-leg calf raise | On a step edge, full range. | Full stretch at the bottom · Rise straight over the big toe · 2 s up, 2–3 s down · Knee straight (gastrocnemius) or bent (soleus) |
| Nordic eccentric | Kneel with heels anchored; lower the torso slowly. | Hips extended, body straight · Resist as long as possible · Catch with hands, push back up |
| Pogo hops (plyo) | Small, fast ankle bounces. | Stiff ankles, minimal knee bend · Quick ground contact · Land on the forefoot, quietly |
| Push-up | Plank to chest near the floor. | Hands under shoulders · Body in one line · Elbows about 45° from the torso |
| One-arm DB row | Hand and knee on a bench; row the DB to the hip. | Flat back · Pull the elbow toward the hip · Don't rotate the torso |

`demo_url` optionally links to licensed or self-recorded media. Media isn't stored in v1 (D).

**Bodyweight-only mode:**
- Flag that it is a submaximal stimulus, which didn't improve RE in the meta-analysis.
- Bias the session toward single-leg work, slow eccentrics, calf volume and plyos.

**Calf benchmark:** single-leg heel raises to failure, target **≥25 reps per side**, the population median in n=500 ([Sleeswijk Visser 2025](https://figshare.le.ac.uk/articles/journal_contribution/Normative_values_for_calf_muscle_strength-endurance_in_the_general_population_assessed_with_the_Calf_Raise_Application_A_large_international_cross-sectional_study/30209584), E norms). Flag a side asymmetry above 10% (D).

### 9.4 Phase table (D on E principles)

| Running phase | Sessions/wk (≤ user setting) | Main lifts | Plyo contacts/session | Notes |
|---|---|---|---|---|
| Off-season / pre-base / General mode | 2–3 | 3 × 8–10 @ RPE 7 → 3 × 6 | 30–50 low | Technique, tendon prep, high calf volume |
| Base (FI) | 2 | 3–4 × 5–6 @ RPE 7–8 (~80–85%) | 40–80 | Add single-leg work |
| Build (EQ/TQ) | 2, ≥48 h apart | 3–5 × 3–5 @ RPE 8 (~85–90%; experienced only ≥90%) | 60–120 | Most RE gain happens here |
| Peak (FQ pre-taper) | 1 | 2–3 × 3–5, **same load** | 40–60 | 1×/wk maintained strength over 12 weeks; once every 2 weeks did not ([Rønnestad 2011](https://nih.brage.unit.no/nih-xmlui/handle/11250/171044?show=full), E, soccer) |
| Taper | 1 light → 0 | Last heavy session at race −10 to −14 d; then ≤40% 1RM × 2 sets, no failure | Last plyo at −10 d | Race −3 to 0: none, or ≤10 min activation |
| Post-race | 0 for about 1 week, then 1 light | Bodyweight or light | 0 | — |

- The −10 to −14 d band sits between Berryman's "≥1 week" ([Outside](https://www.outsideonline.com/health/training-performance/strength-training-taper-research?scope=anon)) and RunnersConnect's 2–3 weeks ([RunnersConnect](https://runnersconnect.net/when-should-i-stop-strength-training-at-the-gym-before-the-marathon/)). Both are C.
- 5K/10K tapers are short, so for those races the last heavy session is at −7 to −10 d (D).
- Deload strength by about 40% fewer sets in running cutback weeks (D).
- **Full-body mode:** upper-body volume follows the same phase table. Upper work isn't removed in the taper until race −3 d (D: upper work doesn't affect running economy).

### 9.5 Plyo ladder, progression and scheduling

**Ladder (D):** pogo hops → skips for height → countermovement jump → split jump / single-leg hop in place → bounds → low drop jumps (20–40 cm) → hurdle hops.
- Entry rung by lifting experience: none → pogo; novice → pogo/skips; experienced → CMJ.
- Advance one rung when there's no soreness or pain 24 h later **and** the contacts were completed with good quality.
- Contacts: start at 40–60 (none: 30–40), add 10–20 per week, run 80–120 in build, hard cap **150** (Blagrove's range is 30–228).
- No plyos during R-PAIN amber or red, or with an injury flag "current".

**Load progression (double progression, D):**
- All sets reach the top of the rep range with RIR ≥2 → +5 kg (≈ +10 lb) on squat or hinge, +2.5 kg (≈ +5 lb) on small lifts.
- RIR below 1 on the first set, or reps missed in 2 consecutive sessions → hold, or cut load 5–10%.
- Autoregulation: last run sRPE ≥8, or soreness moderate or worse → downgrade HEAVY to LIGHT, or move the session. During a caloric deficit, cut one set rather than load.

**Scheduling constraints vs runs.** The evidence:
- Strength done 6 h *before* a run degraded next-day RE more than strength done after the run: 0.77 vs 0.72, baseline 0.70 ([Doma & Deakin 2013](https://researchonline.jcu.edu.au/28717/), E small).
- Runna's docs contradict each other on order ([support](https://support.runna.com/en/articles/6830469-when-to-complete-your-strength-sessions) vs [guide](https://www.runna.com/guides/how-to/how-to-balance-strength-training-and-running)), C.

| ID | Constraint | Type |
|---|---|---|
| ST-1 | Preferred slot: same day as a quality run, **after** it, gap ≥6 h | Soft |
| ST-2 | Second choice: same day as an easy run (either order), only if the next day is easy or rest | Soft |
| ST-3 | **No HEAVY_LOWER or plyo on LR day, LR −1 or LR −2** (strength-before-long-run rule) | **Hard** |
| ST-4 | No HEAVY_LOWER or plyo on the day before any quality run | **Hard** |
| ST-5 | ≥48 h between HEAVY_LOWER sessions | **Hard** |
| ST-6 | Gap under 6 h: run first, lift with −1 set per exercise, flagged as suboptimal | Fallback |
| ST-7 | No hard cross-training session + HEAVY_LOWER + hard run on the same day | **Hard** |
| ST-8 | No heavy deadlifts or trunk-dominant work within 24 h before a quality run or LR (applies to external programs too) | Soft |

ST-4 is a **D resolution**. The notes' blanket "48 h before any key session" made two weekly lower sessions impossible alongside 2 Q + LR. With Q1 on Tue and Q2 on Thu, the Tue-PM lower session is day −2 before Q2, which ST-4 allows. A Thu-PM session is day −3 before a Sunday LR, which ST-3 allows.

### 9.6 External lifting program (mode = external, or full-body "separate days")

The user declares days, a type and typical minutes and sRPE for each session: upper / lower / full / unknown. The app doesn't prescribe these sessions. It treats them as **locked load** (D):
- They count toward `total_load` (sRPE × minutes) and, if lower or full, toward `lower_body_load`.
- **Lower or full sessions are subject to ST-3, ST-4, ST-5 and ST-7.** If the declared schedule violates a hard ST rule, the scheduler moves *runs* where it can and otherwise shows a conflict with a suggested lifting-day swap. It never edits the external program silently.
- Upper-only sessions are unconstrained except ST-7 and ST-8.
- The user may also enable "running-focused add-on": the app adds only CALF + PLYO + one SINGLE_LEG slot (about 15 min) after the user's own lower session (D).
- Persona B uses this: 2 upper-body days on their own program plus running-focused lower A/B from the app. Where possible the app suggests merging a lower block into an existing upper day, lower lifts first, rather than adding gym days (D).

---

## 10. Load model and cross-training

### 10.1 Two channels, never merged (D on E)

Injury evidence is mechanical and running-specific (Frandsen). Session-RPE works across modalities ([Haddad 2017](https://www.frontiersin.org/articles/10.3389/fnins.2017.00612/full)) and is valid for resistance training (ICC 0.88, [Day 2004](https://paulogentil.com/pdf/TREINO%20DE%20FORC%CC%A7A/Monitoring%20Exercise%20Intensity%20During%20Resistance%20Training%20Using%20the%20Session%20RPE%20Scale.pdf), E).

| Channel | Unit | Inputs | Drives |
|---|---|---|---|
| `running_km` (+ per-run max distance and duration) | km, s | Runs only (run/walk counts by total duration and distance) | V1, V2, L1/L2, taper, R-PAIN caps |
| `total_load` | AU = sRPE (CR-10, about 30 min post-session) × minutes | Runs, cross-training, strength (app or external) | R-LOAD-2 trims, cutback frequency, monotony/strain display |
| `lower_body_load` (optional) | count/AU | Lower strength, plyo contacts, runs, lower-dominant cross-training (§10.2 column) | ST constraints, plyo cap |

**Logging:**
- If sRPE wasn't entered, prompt at next app open (push notification, §11) and flag it late.
- Default to the activity type's `expected_srpe` if the user skips.
- Cross-training imported from intervals.icu (any non-run sport) is auto-classified by sport type through the table below; the user confirms sRPE.

### 10.2 Cross-training mapping (all C/D; no validated conversion to running exists)

The rule for every activity: **0 running km**; it never unlocks a longer LR or a weekly-volume increase. Full `sRPE × minutes` goes into `total_load`.

Swim and bike "ratios" such as 4:1 and 3:1 minutes per running mile are anecdotal ([Canadian Running](https://runningmagazine.ca/?p=74656), C). They are **not** used for progression, only shown as optional "equivalent minutes" in the UI.

| Activity (intervals.icu sport → class) | Aerobic for R-BREAK column? | Default sRPE (easy / hard) | Counts as a **hard day** (§7.1) when | Lower-body load? | Notes | Label |
|---|---|---|---|---|---|---|
| Cycling, indoor/outdoor (Ride, VirtualRide) | yes | 3 / 7 | sRPE ≥ 7, or intervals/race | moderate (quads) | Easy rides may replace an easy run 1:1 by minutes for fatigue tracking only | D |
| Swimming | yes | 3 / 7 | sRPE ≥ 7 | none | Good substitute during R-PAIN | D |
| Rowing / erg / paddling / dragon boat / kayak / SUP | yes | 4 / 7 | sRPE ≥ 7 (race pieces, hard practice) | low (rowing: moderate) | Trunk-loading → core slot capped at 1 | D |
| Elliptical / aqua jogging | yes | 3 / 6 | sRPE ≥ 7 | low | Closest running substitute; still 0 km | D |
| Hiking / walking / rucking | yes if ≥ 45 min | 2 / 5 | sRPE ≥ 7 or > 3 h with > 800 m gain | **yes** (eccentric on descents) | A long hilly hike counts as lower-body load, so no long hike on LR −1 | D |
| XC skiing / skimo | yes | 4 / 7 | sRPE ≥ 7 | moderate | — | D |
| Team & court sports (soccer, basketball, hockey, ultimate, tennis, squash, badminton) | partial (no) | 5 / 8 | **always**, unless explicitly "light/technique" | **yes** (sprints, cuts, jumps) | Counts as plyo-like load: no HEAVY_LOWER or plyo the same day or the day before a quality run | D |
| HIIT / CrossFit / bootcamp | partial (no) | 6 / 8 | **always** | yes | Counts as half a key session (§6.4) | D |
| Climbing / bouldering | no | 4 / 7 | sRPE ≥ 8 | low | Upper/trunk; ST-8 applies | D |
| Strength: app-prescribed | no | 5 / 8 | HEAVY_LOWER = hard for ST rules, not for the run key-session count | per session | §9 | D |
| Strength: external upper | no | 5 / 7 | never for running purposes | none | ST-7/ST-8 only | D |
| Strength: external lower/full | no | 6 / 8 | yes for ST rules | yes | §9.6 | D |
| Yoga / mobility / Pilates | no | 2 / 4 | never | none | Logged, but excluded from monotony to avoid diluting it | D |
| Other / unknown | no | ask | sRPE ≥ 7 | ask | User classifies once; the choice is remembered | D |

Rules:
- **Hard day:** a hard day is treated like a quality run for §7.1 adjacency (no quality run within 24 h after it; no hard session the day before the LR) and counts as **½ key session** toward the weekly cap of 3 (D).
- **Substitution:** cross-training that replaces a planned easy run gets 1:1 minutes for fatigue tracking and **0 km** for progression (D).
- **Locked vs flexible:** locked sessions (team practice, club paddling) are placed first and never moved. Flexible sessions can be suggested to move by the scheduler fallbacks.

---

## 11. Product: gaps vs commercial apps, notifications, explanations, sharing, AI

### 11.1 Gaps vs Campus, URUNN and Runna, and v1 mitigations (D)

These are positioning notes; the competitor feature sets weren't re-audited in this pass.

| Gap | What commercial apps offer | v1 mitigation |
|---|---|---|
| (a) In-run guidance | Audio coaching or a watch app that runs the workout | **The watch executes the structured workout** delivered via intervals.icu (Garmin, COROS, Suunto, Wahoo). Polar/Apple users follow the PWA step view; it isn't a live in-run guide. |
| (b) Setup friction | One-tap watch connect | Guided connect flow with validation and error states (§2.5). Move to intervals.icu OAuth once approved. |
| (c) Notifications | Today's workout, plan changes | Web push (§11.2) |
| (d) Strength demos | Video library | Exercise cards: description, cues, common faults, regression/progression, optional `demo_url` (§9.3) |
| (e) "Why this workout" | Coach notes, sometimes LLM text | Deterministic explanations from rule traces (§11.4); no LLM needed |
| (f) Social | Friends, clubs, leaderboards | Optional friends feed, **opt-in per user and per field, non-Strava data only** (§11.5) |
| (g) Phone-only users | Phone GPS recording | **Out of scope for v1.** A watch with a supported path is required (PWA limit, §2.1). |
| (h) Breadth (trail, ultra, triathlon, pregnancy) | Varies | Out of scope (§2.4) |

### 11.2 Push notifications (D)

The server sends web push through VAPID, with one subscription per device per user (`push_subscriptions(user_id, endpoint, p256dh, auth, ua, created_at)`). The user picks a quiet window and per-type toggles.

| Trigger | Message | Timing |
|---|---|---|
| Today's workout | Name + duration, in the user's units, plus "on your watch" or "open in app" | User-chosen time, default 07:00 local |
| Plan changed (replan, R-MISS, R-PERF accepted, illness) | One-line summary of what changed and why (rule-trace text) | On change, batched to ≤1 per 2 h |
| sRPE / pain check-in | "How hard was today's run? Any pain?" | 1–2 h after an activity is ingested |
| Next-morning pain check | R-PAIN morning score | Morning after an amber or red pain day |
| Workout not on watch | "Tap to re-send" | When nightly read-back finds it missing (§3.7) |
| Setup issues | No data for 14 d, key invalid | Once, then weekly |

Handle `410 Gone` by deleting the subscription.

### 11.3 Re-send and sync controls (D)

Each workout card shows "Re-send to watch" (§3.7) and its last push time. Settings shows "Sync now", which runs a one-off poll that respects the limiter.

### 11.4 "Why this workout": rule traces → deterministic text (D)

- Every planned session stores `rule_trace[]`: rule IDs plus the values that triggered them, e.g. `["P3:EQ:HM:T", "I2:intermediate:5d:Q1", "W-T:prog+5min", "V1:ok(10.5<=12.1)", "HEAT:+3.5%"]`.
- A template table maps each rule ID to a sentence with slots. Example rendering: "Threshold session: this is the Early Quality phase of a half-marathon plan, where threshold work is the main stimulus (Daniels). You do two quality sessions a week at your level. It's 5 min longer than last week's. Paces are 3.5% slower because of forecast heat."
- Replan notices reuse the same traces, e.g. "Removed Thursday's intervals: amber pain on Tuesday (R-PAIN)."
- Templates are versioned with the engine. Units are formatted per user. There is no LLM, so the output is reproducible and testable.

### 11.5 Optional friends feed (D, consent-gated)

- **Off by default.** Each user opts in explicitly (`consents.kind = feed_share`), chooses visible fields (completed workout name, duration, distance, plan week; never HR, pain, illness or health-screen data) and chooses which users can see them.
- Revocation hides past items immediately.
- **Rows with `strava_derived = true` are never shown to anyone but their owner** (Strava policy).
- Garmin-origin data shown to others carries Garmin attribution (§3.2).
- No leaderboards in v1.

### 11.6 AI features: optional, and constrained by data provenance

- **Strava's AI ban covers only Strava data.** Because the default path avoids Strava, an LLM feature over a user's **own** intervals.icu, Garmin-Personal-API or uploaded-FIT data isn't blocked by Strava's §5.3.
- **intervals.icu API terms** contain no AI/LLM clause ([terms](https://forum.intervals.icu/t/intervals-icu-api-terms-and-conditions/114087), Platform).
- **Garmin-origin data** carries Garmin's own terms. Garmin's developer agreement reportedly allows AI processing with a transparency statement and user consent ([Sahha](https://sahha.ai/blog/health-api-ai-restrictions/), secondary). The Oct 2026 Garmin re-sharing restriction (§3.2) may limit what intervals.icu can pass on at all (UNVERIFIED, §14).
- **Rules (D):**
  1. Any LLM feature is opt-in per user (`consents.kind = llm_features`) and processes only that user's data.
  2. **Never route Strava-derived rows to any app-side LLM.** The query layer filters `strava_derived = false` for every LLM context build.
  3. The core engine stays deterministic; LLM output never changes plans directly.
- **Claude's Strava connector.** Strava launched an official read-only MCP connector for Claude in June 2026, available to **paying Strava subscribers** ([Marathon Handbook](https://marathonhandbook.com/strava-now-lets-runners-talk-to-their-training-data-through-claude/)). A user can connect Strava to their own Claude account independently of this app.
  - The app supports this with a **"Copy my plan as text" export**: plain text or Markdown of the next N weeks with paces in the user's units, plus the rule-trace explanations.
  - The user pastes it into their own Claude chat.
  - The app itself never touches Strava data in this flow.

---
## 12. Deployment and hosting (D)

### 12.1 Runtime components

| Component | Tech | Notes |
|---|---|---|
| API + jobs | `apps/api`: Node 22 LTS + Fastify, with the pg-boss worker in the same process | One container. The engine is imported from `packages/engine`. |
| DB | Postgres 16 | Holds app data **and** the pg-boss queue (`pgboss` schema). `user_id` scoping (§2.2). A `strava_ttl` schema only if the Strava adapter is enabled. |
| Raw files | Local volume (`/data/raw`), or S3-compatible storage | ~100–300 KB per activity; at 10 users, well under 5 GB a year |
| PWA | `apps/web` static build (Vite) | Served by the API container (`@fastify/static`) **or** Cloudflare Pages |
| HTTPS | **Cloudflare Tunnel** (home/laptop) or **Caddy** with automatic Let's Encrypt (VM) | **HTTPS is mandatory**: service workers, PWA install and web push only work in secure contexts |

**Scheduled jobs (pg-boss queues and cron schedules; retries with exponential backoff; dead-letter queue):**

| Job | Cadence | Notes |
|---|---|---|
| `sync:intervals` | Every 10–15 min per user, during that user's waking hours (local timezone) | Staggered by `hash(user_id) mod interval`; `singletonKey = user_id`. One global limiter ≤ 5 req/s (per-IP limit 10 req/s). Back off on 429 using `Retry-After`. |
| `sync:garmin-personal` (fallback users) | Every 15–30 min; token re-mint every 24 h | Key-expiry alert 14 d ahead |
| `sync:strava` (only if enabled) + `purge:strava-ttl` | 15 min, or webhook; nightly purge | — |
| `replan:nightly` | 02:00–04:00 user-local | Reconcile the last 7 d of activities, run FIT-UPDATE / R-* rules, regenerate from today, write rule traces |
| `push:workouts` | After each replan, plus nightly | Bulk-upsert the next **7–14 days** to intervals.icu; bulk-delete removed events; read back and auto-re-send missing workouts in the next 3 d (§3.7) |
| `notify:webpush` | Per-user schedule (default 07:00 local), plus event-driven | `web-push` library with VAPID; delete subscriptions on 404/410 |
| `weather:fetch` (heat rule) | Daily per user location, and 6 h before key sessions | Cache by grid cell |
| `backup:nightly` | Nightly (host cron or sidecar) | Below |

### 12.2 Packaging and operations

- **Docker Compose:** `api` (Node; serves the PWA too, unless Cloudflare Pages does) + `postgres`. Add `caddy` on a VM, or `cloudflared` on a home box. Named volumes for `pgdata` and `raw` (and `caddy_data`).
- **Migrations:** drizzle-kit migrations run at container start, behind a lock, before Fastify listens.
- **Backups:**
  - Nightly `pg_dump -Fc` (includes the pg-boss schema) plus a tar of `/data/raw`.
  - **Copy them off-box** with restic or rclone, encrypted, to S3-compatible object storage (Backblaze B2, Cloudflare R2, Hetzner Storage Box) or another machine. Keep 14 daily and 8 weekly copies.
  - Test a restore monthly.
  - Strava TTL rows are excluded from backups, or their backups expire within 7 days.
- **Secrets:**
  - DB URL, the app master encryption key, VAPID keys, the session secret, the Strava client secret (if used), the intervals.icu OAuth secret (later) and the Cloudflare Tunnel token go in **environment variables via a Compose `.env` outside the repo** (chmod 600), or in Docker secrets.
  - **Nothing goes in git.** Add `.env` to `.gitignore` and run a secret scan (gitleaks) in pre-commit or CI.
  - Validate env at boot with a zod schema, and refuse to start if any secret is missing.
- **Per-user API keys and tokens** (intervals.icu, Garmin Personal, Strava) are **encrypted at rest**:
  - Node `crypto` AES-256-GCM, with a per-row random 12-byte nonce, auth tag stored, and the master key from env.
  - Decrypt only inside the adapter at call time.
  - Never log them. Redact `authorization` in Fastify's pino logger config.
  - Support key rotation by re-encrypting all rows with a new master key and a `key_version` column.
- **Ops minimum:**
  - OS security updates.
  - VM: SSH key-only access; firewall 80/443 (and 22 from your IP).
  - Home + tunnel: **no inbound ports at all**.
  - Uptime ping (healthchecks.io free) hit by `replan:nightly`.
  - Docker log rotation.
  - `restart: unless-stopped`.

**Sizing:** 10 users is a trivial load. The Node API (~150–300 MB RSS) plus Postgres (~200–400 MB with modest `shared_buffers`) **fits comfortably in 1–2 GB RAM**, with no JVM heap tuning. 2 GB machines (older laptops, small VPS plans) are fine. Build the images in CI or on the dev machine, not on a 1 GB host.

### 12.3 Hosting options (approximate prices as of Oct 2026; check before buying)

| # | Option | Spec | Approx. cost | Notes | Verdict |
|---|---|---|---|---|---|
| 1 | **Home laptop / mini-PC + Cloudflare Tunnel** | Any always-on old laptop with ≥ 2 GB RAM, Linux + Docker | **$0** (plus power) | `cloudflared` gives public HTTPS on your domain **without opening router ports**, and Caddy isn't needed. The PWA can also be served by Cloudflare Pages. Disable sleep on lid close and set BIOS "power on after AC loss". Uptime depends on home power and internet; sync and push catch up after an outage (the nightly reconcile covers 7 days). The laptop battery acts as a small UPS. | **Likely choice; recommended for v1** |
| 2 | Hetzner Cloud CX23 | 2 vCPU / 4 GB / 40 GB, EU | ~€5.50–6/mo (€5.49 + €0.50 IPv4, ex VAT since Jun 15, 2026), monthly billing | **Availability caveat:** a price tracker reported the cost-optimized CX/CAX line as "currently unavailable" on repeated checks in Sept–Oct 2026, last on Oct 20 ([Bitdoze](https://www.bitdoze.com/es/hetzner-cloud-precios-2026/)). Check the console. The next tier up is about €20/mo, which is overkill. | Best paid option, if orderable |
| 3 | Netcup VPS (VPS 500, or the smaller "nano"-class plans) | VPS 500 ~2 vCPU / 4 GB; smaller plans ~1–2 GB | VPS 500 ~€5/mo; smaller plans cheaper | **12-month minimum term** on many plans. With Node, a 2 GB plan is enough. | Good value if you accept the lock-in |
| 4 | Oracle Cloud Always Free | Ampere A1 Arm: now **2 OCPU / 12 GB** total (halved from 4/24, reported Jun 2026) ([Linuxiac](https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/)) | $0 | Idle Always Free instances may be reclaimed (reported: under 20% utilisation over 7 days; verify), and a light Node app will look idle. "Out of capacity" errors are common. Node 22 and Postgres ship arm64 images. | $0 but fragile; keep off-box backups |

**Ruled out (coordinator-supplied facts; re-verify if reconsidering):**
- **Render free:** sleeps after 15 min idle, which breaks polling, cron and push; free Postgres expires after 30 days.
- **Fly.io:** no free tier for new orgs since Oct 2024.
- **Koyeb free:** sleeps after 1 h idle; 512 MB.
- **AWS new free plan:** credit-based, and ends after 6 months.

**Domain:** a domain on Cloudflare DNS is needed for the tunnel (or for Caddy on a VM), for HTTPS, PWA install and push. iOS web push needs no Apple Developer account (§2.1).

---
## 13. Constants table

All values are stored in SI; imperial is display only.

**Pace and fitness**

| Constant | Default | Source | Label |
|---|---|---|---|
| VO2 cost eq. coefficients | −4.60, 0.182258, 0.000104 (v in m/min) | Daniels & Gilbert via [Bill Mill](https://notes.billmill.org/fitness/calculating_v02_max.html) | C |
| %max eq. coefficients | 0.8, 0.1894393, −0.012778, 0.2989558, −0.1932605 (t in min) | same | C |
| Unit tests | VDOT 50 → 5K 19:56, M 3:10:39–3:10:40; VDOT 33.7 ↔ M 4:24:00; VDOT 24.8 ↔ 3K 21:00 | computed | — |
| Valid VDOT range | 15–85 | — | D |
| E / M / T / I band (%VO2max) | 59–74 / 75–84 / 83–88 / **95–100** | [CoachRay](https://www.coachray.nz/2023/05/03/jack-daniels-running-intensity/) | C |
| M pace | Goal-time pace; else marathon race solution; % band only as fallback | §4.1 | D |
| R pace | Mile race-time solution | [Running with Rock](https://runningwithrock.com/training-explained-jack-daniels-running-formula/) | C/D |
| LR pace (M plans) | MP + 10–20%, never faster than the fast end of E | [Pfitz](https://runningwithrock.com/pfitz-marathon-training-explained/) | C/D |
| Aggressive-goal flag | goal VDOT − current > 1.5 (warn); > 3.0 (default to +1.0) | — | D |
| k_user default | clamp(1.10 + 0.05·(T_HM − 80)/40, 1.08, 1.15); +0.03 if low volume; max 1.19 | [Vickers](https://pmc.ncbi.nlm.nih.gov/articles/PMC5000509/), [Fetcheveryone](https://www.fetcheveryone.com/article/marathon-predictions-3-0-116) | E/C → D |
| Fitness step | VDOT change ≈ 1.2% T pace (≈ 0.4 @ VDOT 25, 0.5 @ 34, 0.75 @ 50, 0.9 @ 60) | computed | D |
| Cold-start fallback | VO2(v_typical)/0.78 − 1, tagged `estimated` | — | D |
| Time-trial options | 3K, 5K, 30 min; every 4–6 wk in base/EQ; none in the final 3 wk | Daniels (update after TTs) | C/D |
| Training-fitness EWMA τ | 21–28 d | — | D |
| Min qualifying runs to raise VDOT | 3 over ≥14 d | — | D |
| VDOT raise cap | +2 steps per 2–3 weeks | — | D |
| VDOT freeze after change | 2 weeks | Runna "Monitoring" | C/D |
| R-PERF thresholds | ≥3/4 sessions ≥ +2% (faster); ≥2/4 ≤ −2% (slower); rep outlier \|delta\| > 10% | Runna behaviour | D |
| HRmax fallback | 208 − 0.7·age (guidance only) | [Tanaka 2001](https://pubmed.ncbi.nlm.nih.gov/11153730/) | E |
| CS window / min activities | 16 weeks / 24 | [Smyth](https://uhra.herts.ac.uk/id/eprint/8225/1/Calculation_of_Critical_Speed_from_Raw_Training.96275.pdf) | E |
| Marathon %CS prior | 0.93 (150 min) → 0.789 (≥300 min), linear | same | E → D |
| GAP F(g) | 0.0021g² + 0.034g + 1, clamp ±25%; grade over 50–100 m | [Educated Guesswork](https://educatedguesswork.org/posts/grade-vs-pace/) | C/D |
| Heat penalty start | WBGT 10 °C | [Ely 2007](https://experts.umn.edu/en/publications/impact-of-weather-on-marathon-running-performance/) | E |
| Heat penalty slope | 0.35 (VDOT ≥50) / 0.5 (40–50) / 0.65 (<40) %/°C | scaled from Ely | D |
| Exclude from fitness above | WBGT 20 °C | [Gasparetto](https://pmc.ncbi.nlm.nih.gov/articles/PMC7350124) | D |
| GPS max speed / accel / accuracy | 8 m/s / 4–5 m/s² / 20–25 m | — | D |
| Speed smoothing / auto-pause | median 5–9 s / <0.8–1.0 m/s for ≥3–5 s | — | D |
| Qualifying steady window | ≥20 min run; 60 s windows; CV speed <8%, CV HR <5% | [Strava GAP](https://medium.com/strava-engineering/an-improved-gap-model-8b07ae8886c3) | C/D |
| Decoupling "good" | <5% | [TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204071724-Aerobic-Decoupling-and-Efficiency-Factor) | C |

**Plan structure (per-level defaults)**

| Constant | Default | Source | Label |
|---|---|---|---|
| Experience levels | beginner <3 mo or can't run 20 min or <10 km/wk; novice 3–12 mo; intermediate 1–3 yr; advanced >3 yr and ≥50 km/wk | Higdon tiers; [Videbæk 2015](https://pubmed.ncbi.nlm.nih.gov/25951917/) | C/D |
| Min / ideal plan weeks | 5K 6 (9 from run/walk) / 8–12; 10K 8 / 10–12; HM 10 (8 int+) / 12–14; M 12 (16 novice) / 16–20 | original P1 + C25K | C/D |
| Entry volume / longest run | 5K 6 km, 2.5 km or 20 min; 10K 12 km, 5 km; HM 20 km, 10 km; M 30 km, 14 km | — | D |
| Feasibility reachability | simulated peak LR ≥ 85% of L1 (warn), ≥ 70% (block below) | — | D |
| Easy share (time) | ≥75–80% | [Rosenblat](https://www.stir.ac.uk/research/hub/publication/2095779), [Casado](https://lida.sport-iat.de/ta/Record/4076169?lng=en) | E → D |
| Quality sessions | §6.4 table (beginner 0 → advanced 2 + LR); max 3 key incl. LR; hard cross-training = ½ key | Higdon, Hansons | C/D |
| Min gap between quality sessions | 48 h | convention | C |
| **Single-run spike cap** | **≤1.10 × longest non-race run, prior 30 d** (distance; time variant too) | [Frandsen 2025](https://blogs.bmj.com/bjsm/?p=11751) | E-obs (+D) |
| Weekly growth target / hard cap / never | 5–10% / 15% / 30% | [Nielsen 2014](https://vbn.aau.dk/da/publications/excessive-progression-in-weekly-running-distance-and-risk-of-runn) | C/D |
| Low-volume absolute step | +1.5–3 km per run day (<25 km/wk) | — | D |
| Peak weekly ceilings | §6.5 table (e.g. M: novice 40–55, intermediate 50–80, advanced 65–110 km) | — | D |
| Peak Δ over start | 15 / 25 / 30 km (novice / intermediate / advanced) | — | D |
| LR % cap (soft) | 30% (<64 km/wk), 25% (≥64) | [Daniels](https://runningmagazine.ca/?p=99607) | C |
| LR % cap (hard) | 45% M, 35% others | — | D |
| LR time cap | §6.6 table (e.g. M: 150 min; 180 in Higdon/Pfitz mode; beginner 5K 60 min) | Daniels; Higdon/Pfitz | C/D |
| LR distance cap | 5K 16 / 10K 20 / HM 22 / M 32 (advanced Pfitz 35) km | Higdon 20 mi, Pfitz 22 mi | D on C |
| Prescription mode | time/RPE for beginners, estimated VDOT, or E pace slower than 7:30/km; km for advanced | C25K | C/D |
| Rep lengths | I 3–5 min; R ≤ 2 min; switch to time reps outside that | Daniels | C/D |
| Run/walk ladder | 10 stages, 3 sessions/stage; advance at RPE ≤5 + pain green | NHS C25K, [Hottenrott 2016](https://edoc.unibas.ch/57171) | C/D |
| Cutback frequency | 3:1 default; 2:1 if age ≥40, injury flag, beginner/novice, cross-training >40% of load; 4:1 opt-in for advanced <40 | [RunnersConnect](https://runnersconnect.net/?p=6471) | C/D |
| Cutback depth | volume −20–30%, LR −25–35% | — | C/D |
| Taper length | M 3 wk (2 if peak <50 km), HM 2, 10K 7–10 d, 5K 5–7 d; min 7 d | [Bosquet](https://pubmed.ncbi.nlm.nih.gov/17762369/), [Smyth & Lawlor](https://marathonhandbook.com/optimal-marathon-taper-length/) | E/C |
| Taper multipliers (M) | 0.80–0.85 / 0.65–0.70 / 0.40–0.50 | [RunnersConnect](https://runnersconnect.net/running-training-articles/how-to-taper-for-a-marathon/) | C |
| T / I / R / M caps | ≤10% / ≤8% / ≤5% wk; M ≤110 min and <20% wk; minimum session floor below 30 km/wk | [CoachRay](https://www.coachray.nz/2023/05/03/jack-daniels-running-intensity/) | C / D (floor) |

**Adaptation and load**

| Constant | Default | Source | Label |
|---|---|---|---|
| Compliance bands | 80–120 green; 50–79 or 121–150 yellow | [TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204861204) | C |
| Compliance "no change" | ≥90% weekly | Pfitzinger | C |
| Realignment trigger | >3 missed or 1 full week | Runna | C |
| Break pace table / return ramp | §8 R-BREAK; 50% × ceil(d/2) d, then 75% × ceil(d/2) d | Daniels via [RunnersTribe](https://runnerstribe.com/?p=8591) | C (weak) |
| Aerobic-cross-training column | ≥3 aerobic sessions/wk during the break | — | D |
| Illness return minimum | 10 d systemic / 5 d above-neck | [BJSM GRTP](https://blogs.bmj.com/bjsm/?p=10084) | C |
| Exercise challenge | 10–20 min at 60–70% | [IOC 2022](https://bjsm.bmj.com/content/early/2022/07/21/bjsports-2022-105759) | C |
| Pain thresholds | ≤3 green, 3–5 amber, >5 red; settle by morning | [Silbernagel](https://physicaltherapyfirst.com/blog/continued-sports-activity-using-a-pain-monitoring-model-during-rehabilitation-in-patients-with-achilles-tendinopathy/) | E (tendon) |
| Goal-revision trigger | ≥10 d lost in final 8 wk; peak LR < 85% of the plan's own L1; multiplier >2% | Pfitzinger / D | C/D |
| HRV baseline / band | 21–28 nights; mean ± 0.5 SD of 7-d ln(rMSSD) | [Vesterinen](https://jyx.jyu.fi/bitstream/handle/123456789/50625/vesterinenetalindividualendurancemsse.pdf?sequence=1) | E |
| Total-load trim trigger | >1.25–1.30 × 4-wk mean | — | D |
| Hard cross-training threshold | sRPE ≥7; team sports and HIIT always hard | — | D |
| Cross-training default sRPE | §10.2 table | — | D |
| Cross-training → running km | 0, always | — | D |

**Strength**

| Constant | Default | Source | Label |
|---|---|---|---|
| Strength modes | off / running-focused / full-body / external | — | D |
| Strength sessions/wk by phase | 2–3 / 2 / 2 / 1 / 1→0 (≤ user setting) | Blagrove, Rønnestad | E/C |
| Heavy load (build) | 3–5 × 3–5 @ RPE 8 (~85–90%); ≥90% for experienced lifters only | [Eihara](https://sportsmedicine-open.springeropen.com/articles/10.1186/s40798-022-00511-1) | E → D |
| Technique block (no lifting experience) | 4–6 wk, 3 × 8–12 @ RPE 6–7 | — | D |
| Plyo contacts | 40–60 start (30–40 for novices), +10–20/wk, cap 150 | Blagrove (30–228) | D |
| Last heavy / plyo session | race −10 to −14 d / −10 d (5K/10K: −7 to −10 d) | Berryman, RunnersConnect | C/D |
| Strength–run gap | ≥6 h | Runna, Doma | C |
| Min gap between heavy lower sessions | 48 h | Blagrove protocols | C |
| No heavy lower / plyo | LR day, LR −1, LR −2; day before quality | — | D on C |
| Load progression | +5 kg (+10 lb) squat/hinge, +2.5 kg (+5 lb) small lifts, at top of range with RIR ≥2 | — | D |
| Calf benchmark | ≥25 single-leg reps per side; asymmetry flag >10% | [Sleeswijk Visser](https://figshare.le.ac.uk/articles/journal_contribution/Normative_values_for_calf_muscle_strength-endurance_in_the_general_population_assessed_with_the_Calf_Raise_Application_A_large_international_cross-sectional_study/30209584) | E (norms) / D |

**Integrations and operations**

| Constant | Default | Source | Label |
|---|---|---|---|
| Max users | 10 (design target) | — | D |
| Runtime | Node 22 LTS, Postgres 16, pg-boss (Postgres ≥13, Node ≥22.12) | [pg-boss](https://github.com/timgit/pg-boss) | Platform |
| Host memory | 1–2 GB is enough (Node API + Postgres) | — | D |
| intervals.icu limits | 5,000/day and 2,500/15 min per key; 10 req/s per IP | [API thread](https://forum.intervals.icu/t/api-access-to-intervals-icu/609) | Platform |
| intervals.icu poll | 10–15 min per user, waking hours, staggered; global limiter ≤5 req/s | — | D |
| Workout push window | next 7–14 days (default 14); auto re-send for the next 3 d on missing read-back | — | D |
| Garmin Personal API token | re-mint every 24 h; alert 14 d before key expiry | [Garmin Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/) | D |
| Strava (only if enabled) | poll 15 min with `after = last − 1 d`; raw TTL 7 d; 10-athlete self-service upgrade | [Rate limits](https://developers.strava.com/docs/rate-limits/), [Policy §6.2](https://www.strava.com/legal/api_policy) | Policy / D |
| Dedup window | ±60 s start, ±2% distance | — | D |
| Health re-screen | every 12 months, or on health change | PAR-Q+ | C |
| Push batching | ≤1 plan-change notification per 2 h | — | D |
| Backups | nightly pg_dump off-box; 14 daily + 8 weekly | — | D |

---

## 14. Unverified items and open questions

**Must check before shipping:**

Engine
- **VDOT zone calibration.** Race equivalence is confirmed at VDOT 50. Still to do: check E, T, I and R training paces against the official Daniels tables at VDOT 25, 34, 50 and 60. Daniels' official per-zone % values are unpublished.
- **New per-level defaults are D.** Entry minimums, peak ceilings, LR time caps by level, the quality matrix, the 2:1 triggers and the 40% cross-training threshold have no trial support. Review them with a coach, and log outcomes.
- **Cold-start fallback** (`VO2(v)/0.78 − 1`) and the 30-min test → VDOT are unvalidated. Compare against TTs once users run them.
- **The run/walk ladder** is modeled on C25K. The exact NHS week-by-week schedule wasn't retrieved, so the stage table is D.
- **k_user interpolation by level** extrapolates the Fetcheveryone gradient (self-selected sample).
- **Heat slopes by level** are extrapolated from Ely's elite data.
- **Exercise cards** are D content. Get a coach or physio review before release.

intervals.icu
- **Whether per-user API keys are acceptable for a small multi-user app.** The API page says multi-user apps "should" use OAuth, and the terms are silent. v1 assumes per-user keys are fine; apply for OAuth now. Whether OAuth approval is given to private, unlisted 10-user apps is unconfirmed.
- **OAuth token lifetime and refresh.** Forum replies (unofficial) say there are no refresh tokens.
- **The athlete/profile endpoint** for the setup test call (`GET /api/v1/athlete/0` assumed) and the **athlete-settings endpoint** for writing threshold pace are unconfirmed.
- **Workout text syntax for pace targets, and whether API-created pace workouts keep targets on Garmin and COROS.** One Aug 2026 report says they showed duration-only on Garmin. **Test on each target device during setup.**
- **Streams type list.** Only `heartrate`, `watts` and `cadence` are confirmed.
- **The FIT upload endpoint** for forwarding user uploads (`POST /api/v1/athlete/0/activities`).
- **Garmin-origin data via the intervals.icu API after Oct 2026.** The restriction scope and timing are unannounced, and Garmin's "easier path" is undefined.
- **Suunto, HUAWEI, Wahoo and Amazfit workout push** on current models (forum evidence is old or thin).
- **COROS sync window** ("next couple of days") is a user report, not a documented limit.
- **Apple Watch → intervals.icu without Strava.** Intervals.icu Companion's auto-sync and workout delivery to Apple Watch, HealthFit's current direct sync, and BreakAway are all unverified.

Garmin
- **Personal API for multiple users** ("not intended for commercial applications serving multiple end users"): can each user use their own key with this app?
- Personal API endpoint paths, rate limits, backfill window, and whether its FIT files are stripped (Garmin began filtering some metrics from FIT files sent via the official sync in Sept 2026).
- FIT workout speed scale (×1000 assumed), and SDK-file import on newer firmware.
- Whether **`@garmin/fitsdk`'s `Encoder` can write workout (type 5) files** for `FitFileSink`; its licence terms (LICENSE.txt) also weren't read.

Strava (only if the adapter is enabled)
- Is the self-service 10-athlete upgrade still instant? Does §3.3 mean only one subscription is needed? There's an Agreement "no charge" conflict.
- The "AI Application" definition (Agreement) and §5.4 "analytics" scope.
- The new host name (`api-v3.strava.com`), and max `per_page`.

Platform and hosting
- **iOS web push reliability** on current iOS versions (the WebKit doc is from 16.4 beta). Test on a real device.
- **pg-boss version requirements** (Node ≥ 22.12, Postgres ≥ 13) come from the current README; pin a version.
- **Hetzner CX23 orderability.** Reported unavailable Sept–Oct 2026; confirm in the console.
- **Oracle Always Free idle-reclamation rule** (under 20% over 7 days) and the effective date of the A1 halving: the date given to us was Jun 15, 2026; one secondary source cites Aug 18, 2026.
- **Ruled-out host facts** (Render, Fly.io, Koyeb, AWS) were supplied by the coordinator, not re-verified here.
- **PAR-Q+ licensing.** The form must be used whole and unmodified. Confirm that the paraphrased screen plus links is acceptable, or license or embed the official form.
- **Claude Strava connector eligibility** (paid Strava subscription; Claude plan requirements unknown).

**Evidence gaps (accept or monitor):**
- No published thresholds exist for pace updates, cutback frequency, long-run optimum, the minimum post-disruption build, the minimum plan length by level, or exact strength–run hour windows. All are C or D here.
- The Frandsen cohort was 78% men with mean age 46, and the 95% CIs weren't retrieved. Generalizing it to beginners, younger runners, women and heavy cross-trainers is unverified.
- There are no data on running + other sports + lifting load interactions, and no validated cross-training → running conversion.
- The Daniels break table and the 50/75% ramp are secondhand.
- Silbernagel thresholds are validated for Achilles tendinopathy only.
- Vickers' mileage-adjusted model coefficients sit in an unretrieved supplement.
- The Rosenblat recreational-vs-competitive subgroup is post hoc.
- Sex-specific rules aren't implemented. Women benefited more from strict tapers in Smyth & Lawlor (E-obs); revisit this.

**Open product questions for the admin:**
- Auth: password or magic link?
- Apply for intervals.icu OAuth now, or ship with keys first?
- Enable the Strava adapter at all? It is only needed for Apple Watch users without a working bridge.
- Which hosting option? The default recommendation is home laptop + Cloudflare Tunnel.
- Should the friends feed ship in v1?
- Marathon long-run mode default: Daniels at 150 min, or Higdon/Pfitz at 180 min?
- Should HR-target fallback be the default for users whose watch strips pace targets?

---

## 15. Sources

**Integrations**
- intervals.icu: [API access](https://forum.intervals.icu/t/api-access-to-intervals-icu/609) · [OAuth support](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759) · [API Integration Cookbook](https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090) · [API Terms](https://forum.intervals.icu/t/intervals-icu-api-terms-and-conditions/114087) · [Integrations page](https://www.intervals.icu/integrations/) · [Streams](https://forum.intervals.icu/t/access-activities-streams-via-api/101065) · [Uploading planned workouts](https://forum.intervals.icu/t/uploading-planned-workouts-to-intervals-icu/63624) · [workout_doc via API](https://forum.intervals.icu/t/api-create-or-update-workout-without-using-description-text-syntax/124215) · [Garmin upload](https://forum.intervals.icu/t/upload-planned-workouts-to-garmin-connect/1521) · [Pace targets stripped](https://forum.intervals.icu/t/fit-import-strips-pace-targets/120680) · [Mixed targets](https://forum.intervals.icu/t/syncing-both-pace-and-heart-rate-to-garmin-connect-workout/67330/4) · [COROS sync](https://forum.intervals.icu/t/coros-sync-from-intervals-not-working/132316) · [COROS plan sync](https://forum.intervals.icu/t/coros-training-plan-is-created-but-planed-workouts-are-not-syncing/131097) · [Suunto upload](https://forum.intervals.icu/t/upload-workouts-to-suunto-watches/9560) · [Wahoo planned workouts](https://forum.intervals.icu/t/planned-workouts-with-wahoo-now-supported/54795) · [Polar workouts](https://forum.intervals.icu/t/load-the-programmed-training-in-polar-flow/6064) · [Device manufacturers thread](https://forum.intervals.icu/t/which-device-manufacturers-are-embracing-third-party-access-via-api/133000) · [Garmin bridge](https://forum.intervals.icu/t/garmin-intervals-bridge-your-complete-garmin-fit-files-and-wellness-data-in-intervals-icu-with-or-without-the-official-garmin-integration/132863) · [Apple Watch integration](https://forum.intervals.icu/t/integration-with-apple-watch/113470) · [Intervals Companion](https://forum.intervals.icu/t/a-new-intervals-companion-app-with-widgets/92334) · [HealthFit sync](https://forum.intervals.icu/t/healthfit-sync-for-activities-and-health-metrics/2718) · [Apple Health integration](https://forum.intervals.icu/t/best-way-to-integrate-apple-watch-apple-health-data-into-intervals-icu/5776) · [GAP issues](https://forum.intervals.icu/t/issues-with-gap/49213) · [the5krunner: Garmin cuts off Intervals](https://the5krunner.com/2026/10/14/garmin-api-intervals-third-party-apps/) · [AthleteData push guide](https://www.athletedata.health/guides/push-workouts-to-garmin-watch)
- Strava (optional adapter): [Authentication](https://developers.strava.com/docs/authentication/) · [API Reference](https://developers.strava.com/docs/reference/) · [Stream swagger](https://developers.strava.com/swagger/stream.json) · [Webhooks](https://developers.strava.com/docs/webhooks/) · [Rate limits](https://developers.strava.com/docs/rate-limits/) · [Changelog](https://developers.strava.com/docs/changelog/) · [API Policy](https://www.strava.com/legal/api_policy) · [API Agreement](https://www.strava.com/legal/api) · [Developer program update](https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428) · [Strava MCP connector for Claude](https://marathonhandbook.com/strava-now-lets-runners-talk-to-their-training-data-through-claude/)
- Commentary on terms: [Terra](https://tryterra.co/blog/strava-api-changes-2026) · [Sahha](https://sahha.ai/blog/health-api-ai-restrictions/) · [strava-mcp #53](https://github.com/r-huijts/strava-mcp/issues/53)
- Garmin: [Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/) · [Personal FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/) · [Program overview](https://developer.garmin.com/gc-developer-program/overview) · [Training API](https://developer.garmin.com/gc-developer-program/training-api) · [FIT workout file](https://developer.garmin.com/fit/articles/file-types/workout.html) · [the5krunner Oct 2026](https://the5krunner.com/2026/10/22/garmin-personal-api/) · [FIT SDK forum](https://forums.garmin.com/developer/fit-sdk/f/discussion/396686/epix-pro-ii-stopped-processing-workout-fit-files) · [Pace-target forum](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-web/438551/externally-generated-running-workouts-lose-pace-targets-while-hr-targets-remain-functional) · [python-garminconnect](https://github.com/cyberjunky/python-garminconnect)
- Apple and web platform: [WebKit: Web Push for Web Apps on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) · [CustomWorkout](https://developer.apple.com/documentation/workoutkit/customworkout) · [WorkoutScheduler](https://developer.apple.com/documentation/workoutkit/workoutscheduler)
- Other platforms: [Tredict COROS](https://www.tredict.com/blog/coros_training_sync/) · [Polar AccessLink](https://www.polar.com/accesslink-api/) · [Suunto API Zone](https://apizone.suunto.com/faq)

**Stack and hosting**
- [Garmin FIT JavaScript SDK](https://github.com/garmin/fit-javascript-sdk) · [@garmin/fitsdk on npm](https://npmjs.com/package/@garmin/fitsdk) · [pg-boss](https://github.com/timgit/pg-boss) · [Bitdoze: Hetzner Cloud prices 2026](https://www.bitdoze.com/es/hetzner-cloud-precios-2026/) · [Findstack: Hetzner 2026 increase](https://findstack.com/resources/hetzner-price-increase-2026) · [Linuxiac: Oracle halves Ampere A1 free tier](https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/)

**Onboarding, screening and beginners**
- [PAR-Q+ 2025 form](https://southlake.ca/wp-content/uploads/2025/02/PARQPlus2025-Form-fillable.pdf) · [ePARmed-X+](https://www.eparmedx.com) · [NHS Couch to 5K](https://www.nhs.uk/live-well/exercise/get-running-with-couch-to-5k/) · [Hottenrott 2016 run/walk RCT](https://edoc.unibas.ch/57171) · [Videbæk 2015 injury incidence](https://pubmed.ncbi.nlm.nih.gov/25951917/) · [Tanaka 2001 HRmax](https://pubmed.ncbi.nlm.nih.gov/11153730/)

**Pace and fitness**
- [Bill Mill VDOT notes](https://notes.billmill.org/fitness/calculating_v02_max.html) · [RunBundle predictors](https://runbundle.com/tools/race-predictors/general-race-predictors) · [Wikipedia: Jack Daniels](https://en.wikipedia.org/wiki/Jack_Daniels_(coach)) · [AthleteData VDOT](https://www.athletedata.health/guides/vdot-running-paces) · [Vickers & Vertosick 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5000509/) · [Fetcheveryone](https://www.fetcheveryone.com/article/marathon-predictions-3-0-116)
- [Uth 2004](https://www.springermedizin.de/estimation-of-vo2max-from-the-ratio-between-hrmax-and-hrrest-the/8478242) · [Firstbeat](https://www.firstbeat.com/en/science-and-physiology/fitness-level/) · [Gao 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8283806) · [EJAP 2025 Garmin](https://link.springer.com/article/10.1007/s00421-025-05923-x) · [TrainingPeaks EF/decoupling](https://help.trainingpeaks.com/hc/en-us/articles/204071724-Aerobic-Decoupling-and-Efficiency-Factor) · [Smyth & Muniz-Pumares CS](https://uhra.herts.ac.uk/id/eprint/8225/1/Calculation_of_Critical_Speed_from_Raw_Training.96275.pdf)
- [Minetti 2002](https://iris.unibs.it/retrieve/ddc633e4-3c03-4e2e-e053-3705fe0a4c80/Minetti%20JAP%202002.pdf) · [Strava GAP](https://medium.com/strava-engineering/an-improved-gap-model-8b07ae8886c3) · [Educated Guesswork](https://educatedguesswork.org/posts/grade-vs-pace/)
- [Ely 2007](https://experts.umn.edu/en/publications/impact-of-weather-on-marathon-running-performance/) · [El Helou 2012](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0037407) · [Gasparetto 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7350124) · [TrainingPeaks heat](https://www.trainingpeaks.com/blog/running-in-the-heat-how-to-adjust-training-and-race-pace/)
- [Strava moving time](https://support.strava.com/hc/en-us/articles/115001188684-Moving-Time-Speed-and-Pace-Calculations) · [GPS outlier detection](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5191017/)

**Plan structure**
- [Coach Ray periodisation](https://coachray.nz/2021/10/11/jack-daniels-phd-formulaic-approach-to-periodisation) · [Coach Ray intensities](https://www.coachray.nz/2023/05/03/jack-daniels-running-intensity/) · [Running with Rock: Daniels](https://runningwithrock.com/training-explained-jack-daniels-running-formula/) · [Pfitz](https://runningwithrock.com/pfitz-marathon-training-explained/) · [Higdon](https://runningwithrock.com/hal-higdon-marathon-training-plan/) · [Hansons](https://runningwithrock.com/pros-and-cons-of-the-hanson-marathon-training-plan/) · [Marathon Handbook Hansons](https://marathonhandbook.com/hansons-marathon-method/) · [Luke Humphrey](https://lukehumphreyrunning.com/the-classic-hanson-marathon-training-programs/)
- [Casado 2022](https://lida.sport-iat.de/ta/Record/4076169?lng=en) · [Rosenblat 2025](https://www.stir.ac.uk/research/hub/publication/2095779) · [Rivera-Köfler review](https://mtntactical.com/research/research-review-effects-of-polarized-vs-other-training-intensity-distribution-models-on-endurance-performance/) · [Stöggl & Sperlich 2014](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2014.00033/full) · [Bellinger via Outside](https://www.outsideonline.com/health/training-performance/training-distribution-study/?scope=anon)
- [Buist 2008](https://bjsm.bmj.com/content/43/2/155) · [Nielsen 2014](https://vbn.aau.dk/da/publications/excessive-progression-in-weekly-running-distance-and-risk-of-runn) · [Frandsen 2025 blog](https://blogs.bmj.com/bjsm/?p=11751) · [Impellizzeri 2020](https://opus.lib.uts.edu.au/handle/10453/141898) · [Lolli 2019](https://bjsm.bmj.com/content/53/15/921) · [Canadian Running Daniels](https://runningmagazine.ca/?p=99607) · [RunnersConnect progression](https://runnersconnect.net/?p=6471)
- [Bosquet 2007](https://pubmed.ncbi.nlm.nih.gov/17762369/) · [Wang 2023](https://www.fisiologiadelejercicio.com/wp-content/uploads/2023/05/Effects-of-tapering-on-performance-in-endurance-athletes.pdf) · [Smyth & Lawlor via Marathon Handbook](https://marathonhandbook.com/optimal-marathon-taper-length/) · [RunnersConnect taper](https://runnersconnect.net/running-training-articles/how-to-taper-for-a-marathon/)
- [Canadian Running cross-training](https://runningmagazine.ca/?p=74656)

**Adaptive replanning**
- [Mujika & Padilla Part I](https://runpanel.co.il/wp-content/uploads/2023/08/Detraining-Loss-of-Training-Induced-Physiological-and-Performance-Adaptations.-Part-I.pdf) · [Part II](https://paulogentil.com/pdf/Detraining%20-%20Loss%20of%20Training-Induced%20Physiological%20and%20Performance%20Adaptations.%20Part%20II.pdf) · [TrainingPeaks detraining](https://www.trainingpeaks.com/blog/what-happens-to-your-body-during-a-training-break/)
- [Feely 2023](https://www.frontiersin.org/articles/10.3389/fspor.2022.1096124/full) · [RunnersTribe Daniels table](https://runnerstribe.com/?p=8591) · [Pfitzinger excerpt](https://us.humankinetics.com/blogs/excerpt/what-to-do-when-your-marathon-training-gets-interrupted)
- [IOC ARI consensus 2022](https://bjsm.bmj.com/content/early/2022/07/21/bjsports-2022-105759) · [BJSM GRTP](https://blogs.bmj.com/bjsm/?p=10084) · [Silbernagel summary](https://physicaltherapyfirst.com/blog/continued-sports-activity-using-a-pain-monitoring-model-during-rehabilitation-in-patients-with-achilles-tendinopathy/)
- [Haddad 2017](https://www.frontiersin.org/articles/10.3389/fnins.2017.00612/full) · [Foster 1998](https://sponet.de/sponet/Record/4001707)
- [Granero-Gallegos 2020](https://www.mdpi.com/1660-4601/17/21/7999) · [Manresa-Rocamora 2021](https://pubmed.ncbi.nlm.nih.gov/34489178/) · [Vesterinen 2016](https://jyx.jyu.fi/bitstream/handle/123456789/50625/vesterinenetalindividualendurancemsse.pdf?sequence=1) · [Altini HRV history](https://marcoaltini.substack.com/p/a-brief-history-of-heart-rate-variability)
- Runna: [Skip](https://support.runna.com/en/articles/15012850-how-and-when-to-skip-a-run-managing-missed-sessions-in-your-training-plan) · [Realignment](https://support.runna.com/en/articles/10026375-how-to-use-the-plan-realignment-feature) · [Feeling unwell](https://intercom.help/runna/en/articles/12809806-feeling-unwell-how-to-adapt-your-training-plan) · [Pace Insights](https://support.runna.com/en/articles/10854865-what-are-pace-insights-and-how-do-pace-recommendations-work) · [Current fitness](https://support.runna.com/en/articles/15231838-how-does-runna-build-your-training-plan-around-your-current-fitness)
- Other apps: [TrainAsONE missed](https://trainasone.com/faqs/2025/i-missed-a-workout-and-now-it-has-disappeared-how-can-i-do-it-today) · [TrainingPeaks compliance](https://help.trainingpeaks.com/hc/en-us/articles/204861204) · [the5krunner "Is Runna AI?"](https://the5krunner.com/2026/09/28/is-runna-ai/) · [9to5Mac heat](https://9to5mac.com/2026/07/29/runna-now-automatically-adapts-training-paces-based-on-heat-and-humidity/)

**Strength**
- [Llanos-Lagos 2024 RE](https://repository.essex.ac.uk/37272/) · [Llanos-Lagos 2024 performance](https://repository.essex.ac.uk/37960) · [Eihara 2022](https://sportsmedicine-open.springeropen.com/articles/10.1186/s40798-022-00511-1) · [Blagrove 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC5889786) · [Berryman via Outside](https://www.outsideonline.com/health/training-performance/strength-training-taper-research?scope=anon)
- [Lauersen 2014](https://bjsm.bmj.com/content/48/11/871) · [Wu 2024 summary](https://marathonhandbook.com/injury-prevention-strength-training/) · [Fontana 2024](https://doaj.org/article/80f466f2048a4466b4b0b58097124c93)
- [Wilson 2012](https://search.pedro.org.au/search-results/record-detail/34457) · [Doma & Deakin](https://researchonline.jcu.edu.au/28717/) · [Rønnestad 2011](https://nih.brage.unit.no/nih-xmlui/handle/11250/171044?show=full) · [RunnersConnect strength taper](https://runnersconnect.net/when-should-i-stop-strength-training-at-the-gym-before-the-marathon/)
- [Barbell Medicine calves](https://www.barbellmedicine.com/blog/a-case-for-training-calves/) · [Barbell Medicine injury](https://www.barbellmedicine.com/blog/strength-training-for-endurance-athletes-part-i-resistance-training-and-injury-risk/) · [Calf norms 2025](https://figshare.le.ac.uk/articles/journal_contribution/Normative_values_for_calf_muscle_strength-endurance_in_the_general_population_assessed_with_the_Calf_Raise_Application_A_large_international_cross-sectional_study/30209584)
- [Day 2004](https://paulogentil.com/pdf/TREINO%20DE%20FORC%CC%A7A/Monitoring%20Exercise%20Intensity%20During%20Resistance%20Training%20Using%20the%20Session%20RPE%20Scale.pdf) · [Sweet 2004](https://lida.sport-iat.de/ta/Record/4009123)
- Runna strength: [Strength placement](https://support.runna.com/en/articles/6830469-when-to-complete-your-strength-sessions) · [Strength guide](https://www.runna.com/guides/how-to/how-to-balance-strength-training-and-running)
