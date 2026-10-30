import { useEffect, useRef, useState } from "react";
import type { Units } from "@paceo/engine";
import { describeDuration, describeTarget, exercisePrescription, flattenSteps, type ViewWorkout } from "../lib/workout";
import { formatMinSec } from "../lib/units";

interface Card {
  title: string;
  sub?: string;
  big: string;
  target?: string;
  note?: string;
  seconds?: number;
}

function cardsFor(w: ViewWorkout, units: Units, hrMax: number | null): Card[] {
  if (w.steps.length > 0) {
    return flattenSteps(w.steps).map((f) => {
      const c: Card = {
        title: f.label,
        big: describeDuration(f.step.duration, { units, inRepeat: f.inRepeat, longRun: w.type === "L" }),
        target: describeTarget(f.step.target, { units, hrMax }),
      };
      if (f.repLabel) c.sub = f.repLabel;
      const notes = [f.step.fallback ? `or ${describeTarget(f.step.fallback, { units, hrMax })}` : null, f.step.note ?? null].filter(Boolean);
      if (notes.length) c.note = notes.join(" · ");
      if (f.step.duration.type === "time") c.seconds = f.step.duration.s;
      return c;
    });
  }
  return w.exercises.map((ex, i) => {
    const c: Card = { title: `Exercise ${i + 1} of ${w.exercises.length}`, big: ex.name, target: exercisePrescription(ex) };
    if (ex.cues.length) c.note = ex.cues.join(" · ");
    return c;
  });
}

/**
 * Step-by-step "follow in app" view (§3.6): the fallback for watches without workout delivery.
 * A simple per-step timer counts down time-based steps; nothing records GPS (PWA limit, §2.1).
 */
export function FollowMode({ w, units, hrMax = null, onExit }: { w: ViewWorkout; units: Units; hrMax?: number | null; onExit: () => void }) {
  const cards = cardsFor(w, units, hrMax);
  const [idx, setIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  useEffect(() => {
    // Keep the screen on while following, where supported.
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    if (running && nav.wakeLock) {
      nav.wakeLock.request("screen").then(
        (l) => {
          wakeLock.current = l;
        },
        () => undefined,
      );
    }
    return () => {
      void wakeLock.current?.release().catch(() => undefined);
      wakeLock.current = null;
    };
  }, [running]);

  if (cards.length === 0) {
    return (
      <div className="follow">
        <p>This session has no steps to follow.</p>
        <button type="button" className="btn" onClick={onExit}>
          Close
        </button>
      </div>
    );
  }

  const card = cards[Math.min(idx, cards.length - 1)] as Card;
  const go = (i: number) => {
    setIdx(Math.max(0, Math.min(cards.length - 1, i)));
    setElapsed(0);
  };
  const remaining = card.seconds !== undefined ? card.seconds - elapsed : null;
  const finished = idx === cards.length - 1 && remaining !== null && remaining <= 0;

  return (
    <section className="follow" aria-label="Follow workout" data-testid="follow-mode">
      <div className="row row--between">
        <span className="eyebrow">
          Step {idx + 1} of {cards.length}
        </span>
        <button type="button" className="btn btn--small" onClick={onExit}>
          Close
        </button>
      </div>
      <div className="stack stack--tight" aria-live="polite">
        <span className="eyebrow">
          {card.title}
          {card.sub ? ` · ${card.sub}` : ""}
        </span>
        <span className="follow__big">{card.big}</span>
        {card.target && <span className="follow__target">{card.target}</span>}
        {card.note && <span className="small">{card.note}</span>}
      </div>
      {remaining !== null && (
        <div className="row row--between">
          <span className="hero-number" style={{ fontSize: "2.6rem", color: remaining <= 0 ? "var(--accent)" : undefined }}>
            {remaining <= 0 ? "0:00" : formatMinSec(remaining)}
          </span>
          <button type="button" className="btn btn--small" onClick={() => setRunning((r) => !r)}>
            {running ? "Pause" : elapsed > 0 ? "Resume" : "Start timer"}
          </button>
        </div>
      )}
      <div className="row row--nowrap">
        <button type="button" className="btn grow" onClick={() => go(idx - 1)} disabled={idx === 0}>
          Back
        </button>
        <button type="button" className="btn btn--primary grow" onClick={() => (idx === cards.length - 1 ? onExit() : go(idx + 1))}>
          {idx === cards.length - 1 ? (finished ? "Finish" : "Done") : "Next"}
        </button>
      </div>
      <span className="tiny" style={{ opacity: 0.7 }}>
        Your watch still records the run. This view just guides you through the steps.
      </span>
    </section>
  );
}
