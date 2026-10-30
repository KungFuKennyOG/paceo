import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivitySummary, ProposalDecisionResponse, ProposalListResponse } from "@paceo/contracts";
import { api, fetchTransport, setTransport, type TransportRequest } from "../src/api/client";
import { mockTransport, resetMock } from "../src/mock/server";
import { demoProposals, proposalDecision } from "../src/mock/fixtures";
import { ProposalList } from "../src/components/Proposals";
import { FitUpload } from "../src/components/FitUpload";
import { GarminAttributionAny } from "../src/components/WorkoutBits";
import { renderWithProviders } from "./helpers";

const TODAY = "2026-11-02";
const NOW = new Date("2026-11-02T14:00:00Z");

describe("proposal fixtures and mock routes match the contract", () => {
  beforeEach(() => {
    resetMock();
    setTransport((req) => mockTransport(req, { latencyMs: 0 }));
  });
  afterEach(() => {
    resetMock();
    setTransport(fetchTransport);
  });

  it("fixtures parse", () => {
    const items = demoProposals(TODAY, NOW);
    expect(() => ProposalListResponse.parse({ items })).not.toThrow();
    for (const p of items) {
      expect(() => ProposalDecisionResponse.parse(proposalDecision(p, true))).not.toThrow();
      expect(() => ProposalDecisionResponse.parse(proposalDecision(p, false))).not.toThrow();
    }
    for (const kind of ["realign", "goal_change", "something_new"]) {
      expect(() => ProposalDecisionResponse.parse(proposalDecision({ ...items[0]!, kind, details: {} }, true))).not.toThrow();
    }
  });

  it("lists, answers, and refuses a second answer", async () => {
    await api.login({ email: "demo@paceo.run", password: "x" });
    const list = ProposalListResponse.parse(await api.proposals());
    expect(list.items).toHaveLength(1);
    const id = list.items[0]!.id;
    const r = ProposalDecisionResponse.parse(await api.respondProposal(id, true));
    expect(r.planChanges[0]).toMatch(/Paces updated/);
    expect(ProposalListResponse.parse(await api.proposals()).items).toHaveLength(0);
    await expect(api.respondProposal(id, false)).rejects.toMatchObject({ status: 409, code: "proposal_closed" });
    await expect(api.respondProposal("nope", true)).rejects.toMatchObject({ status: 404 });
  });
});

describe("proposal card", () => {
  beforeEach(async () => {
    resetMock();
    setTransport((req) => mockTransport(req, { latencyMs: 0 }));
    await api.login({ email: "demo@paceo.run", password: "x" });
  });
  afterEach(() => {
    resetMock();
    setTransport(fetchTransport);
  });

  it("shows the message with Accept / Not now, then the resulting plan changes", async () => {
    renderWithProviders(<ProposalList />);
    const card = await screen.findByTestId("proposal-card");
    expect(within(card).getByText(/Speed up your paces/)).toBeInTheDocument();
    expect(within(card).getByText(/VDOT 44.1 → 44.7 · paces about 1.2% faster/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Not now" })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect(await within(card).findByText(/Paces updated: VDOT 44.1 → 44.7/)).toBeInTheDocument();
    // The answered card stays with its result; no buttons left.
    expect(screen.getByTestId("proposal-card")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("Not now declines and says the plan stays", async () => {
    renderWithProviders(<ProposalList />);
    const card = await screen.findByTestId("proposal-card");
    await userEvent.click(within(card).getByRole("button", { name: "Not now" }));
    expect(await within(card).findByText(/stays as it is/)).toBeInTheDocument();
  });

  it("renders nothing without proposals", async () => {
    setTransport(async (req: TransportRequest) => (req.url.startsWith("/api/proposals") ? { status: 200, json: { items: [] } } : { status: 404 }));
    const { container } = renderWithProviders(<ProposalList />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector("[data-testid=proposal-card]")).toBeNull();
  });
});

describe("Garmin attribution", () => {
  afterEach(() => setTransport(fetchTransport));

  const garminActivity: ActivitySummary = {
    id: "up1",
    source: "fit_upload",
    originPlatform: "garmin",
    startUtc: "2026-11-01T12:00:00Z",
    localDate: "2026-11-01",
    sport: "run",
    distanceM: 8000,
    movingS: 2700,
    avgHr: 150,
    isRace: false,
    name: "Morning run",
    garminOrigin: true,
  };

  it("shows it after uploading a Garmin FIT file", async () => {
    setTransport(async () => ({ status: 200, json: garminActivity }));
    renderWithProviders(<FitUpload />);
    const input = screen.getByLabelText("FIT file") as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array([1, 2, 3])], "run.fit"));
    expect(await screen.findByText(/Uploaded Morning run/)).toBeInTheDocument();
    expect(screen.getByText("Data from Garmin")).toBeInTheDocument();
  });

  it("shows it under totals that include a Garmin activity, and not otherwise", () => {
    const { rerender } = renderWithProviders(<GarminAttributionAny activities={[null, { garminOrigin: false }, { garminOrigin: true }]} />);
    expect(screen.getByText("Data from Garmin")).toBeInTheDocument();
    rerender(<GarminAttributionAny activities={[null, { garminOrigin: false }]} />);
    expect(screen.queryByText("Data from Garmin")).toBeNull();
  });
});
