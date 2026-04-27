// Raw CDP-over-WebSocket verification (no playwright dependency)
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/phase1-e2e';
mkdirSync(OUT, { recursive: true });

const results = [];
function record(id, title, pass, detail, shot) {
  results.push({ id, title, pass: pass ? 'PASS' : 'FAIL', detail, shot });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${title} :: ${detail}${shot ? ` shot=${shot}` : ''}`);
}

// --- grab target (page) ws url ---
const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const target = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180'));
if (!target) throw new Error('renderer page target not found');
console.log('page:', target.title, target.url, target.id);

const ws = new WebSocket(target.webSocketDebuggerUrl);
const opened = new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = (e) => rej(new Error('ws error'));
});
await opened;
console.log('CDP connected');

let mid = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error)));
      else p.res(m.result);
    }
  } else {
    events.push(m);
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

async function evalJS(expression, awaitPromise = true) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function screenshot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const path = `${OUT}/${name}.png`;
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  return path;
}

// ===== Step 0: wait ready =====
await sleep(800);
const pageInfo = await evalJS(`({
  url: location.href,
  title: document.title,
  hasLogo: !!document.querySelector('img[src*="logo"]'),
})`);
console.log('pageInfo', pageInfo);

// ===== Check 1 + 6: 进程就绪展示 + 生命周期 =====
const check1Dom = await evalJS(`(() => {
  const logo = document.querySelector('img[src*="logo"]');
  const filter = logo ? getComputedStyle(logo).filter : null;
  const gray = filter && /grayscale\\([^0]|saturate\\(0/.test(filter);
  return { hasLogo: !!logo, filter, gray };
})()`);
const httpPa = await evalJS(`
  fetch('http://localhost:58590/api/panel/primary-agent')
    .then(r => r.json())
`);
console.log('HTTP primary-agent:', JSON.stringify(httpPa).slice(0, 300));

const shot1 = await screenshot('01-capsule-initial');
record(
  '1',
  '进程就绪展示 (Logo 亮 + status=RUNNING)',
  check1Dom.hasLogo && !check1Dom.gray && httpPa?.status === 'RUNNING' && httpPa?.cliType === 'claude',
  `logoGray=${check1Dom.gray} filter=${check1Dom.filter} backendStatus=${httpPa?.status} cliType=${httpPa?.cliType}`,
  shot1,
);

// Read store state for driverLifecycle — inject debug probe
const storeSnap = await evalJS(`(() => {
  // search for any global store debugging exposure
  const keys = Object.keys(window).filter(k => /store|primary/i.test(k));
  return { keys };
})()`);
console.log('store keys on window:', storeSnap);

record(
  '6',
  '生命周期 snapshot 初始化 (primary_agent.started)',
  httpPa?.status === 'RUNNING' && typeof httpPa?.id === 'string',
  `id=${httpPa?.id}`,
);

// ===== Expand capsule =====
const expandBtn = await evalJS(`(() => {
  // Try various clickable surface selectors: logo image container / capsule / button
  function fireClick(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width/2;
    const cy = rect.top + rect.height/2;
    ['mousedown','mouseup','click'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: cx, clientY: cy })));
    return { rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  }
  const logo = document.querySelector('img[src*="logo"]');
  if (!logo) return { ok: false, reason: 'no logo' };
  // Climb until we find the widest clickable region
  let el = logo;
  let found = null;
  for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
    if (el.onclick || el.getAttribute?.('role') === 'button' || el.tagName === 'BUTTON') {
      found = el;
      break;
    }
  }
  const result = fireClick(found || logo.parentElement || logo);
  return { ok: true, result, foundTag: (found||logo.parentElement||logo).tagName, foundCls: String((found||logo.parentElement||logo).className||'').slice(0,120) };
})()`);
console.log('expand click:', expandBtn);
await sleep(700);

const expandedProbe = await evalJS(`(() => {
  const textarea = document.querySelector('textarea');
  const contentEditable = document.querySelector('[contenteditable="true"]');
  const input = document.querySelector('input[type="text"]');
  const buttons = Array.from(document.querySelectorAll('button')).map(b => ({ t: (b.textContent||'').trim().slice(0,40), cls: String(b.className||'').slice(0,60), aria: b.getAttribute('aria-label') }));
  const allCls = Array.from(document.querySelectorAll('*')).map(e => String(e.className||'')).filter(c => /expanded|chat|message|send|composer/i.test(c)).slice(0,20);
  return { hasTextarea: !!textarea, hasContentEditable: !!contentEditable, hasInput: !!input, buttonsCount: buttons.length, buttons: buttons.slice(0,10), interestingCls: [...new Set(allCls)].slice(0,20) };
})()`);
console.log('expanded:', JSON.stringify(expandedProbe, null, 2));
const shot2 = await screenshot('02-expanded');

// ===== Check 2: send message =====
const sendProbe = await evalJS(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { ok: false, reason: 'no textarea' };
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'reply OK');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true, value: ta.value, inForm: !!ta.closest('form') };
})()`);
console.log('input set:', sendProbe);
await sleep(200);
const shot3 = await screenshot('03-input-typed');

// find and click send button
const clickSend = await evalJS(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const target = buttons.find(b => {
    const t = (b.textContent||'').trim();
    const aria = b.getAttribute('aria-label') || '';
    return /send|发送/i.test(t) || /send|发送/i.test(aria) || /send/i.test(String(b.className||''));
  });
  if (target) {
    target.click();
    return { ok: true, text: target.textContent?.trim(), cls: String(target.className||'').slice(0,60) };
  }
  // fallback: submit textarea via Enter
  const ta = document.querySelector('textarea');
  if (ta) {
    ta.focus();
    const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    ta.dispatchEvent(kd);
    return { ok: true, via: 'keydown-enter' };
  }
  return { ok: false };
})()`);
console.log('click send:', clickSend);
await sleep(500);
const shot4 = await screenshot('04-after-send');

// Check user bubble exists
const bubbleCheck = await evalJS(`(() => {
  const body = document.body.innerText;
  return {
    hasReplyText: body.includes('reply OK'),
    bodySlice: body.slice(0, 2000),
  };
})()`);
console.log('bubble check:', { hasReplyText: bubbleCheck.hasReplyText });
record(
  '2',
  '发送用户消息 (user bubble with "reply OK")',
  bubbleCheck.hasReplyText === true,
  `typed=${sendProbe.value} clickOK=${clickSend.ok} bubbleVisible=${bubbleCheck.hasReplyText}`,
  shot4,
);

// ===== Check 3: 思考状态 — poll 2.5s for thinking indicator =====
let thinking = false;
let thinkingShot = null;
for (let i = 0; i < 8; i++) {
  await sleep(300);
  const s = await evalJS(`(() => {
    const body = document.body.innerText;
    const dots = document.querySelector('[class*="typing" i], [class*="thinking" i], [class*="Typing" i], [class*="Thinking" i]');
    return { hasDots: !!dots, cls: dots ? String(dots.className||'').slice(0,80) : null, hasThinkText: /思考|thinking/i.test(body) };
  })()`);
  if (s.hasDots || s.hasThinkText) {
    thinking = true;
    thinkingShot = await screenshot(`05-thinking-${i}`);
    break;
  }
}
record(
  '3',
  '思考状态 (thinking dots / indicator)',
  thinking,
  `detected=${thinking}`,
  thinkingShot,
);

// ===== Check 4 + 5: 流式 text + turn.completed =====
// Poll up to 30s for text content updates and completion
const textSamples = [];
let turnDone = false;
let lastText = '';
let shot5;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const s = await evalJS(`(() => {
    // find last agent message block
    const all = document.body.innerText;
    return { body: all.slice(-4000), length: all.length };
  })()`);
  if (s.body !== lastText) {
    textSamples.push({ t: Date.now(), len: s.length, tail: s.body.slice(-200) });
    lastText = s.body;
  }
  // turn.completed by observing no change for 4 consecutive polls after some content
  if (textSamples.length > 3 && textSamples[textSamples.length - 1].t < Date.now() - 2500) {
    const streamingEl = await evalJS(`(() => {
      const el = document.querySelector('[class*="streaming" i], [data-streaming="true"]');
      return { hasStreaming: !!el };
    })()`);
    if (!streamingEl.hasStreaming) {
      turnDone = true;
      break;
    }
  }
}
shot5 = await screenshot('06-turn-complete');
record(
  '4',
  '流式文本回复 (text block 逐步更新)',
  textSamples.length >= 2,
  `samples=${textSamples.length} lastLen=${textSamples[textSamples.length-1]?.len}`,
  shot5,
);
record(
  '5',
  'Turn 结束 (streaming state cleared)',
  turnDone,
  `turnDone=${turnDone}`,
);

console.log('\ntext samples:', textSamples.map(s => `len=${s.len}`).join(','));
console.log('last tail:', textSamples[textSamples.length-1]?.tail);

// ===== Check 6: lifecycle — driverLifecycle from backend =====
const driverInfo = await evalJS(`fetch('http://localhost:58590/api/panel/primary-agent').then(r => r.json())`);
console.log('final driver info:', JSON.stringify(driverInfo).slice(0, 300));

// ===== Extra: cliType switch model dropdown =====
const dropdownProbe = await evalJS(`(() => {
  const selects = Array.from(document.querySelectorAll('select'));
  const dropdowns = Array.from(document.querySelectorAll('[role="combobox"], [class*="dropdown" i], [class*="Dropdown" i]'));
  return {
    selectCount: selects.length,
    dropdownCount: dropdowns.length,
    selectInfo: selects.map(s => ({ value: s.value, options: Array.from(s.options).map(o => o.value) })),
    dropdownInfo: dropdowns.slice(0,5).map(d => ({ text: (d.textContent||'').trim().slice(0,40), cls: String(d.className||'').slice(0,60) })),
  };
})()`);
console.log('dropdown probe:', JSON.stringify(dropdownProbe, null, 2));

// ===== Extra: Settings panel check =====
// Not trivially clickable from here — probe DOM for any settings trigger existence
const settingsProbe = await evalJS(`(() => {
  const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const candidates = all.filter(b => /settings|设置|options|preferences/i.test((b.textContent||'')+(b.getAttribute('aria-label')||'')+String(b.className||''))).slice(0,5);
  return { count: candidates.length, info: candidates.map(b => ({ text: (b.textContent||'').trim().slice(0,40), cls: String(b.className||'').slice(0,60) })) };
})()`);
console.log('settings probe:', JSON.stringify(settingsProbe, null, 2));

// ===== DONE =====
writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, textSamples, dropdownProbe, settingsProbe, driverInfo }, null, 2));

console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.pass} ${r.id} — ${r.title}`);
ws.close();
process.exit(0);
