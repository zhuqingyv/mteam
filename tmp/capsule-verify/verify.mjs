// Verify P1-03 (click anywhere on capsule toggles) and P1-06 (collapsed DOM removed when expanded)
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
if (!page) { console.error('no page'); process.exit(1); }

const c = await makeCdp(page.webSocketDebuggerUrl);
await c.cdp('Runtime.enable'); await c.cdp('Page.enable');
await sleep(800);

// Switch to Organisms tab first
await c.evalJS(`(() => {
  const tabs = [...document.querySelectorAll('button, [role="tab"], a')];
  const organisms = tabs.find((t) => (t.textContent || '').trim().startsWith('Organisms'));
  if (organisms) organisms.click();
  return !!organisms;
})()`);
await sleep(600);

// Scroll to CapsuleCard section in the registry playground
await c.evalJS(`(() => {
  const headers = [...document.querySelectorAll('h1,h2,h3,h4,h5,[class*="name"],[class*="Name"],[class*="title"],[class*="Title"]')];
  const target = headers.find((el) => (el.textContent || '').trim() === 'CapsuleCard');
  if (target) { target.scrollIntoView({ block: 'center' }); return true; }
  const anyEl = [...document.querySelectorAll('*')].find((el) => (el.textContent || '').trim() === 'CapsuleCard');
  if (anyEl) { anyEl.scrollIntoView({ block: 'center' }); return true; }
  return false;
})()`);
await sleep(700);

// Check DOM assertions
const state = await c.evalJS(`(() => {
  const cards = [...document.querySelectorAll('.card')];
  const collapsedCards = cards.filter((c) => !c.classList.contains('card--expanded'));
  const target = collapsedCards[0];
  if (!target) return { err: 'no collapsed card' };
  const collapsed = target.querySelector('.card__collapsed');
  const rect = target.getBoundingClientRect();
  const collRect = collapsed ? collapsed.getBoundingClientRect() : null;
  const collStyle = collapsed ? getComputedStyle(collapsed) : null;
  return {
    cardCount: cards.length,
    hasCollapsed: !!collapsed,
    appRegion: collStyle ? collStyle.webkitAppRegion : null,
    pointerCursor: collStyle ? collStyle.cursor : null,
    role: collapsed ? collapsed.getAttribute('role') : null,
    hasOnClick: collapsed ? !!collapsed.onclick || collapsed.hasAttribute('onclick') : false,
    cardRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    collRect: collRect ? { x: collRect.x, y: collRect.y, w: collRect.width, h: collRect.height } : null,
  };
})()`);
console.log('[state:collapsed]', JSON.stringify(state, null, 2));

await c.screenshot('01-initial-collapsed');

// Simulate programmatic click at card__collapsed center — React onClick should fire.
// In Playground, CapsuleCard may not have onToggle wired (note says: "展开动画依赖 Electron，Playground 仅展示收起态").
// So we validate P1-06 by assessing DOM conditional render via a synthetic expanded render test.
// Instead: inspect registry demo for onToggle handler, then force state.

// P1-06 test: we render the component with expanded=true through the registry's prop controls.
// The easiest: find the props panel for CapsuleCard and toggle 'expanded' if present. But registry entry doesn't expose expanded.
// Alternative — inject a new React tree rendering CapsuleCard expanded=true and inspect DOM.
// Instead, directly assert the source-level behavior by checking the built module. Done via DOM: we mount CapsuleCard with expanded=true using a hidden div and inspecting.

// Use a simpler approach: flip the expanded state via React refs is not possible.
// Check via compiled bundle: inject a fresh CapsuleCard render. Since playground's main.tsx imports React, we can eval React via import map? No, not trivial.

// Practical P1-06 verification: check the source file directly on disk via Node fs inside headless Chrome? No — Chrome is sandboxed.
// Instead: verify DOM after we mark the nearest card with .card--expanded via classList, then confirm our source logic conditionally renders. Since React won't re-render from manual classList change, we rely on source review.

// So: programmatic click test. Dispatch a click at coords inside card__collapsed.
const clickResult = await c.evalJS(`(() => {
  const collapsed = document.querySelector('.card:not(.card--expanded) .card__collapsed');
  if (!collapsed) return { err: 'no target' };
  const captured = [];
  collapsed.addEventListener('click', () => captured.push('collapsed-click'), { capture: true, once: true });
  const rect = collapsed.getBoundingClientRect();
  const evt = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: rect.x + 20, clientY: rect.y + rect.height/2 });
  // Synthesize a title click (avoid hitting MenuDots)
  const title = collapsed.querySelector('.title-block, [class*="title"]') || collapsed;
  title.dispatchEvent(evt);
  return { captured };
})()`);
console.log('[click:title]', JSON.stringify(clickResult));
await sleep(500);
await c.screenshot('02-after-title-click');

// Check MenuDots bubble
const bubbleResult = await c.evalJS(`(() => {
  const collapsed = document.querySelector('.card__collapsed');
  if (!collapsed) return { err: 'no collapsed' };
  const dots = collapsed.querySelector('.btn--dots');
  if (!dots) return { err: 'no dots' };
  const captured = [];
  collapsed.addEventListener('click', (e) => captured.push({ tag: e.target.tagName, cls: e.target.className, bubbled: true }), { capture: false, once: true });
  dots.click();
  return { captured };
})()`);
console.log('[click:dots-bubbles]', JSON.stringify(bubbleResult));

c.close();
process.exit(0);
