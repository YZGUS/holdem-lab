import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionRecord {
  id: string;
  userId: string;
  displayName: string;
  roles: string[];
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface SessionStore {
  get(id: string): SessionRecord | undefined;
  put(session: SessionRecord): void;
  delete(id: string): void;
  list(): SessionRecord[];
  deleteExpired(now: number): number;
}

export interface RoomRepository<T extends { id: string }> {
  get(id: string): T | undefined;
  put(room: T): void;
  delete(id: string): void;
  list(): T[];
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number, now: number): RateLimitResult;
  cleanup(now: number): number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  get(id: string) {
    const session = this.sessions.get(id);
    return session ? clone(session) : undefined;
  }

  put(session: SessionRecord) {
    this.sessions.set(session.id, clone(session));
  }

  delete(id: string) {
    this.sessions.delete(id);
  }

  list() {
    return [...this.sessions.values()].map(clone);
  }

  deleteExpired(now: number) {
    let deleted = 0;
    for (const [id, session] of this.sessions) {
      if (session.revokedAt !== null || session.expiresAt <= now) {
        this.sessions.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class MemoryRoomRepository<T extends { id: string }> implements RoomRepository<T> {
  private readonly rooms = new Map<string, T>();

  get(id: string) {
    const room = this.rooms.get(id);
    return room ? clone(room) : undefined;
  }

  put(room: T) {
    this.rooms.set(room.id, clone(room));
  }

  delete(id: string) {
    this.rooms.delete(id);
  }

  list() {
    return [...this.rooms.values()].map(clone);
  }
}

interface WindowCounter {
  count: number;
  resetAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, WindowCounter>();

  consume(key: string, limit: number, windowMs: number, now: number): RateLimitResult {
    let counter = this.counters.get(key);
    if (!counter || counter.resetAt <= now) {
      counter = { count: 0, resetAt: now + windowMs };
      this.counters.set(key, counter);
    }
    counter.count += 1;
    return {
      allowed: counter.count <= limit,
      remaining: Math.max(0, limit - counter.count),
      retryAfterMs: Math.max(0, counter.resetAt - now),
    };
  }

  cleanup(now: number) {
    let deleted = 0;
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) {
        this.counters.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function safeName(id: string) {
  return Buffer.from(id).toString('base64url');
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`无法读取 ${path}：${String(error)}`);
    return undefined;
  }
}

function atomicWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), 'utf8');
  renameSync(temporary, path);
}

abstract class JsonDirectoryStore<T extends { id: string }> {
  protected readonly values = new Map<string, T>();

  constructor(protected readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const value = readJson<T>(join(directory, file.name));
      if (value?.id) this.values.set(value.id, value);
    }
  }

  protected path(id: string) {
    return join(this.directory, `${safeName(id)}.json`);
  }

  get(id: string) {
    const value = this.values.get(id);
    return value ? clone(value) : undefined;
  }

  put(value: T) {
    const stored = clone(value);
    this.values.set(value.id, stored);
    atomicWrite(this.path(value.id), stored);
  }

  delete(id: string) {
    this.values.delete(id);
    rmSync(this.path(id), { force: true });
  }

  list() {
    return [...this.values.values()].map(clone);
  }
}

export class JsonDirectorySessionStore extends JsonDirectoryStore<SessionRecord> implements SessionStore {
  deleteExpired(now: number) {
    let deleted = 0;
    for (const [id, session] of this.values) {
      if (session.revokedAt !== null || session.expiresAt <= now) {
        this.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class JsonDirectoryRoomRepository<T extends { id: string }> extends JsonDirectoryStore<T> implements RoomRepository<T> {}
