// Verify MessageRow blocks sorting: text/thinking in bubble, tool_call/tool_result below via ToolCallList
// Inject a synthetic message with mixed blocks directly into React state via window hook.
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/Users/zhuqingyu/project/mcp-team-hub/tmp/phase1-e2e';
mkdirSync(OUT, { recursive: true });

function makeCdp(wsUrl) {
  return new Promise(async (resolve) => {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, rej) => { ws.onopen = r; ws.onerror = () => rej(new Error('ws err')); });
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
const main = targets.find((t) => t.type === 'page' && t.url === 'http://localhost:5180/');
if (!main) { console.error('no main target'); process.exit(1); }
const c = await makeCdp(main.webSocketDebuggerUrl);
await c.cdp('Runtime.enable'); await c.cdp('Page.enable');
await sleep(300);

// 1. Expand if needed
const init = await c.evalJS(`({ hasTA: !!document.querySelector('textarea'), expanded: !!document.querySelector('.card--expanded') })`);
if (!init.hasTA) {
  await c.evalJS(`document.querySelector('button.btn--dots')?.click()`);
  await sleep(1500);
}
await c.screenshot('blocks-00-expanded');

// 2. Inject a synthetic agent message with mixed blocks via React fiber
const inject = await c.evalJS(`(() => {
  // find a React-rendered MessageRow to get at fiber → hook store
  const rows = document.querySelectorAll('.message-row');
  if (!rows.length) {
    // fall back: mount a fake row inline via DOM for visual sanity check
    return { ok: false, reason: 'no existing rows to tap store' };
  }
  return { ok: true, count: rows.length };
})()`);
console.log('inject probe:', inject);

// Strategy: wire a synthetic message through the real messageStore by dispatching a
// custom 'debug:add-message' event that we handle in the app. Since the app doesn't
// listen to that, use a different tactic: pull the zustand setState from a module
// via dynamic import (vite dev server exposes modules under /src/...).
// Step A: load the store module, cache to window
const loadRes = await c.evalJS(`(async () => {
  try {
    const mod = await import('/src/store/messageStore.ts');
    window.__msgStore__ = mod.useMessageStore;
    return { ok: true, keys: Object.keys(mod) };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
})()`);
console.log('load:', loadRes);

// Step B: inject via cached store (sync call, no dynamic import)
const injected = await c.evalJS(`(() => {
  const useStore = window.__msgStore__;
  if (!useStore) return { ok: false, err: 'no store cached' };
  const st = useStore.getState();
  st.addMessage({
    id: 'synthetic-blocks-' + Date.now(),
    role: 'agent',
    content: '',
    time: '21:00',
    agentName: 'Claude',
    streaming: false,
    blocks: [
      { type: 'text', blockId: 'b-t1', content: '我来分析一下这个文件。' },
      { type: 'tool_call', blockId: 'b-tc1', toolName: 'read_file', status: 'running', summary: '读取 package.json' },
      { type: 'tool_result', blockId: 'b-tc1', toolName: 'read_file', status: 'done', summary: '返回 42 行' },
      { type: 'tool_call', blockId: 'b-tc2', toolName: 'grep', status: 'running', summary: '搜索 foo' },
      { type: 'text', blockId: 'b-t2', content: '分析完毕，共 42 行。' },
    ],
  });
  return { ok: true, total: useStore.getState().messages.length };
})()`);
console.log('inject:', injected);

await sleep(1200);
const shotInj = await c.screenshot('blocks-01-injected');
console.log('shot:', shotInj);

const debug = await c.evalJS(`(() => {
  const allRows = document.querySelectorAll('.message-row');
  const agentRows = document.querySelectorAll('.message-row--agent');
  const userRows = document.querySelectorAll('.message-row--user');
  const msgs = window.__msgStore__?.getState().messages ?? [];
  return {
    storeCount: msgs.length,
    storeRoles: msgs.map(m => m.role + (m.blocks ? ':blk' + m.blocks.length : '')),
    allRows: allRows.length,
    agentRows: agentRows.length,
    userRows: userRows.length,
  };
})()`);
console.log('debug:', debug);

const dom = await c.evalJS(`(() => {
  const rows = Array.from(document.querySelectorAll('.message-row--agent'));
  const last = rows[rows.length - 1];
  if (!last) return { err: 'no agent row' };
  const bubble = last.querySelector('.bubble');
  const tools = last.querySelector('.message-row__tools');
  const textBlocks = last.querySelectorAll('.bubble .message-row__text-block').length;
  const toolInBubble = !!bubble?.querySelector('.tool-item');
  const toolListItems = tools ? tools.querySelectorAll('.tool-item').length : 0;
  const toolListAfterBubble = bubble && tools && (bubble.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;
  const bubbleText = (bubble?.textContent || '').trim();
  return { hasBubble: !!bubble, hasToolsSection: !!tools, textBlocks, toolInBubble, toolListItems, toolListAfterBubble, bubbleText };
})()`);
console.log('DOM:', JSON.stringify(dom, null, 2));

// Assertions
const pass =
  dom.hasBubble === true &&
  dom.hasToolsSection === true &&
  dom.textBlocks === 2 &&
  dom.toolInBubble === false &&
  dom.toolListItems === 2 &&
  dom.toolListAfterBubble === true;

console.log(pass ? 'PASS: blocks sorted — text in bubble, tool_call below in ToolCallList' : 'FAIL');

c.close();
process.exit(pass ? 0 : 2);
