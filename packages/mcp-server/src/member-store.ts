import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type MemberRole = "leader" | "dev" | "qa" | "pm" | "infra" | string;
export type MemberType = "permanent" | "temporary";

export interface MemberProfile {
  uid: string;
  name: string;
  display_name: string;
  role: MemberRole;
  type: MemberType;
  joined_at: string;
  skills?: string[];
  description?: string;
}

export interface WorkLogEntry {
  event: "check_in" | "check_out";
  timestamp: string;
  project: string;
  task?: string;
  note?: string;
}

export function initMemberDir(membersDir: string, name: string): void {
  const dir = path.join(membersDir, name);
  fs.mkdirSync(dir, { recursive: true });
}

export function saveProfile(membersDir: string, profile: MemberProfile): void {
  initMemberDir(membersDir, profile.name);
  const filePath = path.join(membersDir, profile.name, "profile.json");
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
}

export function getProfile(membersDir: string, name: string): MemberProfile | null {
  const filePath = path.join(membersDir, name, "profile.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const profile = JSON.parse(raw) as MemberProfile;
    // 自动迁移：老 profile 没有 uid 则生成并回写
    if (!profile.uid) {
      profile.uid = randomUUID();
      fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
    }
    return profile;
  } catch {
    return null;
  }
}

export function listMembers(membersDir: string): MemberProfile[] {
  if (!fs.existsSync(membersDir)) return [];
  const entries = fs.readdirSync(membersDir, { withFileTypes: true });
  const result: MemberProfile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = getProfile(membersDir, entry.name);
    if (profile) result.push(profile);
  }
  return result;
}

export function deleteMember(membersDir: string, name: string): boolean {
  const dir = path.join(membersDir, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function appendWorkLog(
  membersDir: string,
  name: string,
  entry: WorkLogEntry
): void {
  initMemberDir(membersDir, name);
  const logPath = path.join(membersDir, name, "work_log.jsonl");
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

export function readWorkLog(membersDir: string, name: string): WorkLogEntry[] {
  const logPath = path.join(membersDir, name, "work_log.jsonl");
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter((l: string) => l.trim());
  const result: WorkLogEntry[] = [];
  for (const line of lines) {
    try {
      result.push(JSON.parse(line) as WorkLogEntry);
    } catch {
      // 跳过损坏行
    }
  }
  return result;
}
