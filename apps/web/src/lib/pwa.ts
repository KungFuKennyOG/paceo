/** Install / standalone detection and web push (spec §2.1, §11.2). */
import { api } from "../api/client";

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iPadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || iPadOs;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches === true || window.matchMedia?.("(display-mode: fullscreen)").matches === true || nav.standalone === true;
  } catch {
    return nav.standalone === true;
  }
}

export type PushAvailability =
  | { kind: "ok" }
  | { kind: "ios_needs_install" }
  | { kind: "unsupported"; reason: string }
  | { kind: "denied" };

export function pushAvailability(): PushAvailability {
  if (typeof window === "undefined") return { kind: "unsupported", reason: "Not in a browser." };
  // iOS/iPadOS 16.4+ only offers push to Home Screen web apps (§2.1).
  if (isIos() && !isStandalone()) return { kind: "ios_needs_install" };
  if (!("serviceWorker" in navigator)) return { kind: "unsupported", reason: "This browser has no service workers." };
  if (!("PushManager" in window) || !("Notification" in window)) return { kind: "unsupported", reason: "This browser can't receive web push." };
  if (Notification.permission === "denied") return { kind: "denied" };
  return { kind: "ok" };
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function readyRegistration(timeoutMs = 6000): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("The app's service worker isn't active yet. Reload the page and try again.")), timeoutMs),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushAvailability().kind !== "ok") return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Must be called straight from a tap handler: the permission prompt has to come from a user gesture
 * (required on iOS, §2.1), so it's the first thing awaited.
 */
export async function enablePush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications weren't allowed. You can change this in your browser's site settings.");
  const reg = await readyRegistration();
  const { publicKey } = await api.vapidKey();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new Error("The browser returned an incomplete push subscription.");
  await api.pushSubscribe({ endpoint: json.endpoint, keys: { p256dh, auth } });
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await api.pushUnsubscribe(endpoint);
}
