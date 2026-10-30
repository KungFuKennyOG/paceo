import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../src/api/client";
import { connectErrorMessage, ConnectStep } from "../src/onboarding/steps/ConnectStep";
import { defaultProfileDraft } from "../src/onboarding/draft";
import { renderWithProviders } from "./helpers";

describe("connect flow (§2.5)", () => {
  it("maps rejected keys and rate limits to the spec copy", () => {
    expect(connectErrorMessage(new ApiError(400, "key_rejected", "x"))).toBe("Key not accepted — copy it again from Developer Settings.");
    expect(connectErrorMessage(new ApiError(401, "http_401", "x"))).toBe("Key not accepted — copy it again from Developer Settings.");
    expect(connectErrorMessage(new ApiError(429, "http_429", "x"))).toMatch(/busy/);
  });

  it("shows per-brand steps and the user's threshold pace in their units", async () => {
    const d = {
      ...defaultProfileDraft(),
      units: "imperial" as const,
      watchBrand: "garmin" as const,
      hasRecentResult: true,
      recentResult: { distanceM: 10000, timeS: 2910, date: "2026-10-01", kind: "race" as const },
    };
    renderWithProviders(<ConnectStep d={d} set={() => undefined} connect={{ connected: false, skipped: false }} onConnect={() => undefined} initialStatus={null} errors={{}} />);
    expect(screen.getByText(/Settings → Connections → Garmin Connect/)).toBeInTheDocument();
    expect(screen.getByText(/Upload planned workouts/)).toBeInTheDocument();
    expect(screen.getByTestId("threshold-pace").textContent).toMatch(/^\d+:\d{2} \/mi$/);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("API key"), "abcdefghijk");
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("tells Polar users workouts are followed in the app", () => {
    const d = { ...defaultProfileDraft(), watchBrand: "polar" as const };
    renderWithProviders(<ConnectStep d={d} set={() => undefined} connect={{ connected: false, skipped: false }} onConnect={() => undefined} initialStatus={null} errors={{}} />);
    expect(screen.getAllByText(/follow each session step by step in Paceo/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/threshold pace/i)).not.toBeInTheDocument();
  });
});
