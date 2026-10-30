/**
 * Typed HTTP client for exactly the routes in @paceo/contracts ROUTES.
 * - Session cookie auth (credentials: "include").
 * - Responses are checked against the contract schemas; a mismatch is logged and the raw body is
 *   returned (the UI still renders defensively), so contract drift shows up in the console, not as a crash.
 * - VITE_MOCK=1 swaps the network for the in-memory mock backend in src/mock.
 */
import {
  ActivityListResponse,
  ActivitySummary,
  CheckInResponse,
  ConnectionStatus,
  CreateInviteResponse,
  ErrorBody,
  HealthScreenResponse,
  MeResponse,
  PlanPreviewResponse,
  PlanResponse,
  Profile,
  ProposalDecisionResponse,
  ProposalListResponse,
  ROUTES,
  SyncResponse,
  TestWorkoutResponse,
  User,
  VapidKeyResponse,
  WorkoutDetailResponse,
  WorkoutItem,
  WorkoutListResponse,
  type CheckInRequest,
  type ConnectIntervalsRequest,
  type HealthScreenRequest,
  type LoginRequest,
  type PushSubscribeRequest,
  type RegisterRequest,
  type SkipWorkoutRequest,
} from "@paceo/contracts";
import type { z } from "zod";

export type RouteName = keyof typeof ROUTES;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isOffline(): boolean {
    return this.status === 0;
  }
}

export interface TransportRequest {
  method: string;
  url: string;
  body?: unknown;
  form?: FormData;
}

export interface TransportResponse {
  status: number;
  /** Parsed JSON body, or undefined for 204 / empty bodies. */
  json?: unknown;
  /** Present when the body was not JSON (e.g. an HTML error page). */
  text?: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export const fetchTransport: Transport = async (req) => {
  const init: RequestInit = { method: req.method, credentials: "include", headers: { Accept: "application/json" } };
  if (req.form) {
    init.body = req.form;
  } else if (req.body !== undefined) {
    init.body = JSON.stringify(req.body);
    init.headers = { ...init.headers, "Content-Type": "application/json" };
  }
  const res = await fetch(req.url, init);
  if (res.status === 204) return { status: res.status };
  const text = await res.text();
  if (!text) return { status: res.status };
  try {
    return { status: res.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, text };
  }
};

let transport: Transport = fetchTransport;

const MOCK = import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_MOCK === "true";
if (MOCK) {
  transport = async (req) => {
    const { mockTransport } = await import("../mock/server");
    return mockTransport(req);
  };
}

/** Swap the transport (tests, mock mode). */
export function setTransport(t: Transport): void {
  transport = t;
}

export function isMockMode(): boolean {
  return MOCK;
}

export function routePath(name: RouteName, params?: Record<string, string>, query?: Record<string, string | undefined>): string {
  let path: string = ROUTES[name].path;
  for (const [k, v] of Object.entries(params ?? {})) path = path.replace(`:${k}`, encodeURIComponent(v));
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

interface CallOptions<T> {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  form?: FormData;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
}

async function call<T>(name: RouteName, opts: CallOptions<T> = {}): Promise<T> {
  const route = ROUTES[name];
  const req: TransportRequest = { method: route.method, url: routePath(name, opts.params, opts.query) };
  if (opts.body !== undefined) req.body = opts.body;
  if (opts.form) req.form = opts.form;
  let res: TransportResponse;
  try {
    res = await transport(req);
  } catch {
    throw new ApiError(0, "offline", "Can't reach Paceo right now. Check your connection and try again.");
  }
  if (res.status >= 400 || res.status === 0) {
    const parsed = ErrorBody.safeParse(res.json);
    if (parsed.success) {
      throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
    }
    throw new ApiError(res.status, `http_${res.status}`, defaultMessage(res.status));
  }
  if (!opts.schema) return res.json as T;
  const parsed = opts.schema.safeParse(res.json);
  if (parsed.success) return parsed.data;
  console.warn(`[paceo] ${route.method} ${route.path}: response does not match the contract`, parsed.error.issues);
  return res.json as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return "Please sign in again.";
  if (status === 403) return "You don't have access to that.";
  if (status === 404) return "Not found.";
  if (status === 429) return "Too many requests. Try again in a minute.";
  if (status >= 500) return "Paceo's server had a problem. Try again shortly.";
  return "Something went wrong.";
}

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) return null;
    throw err;
  }
}

export type HealthScreenInput = z.input<typeof import("@paceo/contracts").HealthScreenRequest>;

export const api = {
  health: () => call<unknown>("health"),
  register: (body: RegisterRequest) => call("register", { body, schema: User }),
  login: (body: LoginRequest) => call("login", { body, schema: User }),
  logout: () => call<void>("logout"),
  createInvite: () => call("createInvite", { schema: CreateInviteResponse }),
  me: () => call("me", { schema: MeResponse }),
  healthScreen: (body: HealthScreenInput | HealthScreenRequest) => call("healthScreen", { body, schema: HealthScreenResponse }),
  getProfile: () => orNull(call("getProfile", { schema: Profile })),
  putProfile: (body: Profile) => call("putProfile", { body, schema: Profile }),
  connectIntervals: (body: ConnectIntervalsRequest) => call("connectIntervals", { body, schema: ConnectionStatus }),
  disconnectIntervals: () => call<void>("disconnectIntervals"),
  connectionStatus: () => call("connectionStatus", { schema: ConnectionStatus }),
  testWorkout: () => call("testWorkout", { schema: TestWorkoutResponse }),
  deleteTestWorkout: () => call<void>("deleteTestWorkout"),
  planPreview: (profile: Profile) => call("planPreview", { body: { profile }, schema: PlanPreviewResponse }),
  planGenerate: () => call("planGenerate", { schema: PlanResponse }),
  planCurrent: () => orNull(call("planCurrent", { schema: PlanResponse })),
  workouts: (from: string, to: string) => call("workouts", { query: { from, to }, schema: WorkoutListResponse }),
  workout: (id: string) => call("workout", { params: { id }, schema: WorkoutDetailResponse }),
  resendWorkout: (id: string) => call("resendWorkout", { params: { id }, schema: WorkoutItem }),
  skipWorkout: (id: string, body: SkipWorkoutRequest) => call("skipWorkout", { params: { id }, body, schema: CheckInResponse }),
  checkIn: (body: CheckInRequest) => call("checkIn", { body, schema: CheckInResponse }),
  activities: (from: string, to: string) => call("activities", { query: { from, to }, schema: ActivityListResponse }),
  uploadFit: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call("uploadFit", { form, schema: ActivitySummary });
  },
  sync: () => call("sync", { schema: SyncResponse }),
  vapidKey: () => call("vapidKey", { schema: VapidKeyResponse }),
  pushSubscribe: (body: PushSubscribeRequest) => call<void>("pushSubscribe", { body }),
  pushUnsubscribe: (endpoint: string) => call<void>("pushUnsubscribe", { body: { endpoint } }),
  proposals: () => call("proposals", { schema: ProposalListResponse }),
  respondProposal: (id: string, accept: boolean) =>
    call("respondProposal", { params: { id }, body: { accept }, schema: ProposalDecisionResponse }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
