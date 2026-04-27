// SettingsRegistry — 薄封装注册表，零业务耦合。
// getter/setter 由调用方注入，registry 只负责 register / search / read / write。

import type { SettingEntry, SearchResult } from './types.js';
import { scoreEntry } from './search-score.js';

export type Actor = { kind: string; id: string };

export type WriteResult =
  | { ok: true; oldValue: unknown; newValue: unknown }
  | { error: string };

const DEFAULT_LIMIT = 20;

export class SettingsRegistry {
  private entries: Map<string, SettingEntry> = new Map();

  register(entry: SettingEntry): void {
    this.entries.set(entry.key, entry);
  }

  registerAll(entries: SettingEntry[]): void {
    for (const e of entries) this.register(e);
  }

  get(key: string): SettingEntry | null {
    return this.entries.get(key) ?? null;
  }

  list(): SettingEntry[] {
    return Array.from(this.entries.values());
  }

  search(query: string, limit: number = DEFAULT_LIMIT): SearchResult[] {
    const all = this.list();
    const q = query.trim();

    const picked: Array<{ entry: SettingEntry; score: number; idx: number }> =
      [];

    if (q.length === 0) {
      all.forEach((entry, idx) => picked.push({ entry, score: 0, idx }));
    } else {
      all.forEach((entry, idx) => {
        const score = scoreEntry(entry, q);
        if (score > 0) picked.push({ entry, score, idx });
      });
      picked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.idx - b.idx;
      });
    }

    return picked.slice(0, limit).map(({ entry }) => this.toResult(entry));
  }

  read(key: string): { value: unknown } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return { value: this.safeGet(entry) };
  }

  write(key: string, value: unknown, _actor: Actor): WriteResult {
    const entry = this.entries.get(key);
    if (!entry) return { error: 'not_found' };
    if (entry.readonly) return { error: 'readonly' };

    let oldValue: unknown;
    try {
      oldValue = entry.getter();
    } catch (e) {
      return { error: `getter_failed: ${errMsg(e)}` };
    }

    try {
      entry.setter(value);
    } catch (e) {
      return { error: `setter_failed: ${errMsg(e)}` };
    }

    let newValue: unknown;
    try {
      newValue = entry.getter();
    } catch {
      newValue = value;
    }

    return { ok: true, oldValue, newValue };
  }

  private toResult(entry: SettingEntry): SearchResult {
    return {
      key: entry.key,
      label: entry.label,
      description: entry.description,
      category: entry.category,
      schema: entry.schema,
      readonly: entry.readonly,
      currentValue: this.safeGet(entry),
    };
  }

  private safeGet(entry: SettingEntry): unknown {
    try {
      return entry.getter();
    } catch {
      return null;
    }
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export const settingsRegistry = new SettingsRegistry();
