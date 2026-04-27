// 模糊搜索打分：token 命中 label / key / description / category。返回 0~1。
// 权重：label 3x > key 2.5x > keywords 2x > description 1x > category 0.5x。

import type { SettingEntry } from './types.js';

const MAX_SCORE = 9; // 经验上限：四字段全命中的总权重大致落在 9 以内

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.\-_/\\]+/u)
    .filter((t) => t.length > 0);
}

function hit(haystack: string, token: string): boolean {
  return haystack.toLowerCase().includes(token);
}

export function scoreEntry(entry: SettingEntry, query: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  const label = entry.label;
  const key = entry.key;
  const desc = entry.description;
  const cat = entry.category;
  const kw = (entry.keywords ?? []).join(' ');

  let raw = 0;
  for (const tk of tokens) {
    if (hit(label, tk)) raw += 3;
    if (hit(key, tk)) raw += 2.5;
    if (hit(kw, tk)) raw += 2;
    if (hit(desc, tk)) raw += 1;
    if (hit(cat, tk)) raw += 0.5;
  }

  const norm = raw / (tokens.length * MAX_SCORE);
  return Math.min(norm, 1);
}
