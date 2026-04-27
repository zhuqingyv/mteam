// fix-r5-batch CDP verification — verify 4 fixes
// P1 CapsuleWindow 无 Tailwind 裸类
// P2 Dropdown 展开间距+阴影
// P3 card__body opacity 过渡 50ms delay 200ms
// P4 reload 后 expanded 态窗口尺寸同步
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/fix-r5-batch';
mkdirSync(OUT, { recursive: true });

function makeCdp(wsUrl) {
  return new Promise(async (resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, rj) => { ws.onopen = r; ws.onerror = () => rj(new Error('ws err')); });
    let mid = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } }
    };
    function cdp(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++mid; pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evalJS(expr, awaitPromise = false) {
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

async function main() {
  const targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const mainPage = targets.find((t) => t.type === 'page' && t.url === 'http://localhost:5180/');
  if (!mainPage) throw new Error('no main page found');
  console.log('target:', mainPage.url);

  const c = await makeCdp(mainPage.webSocketDebuggerUrl);
  await c.cdp('Runtime.enable');
  await c.cdp('Page.enable');

  // Force HMR pickup: reload then wait
  await c.cdp('Page.reload', { ignoreCache: true });
  await sleep(2000);

  // ========== P1 verify: CapsuleWindow has BEM class capsule-window, no w-screen h-screen =========
  const p1 = await c.evalJS(`(() => {
    const cw = document.querySelector('.capsule-window');
    const body = document.body;
    const allEls = Array.from(document.querySelectorAll('*'));
    const twClassRegex = /(?:^|\\s)(w-screen|h-screen|p-5|box-border|overflow-hidden|bg-transparent)(?=$|\\s)/;
    const violators = allEls.filter((el) => typeof el.className === 'string' && twClassRegex.test(el.className)).map((el) => ({ tag: el.tagName, cls: el.className }));
    return {
      hasCapsuleWindow: !!cw,
      cwCls: cw ? cw.className : null,
      cwComputed: cw ? (() => { const s = getComputedStyle(cw); return { width: s.width, height: s.height, padding: s.padding, overflow: s.overflow, background: s.background }; })() : null,
      twViolators: violators,
    };
  })()`);
  console.log('P1:', JSON.stringify(p1, null, 2));
  await c.screenshot('p1-capsule-window');

  // ========== P4 verify: reload 后 expanded state, resize 到展开态 ==========
  // Current: on fresh reload 应为默认 collapsed 态
  const s0 = await c.evalJS(`(() => ({ expanded: document.querySelector('.card')?.className.includes('expanded') }))()`);
  console.log('fresh reload state:', s0);

  // 先展开
  await c.evalJS(`document.querySelector('.btn--dots')?.click()`);
  await sleep(800);
  const exp1 = await c.evalJS(`(() => ({
    expanded: document.querySelector('.card')?.className.includes('expanded'),
    innerW: window.innerWidth, innerH: window.innerHeight
  }))()`);
  console.log('after expand:', exp1);
  await c.screenshot('p4-expanded-before-reload');

  // Reload 窗口 — 保持展开态可能吗? store 可能被 rehydrate
  await c.cdp('Page.reload', { ignoreCache: false });
  await sleep(2200);
  const exp2 = await c.evalJS(`(() => ({
    expanded: document.querySelector('.card')?.className.includes('expanded'),
    innerW: window.innerWidth, innerH: window.innerHeight
  }))()`);
  console.log('after reload:', exp2);
  await c.screenshot('p4-after-reload');

  // ========== P3 verify: card__body transition 50ms delay, 200ms duration ==========
  // Need expanded to check card--expanded .card__body
  const cardExp = await c.evalJS(`(() => ({ expanded: document.querySelector('.card')?.className.includes('expanded') }))()`);
  if (!cardExp.expanded) {
    await c.evalJS(`document.querySelector('.btn--dots')?.click()`);
    await sleep(800);
  }
  const p3 = await c.evalJS(`(() => {
    const body = document.querySelector('.card__body');
    if (!body) return { err: 'no body' };
    const s = getComputedStyle(body);
    return {
      transitionDelay: s.transitionDelay,
      transitionDuration: s.transitionDuration,
      transitionProperty: s.transitionProperty,
      transitionTimingFunction: s.transitionTimingFunction,
      opacity: s.opacity,
    };
  })()`);
  console.log('P3 (expanded body):', JSON.stringify(p3, null, 2));
  await c.screenshot('p3-expanded-body');

  // capture rapid frames after re-collapse & re-expand
  await c.evalJS(`document.querySelector('.card__close button')?.click()`);
  await sleep(500);
  await c.evalJS(`document.querySelector('.btn--dots')?.click()`);
  await sleep(80); // early frame
  await c.screenshot('p3-reexpand-80ms');
  await sleep(100); // ~180ms
  await c.screenshot('p3-reexpand-180ms');
  await sleep(200); // ~380ms
  await c.screenshot('p3-reexpand-380ms');

  // ========== P2 verify: Dropdown 间距 + 阴影 ==========
  // Ensure expanded
  const cardExp2 = await c.evalJS(`(() => ({ expanded: document.querySelector('.card')?.className.includes('expanded') }))()`);
  if (!cardExp2.expanded) {
    await c.evalJS(`document.querySelector('.btn--dots')?.click()`);
    await sleep(800);
  }

  // click dropdown trigger
  const triggerExists = await c.evalJS(`!!document.querySelector('.dropdown__trigger')`);
  console.log('trigger exists:', triggerExists);
  if (triggerExists) {
    await c.evalJS(`document.querySelector('.dropdown__trigger').click()`);
    await sleep(400);
    const p2 = await c.evalJS(`(() => {
      const panel = document.querySelector('.dropdown__panel');
      const trigger = document.querySelector('.dropdown__trigger');
      if (!panel || !trigger) return { err: 'no panel' };
      const p = panel.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();
      const s = getComputedStyle(panel);
      return {
        gap: Math.round(t.y - (p.y + p.height)),
        bottom: s.bottom,
        boxShadow: s.boxShadow,
        zIndex: s.zIndex,
        panelBottom: p.y + p.height,
        triggerTop: t.y,
      };
    })()`);
    console.log('P2:', JSON.stringify(p2, null, 2));
    await c.screenshot('p2-dropdown-open');
    // close it
    await c.evalJS(`document.body.click()`);
    await sleep(200);
  }

  c.close();
  console.log('done');
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
