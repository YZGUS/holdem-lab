import { randomBytes } from 'node:crypto';
import {
  applyAction, createGame, exportReplay, playerView, type GameState, type HandReplay,
  type PlayerAction, type PlayerProfile, type PlayerView,
} from '@holdem/core';
import type { ClientMessage, ReplaySummary, RoomSummary, RoomView, SessionView } from '@holdem/protocol';
import type { PersistenceAdapter } from './persistence.js';

type CreateRoomMessage = Extract<ClientMessage, { type: 'CREATE_ROOM' }>;

interface SessionRecord {
  token: string;
  playerId: string;
  name: string;
  roomId?: string;
}

interface RoomPlayer {
  id: string;
  name: string;
  kind: 'HUMAN' | 'BOT';
  seat: number;
  stack: number;
  connected: boolean;
  sessionToken?: string;
  strategyId?: string;
}

export interface RoomRecord {
  id: string;
  name: string;
  status: 'WAITING' | 'PLAYING' | 'FINISHED';
  hostPlayerId: string;
  maxPlayers: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  turnSeconds: number;
  turnDeadline: number | null;
  players: RoomPlayer[];
  game?: GameState;
  handNumber: number;
  replays: HandReplay[];
  handledActionIds: Set<string>;
}

interface StoredRoom extends Omit<RoomRecord, 'handledActionIds'> {
  handledActionIds: string[];
}

export interface StoredServerState {
  schemaVersion: 1;
  sessions: SessionRecord[];
  rooms: StoredRoom[];
}

const botNames = ['Nova', 'Ada', 'Turing', 'River', 'Atlas', 'Echo', 'Iris'];

function token(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

function roomCode() {
  return randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class RoomService {
  readonly rooms = new Map<string, RoomRecord>();
  readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly persistence: PersistenceAdapter<StoredServerState>) {
    const stored = persistence.load();
    if (stored?.schemaVersion === 1) {
      stored.sessions.forEach((session) => this.sessions.set(session.token, session));
      stored.rooms.forEach((room) => this.rooms.set(room.id, {
        ...room,
        turnDeadline: null,
        players: room.players.map((player) => ({ ...player, connected: player.kind === 'BOT' })),
        handledActionIds: new Set(room.handledActionIds),
      }));
    }
  }

  private save() {
    this.persistence.save({
      schemaVersion: 1,
      sessions: clone([...this.sessions.values()]),
      rooms: [...this.rooms.values()].map((room) => ({ ...clone(room), handledActionIds: [...room.handledActionIds] })),
    });
  }

  hello(existingToken?: string) {
    const existing = existingToken ? this.sessions.get(existingToken) : undefined;
    if (existing) {
      if (existing.roomId && !this.rooms.has(existing.roomId)) {
        existing.roomId = undefined;
        this.save();
      }
      return { session: this.sessionView(existing), resumed: true };
    }
    const session: SessionRecord = { token: token(), playerId: `player-${token(8)}`, name: '玩家' };
    this.sessions.set(session.token, session);
    this.save();
    return { session: this.sessionView(session), resumed: false };
  }

  private sessionView(session: SessionRecord): SessionView {
    return { token: session.token, playerId: session.playerId, name: session.name, ...(session.roomId ? { roomId: session.roomId } : {}) };
  }

  session(sessionToken: string) {
    return this.sessions.get(sessionToken);
  }

  markConnected(sessionToken: string, connected: boolean) {
    const session = this.sessions.get(sessionToken);
    if (!session?.roomId) return;
    const room = this.rooms.get(session.roomId);
    const player = room?.players.find((item) => item.id === session.playerId);
    if (player) {
      player.connected = connected;
      this.save();
    }
  }

  createRoom(sessionToken: string, message: CreateRoomMessage) {
    const session = this.requireSession(sessionToken);
    if (session.roomId) throw new Error('请先离开当前房间');
    if (message.botCount >= message.maxPlayers) throw new Error('至少要保留一个真人座位');
    if (message.smallBlind >= message.bigBlind || message.startingStack < message.bigBlind * 10) throw new Error('盲注或起始筹码设置不合理');
    let id = roomCode();
    while (this.rooms.has(id)) id = roomCode();
    session.name = message.playerName;
    session.roomId = id;
    const players: RoomPlayer[] = [{
      id: session.playerId,
      name: message.playerName,
      kind: 'HUMAN',
      seat: 0,
      stack: message.startingStack,
      connected: true,
      sessionToken,
    }];
    for (let index = 0; index < message.botCount; index += 1) {
      players.push({
        id: `${id}-bot-${index + 1}`,
        name: botNames[index],
        kind: 'BOT',
        seat: index + 1,
        stack: message.startingStack,
        connected: true,
        strategyId: 'basic-check-call',
      });
    }
    const room: RoomRecord = {
      id,
      name: message.roomName,
      status: 'WAITING',
      hostPlayerId: session.playerId,
      maxPlayers: message.maxPlayers,
      startingStack: message.startingStack,
      smallBlind: message.smallBlind,
      bigBlind: message.bigBlind,
      turnSeconds: message.turnSeconds,
      turnDeadline: null,
      players,
      handNumber: 0,
      replays: [],
      handledActionIds: new Set(),
    };
    this.rooms.set(id, room);
    this.save();
    return room;
  }

  joinRoom(sessionToken: string, roomId: string, playerName: string) {
    const session = this.requireSession(sessionToken);
    if (session.roomId) throw new Error('请先离开当前房间');
    const room = this.requireRoom(roomId.toUpperCase());
    if (room.status !== 'WAITING') throw new Error('牌局已经开始，只能使用原会话重连');
    if (room.players.length >= room.maxPlayers) throw new Error('房间已满');
    const seat = Array.from({ length: room.maxPlayers }, (_, index) => index).find((index) => !room.players.some((player) => player.seat === index));
    if (seat === undefined) throw new Error('没有可用座位');
    session.name = playerName;
    session.roomId = room.id;
    room.players.push({ id: session.playerId, name: playerName, kind: 'HUMAN', seat, stack: room.startingStack, connected: true, sessionToken });
    room.players.sort((left, right) => left.seat - right.seat);
    this.save();
    return room;
  }

  leaveRoom(sessionToken: string) {
    const session = this.requireSession(sessionToken);
    if (!session.roomId) return null;
    const room = this.rooms.get(session.roomId);
    session.roomId = undefined;
    if (!room) {
      this.save();
      return null;
    }
    const player = room.players.find((item) => item.id === session.playerId);
    if (room.status === 'WAITING') room.players = room.players.filter((item) => item.id !== session.playerId);
    else if (player) player.connected = false;
    const humans = room.players.filter((item) => item.kind === 'HUMAN');
    const connectedHumans = humans.filter((item) => item.connected);
    if (!connectedHumans.length) this.rooms.delete(room.id);
    else if (room.hostPlayerId === session.playerId) room.hostPlayerId = connectedHumans[0].id;
    this.save();
    return room;
  }

  startGame(sessionToken: string) {
    const { room, session } = this.requireMembership(sessionToken);
    if (room.hostPlayerId !== session.playerId) throw new Error('只有房主可以开始牌局');
    if (room.status !== 'WAITING') throw new Error('牌局已经开始');
    if (room.players.length < 2) throw new Error('至少需要两名玩家');
    room.status = 'PLAYING';
    this.dealNewHand(room, 0);
    this.save();
    return room;
  }

  newHand(sessionToken: string) {
    const { room, session } = this.requireMembership(sessionToken);
    if (room.hostPlayerId !== session.playerId) throw new Error('只有房主可以开始下一手');
    return this.advanceHand(room.id);
  }

  advanceHand(roomId: string) {
    const room = this.requireRoom(roomId);
    if (room.status === 'FINISHED') throw new Error('整局已经结束');
    if (!room.game || room.game.phase !== 'FINISHED') throw new Error('当前手牌尚未结束');
    const nextDealer = (room.game.dealerIndex + 1) % room.players.length;
    this.dealNewHand(room, nextDealer);
    this.save();
    return room;
  }

  private dealNewHand(room: RoomRecord, dealerIndex: number) {
    room.handNumber += 1;
    room.handledActionIds.clear();
    const profiles: PlayerProfile[] = room.players.map(({ id, name, kind, stack }) => ({ id, name, kind, stack }));
    room.game = createGame({
      seed: randomBytes(4).readUInt32LE(0),
      handNumber: room.handNumber,
      dealerIndex,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      players: profiles,
    });
    this.syncStacks(room);
    this.archiveFinishedHand(room);
  }

  act(sessionToken: string, message: Extract<ClientMessage, { type: 'ACTION' }>) {
    const { room, session } = this.requireMembership(sessionToken);
    if (room.handledActionIds.has(message.actionId)) return room;
    if (!room.game) throw new Error('牌局尚未开始');
    if (message.handId !== room.game.handId || message.expectedVersion !== room.game.version) throw new Error('牌局已经推进，已刷新当前状态');
    this.applyForPlayer(room.id, session.playerId, message.action);
    room.handledActionIds.add(message.actionId);
    this.save();
    return room;
  }

  applyForPlayer(roomId: string, playerId: string, action: PlayerAction) {
    const room = this.requireRoom(roomId);
    if (!room.game || room.game.currentPlayerIndex === null) throw new Error('当前没有玩家需要行动');
    if (room.game.players[room.game.currentPlayerIndex].id !== playerId) throw new Error('现在还没轮到你');
    const result = applyAction(room.game, action);
    if (!result.ok) throw new Error(result.error);
    room.game = result.state;
    this.syncStacks(room);
    this.archiveFinishedHand(room);
    this.save();
    return room;
  }

  private syncStacks(room: RoomRecord) {
    if (!room.game) return;
    room.players.forEach((player) => {
      const gamePlayer = room.game!.players.find((item) => item.id === player.id);
      if (gamePlayer) player.stack = gamePlayer.stack;
    });
  }

  private archiveFinishedHand(room: RoomRecord) {
    if (!room.game || room.game.phase !== 'FINISHED' || room.replays.some((replay) => replay.handId === room.game!.handId)) return;
    room.replays.push(exportReplay(room.game));
    if (room.players.filter((player) => player.stack > 0).length < 2) {
      room.status = 'FINISHED';
      room.turnDeadline = null;
    }
  }

  replay(sessionToken: string, handId: string) {
    const { room } = this.requireMembership(sessionToken);
    if (room.status !== 'FINISHED') throw new Error('整局结束后才能查看回放');
    const replay = room.replays.find((item) => item.handId === handId);
    if (!replay) throw new Error('找不到这手回放');
    return clone(replay);
  }

  setTurnDeadline(roomId: string, deadline: number | null) {
    const room = this.requireRoom(roomId);
    room.turnDeadline = deadline;
    this.save();
  }

  currentActor(roomId: string) {
    const room = this.requireRoom(roomId);
    if (!room.game || room.game.currentPlayerIndex === null) return null;
    const gamePlayer = room.game.players[room.game.currentPlayerIndex];
    return { room, player: room.players.find((item) => item.id === gamePlayer.id)!, gamePlayer };
  }

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      status: room.status,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      botCount: room.players.filter((player) => player.kind === 'BOT').length,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
    }));
  }

  roomView(roomId: string, viewerPlayerId: string): { room: RoomView; view?: PlayerView } {
    const room = this.requireRoom(roomId);
    const summary = this.listRooms().find((item) => item.id === roomId)!;
    const replays: ReplaySummary[] = room.replays.map((replay) => ({
      handId: replay.handId,
      handNumber: replay.setup.handNumber,
      resultText: replay.resultText ?? '本手结束',
      actionCount: replay.actions.length,
    }));
    const roomView: RoomView = {
      ...summary,
      hostPlayerId: room.hostPlayerId,
      viewerPlayerId,
      startingStack: room.startingStack,
      turnSeconds: room.turnSeconds,
      turnDeadline: room.turnDeadline,
      players: room.players.map(({ id, name, kind, seat, stack, connected }) => ({ id, name, kind, seat, stack, connected })),
      replays,
    };
    return { room: roomView, ...(room.game?.players.some((player) => player.id === viewerPlayerId) ? { view: playerView(room.game, viewerPlayerId) } : {}) };
  }

  private requireSession(sessionToken: string) {
    const session = this.sessions.get(sessionToken);
    if (!session) throw new Error('会话已经失效，请重新连接');
    return session;
  }

  private requireRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('房间不存在');
    return room;
  }

  private requireMembership(sessionToken: string) {
    const session = this.requireSession(sessionToken);
    if (!session.roomId) throw new Error('你还没有加入房间');
    const room = this.requireRoom(session.roomId);
    if (!room.players.some((player) => player.id === session.playerId)) throw new Error('你不在这个房间');
    return { room, session };
  }
}
