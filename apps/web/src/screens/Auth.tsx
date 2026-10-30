import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoginRequest, RegisterRequest } from "@paceo/contracts";
import { api, isMockMode } from "../api/client";
import { qk } from "../api/hooks";
import { InlineError } from "../components/States";

function Wordmark() {
  return (
    <div className="auth-hero">
      <div className="wordmark">
        <img src="/favicon.svg" alt="" />
        Paceo
      </div>
      <p className="muted">Training plans for the crew. Invite only.</p>
    </div>
  );
}

function fieldErrors(issues: { path: (string | number)[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? "form");
    if (!out[k]) out[k] = i.message;
  }
  return out;
}

export function LoginScreen() {
  const nav = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [email, setEmail] = useState(isMockMode() ? "demo@paceo.run" : "");
  const [password, setPassword] = useState(isMockMode() ? "demo-password" : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
      const from = (location.state as { from?: string } | null)?.from;
      void nav(from && from !== "/login" ? from : "/", { replace: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const p = LoginRequest.safeParse({ email: email.trim(), password });
    if (!p.success) {
      setErrors(fieldErrors(p.error.issues));
      return;
    }
    setErrors({});
    login.mutate(p.data);
  }

  return (
    <main className="page page--bare">
      <Wordmark />
      <form className="card" onSubmit={submit} noValidate>
        <h2>Sign in</h2>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(errors.email)} />
          {errors.email && <span className="error-text">{errors.email}</span>}
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={Boolean(errors.password)} />
          {errors.password && <span className="error-text">{errors.password}</span>}
        </div>
        <InlineError error={login.error} />
        <button type="submit" className="btn btn--primary btn--block" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
        {isMockMode() && <p className="tiny muted">Mock mode: demo@paceo.run with any password, or register with any invite code.</p>}
      </form>
      <p className="small">
        Got an invite code? <Link to="/register">Create your account</Link>
      </p>
    </main>
  );
}

export function RegisterScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ inviteCode: "", displayName: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const register = useMutation({
    mutationFn: api.register,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
      void nav("/onboarding", { replace: true });
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const p = RegisterRequest.safeParse({
      inviteCode: form.inviteCode.trim(),
      displayName: form.displayName.trim(),
      email: form.email.trim(),
      password: form.password,
    });
    if (!p.success) {
      setErrors(fieldErrors(p.error.issues));
      return;
    }
    setErrors({});
    register.mutate(p.data);
  }

  const err = (k: string) => (errors[k] ? <span className="error-text">{errors[k]}</span> : null);

  return (
    <main className="page page--bare">
      <Wordmark />
      <form className="card" onSubmit={submit} noValidate>
        <h2>Join the crew</h2>
        <div className="field">
          <label htmlFor="invite">Invite code</label>
          <input id="invite" className="input" autoCapitalize="characters" autoComplete="off" value={form.inviteCode} onChange={set("inviteCode")} aria-invalid={Boolean(errors.inviteCode)} />
          <span className="hint">Ask whoever invited you. Codes expire.</span>
          {err("inviteCode")}
        </div>
        <div className="field">
          <label htmlFor="name">Display name</label>
          <input id="name" className="input" autoComplete="nickname" value={form.displayName} onChange={set("displayName")} aria-invalid={Boolean(errors.displayName)} />
          {err("displayName")}
        </div>
        <div className="field">
          <label htmlFor="remail">Email</label>
          <input id="remail" className="input" type="email" autoComplete="email" value={form.email} onChange={set("email")} aria-invalid={Boolean(errors.email)} />
          {err("email")}
        </div>
        <div className="field">
          <label htmlFor="rpass">Password</label>
          <input id="rpass" className="input" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} aria-invalid={Boolean(errors.password)} />
          <span className="hint">At least 10 characters.</span>
          {err("password")}
        </div>
        <InlineError error={register.error} />
        <button type="submit" className="btn btn--primary btn--block" disabled={register.isPending}>
          {register.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="small">
        Already in? <Link to="/login">Sign in</Link>
      </p>
    </main>
  );
}
