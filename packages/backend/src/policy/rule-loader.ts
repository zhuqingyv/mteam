// M2a · policy/rule-loader — yaml + DB 模板白名单的 IO 层。
// 不做合并判定，合并交给 M2b (rule-merger)。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface GlobalRules {
  allow: string[];
  deny: string[];
}

export interface RuleLoader {
  getGlobalRules(): GlobalRules;
  getTemplateAllow(instanceId: string): string[] | null;
  close(): void;
}

export interface RuleLoaderOptions {
  configPath?: string;
  watch?: boolean;
  readTemplateWhitelist?: (instanceId: string) => string[] | null;
}

const EMPTY_RULES: GlobalRules = { allow: [], deny: [] };

export function createRuleLoader(opts: RuleLoaderOptions = {}): RuleLoader {
  const configPath =
    opts.configPath ?? path.join(os.homedir(), '.claude', 'team-hub', 'policy.yaml');
  const wantWatch = opts.watch ?? true;
  const readTemplateWhitelist = opts.readTemplateWhitelist;

  let snapshot: GlobalRules = EMPTY_RULES;
  let watcher: fs.FSWatcher | null = null;

  const reload = (): void => {
    try {
      snapshot = parseRulesYaml(fs.readFileSync(configPath, 'utf8'));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        snapshot = EMPTY_RULES;
        return;
      }
      console.warn(
        `[rule-loader] failed to load ${configPath}: ${(err as Error).message}; keeping previous snapshot`,
      );
    }
  };

  reload();

  if (wantWatch) {
    try {
      watcher = fs.watch(configPath, { persistent: false }, () => reload());
      watcher.on('error', (err) => console.warn(`[rule-loader] watcher error: ${err.message}`));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[rule-loader] fs.watch failed: ${(err as Error).message}`);
      }
    }
  }

  return {
    getGlobalRules: () => snapshot,
    getTemplateAllow: (instanceId) =>
      readTemplateWhitelist ? readTemplateWhitelist(instanceId) : null,
    close: () => {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

// 极简 yaml：仅识别 `global_allow:` / `global_deny:` 两个顶层键，
// 值为 `- item` 块列表或同行 flow 数组 `[a, b]`。其余键忽略。
export function parseRulesYaml(text: string): GlobalRules {
  const out: GlobalRules = { allow: [], deny: [] };
  let current: 'allow' | 'deny' | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;

    const topLevel = !/^\s|^-/.test(line);
    if (topLevel) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      current = null;
      if (!m) continue;
      const target = m[1] === 'global_allow' ? 'allow' : m[1] === 'global_deny' ? 'deny' : null;
      if (!target) continue;
      const rest = m[2];
      const flow = rest && /^\[(.*)\]$/.exec(rest.trim());
      if (flow) {
        for (const item of flow[1].split(',')) {
          const v = stripQuotes(item.trim());
          if (v) out[target].push(v);
        }
      } else {
        current = target;
      }
      continue;
    }

    if (current && /^\s*-\s+/.test(line)) {
      const v = stripQuotes(line.replace(/^\s*-\s+/, '').trim());
      if (v) out[current].push(v);
    }
  }

  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
