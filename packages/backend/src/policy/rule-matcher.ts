// policy/rule-matcher —— 规则字符串匹配纯函数。
// 规则形态：精确（`Bash`）或末位通配（`mcp__mteam__*`，仅前缀）。
// 大小写敏感；通配符仅允许出现在末位，中间的 `*` 不做特殊处理。

export interface PolicyDecision {
  verdict: 'allow' | 'deny' | 'no_match';
  matchedPattern: string | null;
}

export function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  // 末位 `*` 视为前缀通配；其余情况一律字符串相等（含中间带 `*` 的非法输入）。
  if (pattern.length > 0 && pattern[pattern.length - 1] === '*') {
    const prefix = pattern.slice(0, -1);
    // 前缀内部若再出现 `*`，不识别为通配，退化为精确匹配。
    if (prefix.indexOf('*') !== -1) return pattern === toolName;
    return toolName.startsWith(prefix);
  }
  return pattern === toolName;
}

function firstHit(toolName: string, rules: string[]): string | null {
  for (const r of rules) {
    if (matchPattern(r, toolName)) return r;
  }
  return null;
}

export function evaluate(
  toolName: string,
  rules: { allow: string[]; deny: string[] },
): PolicyDecision {
  const denied = firstHit(toolName, rules.deny);
  if (denied !== null) {
    return { verdict: 'deny', matchedPattern: denied };
  }
  const allowed = firstHit(toolName, rules.allow);
  if (allowed !== null) {
    return { verdict: 'allow', matchedPattern: allowed };
  }
  return { verdict: 'no_match', matchedPattern: null };
}
