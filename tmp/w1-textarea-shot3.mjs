import { chromium } from '/Users/zhuqingyu/project/mcp-team-hub/node_modules/.bun/playwright@1.59.1/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/w1-textarea';
mkdirSync(OUT, { recursive: true });
const URL = 'http://127.0.0.1:5193/';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 渲染只有 Textarea 一个组件的最小化视图：取 canvas box
const card = page.locator('section').filter({ has: page.locator('h3', { hasText: /^Textarea$/ }) }).first();
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

// 针对 component canvas（右侧的渲染区域）
const canvas = card.locator('.component-card__canvas, .card__canvas, .component-preview, [class*="canvas"], [class*="preview"]').first();
const has = await canvas.count();
console.log('canvas locators found:', has);

// fallback：定位 textarea 根节点
const comp = card.locator('.textarea').first();
await comp.scrollIntoViewIfNeeded();

// 输入文字
const ta = comp.locator('textarea.textarea__field');
await ta.fill('发光玻璃风格\n支持 maxLength 字数计数');
await page.waitForTimeout(200);

const box = await comp.boundingBox();
console.log('component box:', box);
if (box) {
  const pad = 40;
  await page.screenshot({
    path: `${OUT}/05-closeup.png`,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  console.log('closeup saved');
}

// focus + 再次聚焦截一张 focus ring
await ta.click();
await page.waitForTimeout(250);
const box2 = await comp.boundingBox();
if (box2) {
  const pad = 40;
  await page.screenshot({
    path: `${OUT}/06-focus-closeup.png`,
    clip: {
      x: Math.max(0, box2.x - pad),
      y: Math.max(0, box2.y - pad),
      width: box2.width + pad * 2,
      height: box2.height + pad * 2,
    },
  });
  console.log('focus closeup saved');
}

await browser.close();
