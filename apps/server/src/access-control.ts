import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { ClientMessage } from '@holdem/protocol';
import type { RateLimitStore, SessionRecord, SessionStore } from './storage.js';

export type DeploymentMode = 'local' | 'cloud';

export interface Principal {
  userId: string;
  displayName: string;
  roles: readonly string[];
}

export interface ConnectionIdentity {
  principal: Principal;
  sessionId: string;
  resumed: boolean;
}

export interface RequestContext extends ConnectionIdentity {
  ip: string;
  origin: string | undefined;
  mode: DeploymentMode;
}

export class AccessDeniedError extends Error {
  constructor(message: string, readonly statusCode = 403, readonly retryAfterMs?: number) {
    super(message);
  }
}

export class DeploymentPolicy {
  readonly mode: DeploymentMode;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly maxPayloadBytes: number;
  readonly maxConnectionsPerUser: number;
  readonly maxConnectionsPerIp: number;
  readonly maxRoomsPerUser: number;
  readonly maxRoomsGlobal: number;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.mode = environment.HOLDEM_DEPLOYMENT_MODE === 'cloud' ? 'cloud' : 'local';
    this.allowedOrigins = new Set((environment.HOLDEM_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
    this.maxPayloadBytes = positiveInteger(environment.HOLDEM_MAX_MESSAGE_BYTES, 32 * 1024);
    this.maxConnectionsPerUser = positiveInteger(environment.HOLDEM_MAX_CONNECTIONS_PER_USER, this.mode === 'cloud' ? 3 : 10);
    this.maxConnectionsPerIp = positiveInteger(environment.HOLDEM_MAX_CONNECTIONS_PER_IP, this.mode === 'cloud' ? 12 : 50);
    this.maxRoomsPerUser = positiveInteger(environment.HOLDEM_MAX_ROOMS_PER_USER, 1);
    this.maxRoomsGlobal = positiveInteger(environment.HOLDEM_MAX_ROOMS, this.mode === 'cloud' ? 100 : 500);
  }

  simulationEnabled(environment: NodeJS.ProcessEnv = process.env) {
    if (environment.HOLDEM_ENABLE_SIMULATION !== undefined) return environment.HOLDEM_ENABLE_SIMULATION === 'true';
    return this.mode === 'local';
  }

  acceptsOrigin(request: IncomingMessage) {
    if (this.mode === 'local') return true;
    const origin = request.headers.origin;
    if (!origin) return false;
    if (this.allowedOrigins.size > 0) return this.allowedOrigins.has(origin);
    const forwardedProto = firstHeader(request.headers['x-forwarded-proto']) ?? 'http';
    const host = request.headers.host;
    return Boolean(host && origin === `${forwardedProto}://${host}`);
  }
}

export interface AuthProvider {
  readonly mode: DeploymentMode;
  authenticate(request: IncomingMessage, presentedSessionId?: string): ConnectionIdentity;
  validate(identity: ConnectionIdentity): void;
  sessionViewToken(identity: ConnectionIdentity): string | undefined;
  cleanup(): number;
}

class SessionManager {
  constructor(
    private readonly store: SessionStore,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(id: string) {
    const session = this.store.get(id);
    const now = this.now();
    if (!session || session.revokedAt !== null || session.expiresAt <= now) {
      if (session) this.store.delete(id);
      return undefined;
    }
    if (session.expiresAt - now <= this.ttlMs / 2) {
      session.lastSeenAt = now;
      session.expiresAt = now + this.ttlMs;
      this.store.put(session);
    }
    return session;
  }

  create(principal: Principal, maxSessionsForUser?: number) {
    const now = this.now();
    if (maxSessionsForUser) {
      const existing = this.store.list()
        .filter((session) => session.userId === principal.userId)
        .sort((left, right) => left.lastSeenAt - right.lastSeenAt);
      while (existing.length >= maxSessionsForUser) this.store.delete(existing.shift()!.id);
    }
    const session: SessionRecord = {
      id: opaqueToken(),
      userId: principal.userId,
      displayName: principal.displayName,
      roles: [...principal.roles],
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
      revokedAt: null,
    };
    this.store.put(session);
    return session;
  }

  revoke(id: string) {
    const session = this.store.get(id);
    if (!session) return;
    session.revokedAt = this.now();
    this.store.put(session);
  }

  cleanup() {
    return this.store.deleteExpired(this.now());
  }

  count() {
    return this.store.list().length;
  }

  principal(session: SessionRecord): Principal {
    return { userId: session.userId, displayName: session.displayName, roles: session.roles };
  }
}

export class AnonymousAuthProvider implements AuthProvider {
  readonly mode = 'local' as const;
  private readonly sessions: SessionManager;

  constructor(
    store: SessionStore,
    ttlMs = 30 * 24 * 60 * 60 * 1000,
    now: () => number = Date.now,
    private readonly maxSessions = 1_000,
  ) {
    this.sessions = new SessionManager(store, ttlMs, now);
  }

  authenticate(_request: IncomingMessage, presentedSessionId?: string): ConnectionIdentity {
    const existing = presentedSessionId ? this.sessions.get(presentedSessionId) : undefined;
    if (existing) return { principal: this.sessions.principal(existing), sessionId: existing.id, resumed: true };
    this.sessions.cleanup();
    if (this.sessions.count() >= this.maxSessions) throw new AccessDeniedError('本地会话数量已达上限', 503);
    const principal: Principal = { userId: `player-${opaqueToken(8)}`, displayName: '玩家', roles: ['PLAYER'] };
    const session = this.sessions.create(principal);
    return { principal, sessionId: session.id, resumed: false };
  }

  sessionViewToken(identity: ConnectionIdentity) {
    return identity.sessionId;
  }

  validate(identity: ConnectionIdentity) {
    const session = this.sessions.get(identity.sessionId);
    if (!session || session.userId !== identity.principal.userId) throw new AccessDeniedError('身份会话已过期', 401);
  }

  cleanup() {
    return this.sessions.cleanup();
  }
}

interface InviteIdentity {
  code: string;
  userId: string;
  displayName: string;
}

export class InviteCodeAuthProvider implements AuthProvider {
  readonly mode = 'cloud' as const;
  readonly cookieName = 'holdem_auth';
  private readonly sessions: SessionManager;
  private readonly invitations: readonly InviteIdentity[];
  private readonly ttlSeconds: number;
  private readonly maxSessionsPerUser: number;

  constructor(
    store: SessionStore,
    environment: NodeJS.ProcessEnv = process.env,
    ttlMs = positiveInteger(environment.HOLDEM_SESSION_TTL_MS, 24 * 60 * 60 * 1000),
    now: () => number = Date.now,
  ) {
    this.ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));
    this.maxSessionsPerUser = positiveInteger(environment.HOLDEM_MAX_SESSIONS_PER_USER, 8);
    this.sessions = new SessionManager(store, ttlMs, now);
    this.invitations = parseInvitations(environment);
    if (this.invitations.length === 0) throw new Error('cloud 模式必须配置 HOLDEM_INVITE_CODES 或 HOLDEM_INVITE_CODE');
  }

  authenticate(request: IncomingMessage): ConnectionIdentity {
    const sessionId = parseCookies(request.headers.cookie)[this.cookieName];
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) throw new AccessDeniedError('请先使用邀请码登录', 401);
    return { principal: this.sessions.principal(session), sessionId: session.id, resumed: true };
  }

  login(code: string) {
    const invite = this.invitations.find((candidate) => safeEqual(candidate.code, code));
    if (!invite) throw new AccessDeniedError('邀请码无效', 401);
    const principal: Principal = { userId: invite.userId, displayName: invite.displayName, roles: ['PLAYER'] };
    const session = this.sessions.create(principal, this.maxSessionsPerUser);
    return { principal, sessionId: session.id, resumed: false } satisfies ConnectionIdentity;
  }

  logout(request: IncomingMessage) {
    const sessionId = parseCookies(request.headers.cookie)[this.cookieName];
    if (sessionId) this.sessions.revoke(sessionId);
  }

  cookie(sessionId: string, secure: boolean) {
    return `${this.cookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${this.ttlSeconds}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure: boolean) {
    return `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  sessionViewToken() {
    return undefined;
  }

  validate(identity: ConnectionIdentity) {
    const session = this.sessions.get(identity.sessionId);
    if (!session || session.userId !== identity.principal.userId) throw new AccessDeniedError('登录已过期，请重新输入邀请码', 401);
  }

  cleanup() {
    return this.sessions.cleanup();
  }
}

export interface RoomQuotaSource {
  roomCount(): number;
  roomCountForHost(userId: string): number;
}

export class AccessGateway {
  constructor(
    readonly deployment: DeploymentPolicy,
    readonly auth: AuthProvider,
    private readonly rateLimits: RateLimitStore,
    private readonly rooms: RoomQuotaSource,
    private readonly now: () => number = Date.now,
    private readonly simulationAllowed = deployment.simulationEnabled(),
  ) {}

  establish(request: IncomingMessage, presentedSessionId?: string): RequestContext {
    if (!this.deployment.acceptsOrigin(request)) throw new AccessDeniedError('请求来源不被允许', 403);
    const ip = clientIp(request);
    const handshake = this.rateLimits.consume(`handshake:${ip}`, 30, 60_000, this.now());
    if (!handshake.allowed) throw new AccessDeniedError('建立连接过于频繁，请稍后再试', 429, handshake.retryAfterMs);
    const identity = this.auth.authenticate(request, presentedSessionId);
    return {
      ...identity,
      ip,
      origin: request.headers.origin,
      mode: this.deployment.mode,
    };
  }

  authorize(context: RequestContext, message: ClientMessage) {
    this.validate(context);
    const subject = `${context.principal.userId}:${context.ip}`;
    const general = this.rateLimits.consume(`messages:${subject}`, 120, 10_000, this.now());
    if (!general.allowed) throw new AccessDeniedError('操作过于频繁，请稍后再试', 429, general.retryAfterMs);

    if (message.type === 'CREATE_ROOM') {
      const create = this.rateLimits.consume(`create-room:${subject}`, 5, 60_000, this.now());
      if (!create.allowed) throw new AccessDeniedError('创建房间过于频繁', 429, create.retryAfterMs);
      if (this.rooms.roomCountForHost(context.principal.userId) >= this.deployment.maxRoomsPerUser) throw new AccessDeniedError('已达到个人房间数量上限', 429);
      if (this.rooms.roomCount() >= this.deployment.maxRoomsGlobal) throw new AccessDeniedError('服务器房间数量已达上限', 429);
    }
    if (message.type === 'RUN_SIMULATION' && !this.simulationAllowed) throw new AccessDeniedError('云端部署未开放批量模拟', 403);
  }

  authorizeFrame(request: IncomingMessage) {
    const attempt = this.rateLimits.consume(`frames:${clientIp(request)}`, 120, 10_000, this.now());
    if (!attempt.allowed) throw new AccessDeniedError('消息过于频繁，请稍后再试', 429);
  }

  authorizeLogin(request: IncomingMessage) {
    const attempt = this.rateLimits.consume(`invite-login:${clientIp(request)}`, 10, 10 * 60_000, this.now());
    if (!attempt.allowed) throw new AccessDeniedError('邀请码尝试过于频繁，请稍后再试', 429, attempt.retryAfterMs);
  }

  validate(context: RequestContext) {
    this.auth.validate(context);
  }

  cleanup() {
    return { sessions: this.auth.cleanup(), rateLimits: this.rateLimits.cleanup(this.now()) };
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function opaqueToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function parseInvitations(environment: NodeJS.ProcessEnv) {
  const configured = (environment.HOLDEM_INVITE_CODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const invitations = configured.map((entry, index) => {
    const separator = entry.indexOf(':');
    if (separator < 1) return { code: entry, userId: `invite-${index + 1}`, displayName: `玩家 ${index + 1}` };
    const subject = entry.slice(0, separator).trim();
    const code = entry.slice(separator + 1).trim();
    return { code, userId: `invite-${Buffer.from(subject).toString('base64url')}`, displayName: subject };
  }).filter((invite) => invite.code.length >= 6);
  if (environment.HOLDEM_INVITE_CODE && environment.HOLDEM_INVITE_CODE.length >= 6) {
    invitations.push({ code: environment.HOLDEM_INVITE_CODE, userId: 'invite-default', displayName: '玩家' });
  }
  return invitations;
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value?.split(',')[0]?.trim();
}

export function clientIp(request: IncomingMessage, environment: NodeJS.ProcessEnv = process.env) {
  const peer = request.socket.remoteAddress ?? 'unknown';
  const trusted = (environment.HOLDEM_TRUSTED_PROXIES ?? '').split(',').map((value) => value.trim());
  const forwarded = request.headers['x-forwarded-for'];
  // A trusted reverse proxy must overwrite this header with a single client address.
  return trusted.includes(peer) && typeof forwarded === 'string' && isIP(forwarded)
    ? forwarded : peer;
}
