import { chromium } from '/Users/zhuqingyu/project/mcp-team-hub/node_modules/.bun/playwright@1.59.1/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/w1-textarea';
mkdirSync(OUT, { recursive: true });

const PORT = process.env.PG_PORT || '5193';
const URL = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();

page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));
page.on('console', (msg) => { if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 找到 Textarea 卡片
const card = page.locator('section', { has: page.locator('h3', { hasText: /^Textarea$/ }) }).first();
await card.waitFor({ state: 'visible', timeout: 5000 });
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(250);

await card.screenshot({ path: `${OUT}/01-default.png` });
console.log('shot 1 default saved');

// 聚焦输入并输入文字
const textarea = card.locator('textarea.textarea__field');
await textarea.click();
await page.waitForTimeout(150);
await card.screenshot({ path: `${OUT}/02-focus.png` });

await textarea.fill('你好，这是一个发光玻璃风格的多行输入框。\n支持 maxLength 字数计数。');
await page.waitForTimeout(150);
await card.screenshot({ path: `${OUT}/03-typed.png` });

// 切 disabled
const disabledLabel = card.locator('label', { hasText: 'disabled' });
if (await disabledLabel.count()) {
  const cb = disabledLabel.locator('input[type="checkbox"]');
  if (await cb.count()) {
    await cb.check();
    await page.waitForTimeout(200);
    await card.screenshot({ path: `${OUT}/04-disabled.png` });
  }
}

await browser.close();
console.log('screenshots saved to', OUT);
