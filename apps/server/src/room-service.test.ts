import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGame } from '@holdem/core';
import type { Principal } from './access-control.js';
import { MemoryRoomRepository } from './storage.js';
import { RoomService, type PersistedRoom } from './room-service.js';
import { RoomEngine } from './room-engine.js';

let userSequence = 0;
function user(displayName = '玩家'): Principal {
  userSequence += 1;
  return { userId: `player-${userSequence}`, displayName, roles: ['PLAYER'] };
}

function roomRequest(playerName: string) {
  return {
    type: 'CREATE_ROOM' as const,
    roomName: '局域网测试桌',
    playerName,
    maxPlayers: 2,
    botCount: 0,
    startingStack: 2000,
    smallBlind: 10,
    bigBlind: 20,
    turnSeconds: 30,
    gameMode: 'TOURNAMENT' as const,
    maxHands: null,
    rebuyEnabled: false,
    rebuyAmount: 1000,
    maxRebuys: null,
  };
}

describe('room and session flow', () => {
  it('creates, joins, restores and plays a room without leaking hidden cards', () => {
    const persistence = new MemoryRoomRepository<PersistedRoom>();
    const service = new RoomService(persistence);
    const first = user();
    const room = service.createRoom(first, roomRequest('Alice'));
    const second = user();
    service.joinRoom(second, room.id, 'Bob');
    service.startGame(first);

    const firstRoom = service.roomView(room.id, first.userId);
    const secondRoom = service.roomView(room.id, second.userId);
    const firstView = firstRoom.view!;
    const secondView = secondRoom.view!;
    assert.equal(firstView.holeCards.length, 2);
    assert.equal(secondView.holeCards.length, 2);
    assert.deepEqual(firstRoom.table!.revealedCards, {});
    assert.deepEqual(secondRoom.table!.revealedCards, {});
    assert.equal('players' in firstView, false);
    assert.notDeepEqual(firstView.holeCards, secondView.holeCards);

    const restored = new RoomService(persistence);
    const resumed = restored.sessionView(first, 'restored-session');
    assert.equal(resumed.playerId, first.userId);
    assert.equal(resumed.roomId, room.id);

    restored.setConnected(first.userId, true);
    const game = restored.rooms.get(room.id)!.game!;
    restored.act(first, { type: 'ACTION', actionId: 'first-action', handId: game.handId, expectedVersion: game.version, action: { type: 'CALL' } });
    assert.equal(restored.rooms.get(room.id)!.game!.version, game.version + 1);
  });

  it('keeps display names distinguishable when players keep the same default nickname', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const host = user();
    const room = service.createRoom(host, { ...roomRequest('玩家'), maxPlayers: 4 });
    const second = user();
    const third = user();

    service.joinRoom(second, room.id, '玩家');
    service.joinRoom(third, room.id, '玩家');

    assert.deepEqual(room.players.map((player) => player.name), ['玩家', '玩家 2', '玩家 3']);
    assert.match(room.ledger.at(-1)!.text, /^玩家 3 获得起始筹码/);
  });

  it('rejects an action from a player whose turn has not arrived', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const first = user();
    const room = service.createRoom(first, roomRequest('Alice'));
    const second = user();
    service.joinRoom(second, room.id, 'Bob');
    service.startGame(first);
    const game = room.game!;

    assert.throws(() => service.act(second, {
      type: 'ACTION', actionId: 'wrong-turn', handId: game.handId, expectedVersion: game.version, action: { type: 'CHECK' },
    }), /还没轮到/);
  });

  it('lets only the host disband a room and clears every membership', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const first = user();
    const room = service.createRoom(first, roomRequest('Alice'));
    const second = user();
    service.joinRoom(second, room.id, 'Bob');

    assert.throws(() => service.disbandRoom(second), /只有房主/);
    const closed = service.disbandRoom(first);

    assert.equal(closed.roomId, room.id);
    assert.equal(service.rooms.has(room.id), false);
    assert.equal(service.roomForUser(first.userId), undefined);
    assert.equal(service.roomForUser(second.userId), undefined);
  });

  it('keeps the seat on leave, pauses the room, and lets the same session return', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const first = user();
    const room = service.createRoom(first, roomRequest('Alice'));
    const second = user();
    service.joinRoom(second, room.id, 'Bob');
    service.startGame(first);

    service.leaveTable(first);
    const departed = room.players.find((player) => player.id === first.userId)!;
    assert.equal(departed.presence, 'AWAY');
    assert.equal(service.roomForUser(first.userId)?.id, room.id);
    assert.equal(room.hostPlayerId, first.userId);
    assert.equal(room.status, 'PAUSED');
    assert.equal(room.game!.currentPlayerIndex, null);

    service.returnToRoom(first);
    assert.equal(departed.presence, 'AT_TABLE');
    assert.equal(room.status, 'PLAYING');
  });

  it('folds an out-of-turn leaver through the rules engine and excludes them from later hands', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const first = user();
    const room = service.createRoom(first, { ...roomRequest('Alice'), maxPlayers: 3 });
    const second = user();
    const third = user();
    service.joinRoom(second, room.id, 'Bob');
    service.joinRoom(third, room.id, 'Carol');
    service.startGame(first);

    service.leaveTable(second);
    assert.equal(room.game!.players.find((player) => player.id === second.userId)?.folded, true);
    assert.equal(room.status, 'PLAYING');
    while (room.game!.phase !== 'FINISHED') {
      const actorId = room.game!.players[room.game!.currentPlayerIndex!].id;
      const legal = room.game!.currentBet === room.game!.players[room.game!.currentPlayerIndex!].streetBet ? { type: 'CHECK' as const } : { type: 'CALL' as const };
      service.applyForPlayer(room.id, actorId, legal);
    }
    service.advanceHand(room.id);

    assert.equal(room.players.some((player) => player.id === second.userId), true);
    assert.deepEqual(room.game!.players.map((player) => player.id).sort(), [first.userId, third.userId].sort());
  });

  it('pauses restored rooms with no online human and expires the whole membership after the grace period', () => {
    let now = 100;
    const persistence = new MemoryRoomRepository<PersistedRoom>();
    const service = new RoomService(persistence, new RoomEngine(1_000), () => now);
    const host = user();
    const room = service.createRoom(host, { ...roomRequest('Alice'), botCount: 1 });
    service.startGame(host);

    const restored = new RoomService(persistence, new RoomEngine(1_000), () => now);
    assert.equal(restored.rooms.get(room.id)?.status, 'PAUSED');
    assert.equal(restored.rooms.get(room.id)?.handNumber, 1);

    now = 1_101;
    const closed = restored.expireInactiveRoom(room.id);
    assert.equal(closed?.roomId, room.id);
    assert.equal(restored.rooms.has(room.id), false);
    assert.equal(restored.roomForUser(host.userId), undefined);
  });

  it('resumes an unfinished hand when an all-in player reconnects with zero remaining stack', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const host = user();
    const room = service.createRoom(host, {
      ...roomRequest('Alice'),
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
    });
    service.startGame(host);

    service.applyForPlayer(room.id, host.userId, { type: 'ALL_IN' });
    assert.equal(room.game!.phase, 'PRE_FLOP');
    assert.equal(room.players.find((player) => player.id === host.userId)!.stack, 0);

    service.setConnected(host.userId, false);
    assert.equal(room.status, 'PAUSED');
    service.setConnected(host.userId, true);
    assert.equal(room.status, 'PLAYING');
    assert.equal(room.pauseReason, null);
  });

  it('advances from a finished hand without a host action', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const first = user();
    const room = service.createRoom(first, roomRequest('Alice'));
    const second = user();
    service.joinRoom(second, room.id, 'Bob');
    service.startGame(first);
    service.applyForPlayer(room.id, first.userId, { type: 'FOLD' });

    assert.equal(room.game!.phase, 'FINISHED');
    service.advanceHand(room.id);

    assert.equal(room.handNumber, 2);
    assert.equal(room.game!.phase, 'PRE_FLOP');
  });

  it('ends the whole game after the last funded player wins and only then exposes replays', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const first = user();
    const room = service.createRoom(first, roomRequest('Alice'));
    const second = user();
    service.joinRoom(second, room.id, 'Bob');
    service.startGame(first);

    room.game = createGame({
      seed: 2,
      handNumber: 1,
      smallBlind: 10,
      bigBlind: 20,
      players: [
        { id: first.userId, name: 'Alice', kind: 'HUMAN', stack: 100 },
        { id: second.userId, name: 'Bob', kind: 'HUMAN', stack: 20 },
      ],
    });
    assert.throws(() => service.replay(first, room.game!.handId), /整局结束后/);

    service.applyForPlayer(room.id, first.userId, { type: 'CALL' });

    assert.equal(room.status, 'FINISHED');
    assert.equal(room.replays.length, 1);
    assert.equal(service.replay(first, room.game!.handId).handId, room.game!.handId);
    assert.throws(() => service.newHand(first), /整局已经结束/);
  });

  it('finishes a points match when only one funded player remains and nobody can rebuy', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const host = user();
    const room = service.createRoom(host, {
      ...roomRequest('Alice'),
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
    });
    service.startGame(host);
    const bot = room.players.find((player) => player.kind === 'BOT')!;
    room.game = createGame({
      seed: 2,
      handNumber: 1,
      dealerIndex: 0,
      smallBlind: 10,
      bigBlind: 20,
      players: [
        { id: host.userId, name: 'Alice', kind: 'HUMAN', stack: 100 },
        { id: bot.id, name: bot.name, kind: 'BOT', stack: 20 },
      ],
    });

    service.applyForPlayer(room.id, host.userId, { type: 'CALL' });

    assert.equal(bot.stack, 0);
    assert.equal(room.status, 'FINISHED');
  });

  it('pauses for a busted human decision and finishes after they decline rebuying', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const host = user();
    const room = service.createRoom(host, {
      ...roomRequest('Alice'),
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
      maxRebuys: 1,
    });
    service.startGame(host);
    const bot = room.players.find((player) => player.kind === 'BOT')!;
    room.game = createGame({
      seed: 0,
      handNumber: 1,
      dealerIndex: 0,
      smallBlind: 10,
      bigBlind: 20,
      players: [
        { id: host.userId, name: 'Alice', kind: 'HUMAN', stack: 20 },
        { id: bot.id, name: bot.name, kind: 'BOT', stack: 100 },
      ],
    });

    service.applyForPlayer(room.id, host.userId, { type: 'CALL' });
    service.applyForPlayer(room.id, bot.id, { type: 'CHECK' });

    assert.equal(room.players.find((player) => player.id === host.userId)?.stack, 0);
    assert.equal(room.status, 'PAUSED');

    service.declineRebuy(host);

    assert.equal(room.players.find((player) => player.id === host.userId)?.rebuyStatus, 'DECLINED');
    assert.equal(room.status, 'FINISHED');
    assert.match(room.ledger.at(-1)?.text ?? '', /放弃本局/);
  });

  it('keeps a busted member at the table as a spectator without exposing private cards', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const host = user();
    const room = service.createRoom(host, {
      ...roomRequest('Alice'),
      maxPlayers: 3,
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
    });
    const busted = user();
    service.joinRoom(busted, room.id, 'Bob');
    service.startGame(host);

    room.players.find((player) => player.id === busted.userId)!.stack = 0;
    room.handNumber = 2;
    room.game = createGame({
      seed: 31,
      handNumber: room.handNumber,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      players: room.players
        .filter((player) => player.id !== busted.userId)
        .map(({ id, name, kind, stack }) => ({ id, name, kind, stack })),
    });

    const spectator = service.roomView(room.id, busted.userId);
    assert.ok(spectator.table);
    assert.equal(spectator.table.handNumber, 2);
    assert.equal(spectator.view, undefined);
    assert.equal(spectator.table.players.some((player) => 'holeCards' in player), false);
    assert.deepEqual(spectator.table.revealedCards, {});
  });

  it('applies an approved rebuy at a hand boundary and returns the member next hand', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const host = user();
    const room = service.createRoom(host, {
      ...roomRequest('Alice'),
      maxPlayers: 3,
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
      rebuyAmount: 1000,
      maxRebuys: 2,
    });
    const busted = user();
    service.joinRoom(busted, room.id, 'Bob');
    service.startGame(host);

    const bustedPlayer = room.players.find((player) => player.id === busted.userId)!;
    bustedPlayer.stack = 0;
    room.game = createGame({
      seed: 41,
      handNumber: room.handNumber,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      players: room.players
        .filter((player) => player.id !== busted.userId)
        .map(({ id, name, kind, stack }) => ({ id, name, kind, stack })),
    });

    service.requestRebuy(busted);
    assert.equal(bustedPlayer.rebuyStatus, 'PENDING');
    service.resolveRebuy(host, busted.userId, true);
    assert.equal(bustedPlayer.rebuyStatus, 'APPROVED');
    assert.equal(bustedPlayer.stack, 0);

    const actorId = room.game.players[room.game.currentPlayerIndex!].id;
    service.applyForPlayer(room.id, actorId, { type: 'FOLD' });
    assert.equal(bustedPlayer.stack, 1000);
    assert.equal(bustedPlayer.buyInTotal, 3000);
    assert.equal(bustedPlayer.rebuyCount, 1);
    assert.equal(bustedPlayer.rebuyStatus, 'NONE');
    assert.equal(room.ledger.filter((entry) => entry.playerId === busted.userId).map((entry) => entry.type).at(-1), 'REBUY_APPLIED');

    service.advanceHand(room.id);
    assert.ok(service.roomView(room.id, busted.userId).view);
  });

  it('finishes the match after the configured hand limit', () => {
    const service = new RoomService(new MemoryRoomRepository<PersistedRoom>());
    const host = user();
    const room = service.createRoom(host, {
      ...roomRequest('Alice'),
      gameMode: 'POINTS',
      maxHands: 1,
    });
    const second = user();
    service.joinRoom(second, room.id, 'Bob');
    service.startGame(host);

    const actorId = room.game!.players[room.game!.currentPlayerIndex!].id;
    service.applyForPlayer(room.id, actorId, { type: 'FOLD' });

    assert.equal(room.handNumber, 1);
    assert.equal(room.status, 'FINISHED');
    assert.equal(service.roomView(room.id, host.userId).table?.phase, 'FINISHED');
  });
});
