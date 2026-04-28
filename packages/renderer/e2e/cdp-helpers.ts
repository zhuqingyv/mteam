// Electron CDP helpers：假定 Electron dev 已在跑且 CDP 9222 可连。
// 每个 spec 独立，不依赖顺序；通过窗口 URL query 区分 main/team/settings。
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CDP_URL = process.env.MTEAM_CDP_URL ?? 'http://127.0.0.1:9222';
const SCREENSHOT_DIR = resolve(__dirname, 'screenshots');

mkdirSync(SCREENSHOT_DIR, { recursive: true });

export async function connectElectron(): Promise<{
  browser: Browser;
  contexts: BrowserContext[];
}> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error('CDP: no browser context found');
  return { browser, contexts };
}

// 在所有已打开 Page 中找第一条 URL 匹配 predicate 的，轮询到 timeout。
export async function findPageByUrl(
  browser: Browser,
  match: (url: string) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<Page> {
  const timeout = opts.timeoutMs ?? 5_000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (match(p.url())) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`findPageByUrl timeout: no page matched within ${timeout}ms`);
}

// 主窗口（无 window= 参数）。
export async function getMainPage(browser: Browser): Promise<Page> {
  return findPageByUrl(browser, (u) => u.includes('localhost:5180') && !u.includes('window='));
}

export async function getTeamPage(browser: Browser): Promise<Page> {
  return findPageByUrl(browser, (u) => u.includes('window=team'));
}

export async function getSettingsPage(browser: Browser): Promise<Page> {
  return findPageByUrl(browser, (u) => u.includes('window=settings'));
}

// 保存截图到 e2e/screenshots/<name>.png。
export async function screenshot(page: Page, name: string): Promise<string> {
  const p = resolve(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

// 等 renderer 主窗口首次渲染完成（.card 出现）。
export async function waitMainReady(page: Page, timeoutMs = 5_000): Promise<void> {
  await page.locator('.card').first().waitFor({ state: 'visible', timeout: timeoutMs });
}

export { CDP_URL, SCREENSHOT_DIR };
