import { chromium } from '/Users/zhuqingyu/project/mcp-team-hub/node_modules/.bun/playwright@1.59.1/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/w1-textarea';
mkdirSync(OUT, { recursive: true });
const URL = 'http://127.0.0.1:5193/';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// Textarea card
const card = page.locator('section').filter({ has: page.locator('h3', { hasText: /^Textarea$/ }) }).first();
await card.waitFor({ state: 'visible', timeout: 5000 });
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);

// 在 card 内部找 props panel 的 disabled checkbox
const disabledCb = card.locator('.props-panel input[type="checkbox"]').first();
if ((await disabledCb.count()) === 0) {
  console.log('no checkbox found');
} else {
  await disabledCb.check();
  await page.waitForTimeout(250);
}

// 填点字显示 disabled 效果
const ta = card.locator('textarea.textarea__field');
await ta.evaluate((el, v) => { el.value = v; }, '禁用态示例文本');
await page.waitForTimeout(150);

await card.screenshot({ path: `${OUT}/04-disabled.png` });
console.log('disabled shot saved');

await browser.close();
