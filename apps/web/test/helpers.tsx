import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function renderWithProviders(ui: ReactElement, { route = "/" }: { route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Spec §3.8 example: cruise intervals 4 × 8 min @ T. */
export const T_WORKOUT = {
  id: "wk-2026-W47-tue",
  user_id: "u_123",
  date: "2026-11-17",
  sport: "run",
  type: "T",
  name: "Cruise intervals 4 × 8 min @ T",
  phase: "EQ",
  prescription_mode: "pace",
  steps: [
    { kind: "warmup", duration: { type: "time", s: 900 }, target: { type: "hr_pct_max", lo: 65, hi: 79 } },
    {
      kind: "repeat",
      count: 4,
      steps: [
        {
          kind: "work",
          duration: { type: "time", s: 480 },
          target: { type: "pace", lo_s_per_km: 350, hi_s_per_km: 367 },
          fallback: { type: "hr_pct_max", lo: 88, hi: 92 },
          rpe: "7-8",
        },
        { kind: "recovery", duration: { type: "time", s: 60 }, target: { type: "open" } },
      ],
    },
    { kind: "cooldown", duration: { type: "time", s: 600 }, target: { type: "open" } },
  ],
  planned: { run_m: 10500, minutes: 62, expected_srpe: 6 },
  flags: { heat_adjusted: false, key_session: true },
  rule_trace: ["P3:EQ:HM:T", "I2:intermediate:5d:Q1", "W-T:prog+5min", "V1:ok(10.5<=12.1)"],
};

export const STRENGTH_WORKOUT = {
  id: "str-1",
  user_id: "u_123",
  date: "2026-11-18",
  sport: "strength",
  type: "STRENGTH",
  name: "Strength A",
  prescription_mode: "time_rpe",
  steps: [],
  planned: { run_m: 0, minutes: 45, expected_srpe: 6 },
  exercises: [
    { name: "Heavy goblet squat", slot: "SQUAT", sets: 3, reps: "6–8", rpe: "7", load_kg: 24, rest_s: 120, cues: ["Chest up", "Drive through mid-foot"], common_faults: ["Heels lifting"] },
    { name: "Single-leg calf raise", sets: 3, reps: 12 },
    "Side plank",
    { notAName: true },
  ],
};
