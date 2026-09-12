import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGame } from '@holdem/core';
import { MemoryPersistence } from './persistence.js';
import { RoomService, type PersistedServerState } from './room-service.js';
import { RoomEngine } from './room-engine.js';

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
    const persistence = new MemoryPersistence<PersistedServerState>();
    const service = new RoomService(persistence);
    const first = service.hello().session;
    const room = service.createRoom(first.token, roomRequest('Alice'));
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.startGame(first.token);

    const firstRoom = service.roomView(room.id, first.playerId);
    const secondRoom = service.roomView(room.id, second.playerId);
    const firstView = firstRoom.view!;
    const secondView = secondRoom.view!;
    assert.equal(firstView.holeCards.length, 2);
    assert.equal(secondView.holeCards.length, 2);
    assert.deepEqual(firstRoom.table!.revealedCards, {});
    assert.deepEqual(secondRoom.table!.revealedCards, {});
    assert.equal('players' in firstView, false);
    assert.notDeepEqual(firstView.holeCards, secondView.holeCards);

    const restored = new RoomService(persistence);
    const resumed = restored.hello(first.token);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.session.playerId, first.playerId);
    assert.equal(resumed.session.roomId, room.id);

    restored.setConnected(first.token, true);
    const game = restored.rooms.get(room.id)!.game!;
    restored.act(first.token, { type: 'ACTION', actionId: 'first-action', handId: game.handId, expectedVersion: game.version, action: { type: 'CALL' } });
    assert.equal(restored.rooms.get(room.id)!.game!.version, game.version + 1);
  });

  it('rejects an action from a player whose turn has not arrived', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const first = service.hello().session;
    const room = service.createRoom(first.token, roomRequest('Alice'));
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.startGame(first.token);
    const game = room.game!;

    assert.throws(() => service.act(second.token, {
      type: 'ACTION', actionId: 'wrong-turn', handId: game.handId, expectedVersion: game.version, action: { type: 'CHECK' },
    }), /还没轮到/);
  });

  it('lets only the host disband a room and clears every member session', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const first = service.hello().session;
    const room = service.createRoom(first.token, roomRequest('Alice'));
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');

    assert.throws(() => service.disbandRoom(second.token), /只有房主/);
    const closed = service.disbandRoom(first.token);

    assert.equal(closed.roomId, room.id);
    assert.equal(service.rooms.has(room.id), false);
    assert.equal(service.session(first.token)?.roomId, undefined);
    assert.equal(service.session(second.token)?.roomId, undefined);
  });

  it('keeps the seat on leave, pauses the room, and lets the same session return', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const first = service.hello().session;
    const room = service.createRoom(first.token, roomRequest('Alice'));
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.startGame(first.token);

    service.leaveTable(first.token);
    const departed = room.players.find((player) => player.id === first.playerId)!;
    assert.equal(departed.presence, 'AWAY');
    assert.equal(service.session(first.token)?.roomId, room.id);
    assert.equal(room.hostPlayerId, first.playerId);
    assert.equal(room.status, 'PAUSED');
    assert.equal(room.game!.currentPlayerIndex, null);

    service.returnToRoom(first.token);
    assert.equal(departed.presence, 'AT_TABLE');
    assert.equal(room.status, 'PLAYING');
  });

  it('folds an out-of-turn leaver through the rules engine and excludes them from later hands', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const first = service.hello().session;
    const room = service.createRoom(first.token, { ...roomRequest('Alice'), maxPlayers: 3 });
    const second = service.hello().session;
    const third = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.joinRoom(third.token, room.id, 'Carol');
    service.startGame(first.token);

    service.leaveTable(second.token);
    assert.equal(room.game!.players.find((player) => player.id === second.playerId)?.folded, true);
    assert.equal(room.status, 'PLAYING');
    while (room.game!.phase !== 'FINISHED') {
      const actorId = room.game!.players[room.game!.currentPlayerIndex!].id;
      const legal = room.game!.currentBet === room.game!.players[room.game!.currentPlayerIndex!].streetBet ? { type: 'CHECK' as const } : { type: 'CALL' as const };
      service.applyForPlayer(room.id, actorId, legal);
    }
    service.advanceHand(room.id);

    assert.equal(room.players.some((player) => player.id === second.playerId), true);
    assert.deepEqual(room.game!.players.map((player) => player.id).sort(), [first.playerId, third.playerId].sort());
  });

  it('pauses restored rooms with no online human and expires the whole membership after the grace period', () => {
    let now = 100;
    const persistence = new MemoryPersistence<PersistedServerState>();
    const service = new RoomService(persistence, new RoomEngine(1_000), () => now);
    const host = service.hello().session;
    const room = service.createRoom(host.token, { ...roomRequest('Alice'), botCount: 1 });
    service.startGame(host.token);

    const restored = new RoomService(persistence, new RoomEngine(1_000), () => now);
    assert.equal(restored.rooms.get(room.id)?.status, 'PAUSED');
    assert.equal(restored.rooms.get(room.id)?.handNumber, 1);

    now = 1_101;
    const closed = restored.expireInactiveRoom(room.id);
    assert.equal(closed?.roomId, room.id);
    assert.equal(restored.rooms.has(room.id), false);
    assert.equal(restored.session(host.token)?.roomId, undefined);
  });

  it('resumes an unfinished hand when an all-in player reconnects with zero remaining stack', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const host = service.hello().session;
    const room = service.createRoom(host.token, {
      ...roomRequest('Alice'),
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
    });
    service.startGame(host.token);

    service.applyForPlayer(room.id, host.playerId, { type: 'ALL_IN' });
    assert.equal(room.game!.phase, 'PRE_FLOP');
    assert.equal(room.players.find((player) => player.id === host.playerId)!.stack, 0);

    service.setConnected(host.token, false);
    assert.equal(room.status, 'PAUSED');
    service.setConnected(host.token, true);
    assert.equal(room.status, 'PLAYING');
    assert.equal(room.pauseReason, null);
  });

  it('advances from a finished hand without a host action', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const first = service.hello().session;
    const room = service.createRoom(first.token, roomRequest('Alice'));
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.startGame(first.token);
    service.applyForPlayer(room.id, first.playerId, { type: 'FOLD' });

    assert.equal(room.game!.phase, 'FINISHED');
    service.advanceHand(room.id);

    assert.equal(room.handNumber, 2);
    assert.equal(room.game!.phase, 'PRE_FLOP');
  });

  it('ends the whole game after the last funded player wins and only then exposes replays', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const first = service.hello().session;
    const room = service.createRoom(first.token, roomRequest('Alice'));
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.startGame(first.token);

    room.game = createGame({
      seed: 2,
      handNumber: 1,
      smallBlind: 10,
      bigBlind: 20,
      players: [
        { id: first.playerId, name: 'Alice', kind: 'HUMAN', stack: 100 },
        { id: second.playerId, name: 'Bob', kind: 'HUMAN', stack: 20 },
      ],
    });
    assert.throws(() => service.replay(first.token, room.game!.handId), /整局结束后/);

    service.applyForPlayer(room.id, first.playerId, { type: 'CALL' });

    assert.equal(room.status, 'FINISHED');
    assert.equal(room.replays.length, 1);
    assert.equal(service.replay(first.token, room.game!.handId).handId, room.game!.handId);
    assert.throws(() => service.newHand(first.token), /整局已经结束/);
  });

  it('keeps a busted member at the table as a spectator without exposing private cards', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const host = service.hello().session;
    const room = service.createRoom(host.token, {
      ...roomRequest('Alice'),
      maxPlayers: 3,
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
    });
    const busted = service.hello().session;
    service.joinRoom(busted.token, room.id, 'Bob');
    service.startGame(host.token);

    room.players.find((player) => player.id === busted.playerId)!.stack = 0;
    room.handNumber = 2;
    room.game = createGame({
      seed: 31,
      handNumber: room.handNumber,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      players: room.players
        .filter((player) => player.id !== busted.playerId)
        .map(({ id, name, kind, stack }) => ({ id, name, kind, stack })),
    });

    const spectator = service.roomView(room.id, busted.playerId);
    assert.ok(spectator.table);
    assert.equal(spectator.table.handNumber, 2);
    assert.equal(spectator.view, undefined);
    assert.equal(spectator.table.players.some((player) => 'holeCards' in player), false);
    assert.deepEqual(spectator.table.revealedCards, {});
  });

  it('applies an approved rebuy at a hand boundary and returns the member next hand', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const host = service.hello().session;
    const room = service.createRoom(host.token, {
      ...roomRequest('Alice'),
      maxPlayers: 3,
      botCount: 1,
      gameMode: 'POINTS',
      rebuyEnabled: true,
      rebuyAmount: 1000,
      maxRebuys: 2,
    });
    const busted = service.hello().session;
    service.joinRoom(busted.token, room.id, 'Bob');
    service.startGame(host.token);

    const bustedPlayer = room.players.find((player) => player.id === busted.playerId)!;
    bustedPlayer.stack = 0;
    room.game = createGame({
      seed: 41,
      handNumber: room.handNumber,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      players: room.players
        .filter((player) => player.id !== busted.playerId)
        .map(({ id, name, kind, stack }) => ({ id, name, kind, stack })),
    });

    service.requestRebuy(busted.token);
    assert.equal(bustedPlayer.rebuyStatus, 'PENDING');
    service.resolveRebuy(host.token, busted.playerId, true);
    assert.equal(bustedPlayer.rebuyStatus, 'APPROVED');
    assert.equal(bustedPlayer.stack, 0);

    const actorId = room.game.players[room.game.currentPlayerIndex!].id;
    service.applyForPlayer(room.id, actorId, { type: 'FOLD' });
    assert.equal(bustedPlayer.stack, 1000);
    assert.equal(bustedPlayer.buyInTotal, 3000);
    assert.equal(bustedPlayer.rebuyCount, 1);
    assert.equal(bustedPlayer.rebuyStatus, 'NONE');
    assert.equal(room.ledger.filter((entry) => entry.playerId === busted.playerId).map((entry) => entry.type).at(-1), 'REBUY_APPLIED');

    service.advanceHand(room.id);
    assert.ok(service.roomView(room.id, busted.playerId).view);
  });

  it('finishes the match after the configured hand limit', () => {
    const service = new RoomService(new MemoryPersistence<PersistedServerState>());
    const host = service.hello().session;
    const room = service.createRoom(host.token, {
      ...roomRequest('Alice'),
      gameMode: 'POINTS',
      maxHands: 1,
    });
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.startGame(host.token);

    const actorId = room.game!.players[room.game!.currentPlayerIndex!].id;
    service.applyForPlayer(room.id, actorId, { type: 'FOLD' });

    assert.equal(room.handNumber, 1);
    assert.equal(room.status, 'FINISHED');
    assert.equal(service.roomView(room.id, host.playerId).table?.phase, 'FINISHED');
  });
});
