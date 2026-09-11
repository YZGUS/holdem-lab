import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
