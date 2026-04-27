// P4 verify v2 — hard reload then navigate ?expanded=1
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
  const mainPage = targets.find((t) => t.type === 'page' && /localhost:5180\/(?:$|\?)/.test(t.url));
  if (!mainPage) {
    console.log(targets.map((t) => t.url));
    throw new Error('no main page');
  }
  const c = await makeCdp(mainPage.webSocketDebuggerUrl);
  await c.cdp('Runtime.enable');
  await c.cdp('Page.enable');

  // check electronAPI presence
  const api = await c.evalJS(`(() => ({
    hasAPI: !!window.electronAPI,
    hasResize: !!(window.electronAPI && window.electronAPI.resize),
    keys: window.electronAPI ? Object.keys(window.electronAPI) : null,
  }))()`);
  console.log('electronAPI:', api);

  // Navigate with ?expanded=1 then wait
  await c.cdp('Page.navigate', { url: 'http://localhost:5180/?expanded=1' });
  await sleep(2500);

  const state = await c.evalJS(`(() => ({
    expanded: document.querySelector('.card')?.className.includes('expanded'),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    outerW: window.outerWidth,
    outerH: window.outerHeight,
  }))()`);
  console.log('mounted with ?expanded=1:', state);
  await c.screenshot('p4-expanded-param-v2');

  // Navigate back to plain
  await c.cdp('Page.navigate', { url: 'http://localhost:5180/' });
  await sleep(2200);
  const state2 = await c.evalJS(`(() => ({
    expanded: document.querySelector('.card')?.className.includes('expanded'),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
  }))()`);
  console.log('nav back plain:', state2);
  await c.screenshot('p4-plain');

  c.close();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
