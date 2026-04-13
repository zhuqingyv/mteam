import fs from "node:fs";
import path from "node:path";

type MemoryScope = "generic" | "project";
type ExperienceScope = "generic" | "project" | "team";
type SharedType = "experience" | "rules" | "pending_rules";

export interface PendingRule {
  id: string;
  member: string;
  rule: string;
  reason: string;
  proposed_at: string;
}

function memoryFilePath(
  membersDir: string,
  member: string,
  scope: MemoryScope,
  project?: string
): string {
  if (scope === "generic") {
    return path.join(membersDir, member, "memory_generic.md");
  }
  if (!project) throw new Error("project required for scope=project");
  return path.join(membersDir, member, `memory_proj_${project}.md`);
}

function experienceFilePath(
  sharedDir: string,
  scope: Exclude<ExperienceScope, "team">,
  project?: string
): string {
  if (scope === "generic") {
    return path.join(sharedDir, "experience_generic.md");
  }
  if (!project) throw new Error("project required for scope=project");
  return path.join(sharedDir, `experience_proj_${project}.md`);
}

export function saveMemory(
  membersDir: string,
  member: string,
  scope: MemoryScope,
  content: string,
  project?: string
): void {
  const filePath = memoryFilePath(membersDir, member, scope, project);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, content + "\n", "utf-8");
}

export function readMemory(
  membersDir: string,
  member: string,
  scope?: MemoryScope,
  project?: string
): string {
  if (!scope) {
    // 返回所有记忆
    const generic = safeReadFile(memoryFilePath(membersDir, member, "generic"));
    const parts = [generic];
    const memberDir = path.join(membersDir, member);
    if (fs.existsSync(memberDir)) {
      const files = fs.readdirSync(memberDir).filter((f: string) => f.startsWith("memory_proj_"));
      for (const f of files) {
        parts.push(safeReadFile(path.join(memberDir, f)));
      }
    }
    return parts.filter(Boolean).join("\n\n---\n\n");
  }
  return safeReadFile(memoryFilePath(membersDir, member, scope, project));
}

export interface SubmitResult {
  saved: boolean;
  similar_lines: string[];
}

export function submitExperience(
  membersDir: string,
  sharedDir: string,
  member: string,
  scope: ExperienceScope,
  content: string,
  project?: string,
  prefixLen = 30
): SubmitResult {
  fs.mkdirSync(sharedDir, { recursive: true });
  if (scope === "team") {
    const pendingPath = path.join(sharedDir, "pending_rules.json");
    const pending = readPendingRules(sharedDir);
    const newRule: PendingRule = {
      id: `rule_${Date.now()}`,
      member,
      rule: content,
      reason: "",
      proposed_at: new Date().toISOString(),
    };
    pending.push(newRule);
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf-8");
    return { saved: true, similar_lines: [] };
  }

  const filePath = experienceFilePath(sharedDir, scope, project);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // 相似度检查：用内容前 N 个字符做子串匹配，Set 去重
  const prefix = content.slice(0, prefixLen).toLowerCase();
  const seen = new Set<string>();
  const similar_lines: string[] = [];
  const existing = safeReadFile(filePath);
  if (existing && prefix.length >= 5) {
    for (const line of existing.split("\n")) {
      if (line.toLowerCase().includes(prefix)) {
        const trimmed = line.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          similar_lines.push(trimmed);
        }
      }
    }
  }

  // 不管有没有相似，都写入（由调用方在返回值里告知用户）
  const header = `\n## [${member}] ${new Date().toISOString()}\n`;
  fs.appendFileSync(filePath, header + content + "\n", "utf-8");
  return { saved: true, similar_lines };
}

export function readShared(
  sharedDir: string,
  type: SharedType,
  scope?: Exclude<ExperienceScope, "team">,
  project?: string
): string {
  if (type === "pending_rules") {
    return JSON.stringify(readPendingRules(sharedDir), null, 2);
  }
  if (type === "rules") {
    return safeReadFile(path.join(sharedDir, "rules.md"));
  }
  // experience
  if (!scope) {
    const generic = safeReadFile(path.join(sharedDir, "experience_generic.md"));
    if (project) {
      const proj = safeReadFile(path.join(sharedDir, `experience_proj_${project}.md`));
      return [generic, proj].filter(Boolean).join("\n\n---\n\n");
    }
    return generic;
  }
  return safeReadFile(experienceFilePath(sharedDir, scope, project));
}

export interface SearchHit {
  line: string;
  source: string; // 来源文件名（不含目录）
}

export function searchExperience(
  sharedDir: string,
  keyword: string,
  scope?: Exclude<ExperienceScope, "team">
): SearchHit[] {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const files: string[] = [];

  if (!scope || scope === "generic") {
    files.push(path.join(sharedDir, "experience_generic.md"));
  }
  if (scope === "project" || !scope) {
    if (fs.existsSync(sharedDir)) {
      const all = fs.readdirSync(sharedDir).filter((f: string) => f.startsWith("experience_proj_"));
      files.push(...all.map((f: string) => path.join(sharedDir, f)));
    }
  }

  const lowerKw = keyword.toLowerCase();
  for (const filePath of files) {
    const content = safeReadFile(filePath);
    if (!content) continue;
    const source = path.basename(filePath);
    for (const line of content.split("\n")) {
      if (line.toLowerCase().includes(lowerKw)) {
        const trimmed = line.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        hits.push({ line: trimmed, source });
      }
    }
  }
  return hits;
}

export function readPendingRules(sharedDir: string): PendingRule[] {
  const filePath = path.join(sharedDir, "pending_rules.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PendingRule[];
  } catch {
    return [];
  }
}

export function writePendingRules(sharedDir: string, rules: PendingRule[]): void {
  const filePath = path.join(sharedDir, "pending_rules.json");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(rules, null, 2), "utf-8");
}

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
