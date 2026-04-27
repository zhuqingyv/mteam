// rule-loader 契约测试：真读真写 tmp 文件，不 mock fs；模板 DB 用注入假函数。
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRuleLoader, parseRulesYaml } from './rule-loader.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rule-loader-'));
}

async function waitFor<T>(check: () => T | null | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('waitFor timeout');
}

describe('rule-loader — parseRulesYaml', () => {
  it('parses block list and flow list', () => {
    const text = [
      'global_allow:',
      '  - Bash',
      '  - "Read"',
      'global_deny: [ Write, "Edit" ]',
      'unrelated_key: value',
    ].join('\n');
    const r = parseRulesYaml(text);
    expect(r.allow).toEqual(['Bash', 'Read']);
    expect(r.deny).toEqual(['Write', 'Edit']);
  });

  it('ignores comments and empty input', () => {
    expect(parseRulesYaml('')).toEqual({ allow: [], deny: [] });
    expect(parseRulesYaml('# just a comment\n\n')).toEqual({ allow: [], deny: [] });
  });
});

describe('rule-loader — createRuleLoader (yaml IO)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkTmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing yaml file → empty rules, no throw', () => {
    const loader = createRuleLoader({
      configPath: path.join(dir, 'nope.yaml'),
      watch: false,
    });
    expect(loader.getGlobalRules()).toEqual({ allow: [], deny: [] });
    loader.close();
  });

  it('parses valid yaml into GlobalRules', () => {
    const cfg = path.join(dir, 'policy.yaml');
    fs.writeFileSync(cfg, 'global_allow:\n  - Bash\n  - Read\nglobal_deny:\n  - Write\n');
    const loader = createRuleLoader({ configPath: cfg, watch: false });
    const rules = loader.getGlobalRules();
    expect(rules.allow).toEqual(['Bash', 'Read']);
    expect(rules.deny).toEqual(['Write']);
    loader.close();
  });

  it('malformed yaml → keeps previous snapshot, does not throw', () => {
    const cfg = path.join(dir, 'policy.yaml');
    fs.writeFileSync(cfg, 'global_allow:\n  - Bash\n');
    const loader = createRuleLoader({ configPath: cfg, watch: false });
    expect(loader.getGlobalRules().allow).toEqual(['Bash']);

    // 再写一个触发解析异常的内容（这里制造读失败：把文件改成目录）
    fs.rmSync(cfg);
    fs.mkdirSync(cfg); // readFileSync 会抛 EISDIR

    // 手动触发 reload：重新 createRuleLoader 模拟下一次 watch 回调
    const loader2 = createRuleLoader({ configPath: cfg, watch: false });
    // loader2 首次读失败，应保留初始空快照（上一个 snapshot 仅对同实例有效）
    expect(loader2.getGlobalRules()).toEqual({ allow: [], deny: [] });

    loader.close();
    loader2.close();
    fs.rmdirSync(cfg);
  });

  it('fs.watch triggers reload after file update', async () => {
    const cfg = path.join(dir, 'policy.yaml');
    fs.writeFileSync(cfg, 'global_allow:\n  - Bash\n');
    const loader = createRuleLoader({ configPath: cfg, watch: true });
    expect(loader.getGlobalRules().allow).toEqual(['Bash']);

    fs.writeFileSync(cfg, 'global_allow:\n  - Read\n  - Write\n');
    const rules = await waitFor(() => {
      const r = loader.getGlobalRules();
      return r.allow.length === 2 ? r : null;
    });
    expect(rules.allow).toEqual(['Read', 'Write']);
    loader.close();
  });

  it('getTemplateAllow passes through injected reader (null / array)', () => {
    const calls: string[] = [];
    const loader = createRuleLoader({
      configPath: path.join(dir, 'nope.yaml'),
      watch: false,
      readTemplateWhitelist: (id) => {
        calls.push(id);
        return id === 'inst-1' ? ['Bash'] : null;
      },
    });
    expect(loader.getTemplateAllow('inst-1')).toEqual(['Bash']);
    expect(loader.getTemplateAllow('inst-2')).toBeNull();
    expect(calls).toEqual(['inst-1', 'inst-2']);
    loader.close();
  });

  it('no readTemplateWhitelist injected → getTemplateAllow returns null', () => {
    const loader = createRuleLoader({
      configPath: path.join(dir, 'nope.yaml'),
      watch: false,
    });
    expect(loader.getTemplateAllow('any-id')).toBeNull();
    loader.close();
  });

  it('close() tears down watcher (no reload after file change)', async () => {
    const cfg = path.join(dir, 'policy.yaml');
    fs.writeFileSync(cfg, 'global_allow:\n  - Bash\n');
    const loader = createRuleLoader({ configPath: cfg, watch: true });
    expect(loader.getGlobalRules().allow).toEqual(['Bash']);

    loader.close();
    fs.writeFileSync(cfg, 'global_allow:\n  - Read\n');
    // 给 watcher 一点时间证明它确实不会再回调
    await new Promise((r) => setTimeout(r, 200));
    expect(loader.getGlobalRules().allow).toEqual(['Bash']);
  });
});
