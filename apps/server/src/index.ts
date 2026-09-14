import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  AccessGateway,
  AnonymousAuthProvider,
  DeploymentPolicy,
  InviteCodeAuthProvider,
  type AuthProvider,
} from './access-control.js';
import { GameServer } from './game-server.js';
import { migrateLegacyState } from './legacy-migration.js';
import { RoomService, type PersistedRoom } from './room-service.js';
import {
  JsonDirectoryRoomRepository,
  JsonDirectorySessionStore,
  MemoryRateLimitStore,
  type SessionStore,
} from './storage.js';

const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dataDirectory = process.env.HOLDEM_DATA_DIR ?? join(workspaceRoot, '.data', 'holdem');
const webDist = process.env.HOLDEM_WEB_DIST ?? join(workspaceRoot, 'apps', 'web', 'dist');
const deployment = new DeploymentPolicy();
const roomRepository = new JsonDirectoryRoomRepository<PersistedRoom>(join(dataDirectory, 'rooms'));
const sessionStore: SessionStore = new JsonDirectorySessionStore(join(dataDirectory, 'sessions'));
if (deployment.mode === 'local') {
  migrateLegacyState(join(workspaceRoot, '.data', 'server-state.json'), roomRepository, sessionStore);
}
const auth: AuthProvider = deployment.mode === 'cloud'
  ? new InviteCodeAuthProvider(sessionStore)
  : new AnonymousAuthProvider(sessionStore);
const service = new RoomService(roomRepository);
const gateway = new AccessGateway(deployment, auth, new MemoryRateLimitStore(), service);

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
};

const httpServer = createServer(async (request, response) => {
  try {
    if (request.url === '/health') {
      json(response, 200, { ok: true, rooms: service.roomCount(), mode: deployment.mode });
      return;
    }
    if (request.url === '/api/auth/status' && request.method === 'GET') {
      if (deployment.mode === 'local') {
        json(response, 200, { mode: 'local', authenticated: true });
        return;
      }
      try {
        auth.authenticate(request);
        json(response, 200, { mode: 'cloud', authenticated: true });
      } catch {
        json(response, 200, { mode: 'cloud', authenticated: false });
      }
      return;
    }
    if (request.url === '/api/auth/invite' && request.method === 'POST') {
      if (!(auth instanceof InviteCodeAuthProvider)) {
        json(response, 404, { error: '本地模式不需要登录' });
        return;
      }
      gateway.authorizeLogin(request);
      const body = await readJsonBody(request, 4 * 1024) as { code?: unknown };
      if (typeof body.code !== 'string') {
        json(response, 400, { error: '请输入邀请码' });
        return;
      }
      const identity = auth.login(body.code.trim());
      response.setHeader('set-cookie', auth.cookie(identity.sessionId, secureCookie(request)));
      json(response, 200, { authenticated: true });
      return;
    }
    if (request.url === '/api/auth/logout' && request.method === 'POST') {
      if (auth instanceof InviteCodeAuthProvider) {
        auth.logout(request);
        response.setHeader('set-cookie', auth.clearCookie(secureCookie(request)));
      }
      json(response, 200, { authenticated: false });
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    json(response, statusCode, { error: error instanceof Error ? error.message : '请求失败' });
  }
});

const socketServer = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  maxPayload: deployment.maxPayloadBytes,
  verifyClient(info, done) {
    try {
      if (!deployment.acceptsOrigin(info.req)) throw new Error('请求来源不被允许');
      if (deployment.mode === 'cloud') auth.authenticate(info.req);
      done(true);
    } catch {
      done(false, 401, 'Unauthorized');
    }
  },
});
const gameServer = new GameServer(socketServer, service, gateway);

httpServer.on('listening', () => {
  console.log(`Holdem server listening on http://0.0.0.0:${port} (${deployment.mode})`);
  gameServer.start();
});

httpServer.on('close', () => gameServer.stop());
httpServer.listen(port, '0.0.0.0');

async function serveStatic(request: IncomingMessage, response: ServerResponse) {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const basePath = resolve(webDist);
  let filePath = resolve(basePath, relativePath);
  if (filePath !== basePath && !filePath.startsWith(`${basePath}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    response.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
    response.end(data);
  } catch {
    filePath = join(basePath, 'index.html');
    try {
      const data = await readFile(filePath);
      response.writeHead(200, { 'content-type': mimeTypes['.html'], 'cache-control': 'no-cache' });
      response.end(data);
    } catch {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Web build is unavailable. Run npm run build first.');
    }
  }
}

function json(response: ServerResponse, statusCode: number, value: unknown) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage, limit: number) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw Object.assign(new Error('请求格式无效'), { statusCode: 400 });
  }
}

function secureCookie(request: IncomingMessage) {
  const forwarded = Array.isArray(request.headers['x-forwarded-proto'])
    ? request.headers['x-forwarded-proto'][0]
    : request.headers['x-forwarded-proto']?.split(',')[0]?.trim();
  return process.env.HOLDEM_COOKIE_SECURE === 'true' || forwarded === 'https';
}
