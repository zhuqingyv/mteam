// Phase 1 verify round 4: proper MenuDots click to expand + React native input setter
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/phase1-e2e';
mkdirSync(OUT, { recursive: true });

const results = [];
function record(id, title, pass, detail, shot) {
  results.push({ id, title, pass: pass ? 'PASS' : 'FAIL', detail, shot });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${title} :: ${detail}${shot ? ` shot=${shot}` : ''}`);
}

const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const target = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws err')); });

let mid = 0;
const pending = new Map();
const wsFrames = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } return; }
  if (m.method === 'Network.webSocketFrameReceived') wsFrames.push({ dir: 'in', t: Date.now(), d: m.params.response.payloadData });
  else if (m.method === 'Network.webSocketFrameSent') wsFrames.push({ dir: 'out', t: Date.now(), d: m.params.response.payloadData });
};
function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++mid; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Page.enable');
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

await sleep(500);

// ===== Check 1 =====
const initSnap = await evalJS(`(() => ({
  url: location.href,
  hasLogo: !!document.querySelector('img[src*="logo"]'),
  logoFilter: (() => { const l = document.querySelector('img[src*="logo"]'); return l ? getComputedStyle(l).filter : null; })(),
  hasDotsBtn: !!document.querySelector('button.btn--dots'),
  hasCloseBtn: !!document.querySelector('button.card__close'),
  expanded: !!document.querySelector('.card--expanded'),
  collapsed: !!document.querySelector('.card__collapsed'),
}))()`);
console.log('INIT:', JSON.stringify(initSnap, null, 2));
const shot1 = await screenshot('R4-00-initial');

const pa = await evalJS(`fetch('http://localhost:58590/api/panel/primary-agent').then(r => r.json())`);
const gray = /grayscale\([^0]|saturate\(0/.test(initSnap.logoFilter || '');
record('1', '进程就绪展示 (Logo 亮 + status=RUNNING + cliType)',
  initSnap.hasLogo && !gray && pa?.status === 'RUNNING' && pa?.cliType === 'claude',
  `logoFilter=${initSnap.logoFilter} gray=${gray} status=${pa?.status} cliType=${pa?.cliType}`,
  shot1);
record('6', '生命周期初始化 (snapshot driven logo + backend RUNNING)',
  !gray && pa?.status === 'RUNNING', `logo lit, backend running`);

// ===== Expand via MenuDots =====
const dotsClick = await evalJS(`(() => {
  const btn = document.querySelector('button.btn--dots');
  if (!btn) return { ok: false };
  btn.click();
  return { ok: true };
})()`);
console.log('dots click:', dotsClick);
await sleep(900); // expand animation + mount ExpandedView

const expandState = await evalJS(`(() => ({
  expanded: !!document.querySelector('.card--expanded'),
  hasTA: !!document.querySelector('textarea'),
  hasChat: !!document.querySelector('.chat-panel'),
}))()`);
console.log('after dots:', expandState);
const shot2 = await screenshot('R4-01-expanded');

if (!expandState.hasTA) {
  console.log('still no textarea — probably need to wait/re-toggle');
  await sleep(800);
  const recheck = await evalJS(`({ hasTA: !!document.querySelector('textarea'), expanded: !!document.querySelector('.card--expanded') })`);
  console.log('recheck:', recheck);
}

// ===== Check 2: send message =====
const fill = await evalJS(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { ok: false, reason: 'no textarea' };
  const keys = Object.keys(ta);
  const propsKey = keys.find(k => k.startsWith('__reactProps'));
  if (!propsKey) return { ok: false, reason: 'no react props' };
  const props = ta[propsKey];
  props.onChange({ target: { value: 'reply OK' } });
  return { ok: true };
})()`);
console.log('fill:', fill);
await sleep(250);

const btnState = await evalJS(`(() => {
  const b = document.querySelector('button.chat-input__send');
  return { exists: !!b, disabled: b?.disabled };
})()`);
console.log('send btn:', btnState);

const clickSend = await evalJS(`(() => {
  const b = document.querySelector('button.chat-input__send');
  if (!b || b.disabled) return { ok: false };
  b.click();
  return { ok: true };
})()`);
console.log('clickSend:', clickSend);
await sleep(400);
const shot3 = await screenshot('R4-02-sent');

const bubble = await evalJS(`(() => {
  const bodies = Array.from(document.querySelectorAll('.message-row--user .message-row__body'));
  return { userRows: bodies.length, texts: bodies.map(b => b.textContent?.trim().slice(0,80)) };
})()`);
console.log('user bubble:', bubble);
record('2', '发送用户消息 (user bubble with "reply OK")',
  bubble.texts?.some(t => (t||'').includes('reply OK')),
  `rows=${bubble.userRows} texts=${JSON.stringify(bubble.texts)}`, shot3);

await sleep(300);
const promptOut = wsFrames.filter(f => f.dir === 'out').find(f => /"type":"prompt"/.test(f.d) && /reply OK/.test(f.d));
console.log('WS prompt outbound:', promptOut ? promptOut.d.slice(0, 300) : 'NOT FOUND');

// ===== Check 3: thinking =====
let thinking = false, thinkingShot = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const s = await evalJS(`(() => {
    const dots = document.querySelector('[class*="TypingDots"], [class*="typing-dots"], [class*="Typing"], [class*="Thinking"], [class*="thinking-"]');
    const block = document.querySelector('[class*="block" i][class*="thinking" i]');
    return { hasDots: !!(dots || block), cls: String((dots||block)?.className||'').slice(0,80) };
  })()`);
  if (s.hasDots) { thinking = true; thinkingShot = await screenshot('R4-03-thinking'); console.log('thinking at iter', i, s.cls); break; }
}
record('3', '思考状态 (thinking dots)', thinking, `detected=${thinking}`, thinkingShot);

// ===== Check 4: streaming text =====
const samples = [];
let lastText = '';
let shotStream;
const gotCompleted = () => wsFrames.some(f => f.dir === 'in' && /turn\.completed/.test(f.d));
for (let i = 0; i < 80; i++) {
  await sleep(350);
  const s = await evalJS(`(() => {
    const rows = Array.from(document.querySelectorAll('.message-row--agent .message-row__body'));
    return { texts: rows.map(r => r.textContent?.trim()), count: rows.length };
  })()`);
  const cur = JSON.stringify(s.texts);
  if (cur !== lastText) {
    samples.push({ t: Date.now(), texts: s.texts });
    lastText = cur;
    if (samples.length === 2) shotStream = await screenshot('R4-04-streaming');
  }
  if (gotCompleted() && samples.length >= 1) break;
}
console.log(`stream samples=${samples.length}`, 'last:', samples[samples.length-1]?.texts);
record('4', '流式文本回复 (agent bubble text updates)',
  samples.length >= 2, `samples=${samples.length}`, shotStream);

// ===== Check 5: turn.completed =====
await sleep(1500);
const streamingState = await evalJS(`(() => {
  const s = document.querySelector('[data-streaming="true"], [class*="--streaming"], [class*="__streaming"]');
  return { has: !!s, cls: s ? String(s.className||'').slice(0,80) : null };
})()`);
const wsCompleted = wsFrames.some(f => f.dir === 'in' && /turn\.completed/.test(f.d));
const shot5 = await screenshot('R4-05-completed');
record('5', 'Turn 结束 (WS turn.completed received + streaming cleared)',
  wsCompleted && !streamingState.has,
  `wsCompleted=${wsCompleted} streamingVisible=${streamingState.has}`, shot5);

// ===== Extra: model dropdown — click trigger then option =====
const ddState = await evalJS(`(() => {
  const t = document.querySelector('button.dropdown__trigger');
  return { exists: !!t, text: t?.textContent?.trim() };
})()`);
console.log('dropdown trigger:', ddState);

await evalJS(`(() => {
  const t = document.querySelector('button.dropdown__trigger');
  if (t) t.click();
})()`);
await sleep(400);
const ddOpen = await evalJS(`(() => {
  const menu = document.querySelector('[class*="dropdown__menu"], [class*="dropdown__panel"], [class*="dropdown" i][role="menu"], [role="listbox"]');
  const items = Array.from(document.querySelectorAll('[role="option"], .dropdown__menu button, [class*="dropdown"] button')).filter(b => /claude|codex|gemini|qwen/i.test((b.textContent||'').trim()));
  return { menuExists: !!menu, menuCls: menu ? String(menu.className||'').slice(0,60) : null, items: items.map(i => ({t: (i.textContent||'').trim().slice(0,30), cls: String(i.className||'').slice(0,50)})) };
})()`);
console.log('dropdown open:', JSON.stringify(ddOpen, null, 2));
const shotDd = await screenshot('R4-06-dropdown');

let afterConf = null;
if (ddOpen.items.length > 0) {
  // find codex option (not trigger)
  const clickOpt = await evalJS(`(() => {
    const items = Array.from(document.querySelectorAll('[role="option"], [class*="dropdown" i] button')).filter(b => !b.classList.contains('dropdown__trigger') && /codex/i.test((b.textContent||'').trim()));
    if (items.length === 0) return { ok: false, seen: Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim().slice(0,30)).slice(0,15) };
    items[0].click();
    return { ok: true, text: items[0].textContent?.trim() };
  })()`);
  console.log('click codex:', clickOpt);
  await sleep(1500);
  afterConf = await evalJS(`fetch('http://localhost:58590/api/panel/primary-agent').then(r => r.json())`);
  console.log('after codex:', JSON.stringify(afterConf).slice(0,300));
}
record('extra-model', '模型切换 (codex)',
  afterConf?.cliType === 'codex', `afterCliType=${afterConf?.cliType}`);

// Revert
if (afterConf?.cliType === 'codex') {
  await evalJS(`document.querySelector('button.dropdown__trigger')?.click()`);
  await sleep(300);
  await evalJS(`(() => {
    const items = Array.from(document.querySelectorAll('[role="option"], [class*="dropdown" i] button')).filter(b => !b.classList.contains('dropdown__trigger') && /^claude$/i.test((b.textContent||'').trim()));
    items[0]?.click();
  })()`);
  await sleep(1000);
}

// ===== Extra: Settings panel + no Start/Stop =====
const openSettings = await evalJS(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Settings');
  if (!b) return { ok: false };
  b.click();
  return { ok: true };
})()`);
console.log('open settings:', openSettings);
await sleep(800);
const shotSet = await screenshot('R4-07-settings');
const settingsState = await evalJS(`(() => {
  const body = document.body.innerText;
  const sidebar = document.querySelector('[class*="SettingsPage"], [class*="settings-page"], [class*="Settings"]');
  const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /^(Start|Stop|启动|停止)$/i.test(t));
  // Also check window presence by looking for signage
  const hasSettingsMarker = /General|Primary Agent|Leader|CLI/i.test(body);
  return {
    sidebar: !!sidebar, sidebarCls: sidebar ? String(sidebar.className||'').slice(0,80) : null,
    hasSettingsMarker, startStop: buttons, bodyTail: body.slice(-600),
  };
})()`);
console.log('settings state:', JSON.stringify(settingsState, null, 2));

record('extra-settings-open', '设置面板能打开',
  settingsState.sidebar || settingsState.hasSettingsMarker,
  `sidebar=${settingsState.sidebar} marker=${settingsState.hasSettingsMarker}`, shotSet);
record('extra-settings-no-startstop', 'SettingsPage 没有 Start/Stop 按钮',
  settingsState.startStop.length === 0, `startStop=${JSON.stringify(settingsState.startStop)}`);

// ===== Done =====
writeFileSync(`${OUT}/R4-wsframes.json`, JSON.stringify(wsFrames.map(f => ({dir: f.dir, head: f.d.slice(0, 300)})), null, 2));
writeFileSync(`${OUT}/R4-results.json`, JSON.stringify({ results, pa, afterConf, settingsState, samples, wsFrames: wsFrames.length }, null, 2));

console.log('\n===== WS FRAMES (last 30) =====');
for (const f of wsFrames.slice(-30)) console.log(`  ${f.dir}: ${f.d.slice(0, 200)}`);

console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.pass} ${r.id} — ${r.title}`);

ws.close();
process.exit(0);
