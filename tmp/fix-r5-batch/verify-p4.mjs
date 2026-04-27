// P4 verify — navigate with ?expanded=1, check window size synced to EXPANDED
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
    console.log('targets:', targets.map((t) => t.url));
    throw new Error('no main page');
  }
  const c = await makeCdp(mainPage.webSocketDebuggerUrl);
  await c.cdp('Runtime.enable');
  await c.cdp('Page.enable');

  // Navigate with ?expanded=1 to force INITIAL_EXPANDED=true
  await c.cdp('Page.navigate', { url: 'http://localhost:5180/?expanded=1' });
  await sleep(2000);

  const state = await c.evalJS(`(() => ({
    expanded: document.querySelector('.card')?.className.includes('expanded'),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
  }))()`);
  console.log('mounted with ?expanded=1:', state);
  await c.screenshot('p4-expanded-param');

  c.close();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
