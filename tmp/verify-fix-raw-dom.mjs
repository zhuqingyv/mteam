// Verify P2+P3 component replacements in Playground
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/fix-raw-dom';
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

const targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const main = targets.find((t) => t.type === 'page');
if (!main) { console.error('no page target'); process.exit(1); }
console.log('current page:', main.url);
const savedUrl = main.url;
const c = await makeCdp(main.webSocketDebuggerUrl);
await c.cdp('Runtime.enable');
await c.cdp('Page.enable');

// navigate to playground
await c.cdp('Page.navigate', { url: 'http://127.0.0.1:5190/' });
await sleep(2000);
// wait up to 5s for cards to render
for (let i = 0; i < 10; i++) {
  const cnt = await c.evalJS(`document.querySelectorAll('[class*="card"]').length`);
  if (cnt > 0) break;
  await sleep(500);
}

// Probe 1 — MessageBubble thinking variant: ensure <i /> gone, TypingDots present
await c.evalJS(`(async () => {
  const cards = Array.from(document.querySelectorAll('*'));
  // scroll to a card whose label says MessageBubble then switch variant to thinking via the props panel
  // Simpler: just search DOM for any rendered thinking bubble. Playground default might already include it.
  window.scrollTo(0, 0);
})()`);

await c.screenshot('01-playground-overview');

// Inspect: Playground renders each component with defaults. Scroll and screenshot zones.
// Gather a deep dom diagnostic for the replaced spots.
const diagnostics = await c.evalJS(`(() => {
  const findAll = (sel) => Array.from(document.querySelectorAll(sel));
  return {
    // P2-3: thinking bubble should no longer have bubble__dots i×3
    bubbleThinkingCount: findAll('.bubble--thinking').length,
    bubbleDotsLegacy: findAll('.bubble__dots').length,
    typingDotsCount: findAll('.typing-dots').length,
    // P2-4: bubble__meta now contains .message-meta (atom)
    bubbleMetaCount: findAll('.bubble__meta').length,
    bubbleMetaWithMessageMeta: findAll('.bubble__meta .message-meta').length,
    bubbleReadLegacy: findAll('.bubble__read').length,
    // P2-1: message-row__text-block gone, .text-block present for text blocks
    legacyTextBlock: findAll('.message-row__text-block').length,
    legacyCursor: findAll('.message-row__cursor').length,
    newTextBlock: findAll('.text-block').length,
    // P3-5: ToolCallList chevron no unicode triangle
    toolListChevron: findAll('.tool-list__chevron').map((el) => el.textContent.trim()),
    toolListChevronSvg: findAll('.tool-list__chevron svg').length,
    // P3-6: Dropdown caret
    dropdownCaret: findAll('.dropdown__caret').map((el) => el.textContent.trim()),
    dropdownCaretSvg: findAll('.dropdown__caret svg').length,
  };
})()`);
console.log('diagnostics:', JSON.stringify(diagnostics, null, 2));

// Screenshot specific components — scroll to each card
const scrollToCard = async (labelMatch) => {
  const ok = await c.evalJS(`(() => {
    const cards = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = el.tagName;
      const tx = el.textContent || '';
      return (t === 'H3' || t === 'H2' || t === 'DIV' || t === 'SPAN') && tx.trim() === ${JSON.stringify(labelMatch)};
    });
    const el = cards[0];
    if (!el) return false;
    el.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  return ok;
};

await scrollToCard('MessageBubble');
await sleep(400);
await c.screenshot('02-message-bubble');

await scrollToCard('MessageRow');
await sleep(400);
await c.screenshot('03-message-row');

await scrollToCard('TurnRendering');
await sleep(400);
await c.screenshot('04-turn-rendering');

await scrollToCard('ToolCallList');
await sleep(400);
await c.screenshot('05-tool-call-list');

await scrollToCard('Dropdown');
await sleep(400);
await c.screenshot('06-dropdown');

await scrollToCard('Icon');
await sleep(400);
await c.screenshot('07-icon');

await scrollToCard('TextBlock');
await sleep(400);
await c.screenshot('08-text-block');

// Restore original URL
await c.cdp('Page.navigate', { url: savedUrl });
await sleep(500);

c.close();
console.log('done');
