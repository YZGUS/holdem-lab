import type { IncomingMessage } from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { decisionContext, type PlayerAction } from '@holdem/core';
import { createDefaultStrategyRegistry, runSimulation } from '@holdem/bot';
import { clientMessageSchema, type ClientMessage, type ServerMessage } from '@holdem/protocol';
import { AccessDeniedError, AccessGateway, clientIp, type RequestContext } from './access-control.js';
import { RoomService } from './room-service.js';

const nextHandDelay = 2_500;

export class GameServer {
  private readonly connections = new Map<WebSocket, RequestContext>();
  private readonly sessionClients = new Map<string, WebSocket>();
  private readonly pendingConnections = new Map<WebSocket, { ip: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly strategies = createDefaultStrategyRegistry();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly server: WebSocketServer,
    private readonly service: RoomService,
    private readonly gateway: AccessGateway,
  ) {
    server.on('connection', (client, request) => this.accept(client, request));
    this.cleanupTimer = setInterval(() => {
      gateway.cleanup();
      for (const [client, context] of this.connections) {
        try {
          gateway.validate(context);
        } catch {
          client.close(4003, '身份会话已过期');
        }
      }
    }, 60_000);
    this.cleanupTimer.unref();
  }

  start() {
    this.service.rooms.forEach((room) => this.scheduleRoom(room.id));
  }

  stop() {
    clearInterval(this.cleanupTimer);
    this.pendingConnections.forEach(({ timer }) => clearTimeout(timer));
    this.pendingConnections.clear();
    this.turnTimers.forEach(clearTimeout);
    this.turnTimers.clear();
  }

  private accept(client: WebSocket, request: IncomingMessage) {
    const ip = clientIp(request);
    const connectionCount = [...this.connections.values()].filter((context) => context.ip === ip).length
      + [...this.pendingConnections.values()].filter((pending) => pending.ip === ip).length;
    if (connectionCount >= this.gateway.deployment.maxConnectionsPerIp) {
      client.close(4008, '该地址连接数已达上限');
      return;
    }
    const timer = setTimeout(() => client.close(4003, '身份验证超时'), 5_000);
    timer.unref();
    this.pendingConnections.set(client, { ip, timer });
    client.on('message', (raw) => void this.handleMessage(client, request, raw.toString()));
    client.on('close', () => {
      this.releasePending(client);
      this.disconnect(client);
    });
  }

  private async handleMessage(client: WebSocket, request: IncomingMessage, raw: string) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.send(client, { type: 'ERROR', message: '消息格式无效' });
      return;
    }
    const parsed = clientMessageSchema.safeParse(data);
    if (!parsed.success) {
      this.send(client, { type: 'ERROR', message: '消息参数无效' });
      return;
    }

    const message = parsed.data;
    try {
      let context = this.connections.get(client);
      if (!context) {
        if (message.type !== 'HELLO') throw new AccessDeniedError('请先建立身份会话', 401);
        context = this.gateway.establish(request, message.sessionToken);
        this.releasePending(client);
        this.admit(client, context);
        this.welcome(client, context);
        return;
      }
      if (message.type === 'HELLO') throw new Error('身份会话已经建立');
      this.gateway.authorize(context, message);
      await this.dispatch(client, context, message);
    } catch (error) {
      const context = this.connections.get(client);
      const state = context ? this.errorRoomState(context) : undefined;
      this.send(client, {
        type: 'ERROR',
        message: error instanceof Error ? error.message : '操作失败',
        ...(state ?? {}),
      });
      if (error instanceof AccessDeniedError && (!context || error.statusCode === 401)) client.close(4003, error.message);
    }
  }

  private admit(client: WebSocket, context: RequestContext) {
    const existing = this.sessionClients.get(context.sessionId);
    const activeConnections = [...this.connections.entries()].filter(([socket]) => socket !== existing);
    const userConnections = activeConnections.filter(([, item]) => item.principal.userId === context.principal.userId).length;
    const ipConnections = activeConnections.filter(([, item]) => item.ip === context.ip).length;
    if (userConnections >= this.gateway.deployment.maxConnectionsPerUser) throw new AccessDeniedError('该用户连接数已达上限', 429);
    if (ipConnections >= this.gateway.deployment.maxConnectionsPerIp) throw new AccessDeniedError('该地址连接数已达上限', 429);

    if (existing && existing !== client) {
      this.connections.delete(existing);
      this.sessionClients.delete(context.sessionId);
      existing.close(4001, '会话已在新连接恢复');
    }
    this.connections.set(client, context);
    this.sessionClients.set(context.sessionId, client);
  }

  private welcome(client: WebSocket, context: RequestContext) {
    const affectedRoom = this.service.setConnected(context.principal.userId, true);
    const session = this.service.sessionView(context.principal, this.gateway.auth.sessionViewToken(context));
    this.send(client, { type: 'WELCOME', session, resumed: context.resumed });
    if (session.roomId && session.roomPresence === 'AT_TABLE') {
      this.sendRoom(client, session.roomId, context.principal.userId);
      this.broadcastRoom(session.roomId);
    } else {
      this.sendLobby(client, context);
    }
    if (affectedRoom) this.scheduleRoom(affectedRoom.id);
    this.broadcastLobby();
  }

  private async dispatch(client: WebSocket, context: RequestContext, message: Exclude<ClientMessage, { type: 'HELLO' }>) {
    const principal = context.principal;
    if (message.type === 'LIST_ROOMS') {
      this.sendLobby(client, context);
    } else if (message.type === 'CREATE_ROOM') {
      const room = this.service.createRoom(principal, message);
      this.broadcastRoom(room.id);
      this.broadcastLobby();
    } else if (message.type === 'JOIN_ROOM') {
      const room = this.service.joinRoom(principal, message.roomId, message.playerName);
      this.broadcastRoom(room.id);
      this.broadcastLobby();
    } else if (message.type === 'LEAVE_ROOM') {
      const result = this.service.leaveRoom(principal);
      if (result.room) {
        this.scheduleRoom(result.roomId);
        this.broadcastRoom(result.roomId);
      } else {
        this.clearRoomTimer(result.roomId);
      }
      this.sendLobby(client, context);
      this.broadcastLobby();
    } else if (message.type === 'LEAVE_TABLE') {
      const room = this.service.leaveTable(principal);
      this.scheduleRoom(room.id);
      this.broadcastRoom(room.id);
      this.sendLobby(client, context);
      this.broadcastLobby();
    } else if (message.type === 'RETURN_ROOM') {
      const room = this.service.returnToRoom(principal);
      this.scheduleRoom(room.id);
      this.sendRoom(client, room.id, principal.userId);
      this.broadcastRoom(room.id);
      this.broadcastLobby();
    } else if (message.type === 'DISBAND_ROOM') {
      const closed = this.service.disbandRoom(principal);
      this.clearRoomTimer(closed.roomId);
      this.notifyRoomClosed(closed.memberUserIds, closed.roomId, '房主已解散房间');
      this.broadcastLobby();
    } else if (message.type === 'REQUEST_REBUY') {
      const room = this.service.requestRebuy(principal);
      this.broadcastRoom(room.id);
    } else if (message.type === 'DECLINE_REBUY') {
      const room = this.service.declineRebuy(principal);
      this.scheduleRoom(room.id);
      this.broadcastRoom(room.id);
      this.broadcastLobby();
    } else if (message.type === 'RESOLVE_REBUY') {
      const room = this.service.resolveRebuy(principal, message.playerId, message.approved);
      this.scheduleRoom(room.id);
      this.broadcastRoom(room.id);
      this.broadcastLobby();
    } else if (message.type === 'START_GAME') {
      const room = this.service.startGame(principal);
      this.scheduleRoom(room.id);
      this.broadcastRoom(room.id);
      this.broadcastLobby();
    } else if (message.type === 'NEW_HAND') {
      const room = this.service.newHand(principal);
      this.scheduleRoom(room.id);
      this.broadcastRoom(room.id);
    } else if (message.type === 'ACTION') {
      const room = this.service.act(principal, message);
      this.scheduleRoom(room.id);
      this.broadcastRoom(room.id);
    } else if (message.type === 'GET_REPLAY') {
      this.send(client, { type: 'REPLAY', replay: this.service.replay(principal, message.handId) });
    } else if (message.type === 'RUN_SIMULATION') {
      this.send(client, { type: 'SIMULATION_RESULT', result: runSimulation(message) });
    }
  }

  private send(client: WebSocket, message: ServerMessage) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  private sendLobby(client: WebSocket, context: RequestContext) {
    this.send(client, {
      type: 'LOBBY',
      session: this.service.sessionView(context.principal, this.gateway.auth.sessionViewToken(context)),
      rooms: this.service.listRooms(context.principal.userId),
    });
  }

  private sendRoom(client: WebSocket, roomId: string, userId: string) {
    try {
      this.send(client, { type: 'ROOM', ...this.service.roomView(roomId, userId) });
    } catch {
      const context = this.connections.get(client);
      if (context) this.sendLobby(client, context);
    }
  }

  private broadcastLobby() {
    for (const [client, context] of this.connections) {
      if (!this.service.isAtTable(context.principal.userId)) this.sendLobby(client, context);
    }
  }

  private broadcastRoom(roomId: string) {
    for (const [client, context] of this.connections) {
      if (this.service.roomForUser(context.principal.userId)?.id === roomId && this.service.isAtTable(context.principal.userId)) {
        this.sendRoom(client, roomId, context.principal.userId);
      }
    }
  }

  private notifyRoomClosed(userIds: readonly string[], roomId: string, message: string) {
    for (const [client, context] of this.connections) {
      if (userIds.includes(context.principal.userId)) this.send(client, { type: 'ROOM_CLOSED', roomId, message });
    }
  }

  private disconnect(client: WebSocket) {
    const context = this.connections.get(client);
    if (!context) return;
    const roomId = this.service.roomForUser(context.principal.userId)?.id;
    this.connections.delete(client);
    if (this.sessionClients.get(context.sessionId) === client) this.sessionClients.delete(context.sessionId);
    const stillConnected = [...this.connections.values()].some((item) => item.principal.userId === context.principal.userId);
    if (!stillConnected) this.service.setConnected(context.principal.userId, false);
    if (roomId) {
      this.scheduleRoom(roomId);
      this.broadcastRoom(roomId);
    }
    this.broadcastLobby();
  }

  private releasePending(client: WebSocket) {
    const pending = this.pendingConnections.get(client);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingConnections.delete(client);
  }

  private errorRoomState(context: RequestContext) {
    const room = this.service.roomForUser(context.principal.userId);
    if (!room) return undefined;
    try {
      const { table, view } = this.service.roomView(room.id, context.principal.userId);
      return { ...(table ? { table } : {}), ...(view ? { view } : {}) };
    } catch {
      return undefined;
    }
  }

  private clearRoomTimer(roomId: string) {
    const timer = this.turnTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.turnTimers.delete(roomId);
  }

  private timeoutAction(roomId: string, playerId: string): PlayerAction {
    const actor = this.service.currentActor(roomId);
    if (!actor || actor.player.id !== playerId || !actor.room.game) return { type: 'FOLD' };
    const legal = decisionContext(actor.room.game, playerId).legalActions;
    return legal.types.includes('CHECK') ? { type: 'CHECK' } : { type: 'FOLD' };
  }

  private scheduleRoom(roomId: string) {
    this.clearRoomTimer(roomId);
    const room = this.service.rooms.get(roomId);
    if (!room) return;
    const expiresAt = this.service.roomEngine.expiresAt(room);
    if (expiresAt !== null) {
      const timer = setTimeout(() => {
        this.turnTimers.delete(roomId);
        const closed = this.service.expireInactiveRoom(roomId);
        if (!closed) {
          if (this.service.rooms.has(roomId)) this.scheduleRoom(roomId);
          return;
        }
        this.notifyRoomClosed(closed.memberUserIds, roomId, '房间因长时间无人在线已关闭');
        this.broadcastLobby();
      }, Math.max(0, expiresAt - Date.now()));
      this.turnTimers.set(roomId, timer);
      return;
    }
    if (room.status !== 'PLAYING') {
      if (room.turnDeadline !== null) this.service.setTurnDeadline(roomId, null);
      return;
    }
    if (room.game?.phase === 'FINISHED') {
      const expectedHandId = room.game.handId;
      this.service.setTurnDeadline(roomId, null);
      const timer = setTimeout(() => {
        this.turnTimers.delete(roomId);
        try {
          const current = this.service.rooms.get(roomId);
          if (!current || current.status !== 'PLAYING' || current.game?.handId !== expectedHandId || current.game.phase !== 'FINISHED') return;
          this.service.advanceHand(roomId);
        } catch (error) {
          console.warn(`自动开始下一手失败：${String(error)}`);
        }
        if (this.service.rooms.has(roomId)) {
          this.scheduleRoom(roomId);
          this.broadcastRoom(roomId);
          this.broadcastLobby();
        }
      }, nextHandDelay);
      this.turnTimers.set(roomId, timer);
      return;
    }
    const actor = this.service.currentActor(roomId);
    if (!actor?.room.game) {
      this.service.setTurnDeadline(roomId, null);
      return;
    }
    const expectedHandId = actor.room.game.handId;
    const expectedVersion = actor.room.game.version;
    const delay = actor.player.kind === 'BOT' ? 550 : actor.player.connected ? actor.room.turnSeconds * 1000 : 3_000;
    this.service.setTurnDeadline(roomId, Date.now() + delay);
    const timer = setTimeout(async () => {
      this.turnTimers.delete(roomId);
      try {
        const current = this.service.currentActor(roomId);
        if (!current?.room.game || current.player.id !== actor.player.id || current.room.game.handId !== expectedHandId || current.room.game.version !== expectedVersion) return;
        let action: PlayerAction;
        if (current.player.kind === 'BOT') {
          const strategy = this.strategies.create(current.player.strategyId ?? 'basic-check-call');
          action = await strategy.decide(decisionContext(current.room.game, current.player.id), { random: Math.random });
        } else {
          action = this.timeoutAction(roomId, current.player.id);
        }
        this.service.applyForPlayer(roomId, current.player.id, action);
      } catch (error) {
        console.warn(`自动行动失败：${String(error)}`);
      }
      if (this.service.rooms.has(roomId)) {
        this.scheduleRoom(roomId);
        this.broadcastRoom(roomId);
        this.broadcastLobby();
      }
    }, delay);
    this.turnTimers.set(roomId, timer);
  }
}
