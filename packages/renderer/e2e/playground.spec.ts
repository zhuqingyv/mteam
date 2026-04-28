// Playground（5190）：Tab 切换 / 组件卡片可见 / 3+ 列布局。
// 用独立 headless chromium 跑，不连 Electron CDP（后者 newContext 受限）。
// 前置：`npm run playground` 已跑；连不上 5190 则整组 skip。
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const PLAYGROUND_URL = process.env.MTEAM_PLAYGROUND_URL ?? 'http://127.0.0.1:5190';

async function isPlaygroundUp(): Promise<boolean> {
  try {
    const res = await fetch(PLAYGROUND_URL, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

test.describe('Playground', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    if (!(await isPlaygroundUp())) test.skip(true, 'Playground 5190 未启动');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(PLAYGROUND_URL, { waitUntil: 'domcontentloaded' });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
  });

  test('页面加载，header 标题出现', async () => {
    await expect(page.locator('.playground__title')).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'playground-header.png') });
  });

  test('Tab 切换：Atoms / Molecules / Organisms / Scenes', async () => {
    const tabs = ['Atoms', 'Molecules', 'Organisms', 'Scenes'];
    for (const label of tabs) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${label}`) });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'playground-tabs.png') });
  });

  test('组件卡片可见（Atoms tab 至少 1 张）', async () => {
    await page.getByRole('tab', { name: /^Atoms/ }).click();
    const cards = page.locator('.playground__grid > *');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('布局 3+ 列（.playground__grid grid-template-columns 列数≥3）', async () => {
    await page.getByRole('tab', { name: /^Atoms/ }).click();
    const grid = page.locator('.playground__grid').first();
    await expect(grid).toBeVisible();
    const cols = await grid.evaluate((el) => {
      const tpl = getComputedStyle(el).gridTemplateColumns;
      return tpl.split(' ').filter(Boolean).length;
    });
    expect(cols).toBeGreaterThanOrEqual(3);
  });
});
