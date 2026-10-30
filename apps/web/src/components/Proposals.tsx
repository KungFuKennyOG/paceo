import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Proposal, ProposalDecisionResponse } from "@paceo/contracts";
import { api } from "../api/client";
import { useInvalidatePlanData, useProposals } from "../api/hooks";
import { InlineError } from "./States";

const KIND_LABEL: Record<string, string> = {
  vdot_change: "Paces",
  goal_change: "Goal",
  realign: "Plan",
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One extra line of detail from the engine payload, when there is something useful to add. */
function detailLines(p: Proposal): string[] {
  const d = p.details;
  if (p.kind === "vdot_change") {
    const from = num(d.fromVdot);
    const to = num(d.toVdot);
    const pct = num(d.pacePct);
    if (from === null || to === null) return [];
    const dir = to > from ? "faster" : "slower";
    return [`VDOT ${from.toFixed(1)} → ${to.toFixed(1)}${pct !== null ? ` · paces about ${Math.abs(pct).toFixed(1)}% ${dir}` : ""}`];
  }
  if (p.kind === "goal_change" && Array.isArray(d.alternatives)) {
    return d.alternatives
      .map((a) => (a && typeof a === "object" && typeof (a as { message?: unknown }).message === "string" ? (a as { message: string }).message : null))
      .filter((m): m is string => m !== null)
      .slice(0, 3);
  }
  return [];
}

/** The outcome of answering a proposal: plan changes (accent) and advice. */
export function ProposalResult({ result }: { result: ProposalDecisionResponse }) {
  return (
    <div className="stack" role="status" data-testid="proposal-result">
      {result.planChanges.length > 0 && (
        <div className="banner banner--accent">
          <strong>Plan changes</strong>
          <ul>
            {result.planChanges.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {result.advice.map((a) => (
        <p key={a} className="small">
          {a}
        </p>
      ))}
    </div>
  );
}

/** One replan suggestion (§8) with Accept / Not now; shows what changed once answered. */
export function ProposalCard({ proposal, onAnswered }: { proposal: Proposal; onAnswered?: (r: ProposalDecisionResponse) => void }) {
  const invalidate = useInvalidatePlanData();
  const [result, setResult] = useState<ProposalDecisionResponse | null>(null);
  const answer = useMutation({
    mutationFn: (accept: boolean) => api.respondProposal(proposal.id, accept),
    onSuccess: (r) => {
      setResult(r);
      onAnswered?.(r);
      void invalidate();
    },
  });
  const lines = detailLines(proposal);
  return (
    <article className="card card--tone tone-other" data-testid="proposal-card" aria-label="Suggested change">
      <span className="eyebrow">Suggestion · {KIND_LABEL[proposal.kind] ?? "Plan"}</span>
      <p style={{ margin: 0 }}>{proposal.message}</p>
      {lines.length > 0 && (
        <ul className="bullets small muted">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {result ? (
        <ProposalResult result={result} />
      ) : (
        <div className="row">
          <button type="button" className="btn btn--small btn--primary" disabled={answer.isPending} onClick={() => answer.mutate(true)}>
            {answer.isPending && answer.variables === true ? "Updating…" : "Accept"}
          </button>
          <button type="button" className="btn btn--small btn--ghost" disabled={answer.isPending} onClick={() => answer.mutate(false)}>
            Not now
          </button>
        </div>
      )}
      <InlineError error={answer.error} />
    </article>
  );
}

/**
 * Pending proposals, each as a card. Answered cards stay (with their result) until the screen is
 * left, even though the refetched list no longer has them.
 */
export function ProposalList() {
  const q = useProposals();
  const [answered, setAnswered] = useState<Proposal[]>([]);
  const pending = q.data?.items ?? [];
  const shown = [...answered, ...pending.filter((p) => !answered.some((a) => a.id === p.id))];
  if (shown.length === 0) return null;
  return (
    <section className="stack" aria-label="Suggested changes">
      {shown.map((p) => (
        <ProposalCard key={p.id} proposal={p} onAnswered={() => setAnswered((xs) => (xs.some((x) => x.id === p.id) ? xs : [...xs, p]))} />
      ))}
    </section>
  );
}
