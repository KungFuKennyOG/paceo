/** Dependencies shared by routes, services and job handlers. Built once in main.ts (or a test). */
import type { Db } from "../db/client.js";
import type { SecretBox } from "../crypto/secretbox.js";
import type { IntervalsAccountFactory } from "../integrations/types.js";
import type { Explainer } from "../plan/explain.js";
import type { Clock } from "../lib/time.js";
import type { JobQueue } from "../jobs/queue.js";
import type { PushSender } from "./notify.js";

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface AppConfig {
  cookieSecure: boolean;
  sessionTtlDays: number;
  publicUrl: string;
  vapidPublicKey: string | null;
  morningPushHour: number;
  nightlyHour: number;
}

export interface Services {
  db: Db;
  secretBox: SecretBox;
  intervals: IntervalsAccountFactory;
  jobs: JobQueue;
  clock: Clock;
  push: PushSender | null;
  explainer: Explainer;
  config: AppConfig;
  log: Logger;
}
