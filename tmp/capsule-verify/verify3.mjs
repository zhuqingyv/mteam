// Focused screenshot — scroll to CapsuleCard, capture collapsed + expanded states with clipping
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
    async function shotFull(name) {
      const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const p = `${OUT}/${name}.png`;
      writeFileSync(p, Buffer.from(r.data, 'base64'));
      return p;
    }
    async function shotClip(name, clip) {
      const r = await cdp('Page.captureScreenshot', { format: 'png', clip });
      const p = `${OUT}/${name}.png`;
      writeFileSync(p, Buffer.from(r.data, 'base64'));
      return p;
    }
    resolve({ cdp, evalJS, shotFull, shotClip, close: () => ws.close() });
  });
}

const list = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json());
const page = list.find((t) => t.type === 'page');
const c = await makeCdp(page.webSocketDebuggerUrl);
await c.cdp('Runtime.enable'); await c.cdp('Page.enable');
await sleep(600);

// Switch to Organisms tab
await c.evalJS(`(() => {
  const tabs = [...document.querySelectorAll('button, [role="tab"], a')];
  const organisms = tabs.find((t) => (t.textContent || '').trim().startsWith('Organisms'));
  if (organisms) organisms.click();
  return !!organisms;
})()`);
await sleep(700);

// Scroll into view
const rect1 = await c.evalJS(`(() => {
  const anyEl = [...document.querySelectorAll('*')].find((el) => (el.textContent || '').trim() === 'CapsuleCard');
  if (!anyEl) return null;
  anyEl.scrollIntoView({ block: 'center' });
  return null;
})()`);
await sleep(500);

// Get card bounding rect for clip
const card1 = await c.evalJS(`(() => {
  const card = document.querySelector('.card');
  if (!card) return null;
  const r = card.getBoundingClientRect();
  return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: r.width + 40, height: r.height + 40, scale: 1 };
})()`);
console.log('card1', card1);
if (card1) await c.shotClip('06-collapsed-clip', card1);

// Click title area
await c.evalJS(`(() => {
  const title = document.querySelector('.card__collapsed .title-block') || document.querySelector('.card__collapsed');
  title.click();
  return true;
})()`);
await sleep(400);

const s2 = await c.evalJS(`(() => {
  const card = document.querySelector('.card');
  return {
    hasExpanded: card ? card.classList.contains('card--expanded') : null,
    hasCollapsedInDOM: !!document.querySelector('.card__collapsed'),
    bodyVisible: document.querySelector('.card--body-visible') !== null,
    expandedHeadVisible: (() => { const h = document.querySelector('.card__expanded-head'); return h ? getComputedStyle(h).opacity : null; })(),
    closeVisible: (() => { const h = document.querySelector('.card__close'); return h ? getComputedStyle(h).opacity : null; })(),
  };
})()`);
console.log('S2', s2);

const card2 = await c.evalJS(`(() => {
  const card = document.querySelector('.card');
  if (!card) return null;
  const r = card.getBoundingClientRect();
  return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: r.width + 40, height: r.height + 40, scale: 1 };
})()`);
if (card2) await c.shotClip('07-expanded-clip', card2);

c.close();
process.exit(0);
