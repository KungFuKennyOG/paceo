import type { ReactNode } from "react";
import { errorMessage } from "../api/client";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <span className="small muted">{label}</span>
    </div>
  );
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ minHeight: height }} aria-hidden="true" />;
}

export function ErrorState({ error, onRetry, title = "Couldn't load this" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="banner banner--block" role="alert">
      <strong>{title}</strong>
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <div>
          <button type="button" className="btn btn--small btn--ghost" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      {children && <div className="small muted">{children}</div>}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="error-text" role="alert">
      {errorMessage(error)}
    </p>
  );
}
