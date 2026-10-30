/**
 * "Why this workout" lines (spec §11.4) behind a small interface.
 *
 * TODO(engine-explain): once @paceo/engine exports `explain(trace, units)`, call it directly with
 * proper types. Until then `defaultExplainer` uses it if present at runtime and otherwise returns the
 * raw rule_trace strings.
 */
import * as engine from "@paceo/engine";
import type { Units } from "@paceo/engine";

export interface ExplainableWorkout {
  rule_trace?: readonly string[] | undefined;
}

export interface Explainer {
  explain(workout: ExplainableWorkout, units: Units): string[];
}

export const ruleTraceExplainer: Explainer = {
  explain: (w) => [...(w.rule_trace ?? [])],
};

type MaybeExplain = (trace: readonly string[], units: Units) => unknown;

export function createDefaultExplainer(): Explainer {
  const candidate = (engine as unknown as Record<string, unknown>)["explain"];
  if (typeof candidate !== "function") return ruleTraceExplainer;
  const fn = candidate as MaybeExplain;
  return {
    explain(w, units) {
      const trace = w.rule_trace ?? [];
      try {
        const out = fn(trace, units);
        if (Array.isArray(out) && out.every((x) => typeof x === "string")) return out as string[];
        if (typeof out === "string") return out.split("\n").filter(Boolean);
      } catch {
        /* fall back */
      }
      return [...trace];
    },
  };
}
