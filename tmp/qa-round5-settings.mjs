import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/D1F57A1A1A3E9AF3BE6F11AEDF21A4E1'.slice(0, 46) + await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json()).then((l) => l.find((t) => /window=settings/.test(t.url)).id));
// simpler: re-fetch
const t = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const s = t.find((x) => /window=settings/.test(x.url));
const sws = new WebSocket(s.webSocketDebuggerUrl);
await new Promise((r) => { sws.onopen = r; });
let id = 0;
const pend = new Map();
sws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id) { const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } } };
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); sws.send(JSON.stringify({ id: i, method, params })); });
await call('Runtime.enable');
await call('Page.enable');
const rr = await call('Runtime.evaluate', { expression: 'document.body.innerHTML.length', returnByValue: true });
console.log('body html length:', rr.result.value);
const h = await call('Runtime.evaluate', { expression: 'JSON.stringify({title: document.title, url: location.href, bodyCls: document.body.className, bodyRect: document.body.getBoundingClientRect(), rootCls: (document.querySelector("#root")||{}).className, rootChildCount: (document.querySelector("#root")||{}).children ? document.querySelector("#root").children.length : 0, allClassNames: Array.from(document.querySelectorAll("*")).slice(0,30).map(e => e.tagName+"."+e.className)})', returnByValue: true });
console.log(h.result.value);

await call('Page.bringToFront');
await sleep(500);
const pic = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/qa5-settings-fresh.png', Buffer.from(pic.data, 'base64'));
console.log('saved fresh settings');
sws.close();
