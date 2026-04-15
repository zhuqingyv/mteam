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

export function launchPanel(hubDir: string): void {
  if (isPanelRunning(hubDir)) return;

  const panelDir = findPanelDir();
  if (!panelDir) {
    process.stderr.write("[panel-launcher] panel directory not found, skipping\n");
    return;
  }

  const electronBin = findElectronBin(panelDir);
  if (!electronBin) {
    process.stderr.write("[panel-launcher] electron binary not found, skipping\n");
    return;
  }

  const mainEntry = path.join(panelDir, "out", "main", "index.js");
  if (!fs.existsSync(mainEntry)) {
    process.stderr.write("[panel-launcher] panel not built (out/main/index.js missing), skipping\n");
    return;
  }

  const child = spawn(electronBin, [mainEntry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MCP_HUB_DIR: hubDir },
    cwd: panelDir,
  });
  child.unref();

  const pidFile = path.join(hubDir, "panel.pid");
  fs.writeFileSync(pidFile, String(child.pid ?? ""), "utf-8");
  process.stderr.write(`[panel-launcher] panel started, pid=${child.pid}\n`);
}

function findPanelDir(): string | null {
  // MCP server 源码在 packages/mcp-server/src/，面板在 packages/panel/
  const candidates = [
    path.resolve(__dirname, "../../panel"),
    path.resolve(process.cwd(), "../panel"),
    path.resolve(process.cwd(), "../../packages/panel"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "out", "main", "index.js"))) return c;
  }
  return null;
}

function findElectronBin(panelDir: string): string | null {
  const candidates = [
    path.join(panelDir, "node_modules", ".bin", "electron"),
    path.resolve(panelDir, "../../node_modules/.bin/electron"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
