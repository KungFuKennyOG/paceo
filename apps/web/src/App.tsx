import { useEffect, useState, type ReactNode } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router";
import { useMe } from "./api/hooks";
import { ApiError, isMockMode } from "./api/client";
import { ErrorState, Loading } from "./components/States";
import { LogIcon, PlanIcon, SettingsIcon, TodayIcon, WeekIcon } from "./components/Icons";
import { LoginScreen, RegisterScreen } from "./screens/Auth";
import { OnboardingWizard } from "./onboarding/Wizard";
import { TodayScreen } from "./screens/Today";
import { WeekScreen } from "./screens/Week";
import { PlanScreen } from "./screens/Plan";
import { WorkoutDetailScreen } from "./screens/WorkoutDetail";
import { CheckInsScreen } from "./screens/CheckIns";
import { SettingsScreen } from "./screens/Settings";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/** Signed-in gate: 401 → login, unfinished onboarding → wizard. */
function RequireAuth({ children, allowOnboarding = false }: { children: ReactNode; allowOnboarding?: boolean }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Loading label="Loading Paceo…" />;
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.isUnauthorized) {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return (
      <div className="page page--bare">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} title="Couldn't reach Paceo" />
      </div>
    );
  }
  if (!me.data.onboardingComplete && !allowOnboarding) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

const TABS = [
  { to: "/", label: "Today", icon: <TodayIcon />, end: true },
  { to: "/week", label: "Week", icon: <WeekIcon />, end: false },
  { to: "/plan", label: "Plan", icon: <PlanIcon />, end: false },
  { to: "/checkins", label: "Log", icon: <LogIcon />, end: false },
  { to: "/settings", label: "Settings", icon: <SettingsIcon />, end: false },
];

function Shell() {
  return (
    <>
      <Outlet />
      <nav className="tabbar" aria-label="Main">
        <ul>
          {TABS.map((t) => (
            <li key={t.to}>
              <NavLink to={t.to} end={t.end} className={({ isActive }) => (isActive ? "active" : undefined)}>
                {t.icon}
                <span>{t.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

export function App() {
  const online = useOnline();
  return (
    <div className="app">
      {!online && <div className="offline-bar" role="status">You're offline. Showing what's already loaded.</div>}
      {isMockMode() && <MockRibbon />}
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/register" element={<RegisterScreen />} />
        <Route
          path="/onboarding"
          element={
            <RequireAuth allowOnboarding>
              <OnboardingWizard />
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route index element={<TodayScreen />} />
          <Route path="week" element={<WeekScreen />} />
          <Route path="plan" element={<PlanScreen />} />
          <Route path="workouts/:id" element={<WorkoutDetailScreen />} />
          <Route path="checkins" element={<CheckInsScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function MockRibbon() {
  return (
    <div className="offline-bar" style={{ background: "var(--accent-soft)", color: "var(--accent)", position: "static" }}>
      Mock mode · demo data, no backend
    </div>
  );
}
