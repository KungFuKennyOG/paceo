/**
 * Invite-only auth (spec §2.2). Passwords: scrypt. Sessions: random token in a signed, httpOnly,
 * SameSite=Lax cookie; only its sha256 is stored, so a database leak does not leak live sessions.
 */
import type { RegisterRequest, LoginRequest, User } from "@paceo/contracts";
import { invitesRepo, sessionsRepo, usersRepo, type UserRow } from "../repo/index.js";
import { AppError } from "../http/errors.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../crypto/password.js";
import { inviteCode, normalizeInviteCode, randomToken, sha256Hex } from "../crypto/tokens.js";
import type { Db } from "../db/client.js";
import type { Services } from "./context.js";

export const SESSION_COOKIE = "paceo_session";
export const INVITE_TTL_DAYS = 7;

export function toUser(u: UserRow): User {
  return { id: u.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin };
}

export async function createInvite(db: Db, createdBy: string | null, now: Date): Promise<{ code: string; expiresAt: Date }> {
  const code = inviteCode();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);
  await invitesRepo.create(db, { codeHash: sha256Hex(normalizeInviteCode(code)), createdBy, expiresAt });
  return { code, expiresAt };
}

/** Registers with a single-use invite. The very first user becomes admin. */
export async function register(svc: Services, req: RegisterRequest): Promise<UserRow> {
  const email = req.email.trim().toLowerCase();
  const passwordHash = await hashPassword(req.password);
  const now = svc.clock();
  return svc.db.transaction(async (tx) => {
    const invite = await invitesRepo.lockUsable(tx, sha256Hex(normalizeInviteCode(req.inviteCode)), now);
    if (!invite) throw new AppError(400, "invite_invalid", "That invite code is invalid, used or expired.");
    if (await usersRepo.byEmail(tx, email)) throw new AppError(409, "email_taken", "An account with that email already exists.");
    const isAdmin = (await usersRepo.count(tx)) === 0;
    const user = await usersRepo.create(tx, {
      email,
      passwordHash,
      displayName: req.displayName.trim(),
      isAdmin,
      invitedBy: invite.createdBy,
    });
    await invitesRepo.markUsed(tx, invite.id, user.id, now);
    return user;
  });
}

export async function login(svc: Services, req: LoginRequest): Promise<UserRow> {
  const user = await usersRepo.byEmail(svc.db, req.email.trim());
  // Same work whether or not the account exists.
  const ok = await verifyPassword(req.password, user?.passwordHash ?? (await dummyPasswordHash()));
  if (!user || !ok) throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
  return user;
}

export async function startSession(svc: Services, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(svc.clock().getTime() + svc.config.sessionTtlDays * 86_400_000);
  await sessionsRepo.create(svc.db, { id: sha256Hex(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function userForToken(svc: Services, token: string): Promise<UserRow | undefined> {
  return sessionsRepo.findUser(svc.db, sha256Hex(token), svc.clock());
}

export async function endSession(svc: Services, token: string): Promise<void> {
  await sessionsRepo.delete(svc.db, sha256Hex(token));
}

/**
 * Small in-memory throttle for login/register attempts per key (IP or email):
 * at most `max` attempts per window. Enough for a 10-user app behind one process.
 */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 10 * 60_000,
  ) {}
  check(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return recent.length <= this.max;
  }
}
