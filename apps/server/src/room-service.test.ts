import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGame } from '@holdem/core';
import { MemoryPersistence } from './persistence.js';
import { RoomService, type StoredServerState } from './room-service.js';

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
  };
}

describe('room and session flow', () => {
  it('creates, joins, restores and plays a room without leaking hidden cards', () => {
    const persistence = new MemoryPersistence<StoredServerState>();
    const service = new RoomService(persistence);
    const first = service.hello().session;
    const room = service.createRoom(first.token, roomRequest('Alice'));
    const second = service.hello().session;
    service.joinRoom(second.token, room.id, 'Bob');
    service.startGame(first.token);

    const firstView = service.roomView(room.id, first.playerId).view!;
    const secondView = service.roomView(room.id, second.playerId).view!;
    assert.equal(firstView.holeCards.length, 2);
    assert.equal(secondView.holeCards.length, 2);
    assert.deepEqual(firstView.revealedCards, {});
    assert.deepEqual(secondView.revealedCards, {});
    assert.notDeepEqual(firstView.holeCards, secondView.holeCards);

    const restored = new RoomService(persistence);
    const resumed = restored.hello(first.token);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.session.playerId, first.playerId);
    assert.equal(resumed.session.roomId, room.id);

    const game = restored.rooms.get(room.id)!.game!;
    restored.act(first.token, { type: 'ACTION', actionId: 'first-action', handId: game.handId, expectedVersion: game.version, action: { type: 'CALL' } });
    assert.equal(restored.rooms.get(room.id)!.game!.version, game.version + 1);
  });

  it('rejects an action from a player whose turn has not arrived', () => {
    const service = new RoomService(new MemoryPersistence<StoredServerState>());
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

  it('advances from a finished hand without a host action', () => {
    const service = new RoomService(new MemoryPersistence<StoredServerState>());
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
    const service = new RoomService(new MemoryPersistence<StoredServerState>());
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
});
