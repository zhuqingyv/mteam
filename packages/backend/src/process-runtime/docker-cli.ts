// DockerRuntime 辅助：容器名生成 + docker CLI 可执行性预检。
// 拆出来是为了让 docker-runtime.ts 主体 <200 行（团队红线）。
import { randomBytes } from 'node:crypto';
import { accessSync, constants as FS } from 'node:fs';
import { delimiter as PATH_DELIM, isAbsolute, join } from 'node:path';

// 容器名：mteam-<instanceIdSlug>-<random6>，避免并发 spawn 冲突与 --rm 清理前撞名。
// instanceId 可能含 : 等 docker 不接受的字符，这里做保守过滤。
export function containerName(instanceId: string): string {
  const slug = instanceId.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 32) || 'anon';
  const rand = randomBytes(3).toString('hex');
  return `mteam-${slug}-${rand}`;
}

// 同步探测 docker CLI 是否可执行。
// Bun 在 ENOENT 下 spawn() 会直接把 SystemError 抛出 try/catch 外，所以必须事先同步检测。
export function isExecutableOnPath(bin: string): boolean {
  try {
    if (isAbsolute(bin) || bin.includes('/')) {
      accessSync(bin, FS.X_OK);
      return true;
    }
    const pathEnv = process.env.PATH ?? '';
    for (const dir of pathEnv.split(PATH_DELIM)) {
      if (!dir) continue;
      try {
        accessSync(join(dir, bin), FS.X_OK);
        return true;
      } catch { /* try next */ }
    }
    return false;
  } catch {
    return false;
  }
}
