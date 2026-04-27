// 权威设计：docs/phase-sandbox-acp/stage-5/TASK-LIST.md §M2b
// 纯函数：把模板级 allow 和全局规则合并成调用方可直接用的 EffectiveRules。
// 零 IO，不触碰 fs/db/bus。

import type { GlobalRules } from './rule-loader.js';

export type { GlobalRules };

export interface EffectiveRules {
  allow: string[];
  deny: string[];
  /** false = 该 instance 未配置模板白名单（调用方按 default allow 处理） */
  configured: boolean;
}

/**
 * 合并两级白名单 + 全局 deny。
 *
 * 规则：
 * - `templateAllow === null` → `configured=false`（调用方按 default allow）
 * - `templateAllow === []`   → `configured=true`（显式空白名单 = 全部拒绝）
 * - 有效 allow = (templateAllow ?? []) ∪ global.allow，顺序：模板在前、去重
 * - 有效 deny  = global.deny（模板不设 deny，deny 是全局底线）
 *
 * 注意：本函数不做 deny vs allow 的优先级判定 —— 那是 rule-matcher.evaluate 的职责。
 * 本函数只负责"合并出 allow/deny 两张表"。
 */
export function mergeRules(
  templateAllow: string[] | null,
  global: GlobalRules,
): EffectiveRules {
  const configured = templateAllow !== null;
  const allow = dedupe(configured ? [...templateAllow!, ...global.allow] : [...global.allow]);
  const deny = dedupe([...global.deny]);
  return { allow, deny, configured };
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
