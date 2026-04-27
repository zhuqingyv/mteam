// Round 5 QA — full flow CDP probe
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
    resolve({ cdp, evalJS, screenshot, close: () => ws.close() });
  });
}

async function main() {
  const targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const mainPage = targets.find((t) => t.type === 'page' && !/window=/.test(t.url));
  if (!mainPage) { console.error('no main capsule page target'); process.exit(1); }
  console.log('capsule page:', mainPage.url);
  const c = await makeCdp(mainPage.webSocketDebuggerUrl);
  await c.cdp('Runtime.enable');
  await c.cdp('Page.enable');

  // Normalize: force collapsed state, then reload. store persisted state across reloads.
  await c.evalJS(`(() => {
    try {
      // zustand persists under localStorage; brute force clear store keys that likely hold expanded=true
      const toClear = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/window|capsule|expanded/i.test(k)) toClear.push(k);
      }
      for (const k of toClear) localStorage.removeItem(k);
    } catch (e) {}
    return true;
  })()`);
  await c.cdp('Page.reload');
  await sleep(1500);

  // Step 1: capsule
  await c.screenshot('qa5-01-capsule');
  const capsuleDiag = await c.evalJS(`(() => {
    const card = document.querySelector('.card');
    const badge = document.querySelector('.text--badge');
    const subtitle = document.querySelector('.text--subtitle');
    const dotsBtn = document.querySelector('.btn--dots');
    const title = document.querySelector('.text--title');
    const logo = document.querySelector('[class*="logo"]');
    return {
      hasCard: !!card,
      cardClass: card ? card.className : null,
      cardRect: card ? (() => { const r=card.getBoundingClientRect(); return {w:r.width,h:r.height,x:r.x,y:r.y}; })() : null,
      titleText: title ? title.textContent : null,
      badgeExists: !!badge,
      badgeText: badge ? badge.textContent : null,
      subtitleText: subtitle ? subtitle.textContent : null,
      dotsBtn: !!dotsBtn,
      innerDotsCount: dotsBtn ? dotsBtn.querySelectorAll('.btn__dot').length : 0,
      hasLogo: !!logo,
    };
  })()`);
  console.log('[1] capsule diag:', JSON.stringify(capsuleDiag, null, 2));

  // Step 2: click dots btn to expand
  const expandClick = await c.evalJS(`(() => {
    const dots = document.querySelector('.btn--dots');
    if (!dots) return { error: 'no dots btn' };
    dots.click();
    return { clicked: true };
  })()`);
  console.log('[2] expand click:', JSON.stringify(expandClick));
  await sleep(1500);
  await c.screenshot('qa5-02-expanded');
  const expandDiag = await c.evalJS(`(() => {
    const card = document.querySelector('.card');
    const expanded = document.querySelector('.expanded-view');
    const chatPanel = document.querySelector('.chat-panel');
    const toolBar = document.querySelector('.toolbar, [class*="toolbar"]');
    const dropdown = document.querySelector('.dropdown');
    const input = document.querySelector('.chat-input__textarea');
    const sendBtn = document.querySelector('.chat-input__send');
    return {
      cardClass: card ? card.className : null,
      cardRect: card ? card.getBoundingClientRect() : null,
      bodyRect: document.body.getBoundingClientRect(),
      hasExpanded: !!expanded,
      hasChatPanel: !!chatPanel,
      hasToolBar: !!toolBar,
      hasDropdown: !!dropdown,
      hasInput: !!input,
      hasSendBtn: !!sendBtn,
      sendBtnCls: sendBtn ? sendBtn.className : null,
    };
  })()`);
  console.log('[2] expanded diag:', JSON.stringify(expandDiag, null, 2));

  // Step 3: set input value
  const setVal = await c.evalJS(`(() => {
    const input = document.querySelector('.chat-input__textarea');
    if (!input) return { error: 'no input' };
    const proto = window.HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(input, 'round5 check, reply one short sentence');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`, false);
  console.log('[3a] set value:', JSON.stringify(setVal));
  await sleep(300);
  const sendResult = await c.evalJS(`(() => {
    const sendBtn = document.querySelector('.chat-input__send');
    if (!sendBtn) return { error: 'no send btn' };
    sendBtn.click();
    return { sent: true };
  })()`, false);
  console.log('[3] send:', JSON.stringify(sendResult));
  await sleep(400);
  await c.screenshot('qa5-03-sent-loading');
  const loadingDiag = await c.evalJS(`(() => {
    const rows = Array.from(document.querySelectorAll('.chat-panel__row, .message-row'));
    const bubbles = Array.from(document.querySelectorAll('[class*="bubble"]'));
    const thinking = document.querySelector('.bubble--thinking');
    const typingDots = document.querySelector('.typing-dots, [class*="typing-dots"]');
    return {
      rowCount: rows.length,
      bubbleCount: bubbles.length,
      hasThinking: !!thinking,
      hasTypingDots: !!typingDots,
      typingDotsHTML: typingDots ? typingDots.outerHTML.slice(0, 200) : null,
      lastRowText: rows.length ? (rows[rows.length-1].textContent || '').slice(0, 80) : null,
    };
  })()`);
  console.log('[3] loading diag:', JSON.stringify(loadingDiag, null, 2));

  // Step 4: wait for reply
  for (let i = 0; i < 40; i++) {
    const st = await c.evalJS(`(() => {
      const thinking = document.querySelector('.bubble--thinking');
      const streaming = document.querySelector('[class*="streaming"], [class*="cursor"]');
      const rows = document.querySelectorAll('.chat-panel__row, .message-row');
      return { rowCount: rows.length, thinking: !!thinking, streaming: !!streaming };
    })()`);
    if (st.rowCount >= 2 && !st.thinking && !st.streaming) break;
    await sleep(1000);
  }
  await c.screenshot('qa5-04-reply');
  const replyDiag = await c.evalJS(`(() => {
    const rows = Array.from(document.querySelectorAll('.chat-panel__row, .message-row'));
    const thinking = document.querySelector('.bubble--thinking');
    const streaming = document.querySelector('[class*="streaming"], [class*="cursor"]');
    return {
      rowCount: rows.length,
      stillThinking: !!thinking,
      stillStreaming: !!streaming,
      rows: rows.slice(-5).map((r) => ({ cls: r.className, text: (r.textContent || '').slice(0, 100) })),
    };
  })()`);
  console.log('[4] reply diag:', JSON.stringify(replyDiag, null, 2));

  // Step 5: tool call rendering
  const toolDiag = await c.evalJS(`(() => {
    const toolList = Array.from(document.querySelectorAll('.tool-list, [class*="tool-list"], .tool-call, [class*="tool-call"]'));
    const chevron = Array.from(document.querySelectorAll('.tool-list__chevron, [class*="tool-list__chevron"]'));
    return {
      toolCount: toolList.length,
      items: toolList.slice(0, 3).map((t) => ({ cls: t.className, text: (t.textContent || '').slice(0, 80) })),
      chevrons: chevron.map((c) => ({ cls: c.className, svg: !!c.querySelector('svg, [class*="icon"]'), text: c.textContent.trim() })),
    };
  })()`);
  console.log('[5] tool diag:', JSON.stringify(toolDiag));
  await c.screenshot('qa5-05-tool-call');

  // Step 6: settings via toolbar button (ToolBar has settings btn)
  const settingsClick = await c.evalJS(`(() => {
    // look for settings trigger — Button variant="icon" with icon settings inside toolbar
    const toolbarBtns = Array.from(document.querySelectorAll('.toolbar button, [class*="toolbar"] button'));
    const res = { toolbarBtnCount: toolbarBtns.length, btns: toolbarBtns.map((b) => ({ aria: b.getAttribute('aria-label'), iconName: b.querySelector('[class*="icon"]') ? b.querySelector('[class*="icon"]').className : null })) };
    // click the last button (typically settings)
    if (toolbarBtns.length) {
      toolbarBtns[toolbarBtns.length-1].click();
      res.clicked = true;
    }
    return res;
  })()`);
  console.log('[6] settings click:', JSON.stringify(settingsClick));
  await sleep(2500);
  const targets2 = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const settings = targets2.find((t) => t.type === 'page' && /window=settings/.test(t.url));
  if (settings) {
    const sc = await makeCdp(settings.webSocketDebuggerUrl);
    await sc.cdp('Runtime.enable');
    await sc.cdp('Page.enable');
    await sleep(500);
    await sc.screenshot('qa5-06-settings');
    const settingsDiag = await sc.evalJS(`(() => {
      const page = document.querySelector('.settings-page, [class*="settings-page"]');
      const content = document.querySelector('.settings-page__content');
      const twRegex = /(?:^|\\s)(p-[0-9]|m-[0-9]|flex\\s|gap-[0-9]|text-\\w+-[0-9]|bg-\\w+-[0-9]|w-[0-9]|h-[0-9]|max-w-\\[|mx-auto|min-h-|box-border|overflow-hidden|bg-transparent|w-screen|h-screen)/;
      const all = Array.from(document.querySelectorAll('*'));
      const tw = all.filter((el) => typeof el.className === 'string' && twRegex.test(el.className)).slice(0, 5).map((el) => ({ tag: el.tagName, cls: el.className }));
      const svgs = Array.from(document.querySelectorAll('svg'));
      const rawSvgs = svgs.filter((s) => !s.closest('[class*="icon"]') && !s.closest('.icon'));
      return {
        hasPage: !!page,
        hasContent: !!content,
        contentCls: content ? content.className : null,
        tailwindViolators: tw,
        totalSvg: svgs.length,
        rawSvgCount: rawSvgs.length,
        title: document.title,
      };
    })()`);
    console.log('[6] settings diag:', JSON.stringify(settingsDiag, null, 2));
    sc.close();
  } else {
    console.log('[6] no settings window opened');
  }

  // Step 7: dropdown
  const dropdownResult = await c.evalJS(`(() => {
    const dd = document.querySelector('.dropdown');
    if (!dd) return { error: 'no dropdown' };
    const trigger = dd.querySelector('.dropdown__trigger, button, [role="button"]') || dd;
    const rect = dd.getBoundingClientRect();
    trigger.click();
    return { clicked: true, ddCls: dd.className, triggerCls: trigger.className, ddRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  })()`);
  console.log('[7] dropdown click:', JSON.stringify(dropdownResult));
  await sleep(500);
  await c.screenshot('qa5-07-dropdown');
  const dropdownOpenDiag = await c.evalJS(`(() => {
    const menu = document.querySelector('.dropdown__menu, [class*="dropdown__menu"], [class*="dropdown-menu"]');
    if (!menu) return { open: false, allDdDescend: Array.from(document.querySelectorAll('.dropdown > *')).map((el) => el.className) };
    const mRect = menu.getBoundingClientRect();
    const trigger = document.querySelector('.dropdown__trigger, .dropdown button');
    const tRect = trigger ? trigger.getBoundingClientRect() : null;
    const style = getComputedStyle(menu);
    return {
      open: true,
      menuRect: { x: mRect.x, y: mRect.y, w: mRect.width, h: mRect.height },
      triggerRect: tRect ? { x: tRect.x, y: tRect.y, w: tRect.width, h: tRect.height } : null,
      menuBelowTrigger: tRect ? mRect.y >= (tRect.y + tRect.height - 5) : null,
      menuAboveTrigger: tRect ? (mRect.y + mRect.height) <= (tRect.y + 5) : null,
      opacity: style.opacity,
      zIndex: style.zIndex,
      position: style.position,
      visibility: style.visibility,
      display: style.display,
      items: Array.from(menu.querySelectorAll('[class*="dropdown__item"], li, button')).slice(0,5).map((el) => (el.textContent || '').slice(0, 30)),
    };
  })()`);
  console.log('[7] dropdown open diag:', JSON.stringify(dropdownOpenDiag, null, 2));
  await c.evalJS(`document.body.click(); true`);
  await sleep(200);

  // Step 8: collapse + re-expand retain
  const rowsBefore = await c.evalJS(`document.querySelectorAll('.chat-panel__row, .message-row').length`);
  await c.evalJS(`(() => {
    const close = document.querySelector('.card__close button') || document.querySelector('.card__close');
    if (close) close.click();
  })()`);
  await sleep(1500);
  await c.screenshot('qa5-08a-collapsed');
  await c.evalJS(`(() => {
    const dots = document.querySelector('.btn--dots');
    if (dots) dots.click();
  })()`);
  await sleep(1500);
  await c.screenshot('qa5-08b-reexpanded');
  const rowsAfter = await c.evalJS(`document.querySelectorAll('.chat-panel__row, .message-row').length`);
  console.log('[8] history:', JSON.stringify({ rowsBefore, rowsAfter, retained: rowsBefore === rowsAfter }));

  // Global: raw svg + tailwind
  const globalDiag = await c.evalJS(`(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const svgs = Array.from(document.querySelectorAll('svg'));
    const rawSvg = svgs.filter((s) => !s.closest('[class*="icon"]') && !s.closest('.icon'));
    const twRegex = /(?:^|\\s)(p-[0-9]|m-[0-9]|flex\\s|gap-[0-9]|text-\\w+-[0-9]|bg-\\w+-[0-9]|w-[0-9]|h-[0-9]|max-w-\\[|mx-auto|min-h-|box-border|overflow-hidden|bg-transparent|w-screen|h-screen)/;
    const tailwindHits = all.filter((el) => typeof el.className === 'string' && twRegex.test(el.className)).map((el) => ({ tag: el.tagName, cls: el.className }));
    return {
      totalSvg: svgs.length,
      rawSvgCount: rawSvg.length,
      rawSvgSnippets: rawSvg.slice(0, 5).map((s) => ({ parentCls: s.parentElement ? s.parentElement.className : '?', innerHTML: s.innerHTML.slice(0, 60) })),
      tailwindHitsCount: tailwindHits.length,
      tailwindHits: tailwindHits.slice(0, 10),
    };
  })()`);
  console.log('[global] diag:', JSON.stringify(globalDiag, null, 2));

  c.close();
  console.log('done');
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
