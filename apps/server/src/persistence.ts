import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PersistenceAdapter<T> {
  load(): T | null;
  save(value: T): void;
}

export class MemoryPersistence<T> implements PersistenceAdapter<T> {
  private value: T | null = null;

  load() {
    return this.value;
  }

  save(value: T) {
    this.value = structuredClone(value);
  }
}

export class JsonFilePersistence<T> implements PersistenceAdapter<T> {
  constructor(private readonly filePath: string) {}

  load(): T | null {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      console.warn(`无法读取牌局数据，将使用空数据：${String(error)}`);
      return null;
    }
  }

  save(value: T) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}
