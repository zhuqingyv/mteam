// check if direct resize call works
import { setTimeout as sleep } from 'node:timers/promises';

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
    resolve({ cdp, evalJS, close: () => ws.close() });
  });
}

async function main() {
  const targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const mainPage = targets.find((t) => t.type === 'page' && /localhost:5180\/(?:$|\?)/.test(t.url));
  const c = await makeCdp(mainPage.webSocketDebuggerUrl);
  await c.cdp('Runtime.enable');

  const before = await c.evalJS(`({ w: innerWidth, h: innerHeight })`);
  console.log('before:', before);

  // Call resize directly to 640x620
  await c.evalJS(`window.electronAPI.resize(640, 620, 'bottom-right', false)`);
  await sleep(500);
  const after = await c.evalJS(`({ w: innerWidth, h: innerHeight })`);
  console.log('after manual resize(640,620):', after);

  // try no animate
  await c.evalJS(`window.electronAPI.resize(380, 120, 'bottom-right', false)`);
  await sleep(500);
  const back = await c.evalJS(`({ w: innerWidth, h: innerHeight })`);
  console.log('after resize(380,120):', back);

  c.close();
}

main().catch(console.error);
