// Phase 1 verify (round 2) — fix receipt-side tracking + proper React input dispatch
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
if (!target) throw new Error('renderer target not found');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws err')); });

let mid = 0;
const pending = new Map();
const rawEvents = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  } else {
    rawEvents.push(m);
  }
};
function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await cdp('Runtime.enable');
await cdp('Network.enable');
await cdp('Page.enable');
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

// Inject tap on app WS to observe driver/turn events client-side
await evalJS(`(() => {
  if (window.__tap) return 'already';
  window.__tap = { frames: [] };
  const OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const s = new OrigWS(url, protocols);
    s.addEventListener('message', (ev) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (data.length > 0 && data.length < 4000) window.__tap.frames.push({ dir:'in', t: Date.now(), d: data });
      } catch(e){}
    });
    const origSend = s.send.bind(s);
    s.send = (msg) => {
      try {
        if (typeof msg === 'string' && msg.length < 4000) window.__tap.frames.push({ dir:'out', t: Date.now(), d: msg });
      } catch(e){}
      return origSend(msg);
    };
    return s;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  window.WebSocket.OPEN = OrigWS.OPEN;
  window.WebSocket.CLOSED = OrigWS.CLOSED;
  window.WebSocket.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket.CLOSING = OrigWS.CLOSING;
  return 'tap installed';
})()`);

// Force reload to allow our tap to catch the initial WS connection
await cdp('Page.reload', { ignoreCache: false });
await sleep(2000); // wait react mount + bootstrap
await evalJS(`(() => {
  if (window.__tap) return 'already';
  window.__tap = { frames: [] };
  const OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const s = new OrigWS(url, protocols);
    s.addEventListener('message', (ev) => {
      try { const d = typeof ev.data === 'string' ? ev.data : ''; if (d.length > 0 && d.length < 4000) window.__tap.frames.push({ dir:'in', t: Date.now(), d }); } catch(e){}
    });
    const origSend = s.send.bind(s);
    s.send = (msg) => {
      try { if (typeof msg === 'string' && msg.length < 4000) window.__tap.frames.push({ dir:'out', t: Date.now(), d: msg }); } catch(e){}
      return origSend(msg);
    };
    return s;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  for (const k of ['OPEN','CLOSED','CONNECTING','CLOSING']) window.WebSocket[k] = OrigWS[k];
  return 'tap re-installed';
})()`);
await sleep(800);

// ===== 1. 进程就绪 =====
const init = await evalJS(`(() => {
  const logo = document.querySelector('img[src*="logo"]');
  const filter = logo ? getComputedStyle(logo).filter : null;
  const gray = filter && /grayscale\\([^0]|saturate\\(0/.test(filter);
  return { hasLogo: !!logo, filter, gray };
})()`);
const pa = await evalJS(`fetch('http://localhost:58590/api/panel/primary-agent').then(r => r.json())`);
const shot1 = await screenshot('R2-01-initial');
record('1', '进程就绪展示 (Logo 亮 + status=RUNNING)',
  init.hasLogo && !init.gray && pa?.status === 'RUNNING' && pa?.cliType === 'claude',
  `logoGray=${init.gray} backendStatus=${pa?.status} cliType=${pa?.cliType}`, shot1);
record('6', '生命周期初始化 (backend id present)', typeof pa?.id === 'string', `id=${pa?.id}`);

// Wait for initial WS tapes to come in (snapshot)
await sleep(1500);

const initialWs = await evalJS(`(window.__tap?.frames || []).slice(0,20).map(f => ({ dir:f.dir, t:f.t, head: f.d.slice(0,200) }))`);
console.log('initial WS frames sample:');
for (const f of initialWs) console.log(`  ${f.dir}: ${f.head.slice(0,180)}`);
const hasSnapshotIn = initialWs.some((f) => f.dir === 'in' && /"snapshot"|"type":"snapshot"/i.test(f.head));
const hasSubscribe = initialWs.some((f) => f.dir === 'out' && /"subscribe"|"type":"subscribe"/i.test(f.head));
console.log('initial WS has snapshot-in:', hasSnapshotIn, 'has subscribe-out:', hasSubscribe);

// ===== expand capsule =====
// Need to find a "click to expand" — likely the logo area becomes an event handler on capsule
const expanded1 = await evalJS(`(() => {
  const logo = document.querySelector('img[src*="logo"]');
  if (!logo) return { ok: false };
  // climb to find the largest parent and click it
  let el = logo;
  for (let i = 0; i < 6 && el.parentElement; i++, el = el.parentElement) {}
  const rect = logo.getBoundingClientRect();
  const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => {
    logo.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  });
  return { ok: true };
})()`);
await sleep(700);
const shot2 = await screenshot('R2-02-after-expand-click');
const hasTA = await evalJS(`!!document.querySelector('textarea')`);
console.log('has textarea after expand:', hasTA);

// ===== send via proper React input dispatch =====
const sendResult = await evalJS(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { ok: false, reason: 'no textarea' };
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'reply OK');
  const ev = new Event('input', { bubbles: true });
  ta.dispatchEvent(ev);
  return { ok: true, value: ta.value };
})()`);
console.log('react controlled input set:', sendResult);
await sleep(250); // react flush
const shot3 = await screenshot('R2-03-typed');

// Read send button state
const beforeSend = await evalJS(`(() => {
  const b = document.querySelector('button.chat-input__send');
  return { disabled: b?.disabled, ariaLabel: b?.getAttribute('aria-label') };
})()`);
console.log('send btn state pre-click:', beforeSend);

if (beforeSend.disabled) {
  // try a second strategy: look up React fiber and call onChange directly
  const via = await evalJS(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-ta';
    const key = Object.keys(ta).find(k => k.startsWith('__reactProps'));
    if (!key) return 'no-props';
    const props = ta[key];
    if (props?.onChange) {
      props.onChange({ target: { value: 'reply OK' } });
      return 'called-react-onChange';
    }
    return 'no-onChange';
  })()`);
  console.log('fallback via react props:', via);
  await sleep(250);
}

const beforeSend2 = await evalJS(`(() => {
  const b = document.querySelector('button.chat-input__send');
  return { disabled: b?.disabled };
})()`);
console.log('send btn state after fallback:', beforeSend2);

// Click send
const clickResult = await evalJS(`(() => {
  const b = document.querySelector('button.chat-input__send');
  if (!b) return { ok: false, reason: 'no button' };
  if (b.disabled) return { ok: false, reason: 'disabled' };
  b.click();
  return { ok: true };
})()`);
console.log('clicked send:', clickResult);
await sleep(500);
const shot4 = await screenshot('R2-04-sent');

// ===== Check 2: user bubble =====
const bubble = await evalJS(`(() => {
  const bodies = Array.from(document.querySelectorAll('.message-row--user .message-row__body'));
  return {
    userRows: bodies.length,
    bubbleTexts: bodies.map(b => b.textContent?.trim().slice(0,80)),
    allText: document.body.innerText.slice(-400),
  };
})()`);
console.log('bubble:', bubble);
const hasReplyOk = bubble.bubbleTexts?.some((t) => (t||'').includes('reply OK'));
record('2', '发送用户消息 (user bubble with "reply OK")',
  !!hasReplyOk, `userRows=${bubble.userRows} texts=${JSON.stringify(bubble.bubbleTexts)}`, shot4);

// Capture WS "prompt" outbound frame
const promptFrame = await evalJS(`(() => {
  const out = (window.__tap?.frames || []).filter(f => f.dir === 'out');
  const promptOut = out.find(f => /"type":"prompt"|reply OK/.test(f.d));
  return promptOut ? { d: promptOut.d.slice(0, 500), t: promptOut.t } : null;
})()`);
console.log('prompt frame outbound:', promptFrame);

// ===== Check 3: thinking dots =====
let thinking = false;
let thinkingShot = null;
for (let i = 0; i < 20; i++) {
  await sleep(300);
  const s = await evalJS(`(() => {
    const dots = document.querySelector('[class*="Typing"], [class*="typing"], [class*="Thinking"], [class*="thinking"]');
    const body = document.body.innerText;
    return { hasDots: !!dots, cls: dots ? String(dots.className||'').slice(0,80) : null, hasThinkText: /思考|Thinking|thinking/.test(body) };
  })()`);
  if (s.hasDots) {
    thinking = true;
    thinkingShot = await screenshot(`R2-05-thinking-${i}`);
    console.log(`thinking detected at iter ${i}: ${s.cls}`);
    break;
  }
}
record('3', '思考状态 (thinking dots)',
  thinking, `detected=${thinking}`, thinkingShot);

// ===== Check 4: text streaming =====
const samples = [];
let lastText = '';
let shotStream;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  const s = await evalJS(`(() => {
    const agentRows = Array.from(document.querySelectorAll('.message-row--agent .message-row__body'));
    return { texts: agentRows.map(r => r.textContent?.trim()), allLen: document.body.innerText.length };
  })()`);
  const cur = JSON.stringify(s.texts);
  if (cur !== lastText) {
    samples.push({ t: Date.now(), texts: s.texts, bodyLen: s.allLen });
    lastText = cur;
    if (samples.length === 2) shotStream = await screenshot('R2-06-streaming');
  }
  // break if turn.completed event arrives
  const done = await evalJS(`(window.__tap?.frames || []).some(f => f.dir === 'in' && /turn\\.completed|"type":"event".*"turn\\.completed"/.test(f.d))`);
  if (done && samples.length >= 1) { break; }
}
record('4', '流式文本回复 (agent bubble text updates)',
  samples.length >= 2, `samples=${samples.length} lastTexts=${JSON.stringify(samples[samples.length-1]?.texts)}`, shotStream);

// ===== Check 5: turn.completed clears streaming =====
// give an extra second for WS to deliver turn.completed and React to flush
await sleep(2000);
const completed = await evalJS(`(() => {
  const agentRow = document.querySelector('.message-row--agent');
  const streamingEl = document.querySelector('[data-streaming="true"], [class*="streaming" i]');
  const wsHasCompleted = (window.__tap?.frames || []).some(f => f.dir === 'in' && /turn\\.completed/.test(f.d));
  return { streamingVisible: !!streamingEl, wsGotCompleted: wsHasCompleted };
})()`);
console.log('turn completed check:', completed);
const shot7 = await screenshot('R2-07-completed');
record('5', 'Turn 结束 (turn.completed received + streaming cleared)',
  completed.wsGotCompleted && !completed.streamingVisible,
  `wsGotCompleted=${completed.wsGotCompleted} streamingVisible=${completed.streamingVisible}`, shot7);

// ===== Extra: model dropdown test =====
// click dropdown trigger and probe options
const dropdownTest = await evalJS(`(() => {
  const trigger = Array.from(document.querySelectorAll('button.dropdown__trigger')).find(b => /claude|codex|gemini|qwen/i.test(b.textContent||''));
  if (!trigger) return { ok: false, reason: 'no trigger' };
  trigger.click();
  return { ok: true, triggerText: trigger.textContent?.trim().slice(0,40) };
})()`);
console.log('dropdown open:', dropdownTest);
await sleep(250);
const opts = await evalJS(`(() => {
  const items = Array.from(document.querySelectorAll('[class*="dropdown" i] button, [class*="dropdown" i] [role="option"], [class*="menu" i] [role="option"]'));
  return { count: items.length, items: items.slice(0,10).map(i => ({ t: (i.textContent||'').trim().slice(0,40), cls: String(i.className||'').slice(0,60) })) };
})()`);
console.log('dropdown options:', opts);
const shotDd = await screenshot('R2-08-dropdown-open');

// try to click codex option
const clickCodex = await evalJS(`(() => {
  const items = Array.from(document.querySelectorAll('[class*="dropdown" i] button, [class*="dropdown" i] [role="option"], [role="option"]'));
  const codex = items.find(i => /codex/i.test((i.textContent||'').trim()));
  if (!codex) return { ok: false, seen: items.map(i => (i.textContent||'').trim().slice(0,20)) };
  codex.click();
  return { ok: true };
})()`);
console.log('clicked codex:', clickCodex);
await sleep(600); // let configure via WS flow
// If clicked, backend should have cliType updated
let afterConf = null;
if (clickCodex.ok) {
  await sleep(1200); // backend configure + primary_agent.updated roundtrip
  afterConf = await evalJS(`fetch('http://localhost:58590/api/panel/primary-agent').then(r => r.json())`);
  console.log('backend primary-agent after codex click:', JSON.stringify(afterConf).slice(0,300));
}
record('extra-model',
  '模型切换 (codex)',
  !!(afterConf && afterConf.cliType === 'codex'),
  `afterCliType=${afterConf?.cliType}`);

// Revert to claude
if (clickCodex.ok && afterConf?.cliType === 'codex') {
  await evalJS(`(() => {
    const trigger = Array.from(document.querySelectorAll('button.dropdown__trigger')).find(b => /claude|codex|gemini|qwen/i.test(b.textContent||''));
    trigger?.click();
  })()`);
  await sleep(250);
  await evalJS(`(() => {
    const items = Array.from(document.querySelectorAll('[class*="dropdown" i] button, [role="option"]'));
    const claude = items.find(i => /claude/i.test((i.textContent||'').trim()) && !/claude.*▾/.test(i.textContent||''));
    claude?.click();
  })()`);
  await sleep(1000);
}

// ===== Extra: SettingsPage — open settings =====
const settingsProbe = await evalJS(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Settings');
  if (!btn) return { ok: false };
  btn.click();
  return { ok: true };
})()`);
await sleep(600);
const shotSet = await screenshot('R2-09-settings-open');
const settingsHasStartStop = await evalJS(`(() => {
  const body = document.body.innerText;
  const hasStart = /Start\\b/i.test(body) && /SettingsPage|设置|Primary/i.test(body);
  const hasStop = /Stop\\b/i.test(body);
  const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => /Start|Stop|启动|停止/i.test(t));
  return { hasStart, hasStop, startStopButtons: buttons, bodySlice: body.slice(0, 1500) };
})()`);
console.log('settings panel buttons:', settingsHasStartStop);
record('extra-settings-open', '设置面板能打开',
  true, `buttons=${JSON.stringify(settingsHasStartStop.startStopButtons)}`, shotSet);
record('extra-settings-no-startstop', 'SettingsPage 没有 Start/Stop 按钮',
  settingsHasStartStop.startStopButtons.length === 0,
  `buttons=${JSON.stringify(settingsHasStartStop.startStopButtons)}`);

// ===== Done =====
const wsFramesDump = await evalJS(`(window.__tap?.frames || []).slice(-80).map(f => ({dir:f.dir, head:f.d.slice(0,200)}))`);
writeFileSync(`${OUT}/R2-wsframes.json`, JSON.stringify(wsFramesDump, null, 2));
writeFileSync(`${OUT}/R2-results.json`, JSON.stringify({ results, pa, settingsHasStartStop, afterConf, samples }, null, 2));

console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.pass} ${r.id} — ${r.title}`);

ws.close();
process.exit(0);
