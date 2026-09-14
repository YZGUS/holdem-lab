import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { migrateLegacyState } from './legacy-migration.js';
import type { PersistedRoom } from './room-service.js';
import { JsonDirectoryRoomRepository, JsonDirectorySessionStore } from './storage.js';

describe('split persistence stores', () => {
  it('updates one entity without rewriting a global state file', () => {
    const root = mkdtempSync(join(tmpdir(), 'holdem-storage-'));
    try {
      const sessions = new JsonDirectorySessionStore(join(root, 'sessions'));
      sessions.put({ id: 'session-1', userId: 'user-1', displayName: 'Alice', roles: ['PLAYER'], createdAt: 1, lastSeenAt: 1, expiresAt: 10, revokedAt: null });
      sessions.put({ id: 'session-1', userId: 'user-1', displayName: 'Alice', roles: ['PLAYER'], createdAt: 1, lastSeenAt: 2, expiresAt: 20, revokedAt: null });
      assert.equal(readdirSync(join(root, 'sessions')).length, 1);
      assert.equal(sessions.get('session-1')?.lastSeenAt, 2);
      assert.equal(sessions.deleteExpired(21), 1);
      assert.equal(readdirSync(join(root, 'sessions')).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates the previous single JSON file once and preserves its session token', () => {
    const root = mkdtempSync(join(tmpdir(), 'holdem-migration-'));
    try {
      const legacyPath = join(root, 'server-state.json');
      writeFileSync(legacyPath, JSON.stringify({
        schemaVersion: 3,
        sessions: [{ token: 'legacy-token', playerId: 'legacy-user', name: 'Alice' }],
        rooms: [{ id: 'ABC123' }],
      }));
      const rooms = new JsonDirectoryRoomRepository<PersistedRoom>(join(root, 'new', 'rooms'));
      const sessions = new JsonDirectorySessionStore(join(root, 'new', 'sessions'));
      assert.equal(migrateLegacyState(legacyPath, rooms, sessions, 100), true);
      assert.equal(rooms.get('ABC123')?.id, 'ABC123');
      assert.equal(sessions.get('legacy-token')?.userId, 'legacy-user');
      assert.doesNotThrow(() => JSON.parse(readFileSync(`${legacyPath}.migrated`, 'utf8')));
      assert.equal(migrateLegacyState(legacyPath, rooms, sessions, 100), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
