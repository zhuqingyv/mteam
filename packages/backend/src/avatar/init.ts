import { getDb } from '../db/connection.js';

const BUILTIN_COUNT = 20;

// 启动时把 20 个内置头像 INSERT OR IGNORE 进 avatars 表。
// id: avatar-01 ~ avatar-20；filename: avatar-01.png ~ avatar-20.png；builtin=1。
// 幂等：已存在的行不动（保留 hidden 状态）。
export function ensureBuiltinAvatars(): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO avatars (id, filename, builtin, hidden, created_at) VALUES (?, ?, 1, 0, ?)`,
  );
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (let i = 1; i <= BUILTIN_COUNT; i++) {
      const n = String(i).padStart(2, '0');
      stmt.run(`avatar-${n}`, `avatar-${n}.png`, now);
    }
  });
  tx();
}
