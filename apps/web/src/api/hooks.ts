/** TanStack Query hooks over the typed client. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse, Profile } from "@paceo/contracts";
import type { Units } from "@paceo/engine";
import { api, ApiError } from "./client";
import { defaultUnits } from "../lib/units";
import { localToday } from "../lib/dates";

export const qk = {
  me: ["me"] as const,
  plan: ["plan"] as const,
  connection: ["connection"] as const,
  workouts: (from: string, to: string) => ["workouts", from, to] as const,
  workoutsAll: ["workouts"] as const,
  workout: (id: string) => ["workout", id] as const,
  activities: (from: string, to: string) => ["activities", from, to] as const,
};

function retry(count: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
  return count < 2;
}

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.me, retry, staleTime: 30_000 });
}

/** The signed-in user's display units (§5): profile setting, else locale default. */
export function useUnits(): Units {
  const me = useMe();
  return me.data?.profile?.units ?? defaultUnits();
}

export function useProfile(): Profile | null {
  return useMe().data?.profile ?? null;
}

/** Today's date in the user's timezone. */
export function useToday(): string {
  const me = useMe();
  return localToday(me.data?.profile?.timezone);
}

export function usePlan() {
  return useQuery({ queryKey: qk.plan, queryFn: api.planCurrent, retry, staleTime: 60_000 });
}

export function useConnection() {
  return useQuery({ queryKey: qk.connection, queryFn: api.connectionStatus, retry });
}

export function useWorkouts(from: string, to: string, enabled = true) {
  return useQuery({ queryKey: qk.workouts(from, to), queryFn: () => api.workouts(from, to), retry, enabled });
}

export function useWorkout(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.workout(id ?? ""),
    queryFn: () => api.workout(id ?? ""),
    retry,
    enabled: enabled && Boolean(id),
  });
}

export function useActivities(from: string, to: string, enabled = true) {
  return useQuery({ queryKey: qk.activities(from, to), queryFn: () => api.activities(from, to), retry, enabled });
}

export function useResend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.resendWorkout(id),
    onSuccess: (item) => {
      void qc.invalidateQueries({ queryKey: qk.workoutsAll });
      void qc.invalidateQueries({ queryKey: qk.workout(item.id) });
    },
  });
}

/** After anything that may change the plan or workouts. */
export function useInvalidatePlanData() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.me }),
      qc.invalidateQueries({ queryKey: qk.plan }),
      qc.invalidateQueries({ queryKey: qk.workoutsAll }),
      qc.invalidateQueries({ queryKey: ["workout"] }),
      qc.invalidateQueries({ queryKey: ["activities"] }),
    ]);
}

export function setMeProfile(qc: ReturnType<typeof useQueryClient>, profile: Profile): void {
  qc.setQueryData<MeResponse>(qk.me, (old) => (old ? { ...old, profile } : old));
}
