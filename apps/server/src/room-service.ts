import { randomBytes } from 'node:crypto';
import {
  applyAction, createGame, exportReplay, foldPlayer, playerView, tableView, type GameState, type HandReplay,
  type PlayerAction, type PlayerProfile, type PlayerView, type TableView,
} from '@holdem/core';
import type {
  ClientMessage, GameMode, RebuyStatus, ReplaySummary, RoomLedgerEntry, RoomPresence, RoomStatus,
  RoomSummary, RoomView, SessionView,
} from '@holdem/protocol';
import type { Principal } from './access-control.js';
import type { RoomRepository } from './storage.js';
import { RoomEngine } from './room-engine.js';

type CreateRoomMessage = Extract<ClientMessage, { type: 'CREATE_ROOM' }>;

interface RoomPlayer {
  id: string;
  name: string;
  kind: 'HUMAN' | 'BOT';
  seat: number;
  stack: number;
  connected: boolean;
  presence: RoomPresence;
  buyInTotal: number;
  rebuyCount: number;
  rebuyStatus: RebuyStatus;
  strategyId?: string;
}

export interface RoomRecord {
  id: string;
  name: string;
  status: RoomStatus;
  hostPlayerId: string;
  maxPlayers: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  gameMode: GameMode;
  maxHands: number | null;
  rebuyEnabled: boolean;
  rebuyAmount: number;
  maxRebuys: number | null;
  turnSeconds: number;
  turnDeadline: number | null;
  inactiveSince: number | null;
  pauseReason: 'NO_ONLINE_HUMAN' | 'NOT_ENOUGH_PLAYERS' | null;
  players: RoomPlayer[];
  game?: GameState;
  handNumber: number;
  replays: HandReplay[];
  ledger: RoomLedgerEntry[];
  handledActionIds: Set<string>;
}

export interface StoredRoom extends Omit<RoomRecord, 'handledActionIds'> {
  handledActionIds: string[];
}

interface LegacyRoomPlayer extends Omit<RoomPlayer, 'presence' | 'buyInTotal' | 'rebuyCount' | 'rebuyStatus'> {
  presence?: RoomPresence;
  left?: boolean;
  buyInTotal?: number;
  rebuyCount?: number;
  rebuyStatus?: RebuyStatus;
}

interface LegacyStoredRoom extends Omit<StoredRoom, 'players' | 'inactiveSince' | 'pauseReason' | 'status' | 'gameMode' | 'maxHands' | 'rebuyEnabled' | 'rebuyAmount' | 'maxRebuys' | 'ledger'> {
  status: RoomStatus;
  players: LegacyRoomPlayer[];
  inactiveSince?: number | null;
  pauseReason?: RoomRecord['pauseReason'];
  gameMode?: GameMode;
  maxHands?: number | null;
  rebuyEnabled?: boolean;
  rebuyAmount?: number;
  maxRebuys?: number | null;
  ledger?: RoomLedgerEntry[];
}

export type PersistedRoom = StoredRoom | LegacyStoredRoom;

const botNames = ['Nova', 'Ada', 'Turing', 'River', 'Atlas', 'Echo', 'Iris'];

function roomCode() {
  return randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

function displayNameKey(name: string) {
  return name.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function availablePlayerName(players: readonly RoomPlayer[], requestedName: string) {
  const base = requestedName.trim() || '玩家';
  const used = new Set(players.map((player) => displayNameKey(player.name)));
  if (!used.has(displayNameKey(base))) return base;

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = ` ${index}`;
    let prefix = '';
    for (const character of base) {
      if (`${prefix}${character}${suffix}`.length > 16) break;
      prefix += character;
    }
    const candidate = `${prefix || '玩'}${suffix}`;
    if (!used.has(displayNameKey(candidate))) return candidate;
  }
  throw new Error('无法分配可辨识的玩家昵称');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class RoomService {
  readonly rooms = new Map<string, RoomRecord>();

  constructor(
    private readonly repository: RoomRepository<PersistedRoom>,
    readonly roomEngine = new RoomEngine(),
    private readonly now: () => number = Date.now,
  ) {
    repository.list().forEach((storedRoom) => {
      const players = storedRoom.players
        .filter((player) => !('left' in player && player.left))
        .map((player) => ({
          id: player.id,
          name: player.name,
          kind: player.kind,
          seat: player.seat,
          stack: player.stack,
          connected: player.kind === 'BOT',
          presence: player.presence ?? 'AT_TABLE',
          buyInTotal: player.buyInTotal ?? storedRoom.startingStack,
          rebuyCount: player.rebuyCount ?? 0,
          rebuyStatus: player.rebuyStatus ?? 'NONE',
          ...(player.strategyId ? { strategyId: player.strategyId } : {}),
        }));
      const room: RoomRecord = {
        ...storedRoom,
        status: storedRoom.status,
        turnDeadline: null,
        inactiveSince: storedRoom.inactiveSince ?? null,
        pauseReason: storedRoom.pauseReason ?? null,
        gameMode: storedRoom.gameMode ?? 'TOURNAMENT',
        maxHands: storedRoom.maxHands ?? null,
        rebuyEnabled: storedRoom.rebuyEnabled ?? false,
        rebuyAmount: storedRoom.rebuyAmount ?? storedRoom.startingStack,
        maxRebuys: storedRoom.maxRebuys ?? null,
        players,
        ledger: storedRoom.ledger ?? players.map((player, index) => ({
          index,
          type: 'INITIAL_BUY_IN' as const,
          playerId: player.id,
          amount: storedRoom.startingStack,
          text: `${player.name} 获得起始筹码 ${storedRoom.startingStack}`,
        })),
        handledActionIds: new Set(storedRoom.handledActionIds),
      };
      this.roomEngine.reconcile(room, this.now());
      this.rooms.set(room.id, room);
    });
    this.rooms.forEach((room) => this.saveRoom(room));
  }

  private saveRoom(room: RoomRecord) {
    this.repository.put({ ...clone(room), handledActionIds: [...room.handledActionIds] });
  }

  sessionView(principal: Principal, sessionToken?: string): SessionView {
    const room = this.roomForUser(principal.userId);
    const player = room?.players.find((item) => item.id === principal.userId);
    return {
      ...(sessionToken ? { token: sessionToken } : {}),
      playerId: principal.userId,
      name: player?.name ?? principal.displayName,
      ...(room && player ? { roomId: room.id, roomPresence: player.presence } : {}),
    };
  }

  roomForUser(userId: string) {
    return [...this.rooms.values()].find((room) => room.players.some((player) => player.id === userId));
  }

  roomCount() {
    return this.rooms.size;
  }

  roomCountForHost(userId: string) {
    return [...this.rooms.values()].filter((room) => room.hostPlayerId === userId).length;
  }

  isAtTable(userId: string) {
    const room = this.roomForUser(userId);
    return room ? this.roomEngine.isAtTable(room, userId) : false;
  }

  setConnected(userId: string, connected: boolean) {
    const room = this.roomForUser(userId);
    const player = room?.players.find((item) => item.id === userId);
    if (!room || !player) return null;
    this.roomEngine.apply(room, {
      type: connected ? 'PLAYER_CONNECTED' : 'PLAYER_DISCONNECTED',
      playerId: userId,
    }, this.now());
    this.saveRoom(room);
    return room;
  }

  createRoom(principal: Principal, message: CreateRoomMessage) {
    if (this.roomForUser(principal.userId)) throw new Error('你已经属于一个房间，请先返回或解散原房间');
    if (message.botCount >= message.maxPlayers) throw new Error('至少要保留一个真人座位');
    if (message.smallBlind >= message.bigBlind || message.startingStack < message.bigBlind * 10) throw new Error('盲注或起始筹码设置不合理');
    if (message.gameMode === 'TOURNAMENT' && message.rebuyEnabled) throw new Error('淘汰赛不能启用补充筹码');
    let id = roomCode();
    while (this.rooms.has(id)) id = roomCode();
    const players: RoomPlayer[] = [{
      id: principal.userId,
      name: availablePlayerName([], message.playerName),
      kind: 'HUMAN',
      seat: 0,
      stack: message.startingStack,
      connected: true,
      presence: 'AT_TABLE',
      buyInTotal: message.startingStack,
      rebuyCount: 0,
      rebuyStatus: 'NONE',
    }];
    for (let index = 0; index < message.botCount; index += 1) {
      players.push({
        id: `${id}-bot-${index + 1}`,
        name: availablePlayerName(players, botNames[index]),
        kind: 'BOT',
        seat: index + 1,
        stack: message.startingStack,
        connected: true,
        presence: 'AT_TABLE',
        buyInTotal: message.startingStack,
        rebuyCount: 0,
        rebuyStatus: 'NONE',
        strategyId: 'basic-check-call',
      });
    }
    const room: RoomRecord = {
      id,
      name: message.roomName,
      status: 'WAITING',
      hostPlayerId: principal.userId,
      maxPlayers: message.maxPlayers,
      startingStack: message.startingStack,
      smallBlind: message.smallBlind,
      bigBlind: message.bigBlind,
      gameMode: message.gameMode,
      maxHands: message.maxHands,
      rebuyEnabled: message.gameMode === 'POINTS' && message.rebuyEnabled,
      rebuyAmount: message.rebuyAmount,
      maxRebuys: message.maxRebuys,
      turnSeconds: message.turnSeconds,
      turnDeadline: null,
      inactiveSince: null,
      pauseReason: null,
      players,
      handNumber: 0,
      replays: [],
      ledger: players.map((player, index) => ({
        index,
        type: 'INITIAL_BUY_IN',
        playerId: player.id,
        amount: message.startingStack,
        text: `${player.name} 获得起始筹码 ${message.startingStack}`,
      })),
      handledActionIds: new Set(),
    };
    this.rooms.set(id, room);
    this.saveRoom(room);
    return room;
  }

  joinRoom(principal: Principal, roomId: string, playerName: string) {
    if (this.roomForUser(principal.userId)) throw new Error('你已经属于一个房间，请先返回原房间');
    const room = this.requireRoom(roomId.toUpperCase());
    if (room.status !== 'WAITING') throw new Error('牌局已经开始，只能由原成员返回');
    if (room.players.length >= room.maxPlayers) throw new Error('房间已满');
    const seat = Array.from({ length: room.maxPlayers }, (_, index) => index)
      .find((index) => !room.players.some((player) => player.seat === index));
    if (seat === undefined) throw new Error('没有可用座位');
    const displayName = availablePlayerName(room.players, playerName);
    room.players.push({
      id: principal.userId,
      name: displayName,
      kind: 'HUMAN',
      seat,
      stack: room.startingStack,
      connected: true,
      presence: 'AT_TABLE',
      buyInTotal: room.startingStack,
      rebuyCount: 0,
      rebuyStatus: 'NONE',
    });
    this.addLedger(room, 'INITIAL_BUY_IN', principal.userId, `${displayName} 获得起始筹码 ${room.startingStack}`, room.startingStack);
    room.players.sort((left, right) => left.seat - right.seat);
    this.roomEngine.reconcile(room, this.now());
    this.saveRoom(room);
    return room;
  }

  leaveRoom(principal: Principal) {
    const { room } = this.requireMembership(principal);
    if (room.status !== 'WAITING') throw new Error('牌局进行中请使用离桌，座位和筹码会保留');
    const roomId = room.id;
    room.players = room.players.filter((player) => player.id !== principal.userId);
    const humans = room.players.filter((player) => player.kind === 'HUMAN');
    if (!humans.length) {
      const closed = this.closeRoom(roomId);
      return { roomId, room: null, memberUserIds: closed.memberUserIds };
    }
    if (room.hostPlayerId === principal.userId) room.hostPlayerId = humans[0].id;
    this.roomEngine.reconcile(room, this.now());
    this.saveRoom(room);
    return { roomId, room, memberUserIds: [] };
  }

  leaveTable(principal: Principal) {
    const { room, player } = this.requireMembership(principal);
    if (room.status === 'WAITING') throw new Error('等待开局时请离开房间');
    if (player.presence === 'AWAY') return room;

    if (room.game && room.game.phase !== 'FINISHED') {
      const result = foldPlayer(room.game, principal.userId);
      if (!result.ok) throw new Error(result.error);
      room.game = result.state;
      this.syncStacks(room);
      this.archiveFinishedHand(room);
    }
    this.roomEngine.apply(room, { type: 'PLAYER_LEFT_TABLE', playerId: principal.userId }, this.now());
    this.saveRoom(room);
    return room;
  }

  returnToRoom(principal: Principal) {
    const { room } = this.requireMembership(principal);
    this.roomEngine.apply(room, { type: 'PLAYER_RETURNED', playerId: principal.userId }, this.now());
    this.saveRoom(room);
    return room;
  }

  disbandRoom(principal: Principal) {
    const { room } = this.requireMembership(principal);
    if (room.hostPlayerId !== principal.userId) throw new Error('只有房主可以解散房间');
    const closed = this.closeRoom(room.id);
    return closed;
  }

  requestRebuy(principal: Principal) {
    const { room, player } = this.requireMembership(principal);
    if (room.gameMode !== 'POINTS' || !room.rebuyEnabled) throw new Error('当前房间不允许补充筹码');
    if (player.stack > 0) throw new Error('筹码用完后才能申请补充');
    if (player.rebuyStatus === 'DECLINED') throw new Error('你已经放弃本局');
    if (player.rebuyStatus !== 'NONE') throw new Error('补充申请已经提交');
    if (room.maxHands !== null && room.handNumber >= room.maxHands) throw new Error('牌局已达到手数上限');
    if (room.maxRebuys !== null && player.rebuyCount >= room.maxRebuys) throw new Error('已达到补充次数上限');
    const stillInHand = room.game?.phase !== 'FINISHED' && room.game?.players.some((item) => item.id === player.id);
    if (stillInHand) throw new Error('请等待本手结算完成');

    player.rebuyStatus = 'PENDING';
    this.addLedger(room, 'REBUY_REQUESTED', player.id, `${player.name} 申请补充 ${room.rebuyAmount}`, room.rebuyAmount);
    this.saveRoom(room);
    return room;
  }

  declineRebuy(principal: Principal) {
    const { room, player } = this.requireMembership(principal);
    if (room.status === 'FINISHED') return room;
    if (room.gameMode !== 'POINTS' || !room.rebuyEnabled) throw new Error('当前牌局没有补充筹码流程');
    if (player.stack > 0) throw new Error('仍有筹码，不能放弃补充');
    if (!room.game || room.game.phase !== 'FINISHED') throw new Error('请等待本手结算完成');
    if (player.rebuyStatus === 'APPROVED') throw new Error('补充筹码已经批准');
    if (player.rebuyStatus === 'DECLINED') return room;

    player.rebuyStatus = 'DECLINED';
    this.addLedger(room, 'REBUY_DECLINED', player.id, `${player.name} 放弃本局`);
    this.archiveFinishedHand(room);
    this.saveRoom(room);
    return room;
  }

  resolveRebuy(principal: Principal, playerId: string, approved: boolean) {
    const { room } = this.requireMembership(principal);
    if (room.hostPlayerId !== principal.userId) throw new Error('只有房主可以处理补充申请');
    const player = room.players.find((item) => item.id === playerId);
    if (!player || player.rebuyStatus !== 'PENDING') throw new Error('找不到待处理的补充申请');

    player.rebuyStatus = approved ? 'APPROVED' : 'NONE';
    this.addLedger(
      room,
      approved ? 'REBUY_APPROVED' : 'REBUY_REJECTED',
      player.id,
      approved ? `房主批准 ${player.name} 补充 ${room.rebuyAmount}` : `房主拒绝 ${player.name} 的补充申请`,
      approved ? room.rebuyAmount : undefined,
    );
    if (approved && (!room.game || room.game.phase === 'FINISHED')) this.applyApprovedRebuys(room);
    this.roomEngine.reconcile(room, this.now());
    this.saveRoom(room);
    return room;
  }

  expireInactiveRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !this.roomEngine.shouldExpire(room, this.now())) return null;
    const closed = this.closeRoom(room.id);
    return closed;
  }

  private closeRoom(roomId: string) {
    const memberUserIds = this.rooms.get(roomId)?.players.filter((player) => player.kind === 'HUMAN').map((player) => player.id) ?? [];
    this.rooms.delete(roomId);
    this.repository.delete(roomId);
    return { roomId, memberUserIds };
  }

  private addLedger(room: RoomRecord, type: RoomLedgerEntry['type'], playerId: string, text: string, amount?: number) {
    room.ledger.push({ index: room.ledger.length, type, playerId, text, ...(amount === undefined ? {} : { amount }) });
  }

  private applyApprovedRebuys(room: RoomRecord) {
    room.players.forEach((player) => {
      if (player.rebuyStatus !== 'APPROVED') return;
      player.stack += room.rebuyAmount;
      player.buyInTotal += room.rebuyAmount;
      player.rebuyCount += 1;
      player.rebuyStatus = 'NONE';
      this.addLedger(room, 'REBUY_APPLIED', player.id, `${player.name} 获得补充筹码 ${room.rebuyAmount}`, room.rebuyAmount);
    });
  }

  private canRestoreCompetition(room: RoomRecord) {
    if (room.gameMode !== 'POINTS' || !room.rebuyEnabled) return false;
    return room.players.some((player) => {
      if (player.kind !== 'HUMAN' || player.stack > 0 || player.rebuyStatus === 'DECLINED') return false;
      if (player.rebuyStatus === 'PENDING' || player.rebuyStatus === 'APPROVED') return true;
      return room.maxRebuys === null || player.rebuyCount < room.maxRebuys;
    });
  }

  startGame(principal: Principal) {
    const { room } = this.requireMembership(principal);
    if (room.hostPlayerId !== principal.userId) throw new Error('只有房主可以开始牌局');
    if (room.status !== 'WAITING') throw new Error('牌局已经开始');
    if (room.players.length < 2) throw new Error('至少需要两名玩家');
    room.status = 'PLAYING';
    room.pauseReason = null;
    this.dealNewHand(room, 0);
    this.roomEngine.reconcile(room, this.now());
    this.saveRoom(room);
    return room;
  }

  newHand(principal: Principal) {
    const { room } = this.requireMembership(principal);
    if (room.hostPlayerId !== principal.userId) throw new Error('只有房主可以开始下一手');
    return this.advanceHand(room.id);
  }

  advanceHand(roomId: string) {
    const room = this.requireRoom(roomId);
    if (room.status === 'FINISHED') throw new Error('整局已经结束');
    if (room.status !== 'PLAYING') throw new Error('房间已暂停');
    if (!room.game || room.game.phase !== 'FINISHED') throw new Error('当前手牌尚未结束');
    const previousDealerId = room.game.players[room.game.dealerIndex].id;
    const previousDealerSeat = room.players.find((player) => player.id === previousDealerId)?.seat ?? -1;
    const eligiblePlayers = this.eligiblePlayers(room);
    if (eligiblePlayers.length < 2) {
      this.roomEngine.reconcile(room, this.now());
      this.saveRoom(room);
      return room;
    }
    const nextDealerPlayer = eligiblePlayers.find((player) => player.seat > previousDealerSeat) ?? eligiblePlayers[0];
    this.dealNewHand(room, eligiblePlayers.findIndex((player) => player.id === nextDealerPlayer.id));
    this.saveRoom(room);
    return room;
  }

  private eligiblePlayers(room: RoomRecord) {
    return room.players
      .filter((player) => player.stack > 0 && (player.kind === 'BOT' || player.presence === 'AT_TABLE'))
      .sort((left, right) => left.seat - right.seat);
  }

  private dealNewHand(room: RoomRecord, dealerIndex: number) {
    room.handNumber += 1;
    room.handledActionIds.clear();
    const profiles: PlayerProfile[] = this.eligiblePlayers(room)
      .map(({ id, name, kind, stack }) => ({ id, name, kind, stack }));
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

  act(principal: Principal, message: Extract<ClientMessage, { type: 'ACTION' }>) {
    const { room, player } = this.requireMembership(principal);
    if (player.presence !== 'AT_TABLE') throw new Error('请先返回牌桌');
    if (room.status !== 'PLAYING') throw new Error('房间已暂停');
    if (room.handledActionIds.has(message.actionId)) return room;
    if (!room.game) throw new Error('牌局尚未开始');
    if (message.handId !== room.game.handId || message.expectedVersion !== room.game.version) throw new Error('牌局已经推进，已刷新当前状态');
    this.applyForPlayer(room.id, principal.userId, message.action);
    room.handledActionIds.add(message.actionId);
    this.saveRoom(room);
    return room;
  }

  applyForPlayer(roomId: string, playerId: string, action: PlayerAction) {
    const room = this.requireRoom(roomId);
    if (room.status !== 'PLAYING') throw new Error('房间已暂停');
    if (!room.game || room.game.currentPlayerIndex === null) throw new Error('当前没有玩家需要行动');
    if (room.game.players[room.game.currentPlayerIndex].id !== playerId) throw new Error('现在还没轮到你');
    const result = applyAction(room.game, action);
    if (!result.ok) throw new Error(result.error);
    room.game = result.state;
    this.syncStacks(room);
    this.archiveFinishedHand(room);
    this.saveRoom(room);
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
    if (!room.game || room.game.phase !== 'FINISHED') return;
    if (!room.replays.some((replay) => replay.handId === room.game!.handId)) room.replays.push(exportReplay(room.game));
    if (room.maxHands !== null && room.handNumber >= room.maxHands) {
      room.status = 'FINISHED';
      room.pauseReason = null;
      room.turnDeadline = null;
      return;
    }
    this.applyApprovedRebuys(room);
    const fundedPlayerCount = room.players.filter((player) => player.stack > 0).length;
    if (fundedPlayerCount < 2 && !this.canRestoreCompetition(room)) {
      room.status = 'FINISHED';
      room.pauseReason = null;
      room.turnDeadline = null;
      return;
    }
    this.roomEngine.reconcile(room, this.now());
  }

  replay(principal: Principal, handId: string) {
    const { room } = this.requireMembership(principal);
    if (room.status !== 'FINISHED') throw new Error('整局结束后才能查看回放');
    const replay = room.replays.find((item) => item.handId === handId);
    if (!replay) throw new Error('找不到这手回放');
    return clone(replay);
  }

  setTurnDeadline(roomId: string, deadline: number | null) {
    const room = this.requireRoom(roomId);
    room.turnDeadline = deadline;
    this.saveRoom(room);
  }

  currentActor(roomId: string) {
    const room = this.requireRoom(roomId);
    if (room.status !== 'PLAYING' || !room.game || room.game.currentPlayerIndex === null) return null;
    const gamePlayer = room.game.players[room.game.currentPlayerIndex];
    const player = room.players.find((item) => item.id === gamePlayer.id);
    return player ? { room, player, gamePlayer } : null;
  }

  listRooms(viewerPlayerId?: string): RoomSummary[] {
    return [...this.rooms.values()].map((room) => {
      const member = viewerPlayerId ? room.players.find((player) => player.id === viewerPlayerId) : undefined;
      return {
        id: room.id,
        name: room.name,
        status: room.status,
        playerCount: room.players.length,
        maxPlayers: room.maxPlayers,
        botCount: room.players.filter((player) => player.kind === 'BOT').length,
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        gameMode: room.gameMode,
        maxHands: room.maxHands,
        membership: member?.presence ?? null,
      };
    });
  }

  roomView(roomId: string, viewerPlayerId: string): { room: RoomView; table?: TableView; view?: PlayerView } {
    const room = this.requireRoom(roomId);
    const summary = this.listRooms(viewerPlayerId).find((item) => item.id === roomId)!;
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
      rebuyEnabled: room.rebuyEnabled,
      rebuyAmount: room.rebuyAmount,
      maxRebuys: room.maxRebuys,
      players: room.players.map(({ id, name, kind, seat, stack, connected, presence, buyInTotal, rebuyCount, rebuyStatus }) => ({
        id, name, kind, seat, stack, connected, presence, buyInTotal, rebuyCount, rebuyStatus,
      })),
      replays,
      ledger: clone(room.ledger),
    };
    return {
      room: roomView,
      ...(room.game ? { table: tableView(room.game) } : {}),
      ...(room.game?.players.some((player) => player.id === viewerPlayerId)
        ? { view: playerView(room.game, viewerPlayerId) }
        : {}),
    };
  }

  private requireRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('房间不存在');
    return room;
  }

  private requireMembership(principal: Principal) {
    const room = this.roomForUser(principal.userId);
    if (!room) throw new Error('你还没有加入房间');
    const player = room.players.find((item) => item.id === principal.userId && item.kind === 'HUMAN');
    if (!player) throw new Error('你不在这个房间');
    return { room, player };
  }
}
