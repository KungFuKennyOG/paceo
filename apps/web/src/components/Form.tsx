import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Weekday } from "@paceo/engine";
import { WEEKDAYS } from "../lib/dates";
import { WEEKDAY_SHORT } from "../lib/dates";
import { formatDuration, parseDuration } from "../lib/units";

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | undefined; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="label">{label}</span>}
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function fmt(n: number | null, digits: number): string {
  if (n === null || !Number.isFinite(n)) return "";
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
}

/**
 * Numeric input that shows a display-unit value but reports the SI value.
 * `toDisplay`/`fromDisplay` convert (e.g. km ↔ mi); both default to identity.
 */
export function NumberField({
  label,
  value,
  onChange,
  suffix,
  hint,
  error,
  digits = 1,
  toDisplay = (v: number) => v,
  fromDisplay = (v: number) => v,
  inputMode = "decimal",
  placeholder,
}: {
  label: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: string;
  hint?: ReactNode;
  error?: string | undefined;
  digits?: number;
  toDisplay?: (si: number) => number;
  fromDisplay?: (display: number) => number;
  inputMode?: "decimal" | "numeric";
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState(() => fmt(value === null ? null : toDisplay(value), digits));
  const lastEmitted = useRef<number | null>(value);
  useEffect(() => {
    // Sync when the value changes from outside (units toggle, alternative applied, reset).
    if (value !== lastEmitted.current) {
      setText(fmt(value === null ? null : toDisplay(value), digits));
      lastEmitted.current = value;
    }
  }, [value, toDisplay, digits]);
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <div className={suffix ? "input-group" : undefined}>
        <input
          id={id}
          className="input"
          inputMode={inputMode}
          value={text}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          onChange={(e) => {
            const t = e.target.value.replace(",", ".");
            setText(e.target.value);
            const n = t.trim() === "" ? null : Number(t);
            const si = n === null || !Number.isFinite(n) ? null : fromDisplay(n);
            lastEmitted.current = si;
            onChange(si);
          }}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
    </Field>
  );
}

/** h:mm:ss / mm:ss input → seconds. */
export function DurationField({ label, value, onChange, hint, error, placeholder = "h:mm:ss" }: { label: ReactNode; value: number | null; onChange: (s: number | null) => void; hint?: ReactNode; error?: string | undefined; placeholder?: string }) {
  const id = useId();
  const [text, setText] = useState(() => (value ? formatDuration(value) : ""));
  const last = useRef<number | null>(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(value ? formatDuration(value) : "");
      last.current = value;
    }
  }, [value]);
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input
        id={id}
        className="input"
        inputMode="numeric"
        placeholder={placeholder}
        value={text}
        aria-invalid={Boolean(error)}
        onChange={(e) => {
          setText(e.target.value);
          const s = parseDuration(e.target.value);
          last.current = s;
          onChange(s);
        }}
      />
    </Field>
  );
}

export interface Option<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export function ChoiceGroup<T extends string>({ legend, options, value, onChange, error, hint, name }: { legend: ReactNode; options: readonly Option<T>[]; value: T | null; onChange: (v: T) => void; error?: string | undefined; hint?: ReactNode; name?: string }) {
  const autoName = useId();
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="choices" role="radiogroup">
        {options.map((o) => (
          <label key={o.value} className="choice">
            <input type="radio" name={name ?? autoName} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {hint && <p className="hint" style={{ marginTop: 6 }}>{hint}</p>}
      {error && (
        <p className="error-text" role="alert" style={{ marginTop: 6 }}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function YesNo({ question, value, onChange, name }: { question: ReactNode; value: boolean | null; onChange: (v: boolean) => void; name: string }) {
  return (
    <div className="question" role="group" aria-label={typeof question === "string" ? question : undefined}>
      <p>{question}</p>
      <div className="yesno choices">
        <label className="choice">
          <input type="radio" name={name} checked={value === true} onChange={() => onChange(true)} />
          <span>Yes</span>
        </label>
        <label className="choice">
          <input type="radio" name={name} checked={value === false} onChange={() => onChange(false)} />
          <span>No</span>
        </label>
      </div>
    </div>
  );
}

export function DaysPicker({ legend, value, onChange, error, disabledDays = [] }: { legend: ReactNode; value: Weekday[]; onChange: (v: Weekday[]) => void; error?: string | undefined; disabledDays?: Weekday[] }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="choices choices--days">
        {WEEKDAYS.map((d) => (
          <label key={d} className="choice">
            <input
              type="checkbox"
              checked={value.includes(d)}
              disabled={disabledDays.includes(d)}
              onChange={(e) => {
                const next = e.target.checked ? [...value, d] : value.filter((x) => x !== d);
                onChange(WEEKDAYS.filter((w) => next.includes(w)));
              }}
            />
            <span>{WEEKDAY_SHORT[d]}</span>
          </label>
        ))}
      </div>
      {error && (
        <p className="error-text" role="alert" style={{ marginTop: 6 }}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** 0–10 (or custom) scale with a big readout. */
export function Scale({ label, value, onChange, min = 0, max = 10, describe }: { label: ReactNode; value: number; onChange: (v: number) => void; min?: number; max?: number; describe?: (v: number) => string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row row--nowrap">
        <span className="scale-value" aria-hidden="true">
          {value}
        </span>
        <div className="grow stack stack--tight">
          <input id={id} type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-valuetext={describe ? `${value}: ${describe(value)}` : String(value)} />
          {describe && <span className="small muted">{describe(value)}</span>}
        </div>
      </div>
    </div>
  );
}

/** Borg CR-10 style anchors for session RPE. */
export function rpeWords(v: number): string {
  if (v <= 0) return "Rest";
  if (v <= 2) return "Very easy";
  if (v <= 3) return "Easy, can chat";
  if (v <= 4) return "Comfortable";
  if (v <= 5) return "Steady, a bit hard";
  if (v <= 6) return "Hard";
  if (v <= 7) return "Very hard";
  if (v <= 8) return "Very, very hard";
  if (v <= 9) return "Near max";
  return "Max effort";
}

export function painWords(v: number): string {
  if (v <= 0) return "No pain";
  if (v <= 2) return "Green: aware of it";
  if (v <= 5) return "Amber: noticeable";
  return "Red: hurts";
}
