import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPLAINED_PREFIXES,
  explain,
  explainOne,
  generatePlan,
  replan,
  rulePrefix,
  type CheckInEvent,
  type GeneralFitnessInput,
  type Plan,
  type PlanInput,
} from "../src/index.js";
import { personaA, personaA2, personaB, personaC } from "./personas.js";
import { preHistory, ranAsPlanned, stateOf } from "./replan-fixtures.js";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Rule-ID prefixes written as string literals in the engine ("P3:…", `W-T:${…}`, "W-E", "RACE"). */
function emittedPrefixes(): Map<string, string> {
  const id = /["'`]((?:[A-Z][A-Za-z0-9]*(?:-[A-Z0-9]+)*)|§[\d.]+):(?=[^\s"'`$])/g;
  const bare = /["'`](W-[A-Z]+|RACE)["'`]/g;
  const out = new Map<string, string>();
  for (const f of sourceFiles(SRC)) {
    if (f.endsWith("explain.ts")) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(id)) out.set(m[1]!, f);
    for (const m of text.matchAll(bare)) out.set(m[1]!, f);
  }
  return out;
}

const traces = (p: Plan): string[] => p.weeks.flatMap((w) => w.workouts.flatMap((x) => x.rule_trace));

describe("§11.4 rule traces → plain English", () => {
  it("renders the spec example; unknown IDs degrade gracefully", () => {
    const lines = explain(["P3:EQ:HM:T", "I2:intermediate:5d:Q1", "V1:ok(10.5<=12.1)", "HEAT:+3.5%"]);
    expect(lines[0]).toBe("Threshold work: this is the Early Quality phase of a half-marathon plan, where it's the main stimulus (Daniels).");
    expect(lines[1]).toBe("As an intermediate runner on 5 days a week, this is your main quality session this week.");
    expect(lines[2]).toBe("10.5 km is within your safe single-run limit of 12.1 km (10% over your longest run in the last 30 days).");
    expect(lines[3]).toBe("Rule HEAT applied.");
    expect(explainOne("HEAT:+3.5%").known).toBe(false);
    expect(explainOne("NO_COLON").text).toBe("Rule NO_COLON applied.");
  });

  it("formats units per user", () => {
    expect(explain(["V1:ok(16.1<=17.7)"], "imperial")[0]).toBe("10.0 mi is within your safe single-run limit of 11.0 mi (10% over your longest run in the last 30 days).");
    expect(explain(["R-LOAD-1:v1_actual(9.0<=9.9)"])[0]).toMatch(/9\.0 km.*9\.9 km/);
  });

  it("explains replan markers", () => {
    expect(explain(["R-BREAK:vol×0.5"])[0]).toBe("Volume set to 50% because of your return from a break.");
    expect(explain(["R-BREAK:pace×0.985"])[0]).toBe("Paces are 1.5% slower because of your return from a break.");
    expect(explain(["R-PAIN:easy(was:I)"])[0]).toBe("Now an easy run instead of the planned interval session, because of pain you reported.");
    expect(explain(["R-MISS-2:from(2026-12-01)"])[0]).toBe("Moved here from 2026-12-01 because of a missed key session.");
    expect(explain(["FIT-UPDATE:vdot(50.0->50.8)"])[0]).toBe("Paces updated for your new fitness (VDOT 50.0 → 50.8).");
  });

  it("deduplicates and is deterministic", () => {
    expect(explain(["W-E", "W-E"])).toHaveLength(1);
    expect(explain(["P3:TQ:M:I"])).toEqual(explain(["P3:TQ:M:I"]));
  });

  it("has a template for every rule-ID prefix written in the engine source", () => {
    const missing = [...emittedPrefixes()].filter(([p]) => !EXPLAINED_PREFIXES.includes(p)).map(([p, f]) => `${p} (${f})`);
    expect(missing, "prefixes without an explanation template").toEqual([]);
  });

  it("explains every trace the generator and the replanner actually emit", () => {
    const { raceDate: _r, goal: _g, ...rest } = personaC;
    const gf: GeneralFitnessInput = { ...rest, goal: { type: "general_fitness", weeks: 12 } };
    const inputs: PlanInput[] = [personaA, personaA2, personaB, personaC, { ...personaB, longRunMode: "pfitz" }];
    const all = new Set<string>([...inputs.flatMap((i) => traces(generatePlan(i))), ...traces(generatePlan(gf))]);
    const planB = generatePlan(personaB);
    const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2026-12-08")];
    const events: CheckInEvent[][] = [
      [],
      [{ type: "illness", date: "2026-12-08", fever: false, systemic: false, aboveNeck: true }],
      [{ type: "pain", date: "2026-12-06", bodyPart: "knee", during: 4 }],
      [{ type: "pain", date: "2026-12-06", bodyPart: "knee", during: 6, nextMorning: 4 }],
    ];
    for (const ev of events) for (const t of traces(replan(stateOf(personaB, acts, planB), ev, "2026-12-08").plan)) all.add(t);
    for (const t of traces(replan(stateOf(personaB, acts, planB), [], "2026-12-20").plan)) all.add(t);
    const unknown = [...all].filter((t) => !explainOne(t).known).map(rulePrefix);
    expect([...new Set(unknown)], "trace IDs without a template").toEqual([]);
    for (const t of all) expect(explainOne(t).text !== "", t).toBe(true);
  });
});
