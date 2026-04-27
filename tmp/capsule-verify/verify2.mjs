import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/capsule-verify';
mkdirSync(OUT, { recursive: true });

function makeCdp(wsUrl) {
  return new Promise(async (resolve) => {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, rej) => { ws.onopen = r; ws.onerror = () => rej(new Error('ws err')); });
    let mid = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } return; }
    };
    function cdp(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++mid; pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evalJS(expr, awaitPromise = true) {
      const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval err: ' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    }
    async function screenshot(name) {
      const r = await cdp('Page.captureScreenshot', { format: 'png' });
      const path = `${OUT}/${name}.png`;
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return path;
    }
    resolve({ cdp, evalJS, screenshot, close: () => ws.close() });
  });
}

const list = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json());
const page = list.find((t) => t.type === 'page');
const c = await makeCdp(page.webSocketDebuggerUrl);
await c.cdp('Runtime.enable'); await c.cdp('Page.enable');

// Force reload to pick up registry change
await c.cdp('Page.reload', { ignoreCache: true });
await sleep(1800);

// Switch to Organisms tab
await c.evalJS(`(() => {
  const tabs = [...document.querySelectorAll('button, [role="tab"], a')];
  const organisms = tabs.find((t) => (t.textContent || '').trim().startsWith('Organisms'));
  if (organisms) organisms.click();
  return !!organisms;
})()`);
await sleep(700);

await c.evalJS(`(() => {
  const anyEl = [...document.querySelectorAll('*')].find((el) => (el.textContent || '').trim() === 'CapsuleCard');
  if (anyEl) { anyEl.scrollIntoView({ block: 'center' }); return true; }
  return false;
})()`);
await sleep(500);

// State 1: initial (expanded=false)
const s1 = await c.evalJS(`(() => {
  const card = document.querySelector('.card');
  return {
    hasExpanded: card ? card.classList.contains('card--expanded') : null,
    hasCollapsedInDOM: !!document.querySelector('.card__collapsed'),
    collapsedAppRegion: (() => { const c = document.querySelector('.card__collapsed'); return c ? getComputedStyle(c).webkitAppRegion : null; })(),
    collapsedCursor: (() => { const c = document.querySelector('.card__collapsed'); return c ? getComputedStyle(c).cursor : null; })(),
    collapsedRole: (() => { const c = document.querySelector('.card__collapsed'); return c ? c.getAttribute('role') : null; })(),
  };
})()`);
console.log('[S1 collapsed]', JSON.stringify(s1, null, 2));
await c.screenshot('03-collapsed');

// Toggle via title click
await c.evalJS(`(() => {
  const title = document.querySelector('.card__collapsed .title-block, .card__collapsed');
  title.click();
  return true;
})()`);
await sleep(400);
const s2 = await c.evalJS(`(() => {
  const card = document.querySelector('.card');
  return {
    hasExpanded: card ? card.classList.contains('card--expanded') : null,
    hasCollapsedInDOM: !!document.querySelector('.card__collapsed'),
  };
})()`);
console.log('[S2 after-click]', JSON.stringify(s2, null, 2));
await c.screenshot('04-expanded');

// Toggle back via close button
await c.evalJS(`(() => {
  const close = document.querySelector('.card__close .btn');
  if (close) close.click();
  return !!close;
})()`);
await sleep(400);
const s3 = await c.evalJS(`(() => {
  const card = document.querySelector('.card');
  return {
    hasExpanded: card ? card.classList.contains('card--expanded') : null,
    hasCollapsedInDOM: !!document.querySelector('.card__collapsed'),
  };
})()`);
console.log('[S3 after-close]', JSON.stringify(s3, null, 2));
await c.screenshot('05-collapsed-again');

c.close();
process.exit(0);
