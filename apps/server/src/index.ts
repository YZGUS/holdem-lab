import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { decisionContext, type PlayerAction } from '@holdem/core';
import { createDefaultStrategyRegistry, runSimulation } from '@holdem/bot';
import { clientMessageSchema, type ServerMessage } from '@holdem/protocol';
import { JsonFilePersistence } from './persistence.js';
import { RoomService, type StoredServerState } from './room-service.js';

const port = Number(process.env.PORT ?? 8787);
const workspaceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dataFile = process.env.HOLDEM_DATA_FILE ?? join(workspaceRoot, '.data', 'server-state.json');
const webDist = process.env.HOLDEM_WEB_DIST ?? join(workspaceRoot, 'apps', 'web', 'dist');
const service = new RoomService(new JsonFilePersistence<StoredServerState>(dataFile));
const strategies = createDefaultStrategyRegistry();
const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const httpServer = createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, rooms: service.rooms.size }));
    return;
  }
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
});
const server = new WebSocketServer({ server: httpServer });
const clientTokens = new Map<WebSocket, string>();
const tokenClients = new Map<string, WebSocket>();
const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();

function send(client: WebSocket, message: ServerMessage) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function sendLobby(client: WebSocket) {
  send(client, { type: 'LOBBY', rooms: service.listRooms() });
}

function sendRoom(client: WebSocket, roomId: string, playerId: string) {
  try {
    send(client, { type: 'ROOM', ...service.roomView(roomId, playerId) });
  } catch {
    sendLobby(client);
  }
}

function broadcastLobby() {
  for (const [client, sessionToken] of clientTokens) {
    const session = service.session(sessionToken);
    if (!session?.roomId) sendLobby(client);
  }
}

function broadcastRoom(roomId: string) {
  for (const [client, sessionToken] of clientTokens) {
    const session = service.session(sessionToken);
    if (session?.roomId === roomId) sendRoom(client, roomId, session.playerId);
  }
}

function timeoutAction(roomId: string, playerId: string): PlayerAction {
  const actor = service.currentActor(roomId);
  if (!actor || actor.player.id !== playerId || !actor.room.game) return { type: 'FOLD' };
  const legal = decisionContext(actor.room.game, playerId).legalActions;
  return legal.types.includes('CHECK') ? { type: 'CHECK' } : { type: 'FOLD' };
}

function scheduleRoom(roomId: string) {
  const previous = turnTimers.get(roomId);
  if (previous) clearTimeout(previous);
  turnTimers.delete(roomId);
  const actor = service.currentActor(roomId);
  if (!actor?.room.game) {
    service.setTurnDeadline(roomId, null);
    return;
  }
  const expectedHandId = actor.room.game.handId;
  const expectedVersion = actor.room.game.version;
  const delay = actor.player.kind === 'BOT' ? 550 : actor.room.turnSeconds * 1000;
  service.setTurnDeadline(roomId, Date.now() + delay);
  const timer = setTimeout(async () => {
    turnTimers.delete(roomId);
    try {
      const current = service.currentActor(roomId);
      if (!current?.room.game || current.player.id !== actor.player.id || current.room.game.handId !== expectedHandId || current.room.game.version !== expectedVersion) return;
      let action: PlayerAction;
      if (current.player.kind === 'BOT') {
        const strategy = strategies.create(current.player.strategyId ?? 'basic-check-call');
        action = await strategy.decide(decisionContext(current.room.game, current.player.id), { random: Math.random });
      } else {
        action = timeoutAction(roomId, current.player.id);
      }
      service.applyForPlayer(roomId, current.player.id, action);
    } catch (error) {
      console.warn(`自动行动失败：${String(error)}`);
    }
    if (service.rooms.has(roomId)) {
      scheduleRoom(roomId);
      broadcastRoom(roomId);
      broadcastLobby();
    }
  }, delay);
  turnTimers.set(roomId, timer);
}

function errorView(sessionToken: string | undefined) {
  const session = sessionToken ? service.session(sessionToken) : undefined;
  if (!session?.roomId) return undefined;
  try {
    return service.roomView(session.roomId, session.playerId).view;
  } catch {
    return undefined;
  }
}

server.on('connection', (client) => {
  client.on('message', (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      send(client, { type: 'ERROR', message: '消息格式无效' });
      return;
    }
    const parsed = clientMessageSchema.safeParse(data);
    if (!parsed.success) {
      send(client, { type: 'ERROR', message: '消息参数无效' });
      return;
    }
    const message = parsed.data;
    try {
      if (message.type === 'HELLO') {
        const welcome = service.hello(message.sessionToken);
        const existingClient = tokenClients.get(welcome.session.token);
        if (existingClient && existingClient !== client) existingClient.close(4001, '会话已在新连接恢复');
        clientTokens.set(client, welcome.session.token);
        tokenClients.set(welcome.session.token, client);
        service.markConnected(welcome.session.token, true);
        send(client, { type: 'WELCOME', ...welcome });
        if (welcome.session.roomId) {
          sendRoom(client, welcome.session.roomId, welcome.session.playerId);
          if (!turnTimers.has(welcome.session.roomId)) scheduleRoom(welcome.session.roomId);
          broadcastRoom(welcome.session.roomId);
        } else {
          sendLobby(client);
        }
        broadcastLobby();
        return;
      }
      const sessionToken = clientTokens.get(client);
      if (!sessionToken) throw new Error('请先建立会话');
      if (message.type === 'LIST_ROOMS') {
        sendLobby(client);
      } else if (message.type === 'CREATE_ROOM') {
        const room = service.createRoom(sessionToken, message);
        broadcastRoom(room.id);
        broadcastLobby();
      } else if (message.type === 'JOIN_ROOM') {
        const room = service.joinRoom(sessionToken, message.roomId, message.playerName);
        broadcastRoom(room.id);
        broadcastLobby();
      } else if (message.type === 'LEAVE_ROOM') {
        const previousRoomId = service.session(sessionToken)?.roomId;
        service.leaveRoom(sessionToken);
        if (previousRoomId && service.rooms.has(previousRoomId)) broadcastRoom(previousRoomId);
        else if (previousRoomId) {
          const timer = turnTimers.get(previousRoomId);
          if (timer) clearTimeout(timer);
          turnTimers.delete(previousRoomId);
        }
        sendLobby(client);
        broadcastLobby();
      } else if (message.type === 'START_GAME') {
        const room = service.startGame(sessionToken);
        scheduleRoom(room.id);
        broadcastRoom(room.id);
        broadcastLobby();
      } else if (message.type === 'NEW_HAND') {
        const room = service.newHand(sessionToken);
        scheduleRoom(room.id);
        broadcastRoom(room.id);
      } else if (message.type === 'ACTION') {
        const room = service.act(sessionToken, message);
        scheduleRoom(room.id);
        broadcastRoom(room.id);
      } else if (message.type === 'GET_REPLAY') {
        send(client, { type: 'REPLAY', replay: service.replay(sessionToken, message.handId) });
      } else if (message.type === 'RUN_SIMULATION') {
        send(client, { type: 'SIMULATION_RESULT', result: runSimulation(message) });
      }
    } catch (error) {
      const sessionToken = clientTokens.get(client);
      const view = errorView(sessionToken);
      send(client, { type: 'ERROR', message: error instanceof Error ? error.message : '操作失败', ...(view ? { view } : {}) });
    }
  });

  client.on('close', () => {
    const sessionToken = clientTokens.get(client);
    if (!sessionToken || tokenClients.get(sessionToken) !== client) return;
    const roomId = service.session(sessionToken)?.roomId;
    clientTokens.delete(client);
    tokenClients.delete(sessionToken);
    service.markConnected(sessionToken, false);
    if (roomId) broadcastRoom(roomId);
    broadcastLobby();
  });
});

httpServer.on('listening', () => {
  console.log(`Holdem server listening on http://0.0.0.0:${port}`);
  service.rooms.forEach((room) => {
    if (room.status === 'PLAYING') scheduleRoom(room.id);
  });
});

httpServer.listen(port, '0.0.0.0');
