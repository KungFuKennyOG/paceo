import type { SimpleStep, Step } from "@paceo/engine";
import type { Units } from "@paceo/engine";
import {
  describeDuration,
  describeTarget,
  exercisePrescription,
  isRepeatStep,
  stepLabel,
  type DescribeContext,
  type Exercise,
  type ViewWorkout,
} from "../lib/workout";
import { formatLoad, formatSeconds } from "../lib/units";

function StepRow({ step, ctx }: { step: SimpleStep; ctx: DescribeContext }) {
  const target = describeTarget(step.target, ctx);
  const fallback = step.fallback ? describeTarget(step.fallback, ctx) : null;
  return (
    <li className={`step step--${step.kind}`} data-testid="step">
      <span className="step__bar" aria-hidden="true" />
      <div className="step__main">
        <span className="step__kind">{stepLabel(step)}</span>
        <span className="step__target">{target}</span>
        {fallback && <span className="step__fallback">or {fallback}</span>}
        {step.rpe && step.target.type !== "rpe" && <span className="step__fallback">RPE {step.rpe.replace("-", "–")}</span>}
        {step.note && <span className="step__note">{step.note}</span>}
      </div>
      <span className="step__dur">{describeDuration(step.duration, ctx)}</span>
    </li>
  );
}

/** Structured run steps with targets in the user's units. Repeats render as a grouped block. */
export function WorkoutSteps({ steps, units, longRun = false, hrMax = null }: { steps: Step[]; units: Units; longRun?: boolean; hrMax?: number | null }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps" aria-label="Workout steps">
      {steps.map((s, i) => {
        if (isRepeatStep(s)) {
          const ctx: DescribeContext = { units, inRepeat: true, hrMax };
          return (
            <li key={i} className="repeat">
              <span className="repeat__head">{s.count} ×</span>
              <ol className="steps">
                {s.steps.map((inner, j) => (
                  <StepRow key={j} step={inner} ctx={ctx} />
                ))}
              </ol>
            </li>
          );
        }
        return <StepRow key={i} step={s} ctx={{ units, longRun, hrMax }} />;
      })}
    </ol>
  );
}

export function ExerciseList({ exercises, units }: { exercises: Exercise[]; units: Units }) {
  if (exercises.length === 0) return null;
  return (
    <ol className="exercises" aria-label="Exercises">
      {exercises.map((ex, i) => {
        const rx = exercisePrescription(ex);
        const hasMore = Boolean(ex.description || ex.cues.length || ex.commonFaults.length || ex.notes || ex.demoUrl);
        const head = (
          <>
            <span className="grow">
              <strong>{ex.name}</strong>
              {ex.slot && <span className="tiny muted"> · {ex.slot.replace(/_/g, " ").toLowerCase()}</span>}
            </span>
            <span className="small num">{rx}</span>
          </>
        );
        const meta: string[] = [];
        if (ex.loadKg !== undefined) meta.push(formatLoad(ex.loadKg, units, ex.loadKg < 20));
        if (ex.restS !== undefined) meta.push(`rest ${formatSeconds(ex.restS)}`);
        return (
          <li key={`${ex.name}-${i}`} className="exercise" data-testid="exercise">
            {hasMore ? (
              <details>
                <summary>{head}</summary>
                {meta.length > 0 && <p className="small muted">{meta.join(" · ")}</p>}
                {ex.description && <p className="small">{ex.description}</p>}
                {ex.cues.length > 0 && (
                  <ul aria-label="Cues">
                    {ex.cues.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                {ex.commonFaults.length > 0 && (
                  <p className="small">
                    <span className="muted">Watch for: </span>
                    {ex.commonFaults.join("; ")}
                  </p>
                )}
                {ex.notes && <p className="small muted">{ex.notes}</p>}
                {ex.demoUrl && (
                  <a className="small" href={ex.demoUrl} target="_blank" rel="noreferrer noopener">
                    Demo
                  </a>
                )}
              </details>
            ) : (
              <div className="row row--between">{head}</div>
            )}
            {!hasMore && meta.length > 0 && <p className="small muted">{meta.join(" · ")}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** Steps or exercises, whichever the workout carries; unknown shapes get a neutral note. */
export function WorkoutBody({ w, units, hrMax = null }: { w: ViewWorkout; units: Units; hrMax?: number | null }) {
  const hasSteps = w.steps.length > 0;
  const hasExercises = w.exercises.length > 0;
  return (
    <>
      {hasSteps && <WorkoutSteps steps={w.steps} units={units} longRun={w.type === "L"} hrMax={hrMax} />}
      {hasExercises && <ExerciseList exercises={w.exercises} units={units} />}
      {!hasSteps && !hasExercises && (
        <p className="small muted">No structured steps for this session. Follow the plan summary above.</p>
      )}
      {w.skippedSteps > 0 && (
        <p className="tiny muted">{w.skippedSteps} step(s) use a format this app version can't show yet.</p>
      )}
    </>
  );
}
