import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

export function isPanelRunning(hubDir: string): boolean {
  const pidFile = path.join(hubDir, "panel.pid");
  if (!fs.existsSync(pidFile)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function launchPanel(hubDir: string, panelBin?: string): void {
  if (isPanelRunning(hubDir)) return;

  const bin = panelBin ?? findPanelBin();
  if (!bin) {
    process.stderr.write("[panel-launcher] panel binary not found, skipping\n");
    return;
  }

  const child = spawn(bin, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MCP_HUB_DIR: hubDir },
  });
  child.unref();

  const pidFile = path.join(hubDir, "panel.pid");
  fs.writeFileSync(pidFile, String(child.pid ?? ""), "utf-8");
}

function findPanelBin(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "../../packages/panel/dist/panel"),
    path.resolve(process.cwd(), "../panel/dist/panel"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
