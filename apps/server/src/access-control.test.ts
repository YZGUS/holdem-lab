import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import type { ClientMessage } from '@holdem/protocol';
import {
  AccessDeniedError,
  AccessGateway,
  AnonymousAuthProvider,
  DeploymentPolicy,
  InviteCodeAuthProvider,
} from './access-control.js';
import { MemoryRateLimitStore, MemorySessionStore } from './storage.js';

function request(options: { cookie?: string; origin?: string; host?: string; ip?: string; proto?: string } = {}) {
  return {
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.proto ? { 'x-forwarded-proto': options.proto } : {}),
    },
    socket: { remoteAddress: options.ip ?? '192.0.2.10' },
  } as unknown as IncomingMessage;
}

const createRoomMessage = { type: 'CREATE_ROOM' } as ClientMessage;
const simulationMessage = { type: 'RUN_SIMULATION' } as ClientMessage;

describe('access control', () => {
  it('resumes one local identity and bounds anonymous session creation by IP', () => {
    const sessions = new MemorySessionStore();
    const provider = new AnonymousAuthProvider(sessions);
    const gateway = new AccessGateway(
      new DeploymentPolicy({ HOLDEM_DEPLOYMENT_MODE: 'local' }),
      provider,
      new MemoryRateLimitStore(),
      { roomCount: () => 0, roomCountForHost: () => 0 },
    );
    const first = gateway.establish(request());
    const resumed = gateway.establish(request(), first.sessionId);
    assert.equal(resumed.principal.userId, first.principal.userId);
    for (let index = 2; index < 30; index += 1) gateway.establish(request());
    assert.throws(() => gateway.establish(request()), (error: unknown) => error instanceof AccessDeniedError && error.statusCode === 429);
    assert.equal(sessions.list().length, 29);
  });

  it('places a hard bound on persisted local anonymous sessions', () => {
    const sessions = new MemorySessionStore();
    const provider = new AnonymousAuthProvider(sessions, 60_000, Date.now, 2);
    provider.authenticate(request());
    provider.authenticate(request());
    assert.throws(() => provider.authenticate(request()), /会话数量已达上限/);
    assert.equal(sessions.list().length, 2);
  });

  it('uses a stable invite userId across browser sessions and never exposes the cookie session', () => {
    let now = 100;
    const sessions = new MemorySessionStore();
    const provider = new InviteCodeAuthProvider(
      sessions,
      { HOLDEM_INVITE_CODES: 'Alice:secret-code' },
      2_000,
      () => now,
    );
    const first = provider.login('secret-code');
    const second = provider.login('secret-code');
    assert.equal(first.principal.userId, second.principal.userId);
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(provider.sessionViewToken(), undefined);
    assert.match(provider.cookie(first.sessionId, true), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2; Secure/);
    const restored = provider.authenticate(request({ cookie: `holdem_auth=${first.sessionId}` }));
    assert.equal(restored.principal.userId, first.principal.userId);
    provider.logout(request({ cookie: `holdem_auth=${second.sessionId}` }));
    assert.throws(() => provider.validate(second), /登录已过期/);
    now = 2_101;
    assert.throws(() => provider.authenticate(request({ cookie: `holdem_auth=${first.sessionId}` })), /请先使用邀请码登录/);
  });

  it('enforces cloud origins, stable-user room quotas and disabled simulation', () => {
    const environment = {
      HOLDEM_DEPLOYMENT_MODE: 'cloud',
      HOLDEM_ALLOWED_ORIGINS: 'https://cards.example.com',
      HOLDEM_INVITE_CODES: 'Alice:secret-code',
    };
    const deployment = new DeploymentPolicy(environment);
    assert.equal(deployment.acceptsOrigin(request({ origin: 'https://cards.example.com' })), true);
    assert.equal(deployment.acceptsOrigin(request({ origin: 'https://evil.example' })), false);
    assert.equal(deployment.acceptsOrigin(request()), false);

    const provider = new InviteCodeAuthProvider(new MemorySessionStore(), environment);
    const first = provider.login('secret-code');
    const second = provider.login('secret-code');
    const quota = {
      roomCount: () => 1,
      roomCountForHost: (userId: string) => userId === first.principal.userId ? 1 : 0,
    };
    const gateway = new AccessGateway(deployment, provider, new MemoryRateLimitStore(), quota);
    const firstContext = gateway.establish(request({
      cookie: `holdem_auth=${first.sessionId}`,
      origin: 'https://cards.example.com',
    }));
    const secondContext = gateway.establish(request({
      cookie: `holdem_auth=${second.sessionId}`,
      origin: 'https://cards.example.com',
      ip: '192.0.2.11',
    }));
    assert.equal(firstContext.principal.userId, secondContext.principal.userId);
    assert.throws(() => gateway.authorize(secondContext, createRoomMessage), /个人房间数量上限/);
    assert.throws(() => gateway.authorize(firstContext, simulationMessage), /未开放批量模拟/);
  });

  it('limits invite-code guessing before authentication', () => {
    const environment = { HOLDEM_DEPLOYMENT_MODE: 'cloud', HOLDEM_INVITE_CODE: 'secret-code' };
    const gateway = new AccessGateway(
      new DeploymentPolicy(environment),
      new InviteCodeAuthProvider(new MemorySessionStore(), environment),
      new MemoryRateLimitStore(),
      { roomCount: () => 0, roomCountForHost: () => 0 },
    );
    for (let index = 0; index < 10; index += 1) gateway.authorizeLogin(request());
    assert.throws(() => gateway.authorizeLogin(request()), /尝试过于频繁/);
  });
});
