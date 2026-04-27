// Phase 1 verify round 5 — better prompt to elicit thinking + multi-page
// (connects to Settings page separately)
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/phase1-e2e';
mkdirSync(OUT, { recursive: true });

const results = [];
function record(id, title, pass, detail, shot) {
  results.push({ id, title, pass: pass ? 'PASS' : 'FAIL', detail, shot });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${title} :: ${detail}${shot ? ` shot=${shot}` : ''}`);
}

function makeCdp(wsUrl) {
  return new Promise(async (resolve) => {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, rej) => { ws.onopen = r; ws.onerror = () => rej(new Error('ws err')); });
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
    resolve({ cdp, evalJS, screenshot, wsFrames, close: () => ws.close() });
  });
}

// Connect main renderer
let targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
let main = targets.find((t) => t.type === 'page' && t.url === 'http://localhost:5180/');
console.log('main target:', main?.id);
const mainC = await makeCdp(main.webSocketDebuggerUrl);
await mainC.cdp('Runtime.enable'); await mainC.cdp('Network.enable'); await mainC.cdp('Page.enable');
await sleep(500);

// ===== State =====
const init = await mainC.evalJS(`(() => ({
  hasLogo: !!document.querySelector('img[src*="logo"]'),
  logoFilter: (() => { const l = document.querySelector('img[src*="logo"]'); return l ? getComputedStyle(l).filter : null; })(),
  expanded: !!document.querySelector('.card--expanded'),
  hasTA: !!document.querySelector('textarea'),
  hasDotsBtn: !!document.querySelector('button.btn--dots'),
}))()`);
console.log('init:', init);
const pa = await mainC.evalJS(`fetch('http://localhost:58590/api/panel/primary-agent').then(r => r.json())`);
const gray = /grayscale\([^0]|saturate\(0/.test(init.logoFilter || '');
const shot1 = await mainC.screenshot('R5-00-initial');

record('1', '进程就绪展示 (Logo 亮 + status=RUNNING)',
  init.hasLogo && !gray && pa?.status === 'RUNNING' && pa?.cliType === 'claude',
  `logoFilter=${init.logoFilter} backendStatus=${pa?.status} cliType=${pa?.cliType}`, shot1);
record('6', '生命周期 snapshot 初始化',
  !gray && pa?.status === 'RUNNING', `logo lit via snapshot, backend RUNNING`);

// ===== Expand if needed =====
if (!init.hasTA) {
  await mainC.evalJS(`document.querySelector('button.btn--dots')?.click()`);
  await sleep(1200);
}
await mainC.screenshot('R5-01-expanded');

// ===== Check 2: send message (with longer prompt to induce thinking) =====
// Use a prompt that won't trigger MCP tools but will have some reasoning
const PROMPT = 'please think briefly about the number 7 and reply with a short sentence including the word thinking';
const sendOk = await mainC.evalJS(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { ok: false };
  const propsKey = Object.keys(ta).find(k => k.startsWith('__reactProps'));
  if (!propsKey) return { ok: false, reason: 'no props' };
  ta[propsKey].onChange({ target: { value: ${JSON.stringify(PROMPT)} } });
  return { ok: true };
})()`);
console.log('send fill:', sendOk);
await sleep(250);
await mainC.evalJS(`document.querySelector('button.chat-input__send')?.click()`);
await sleep(400);
const shot2 = await mainC.screenshot('R5-02-sent');

const bubble = await mainC.evalJS(`(() => {
  const b = Array.from(document.querySelectorAll('.message-row--user .message-row__body'));
  return { rows: b.length, texts: b.map(x => x.textContent?.trim().slice(0,100)) };
})()`);
console.log('user bubble:', bubble);
const matched = bubble.texts?.some(t => (t||'').includes('please think briefly'));
record('2', `发送用户消息 (user bubble with prompt)`,
  matched, `rows=${bubble.rows} has=${matched}`, shot2);

// verify WS outbound prompt
await sleep(200);
const outPrompt = mainC.wsFrames.filter(f => f.dir === 'out').find(f => /"op":"prompt"/.test(f.d));
console.log('WS prompt out:', outPrompt ? outPrompt.d.slice(0, 250) : 'NOT FOUND');

// ===== Check 3: thinking dots =====
let thinking = false, thinkingShot = null;
for (let i = 0; i < 60; i++) {
  await sleep(200);
  const s = await mainC.evalJS(`(() => {
    const dots = document.querySelector('.typing-dots');
    return { has: !!dots };
  })()`);
  if (s.has) { thinking = true; thinkingShot = await mainC.screenshot('R5-03-thinking'); console.log('thinking at iter', i); break; }
}
record('3', '思考状态 (thinking dots)', thinking, `detected=${thinking}`, thinkingShot);

// ===== Check 4: streaming text updates =====
// Wait for agent bubble to appear, then track text updates
let samples = [];
let lastText = '';
let shotStream;
const gotCompleted = () => mainC.wsFrames.some(f => f.dir === 'in' && /turn\.completed/.test(f.d));
for (let i = 0; i < 180; i++) {
  await sleep(250);
  const s = await mainC.evalJS(`(() => {
    const rows = Array.from(document.querySelectorAll('.message-row--agent .message-row__body'));
    return { texts: rows.map(r => (r.textContent||'').trim()) };
  })()`);
  const cur = JSON.stringify(s.texts);
  if (cur !== lastText && s.texts.length > 0 && s.texts.some(t => t.length > 0)) {
    samples.push({ t: Date.now(), texts: s.texts });
    lastText = cur;
    if (samples.length === 2) shotStream = await mainC.screenshot('R5-04-streaming');
  }
  if (gotCompleted() && samples.length >= 1) {
    // wait one more cycle for final update
    await sleep(500);
    const fin = await mainC.evalJS(`(() => Array.from(document.querySelectorAll('.message-row--agent .message-row__body')).map(r => (r.textContent||'').trim()))()`);
    if (JSON.stringify(fin) !== lastText) { samples.push({ t: Date.now(), texts: fin }); lastText = JSON.stringify(fin); }
    break;
  }
}
console.log(`stream samples=${samples.length}`, 'first:', samples[0]?.texts, 'last:', samples[samples.length-1]?.texts);
record('4', '流式文本回复 (agent bubble text updates)',
  samples.length >= 2, `samples=${samples.length} firstLen=${(samples[0]?.texts?.[0]||'').length} lastLen=${(samples[samples.length-1]?.texts?.[0]||'').length}`, shotStream);

// ===== Check 5: turn.completed cleared streaming =====
await sleep(1500);
const post = await mainC.evalJS(`(() => {
  const streamingEl = document.querySelector('[data-streaming="true"], [class*="--streaming"], [class*="__streaming"]');
  const dots = document.querySelector('.typing-dots');
  return { streamingVisible: !!streamingEl, dotsVisible: !!dots };
})()`);
const wsCompleted = mainC.wsFrames.some(f => f.dir === 'in' && /turn\.completed/.test(f.d));
console.log('post-turn state:', post, 'wsCompleted:', wsCompleted);
const shot5 = await mainC.screenshot('R5-05-completed');
record('5', 'Turn 结束 (WS turn.completed + streaming cleared)',
  wsCompleted && !post.streamingVisible && !post.dotsVisible,
  `wsCompleted=${wsCompleted} streamingVisible=${post.streamingVisible} dotsVisible=${post.dotsVisible}`, shot5);

// ===== Extra: model dropdown =====
await mainC.evalJS(`document.querySelector('button.dropdown__trigger')?.click()`);
await sleep(400);
const opts = await mainC.evalJS(`(() => Array.from(document.querySelectorAll('.dropdown__option')).map(i => (i.textContent||'').trim()))()`);
console.log('dropdown opts:', opts);
const shotDd = await mainC.screenshot('R5-06-dropdown');

let afterConf = null;
if (opts.some(t => /codex/i.test(t))) {
  await mainC.evalJS(`(() => Array.from(document.querySelectorAll('.dropdown__option')).find(i => /^codex$/i.test((i.textContent||'').trim()))?.click())()`);
  await sleep(1500);
  afterConf = await mainC.evalJS(`fetch('http://localhost:58590/api/panel/primary-agent').then(r => r.json())`);
  console.log('after codex:', JSON.stringify(afterConf).slice(0, 300));
}
record('extra-model', '模型切换 (Dropdown 选 codex → 后端 cliType 变 codex)',
  afterConf?.cliType === 'codex', `afterCliType=${afterConf?.cliType}`);

// revert
if (afterConf?.cliType === 'codex') {
  await mainC.evalJS(`document.querySelector('button.dropdown__trigger')?.click()`);
  await sleep(300);
  await mainC.evalJS(`(() => Array.from(document.querySelectorAll('.dropdown__option')).find(i => /^claude$/i.test((i.textContent||'').trim()))?.click())()`);
  await sleep(1000);
}

// ===== Extra: Open Settings window + verify =====
await mainC.evalJS(`(() => Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Settings')?.click())()`);
await sleep(1500);

// find settings page target
targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const settings = targets.find((t) => t.type === 'page' && t.url.includes('window=settings'));
console.log('settings target:', settings?.id, settings?.url);

let settingsOpen = !!settings;
let settingsHasStartStop = true;
let settingsStateInfo = {};
if (settings) {
  const setC = await makeCdp(settings.webSocketDebuggerUrl);
  await setC.cdp('Runtime.enable'); await setC.cdp('Page.enable');
  await sleep(500);
  const shotSet = await setC.screenshot('R5-07-settings-window');
  settingsStateInfo = await setC.evalJS(`(() => {
    const body = document.body.innerText;
    const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim());
    const startStopButtons = buttons.filter(t => /^(Start|Stop|启动|停止)$/i.test(t));
    return { buttonCount: buttons.length, buttons: buttons.filter(Boolean).slice(0, 25), startStopButtons, bodySlice: body.slice(0, 1500) };
  })()`);
  console.log('settings window state:', JSON.stringify(settingsStateInfo, null, 2));
  settingsHasStartStop = settingsStateInfo.startStopButtons.length > 0;
  setC.close();
  record('extra-settings-open', '设置面板能打开', true, `buttonCount=${settingsStateInfo.buttonCount}`, shotSet);
} else {
  record('extra-settings-open', '设置面板能打开', false, 'no settings target found after click');
}
record('extra-settings-no-startstop', 'SettingsPage 没有 Start/Stop 按钮',
  !settingsHasStartStop, `buttons=${JSON.stringify(settingsStateInfo.startStopButtons || [])}`);

// ===== Done =====
writeFileSync(`${OUT}/R5-wsframes.json`, JSON.stringify(mainC.wsFrames.map(f => ({dir: f.dir, head: f.d.slice(0, 300)})), null, 2));
writeFileSync(`${OUT}/R5-results.json`, JSON.stringify({ results, pa, afterConf, samples, settingsStateInfo }, null, 2));

console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.pass} ${r.id} — ${r.title}`);

mainC.close();
process.exit(0);
