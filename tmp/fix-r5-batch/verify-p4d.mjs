// Find THE capsule window (innerW=380 or smaller) and test P4
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
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('localhost:5180'));
  console.log('pages:', pages.length);

  // probe each page's window size to find the capsule
  let capsule = null;
  for (const p of pages) {
    const c = await makeCdp(p.webSocketDebuggerUrl);
    await c.cdp('Runtime.enable');
    const info = await c.evalJS(`({ url: location.href, w: innerWidth, h: innerHeight, expanded: !!document.querySelector('.card') })`);
    console.log(' target', p.id.slice(0, 8), info);
    if (info.expanded && info.w <= 700) { // capsule
      capsule = { id: p.id, ws: p.webSocketDebuggerUrl };
    }
    c.close();
  }

  if (!capsule) { console.log('no capsule found'); process.exit(1); }

  console.log('using capsule', capsule.id.slice(0, 8));
  const c = await makeCdp(capsule.ws);
  await c.cdp('Runtime.enable');
  await c.cdp('Page.enable');

  // Reset state: navigate to plain /
  await c.cdp('Page.navigate', { url: 'http://localhost:5180/' });
  await sleep(2200);
  const s1 = await c.evalJS(`({ expanded: document.querySelector('.card')?.className.includes('expanded'), w: innerWidth, h: innerHeight })`);
  console.log('plain /:', s1);

  // navigate with ?expanded=1
  await c.cdp('Page.navigate', { url: 'http://localhost:5180/?expanded=1' });
  await sleep(2500);
  const s2 = await c.evalJS(`({ expanded: document.querySelector('.card')?.className.includes('expanded'), w: innerWidth, h: innerHeight })`);
  console.log('?expanded=1:', s2);
  await c.screenshot('p4-capsule-expanded-mount');

  // navigate back plain /
  await c.cdp('Page.navigate', { url: 'http://localhost:5180/' });
  await sleep(2200);
  const s3 = await c.evalJS(`({ expanded: document.querySelector('.card')?.className.includes('expanded'), w: innerWidth, h: innerHeight })`);
  console.log('plain / again:', s3);
  await c.screenshot('p4-capsule-plain');

  c.close();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
