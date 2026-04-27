// Round 5 focused — 验证 dropdown 方向 + 胶囊态 badge + Settings 窗口
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/tmp';
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
  const mainPage = targets.find((t) => t.type === 'page' && !/window=/.test(t.url));
  const c = await makeCdp(mainPage.webSocketDebuggerUrl);
  await c.cdp('Runtime.enable');
  await c.cdp('Page.enable');

  // Ensure expanded state
  const st = await c.evalJS(`(() => {
    const card = document.querySelector('.card');
    return { cls: card ? card.className : null };
  })()`);
  console.log('current state:', JSON.stringify(st));

  if (!st.cls || !st.cls.includes('expanded')) {
    await c.evalJS(`document.querySelector('.btn--dots').click()`);
    await sleep(1500);
  }

  // Verify expanded fully
  const expanded = await c.evalJS(`(() => {
    const input = document.querySelector('.chat-input__textarea');
    const dd = document.querySelector('.dropdown');
    return { hasInput: !!input, hasDropdown: !!dd };
  })()`);
  console.log('expanded verify:', JSON.stringify(expanded));

  // ————— dropdown focused test —————
  const ddClick = await c.evalJS(`(() => {
    const trigger = document.querySelector('.dropdown__trigger');
    if (!trigger) return { error: 'no trigger' };
    const rect = trigger.getBoundingClientRect();
    trigger.click();
    return { clicked: true, tRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  })()`);
  console.log('dd click:', JSON.stringify(ddClick));
  await sleep(500);
  await c.screenshot('qa5-focused-07-dropdown-open');
  const ddDiag = await c.evalJS(`(() => {
    const panel = document.querySelector('.dropdown__panel, [class*="dropdown__panel"]');
    const trigger = document.querySelector('.dropdown__trigger');
    if (!panel || !trigger) return { noOpen: true, panel: !!panel };
    const p = panel.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const items = Array.from(panel.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim()).slice(0, 8).map((el) => ({ cls: el.className, text: el.textContent.trim() }));
    return {
      panelRect: { x: p.x, y: p.y, w: p.width, h: p.height, bottom: p.y + p.height },
      triggerRect: { x: t.x, y: t.y, w: t.width, h: t.height, bottom: t.y + t.height },
      opensUpward: (p.y + p.height) <= (t.y + 2),
      opensDownward: p.y >= (t.y + t.height - 2),
      opacity: style.opacity,
      zIndex: style.zIndex,
      position: style.position,
      items,
    };
  })()`);
  console.log('dropdown open diag:', JSON.stringify(ddDiag, null, 2));

  // close dd
  await c.evalJS(`document.body.click()`);
  await sleep(300);

  // ————— tool call rendering check in playground —————
  // open tool playground directly via navigation bypass? — we instead inspect message store possibility
  // Check if any tool-call blocks in message list
  const toolInDom = await c.evalJS(`(() => {
    const toolBlocks = Array.from(document.querySelectorAll('[class*="tool"]'));
    return {
      count: toolBlocks.length,
      items: toolBlocks.slice(0, 5).map((t) => ({ cls: t.className, text: (t.textContent || '').slice(0, 50) })),
    };
  })()`);
  console.log('tool in dom:', JSON.stringify(toolInDom));

  // ————— Hover / focus states —————
  // Hover on a message bubble, probe input focus ring
  const focusDiag = await c.evalJS(`(() => {
    const input = document.querySelector('.chat-input__textarea');
    if (!input) return { err: 'no input' };
    input.focus();
    const wrap = document.querySelector('.chat-input');
    const ws = wrap ? getComputedStyle(wrap) : null;
    const inS = getComputedStyle(input);
    return {
      inputBg: inS.backgroundColor,
      inputBorder: inS.border,
      inputOutline: inS.outline,
      inputBoxShadow: inS.boxShadow,
      wrapCls: wrap ? wrap.className : null,
      wrapBg: ws ? ws.backgroundColor : null,
    };
  })()`);
  console.log('focus diag:', JSON.stringify(focusDiag, null, 2));

  // ————— Probe visual alignment —————
  const align = await c.evalJS(`(() => {
    const card = document.querySelector('.card');
    const body = document.querySelector('.card__body');
    const expanded = document.querySelector('.expanded-view');
    const chatPanel = document.querySelector('.chat-panel');
    const footer = document.querySelector('.chat-panel__footer');
    const toolbar = document.querySelector('.toolbar') || document.querySelector('[class*="toolbar"]');
    const chatInput = document.querySelector('.chat-input');
    const cr = card ? card.getBoundingClientRect() : null;
    const getRect = (el) => el ? (() => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })() : null;
    return {
      card: getRect(card),
      cardBody: getRect(body),
      expanded: getRect(expanded),
      chatPanel: getRect(chatPanel),
      footer: getRect(footer),
      toolbar: getRect(toolbar),
      chatInput: getRect(chatInput),
      cardCls: card ? card.className : null,
    };
  })()`);
  console.log('alignment:', JSON.stringify(align, null, 2));

  // ————— Re-expand animation + window resize probe —————
  const cls1 = await c.evalJS(`document.querySelector('.card').className`);
  // collapse
  await c.evalJS(`document.querySelector('.card__close button').click()`);
  await sleep(100);
  await c.screenshot('qa5-focused-collapse-50ms');
  await sleep(200);
  await c.screenshot('qa5-focused-collapse-300ms');
  await sleep(300);
  await c.screenshot('qa5-focused-collapse-600ms');
  const cls2 = await c.evalJS(`document.querySelector('.card').className`);
  console.log('collapse cls before→after:', cls1, '→', cls2);

  // ————— Check: re-expand should show typingDots if pending thinking left —————
  await c.evalJS(`document.querySelector('.btn--dots').click()`);
  await sleep(100);
  await c.screenshot('qa5-focused-reexpand-100ms');
  await sleep(400);
  await c.screenshot('qa5-focused-reexpand-500ms');

  c.close();

  // Settings window: open + freshly capture
  await sleep(500);
  // re-open main for settings trigger
  const c2 = await makeCdp(mainPage.webSocketDebuggerUrl);
  await c2.cdp('Runtime.enable');
  await c2.cdp('Page.enable');
  // close any existing settings first by finding and reusing
  const existing = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const existingSettings = existing.find((t) => t.type === 'page' && /window=settings/.test(t.url));
  let sc;
  if (existingSettings) {
    sc = await makeCdp(existingSettings.webSocketDebuggerUrl);
  } else {
    await c2.evalJS(`window.electronAPI && window.electronAPI.openSettings && window.electronAPI.openSettings()`);
    await sleep(2500);
    const t2 = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
    const s = t2.find((t) => t.type === 'page' && /window=settings/.test(t.url));
    if (s) sc = await makeCdp(s.webSocketDebuggerUrl);
  }
  if (sc) {
    await sc.cdp('Runtime.enable');
    await sc.cdp('Page.enable');
    await sleep(300);
    await sc.screenshot('qa5-focused-settings');
    const sdiag = await sc.evalJS(`(() => {
      const page = document.querySelector('.settings-page');
      const content = document.querySelector('.settings-page__content');
      const close = document.querySelector('.settings-page__close');
      const twRegex = /(?:^|\\s)(p-[0-9]|m-[0-9]|flex\\s|gap-[0-9]|text-\\w+-[0-9]|bg-\\w+-[0-9]|w-[0-9]|h-[0-9]|max-w-\\[|mx-auto|min-h-|box-border|overflow-hidden|bg-transparent|w-screen|h-screen)/;
      const all = Array.from(document.querySelectorAll('*'));
      const tw = all.filter((el) => typeof el.className === 'string' && twRegex.test(el.className)).slice(0, 5).map((el) => ({ tag: el.tagName, cls: el.className }));
      const svgs = Array.from(document.querySelectorAll('svg'));
      const rawSvgs = svgs.filter((s) => !s.closest('[class*="icon"]') && !s.closest('.icon'));
      const rect = page ? page.getBoundingClientRect() : null;
      const r = content ? content.getBoundingClientRect() : null;
      return {
        hasPage: !!page,
        pageCls: page ? page.className : null,
        pageRect: rect ? { w: rect.width, h: rect.height } : null,
        hasContent: !!content,
        contentCls: content ? content.className : null,
        contentRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
        hasClose: !!close,
        tailwindViolators: tw,
        rawSvgCount: rawSvgs.length,
      };
    })()`);
    console.log('settings focused diag:', JSON.stringify(sdiag, null, 2));
    sc.close();
  } else {
    console.log('no settings target available');
  }
  c2.close();
  console.log('focused done');
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
