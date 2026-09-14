import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { PersistedRoom } from './room-service.js';
import type { RoomRepository, SessionStore } from './storage.js';

interface LegacySession {
  token: string;
  playerId: string;
  name: string;
}

interface LegacyState {
  schemaVersion: 1 | 2 | 3;
  sessions: LegacySession[];
  rooms: PersistedRoom[];
}

export function migrateLegacyState(
  filePath: string,
  rooms: RoomRepository<PersistedRoom>,
  sessions: SessionStore,
  now = Date.now(),
) {
  if (!existsSync(filePath) || rooms.list().length > 0 || sessions.list().length > 0) return false;
  const state = JSON.parse(readFileSync(filePath, 'utf8')) as LegacyState;
  if (![1, 2, 3].includes(state.schemaVersion) || !Array.isArray(state.rooms) || !Array.isArray(state.sessions)) {
    throw new Error('旧版牌局数据格式无效，未执行迁移');
  }
  state.rooms.forEach((room) => rooms.put(room));
  state.sessions.forEach((session) => sessions.put({
    id: session.token,
    userId: session.playerId,
    displayName: session.name,
    roles: ['PLAYER'],
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    revokedAt: null,
  }));
  renameSync(filePath, `${filePath}.migrated`);
  return true;
}
