// 画布交互 E2E —— 节点拖拽 / 滚轮 zoom / F 适应 / 0 重置。真实用户路径，零 mock / 零 API 绕过。
//
// 场景清单：
//   TC-1 画布节点拖拽：mousedown → mousemove 50px → mouseup，断言 left/top 变化
//   TC-2 画布 zoom：wheel 事件在画布空白区，断言 zoom 变化
//   TC-3 F 键适应 + 0 键重置：按 F 截图，按 0 后 zoom 回 1
//
// 前置：
//   - Electron dev + CDP 9222 可连
//   - 已有 team 窗口（URL 含 window=team）并画布里 ≥ 1 个 .canvas-node；否则整组 test.skip
//
// 红线：
//   - 零 mock、零 page.request（本 spec 不需要建数据，直接复用现有 team 窗）
//   - 所有操作走 Playwright UI（mouse / wheel / keyboard）
//
// 关键 DOM：
//   - .team-canvas 容器（wheel listener 在此，passive: false，支持 preventDefault）
//   - .team-canvas__viewport 子节点，transform: translate(x, y) scale(z) 可反推 zoom
//   - .canvas-node[data-instance-id] 节点，inline style.left / style.top（像素）
//   - .canvas-top-bar__zoom-text "NN%" 读数
//
// 注意：
//   - CanvasNode.onMouseDown 会 stopPropagation，所以 pan 不会与节点拖拽冲突
//   - useCanvasHotkeys 绑在 window.keydown，不接管编辑元素聚焦的按键
//   - useCanvasTransform wheel 事件有 200ms commit 防抖，断言 zoom 时要等 flush
import { test, expect, type Browser, type Page } from '@playwright/test';
import { connectElectron, findPageByUrl, screenshot } from './cdp-helpers';

const REACT_FLUSH_MS = 200;
const WHEEL_COMMIT_MS = 300; // useCanvasTransform 的 wheel commit 防抖 200ms + 余量

// 读 viewport transform 里的 scale 数字。格式：translate(Xpx, Ypx) scale(Z)
async function readZoomFromViewport(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.team-canvas__viewport');
    if (!el) return NaN;
    const t = el.style.transform || '';
    const m = t.match(/scale\(([-\d.]+)\)/);
    return m ? parseFloat(m[1]) : NaN;
  });
}

// 读节点 inline style.left / style.top（像素，字符串带 'px'）
async function readNodePosition(page: Page, instanceId: string): Promise<{ left: number; top: number }> {
  return page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`.canvas-node[data-instance-id="${id}"]`);
    if (!el) return { left: NaN, top: NaN };
    return {
      left: parseFloat(el.style.left || '0'),
      top: parseFloat(el.style.top || '0'),
    };
  }, instanceId);
}

test.describe.configure({ mode: 'serial' });

test.describe('画布交互 —— 节点拖拽 / zoom / hotkeys', () => {
  let browser: Browser;
  let teamPage: Page | null = null;

  test.beforeAll(async () => {
    ({ browser } = await connectElectron());
    // 不主动建 team：复用现有 team 窗口。找不到就整组 skip。
    teamPage = await findPageByUrl(browser, (u) => u.includes('window=team'), { timeoutMs: 2_000 })
      .catch(() => null);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test.beforeEach(async () => {
    test.skip(!teamPage, 'team 窗口未打开（需已有团队），跳过整组画布交互测试');
    const tp = teamPage!;
    // 确认画布和至少一个节点就位
    await tp.locator('.team-canvas').first().waitFor({ state: 'visible', timeout: 3_000 });
    const node = tp.locator('.canvas-node[data-instance-id]').first();
    const hasNode = await node.isVisible().catch(() => false);
    test.skip(!hasNode, '画布内无 canvas-node，跳过');
  });

  // ---- TC-1 画布节点拖拽 ----
  test('TC-1 节点 mousedown → 移动 50px → mouseup，位置有变化', async () => {
    const tp = teamPage!;
    const node = tp.locator('.canvas-node[data-instance-id]').first();
    const instanceId = await node.getAttribute('data-instance-id');
    expect(instanceId, '节点必须有 data-instance-id').toBeTruthy();

    // 先按 0 归一 zoom（drag 公式按 1/zoom 换算，zoom=1 时屏幕位移 = 世界位移）
    await tp.keyboard.press('0');
    await tp.waitForTimeout(REACT_FLUSH_MS);

    // 读初始位置（inline style）
    const before = await readNodePosition(tp, instanceId!);
    expect(Number.isFinite(before.left), 'left 必须是有限数').toBeTruthy();
    expect(Number.isFinite(before.top), 'top 必须是有限数').toBeTruthy();

    // 用 bounding box 算节点中心点作为按下坐标；节点 onMouseDown 会 stopPropagation
    // 所以 pan 逻辑不会干扰。drag 只依赖 clientX/Y 的绝对位移，不关心按下落点是否在节点里，
    // 只要 target 命中 .canvas-node 即可进入 drag 流。
    const box = await node.boundingBox();
    expect(box, '节点必须有 bounding box').toBeTruthy();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;

    // 先移到节点中心，按下
    await tp.mouse.move(startX, startY);
    await tp.mouse.down();

    // 多步移动越过 3px 阈值 + 避免触发浏览器原生 drag；每步 10px
    for (let i = 1; i <= 5; i++) {
      await tp.mouse.move(startX + i * 10, startY + i * 10, { steps: 2 });
    }
    await tp.mouse.up();
    await tp.waitForTimeout(REACT_FLUSH_MS);

    // 读新位置
    const after = await readNodePosition(tp, instanceId!);

    // 断言位置有变化（至少一个轴位移 ≥ 5px，容忍 clamp 回弹或舍入）
    const dx = Math.abs(after.left - before.left);
    const dy = Math.abs(after.top - before.top);
    expect(
      dx + dy,
      `拖拽 50px 后节点位置应变化 (before=${JSON.stringify(before)} after=${JSON.stringify(after)})`,
    ).toBeGreaterThanOrEqual(5);

    await screenshot(tp, 'canvas-tc1-node-dragged');
  });

  // ---- TC-2 画布 zoom（滚轮缩放）----
  test('TC-2 wheel 事件在画布空白区 → zoom 变化', async () => {
    const tp = teamPage!;

    // 先按 0 归一到 1.0
    await tp.keyboard.press('0');
    await tp.waitForTimeout(REACT_FLUSH_MS);

    const before = await readZoomFromViewport(tp);
    expect(Number.isFinite(before), 'zoom 必须是有限数').toBeTruthy();

    // 在画布空白区滚轮 —— 左上角偏内一点，避开 canvas-node / top-bar
    const canvas = tp.locator('.team-canvas').first();
    const cbox = await canvas.boundingBox();
    expect(cbox, '.team-canvas 必须有 bounding box').toBeTruthy();

    const wheelX = cbox!.x + 20;
    const wheelY = cbox!.y + 20;

    // 多次累计 deltaY（单次 100 的影响不够大，factor = exp(-100*0.0015) ≈ 0.86；连续几次叠加）
    await tp.mouse.move(wheelX, wheelY);
    for (let i = 0; i < 5; i++) {
      await tp.mouse.wheel(0, 100);
      await tp.waitForTimeout(30);
    }
    await tp.waitForTimeout(WHEEL_COMMIT_MS);

    const after = await readZoomFromViewport(tp);
    expect(Number.isFinite(after), 'zoom 必须是有限数').toBeTruthy();

    // 断言 zoom 变化（容差 0.01，避开浮点抖动）
    expect(Math.abs(after - before), `zoom 应变化 (before=${before} after=${after})`).toBeGreaterThan(0.01);

    await screenshot(tp, 'canvas-tc2-wheel-zoom');
  });

  // ---- TC-3 F 键适应 + 0 键重置 ----
  test('TC-3 F 键适应 → 截图；0 键重置 → zoom 回 1', async () => {
    const tp = teamPage!;

    // 确保 focus 在 team 窗口且不在输入框里（hotkey 遇到 editable target 会放行）
    await tp.locator('.team-canvas').first().click({ position: { x: 5, y: 5 } });
    await tp.waitForTimeout(50);

    // 先把 zoom 搞乱（非 1）—— 连续 wheel 几下
    const cbox = await tp.locator('.team-canvas').first().boundingBox();
    expect(cbox).toBeTruthy();
    await tp.mouse.move(cbox!.x + 20, cbox!.y + 20);
    for (let i = 0; i < 4; i++) {
      await tp.mouse.wheel(0, 100);
      await tp.waitForTimeout(30);
    }
    await tp.waitForTimeout(WHEEL_COMMIT_MS);

    const zoomBeforeF = await readZoomFromViewport(tp);
    expect(Math.abs(zoomBeforeF - 1)).toBeGreaterThan(0.01);

    // 按 F 键：useCanvasHotkeys 调 onFit → computeFitTransform → commitTransform
    await tp.keyboard.press('f');
    await tp.waitForTimeout(REACT_FLUSH_MS);

    // 截图适应后的状态（不硬断言 zoom 具体值，因为取决于节点分布和画布尺寸）
    await screenshot(tp, 'canvas-tc3-fit-f');

    const zoomAfterF = await readZoomFromViewport(tp);
    expect(Number.isFinite(zoomAfterF)).toBeTruthy();

    // 按 0 键：onResetZoom → commitTransform({ x: 0, y: 0, zoom: 1 })
    await tp.keyboard.press('0');
    await tp.waitForTimeout(REACT_FLUSH_MS);

    const zoomAfterZero = await readZoomFromViewport(tp);
    // 浮点容差 0.001
    expect(
      Math.abs(zoomAfterZero - 1),
      `按 0 后 zoom 应为 1，实际 ${zoomAfterZero}`,
    ).toBeLessThan(0.001);

    await screenshot(tp, 'canvas-tc3-reset-zero');
  });
});
