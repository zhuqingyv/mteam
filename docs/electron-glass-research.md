# Electron macOS 深色玻璃窗口调研

> 调研范围：Electron 41 on macOS。重点回答"如何做到设计图的深紫/深蓝半透明玻璃、能看到桌面壁纸"。
> 作者注：无头环境无法肉眼验证视觉效果，本文只给出 API 层事实 + 可行方案组合 + demo，**视觉结论必须用户本机跑 `/tmp/electron-glass-test/` 确认**。

---

## 1. Electron 41 的 vibrancy 所有合法值

取自 `node_modules/.bun/electron@41.3.0/node_modules/electron/electron.d.ts:3960`：

```ts
vibrancy?: 'appearance-based' | 'titlebar' | 'selection' | 'menu' | 'popover'
        |  'sidebar' | 'header' | 'sheet' | 'window' | 'hud' | 'fullscreen-ui'
        |  'tooltip' | 'content' | 'under-window' | 'under-page';
```

### 关键事实：`'dark'` 和 `'ultra-dark'` 已经**不存在**

- macOS 10.14 Mojave（2018）起 Apple 官方弃用 `NSVisualEffectMaterialDark` / `NSVisualEffectMaterialUltraDark`。
- Electron 23+ 从 TS 类型里移除了这两个值。当前项目用 Electron 41，传 `'dark'` 会 TypeScript 编译失败，运行时也没有对应 material。
- **因此不能直接写 `vibrancy: 'dark'`**。这是上次尝试失败的底层原因之一（如果试了的话）——必须改走另一条路。

### 各 material 的底层含义（对应 NSVisualEffectMaterial）

Electron 字符串 → Apple 的 NSVisualEffectMaterial 常量大致对应关系（Apple 2018 年以后推荐"semantic material"，颜色深浅会跟随 `NSAppearance`）：

| Electron 值         | Apple material                         | 语义/用途              | 默认深浅                              |
| ------------------- | -------------------------------------- | ---------------------- | ------------------------------------- |
| `under-window`      | `NSVisualEffectMaterialUnderWindowBackground` | 窗口下方桌面模糊 | **跟随窗口 appearance**（dark/light） |
| `under-page`        | `NSVisualEffectMaterialUnderPageBackground`  | 页面下背景     | 跟随 appearance                       |
| `sidebar`           | `NSVisualEffectMaterialSidebar`        | 侧边栏（Finder 风格）  | 跟随 appearance                       |
| `header`            | `NSVisualEffectMaterialHeaderView`     | 表头                   | 跟随 appearance                       |
| `hud`               | `NSVisualEffectMaterialHUDWindow`      | HUD 浮层               | **始终偏暗**                          |
| `menu`              | `NSVisualEffectMaterialMenu`           | 菜单                   | 跟随 appearance                       |
| `popover`           | `NSVisualEffectMaterialPopover`        | 气泡                   | 跟随 appearance                       |
| `titlebar`          | `NSVisualEffectMaterialTitlebar`       | 标题栏                 | 跟随 appearance                       |
| `selection`         | `NSVisualEffectMaterialSelection`      | 选中态                 | 跟随 appearance                       |
| `sheet`             | `NSVisualEffectMaterialSheet`          | sheet 弹窗             | 跟随 appearance                       |
| `window`            | `NSVisualEffectMaterialWindowBackground` | 窗口背景              | 跟随 appearance                       |
| `fullscreen-ui`     | `NSVisualEffectMaterialFullScreenUI`   | 全屏 UI                | 跟随 appearance                       |
| `tooltip`           | `NSVisualEffectMaterialToolTip`        | tooltip                | 跟随 appearance                       |
| `content`           | `NSVisualEffectMaterialContentBackground` | 内容区背景           | 跟随 appearance                       |
| `appearance-based`  | **已 deprecated**（Apple 从 10.14 起不再推荐） | 跟随系统    | 跟随系统 appearance                   |

### 结论：走哪个 material

- 想要**深色** vibrancy 材质 → **不是**选某个固定"深色"值，而是让窗口 appearance 变成 dark，让 material 的深色版本生效。
- `hud` 是少数几个**无论窗口 appearance 是什么都偏暗**的 material，但视觉上是"带暗色调的半透明黑/灰"，色相中性，做不出深紫/深蓝。
- 深紫/深蓝效果**无法单纯靠选某个 vibrancy 值拿到**——Apple 的 vibrancy 材质色相固定（灰调居多），**饱和色相必须靠 CSS 层叠加**。

---

## 2. NSAppearance 控制 vibrancy 颜色

### Electron 的相关 API（Electron 41 d.ts 实测）

| API | 效果 | 平台 |
| --- | --- | --- |
| `nativeTheme.themeSource = 'dark'` | 强制所有窗口走 dark appearance；macOS 原生 UI（菜单、窗口框架、vibrancy 材质）会切到深色版本 | 全平台，macOS 影响 vibrancy |
| `nativeTheme.shouldUseDarkColors` | 读取当前是否深色（只读） | 全平台 |
| `systemPreferences.getEffectiveAppearance()` | 返回 `'dark' \| 'light' \| 'unknown'` | macOS |
| `darkTheme: true`（BrowserWindow 选项） | **只对 Linux GTK+3 生效**，macOS 无效 | Linux 专属 |
| `titleBarOverlay` | 只是控制标题栏 overlay 按钮颜色，和 vibrancy 无关 | macOS/Windows |

**关键**：Electron 文档（`electron.d.ts:9888-9894`）原文：

> Setting this property to `dark` will have the following effects:
> - Any UI the OS renders on macOS **including menus, window frames, etc. will use the dark UI**.

vibrancy 是由系统绘制的 NSVisualEffectView，属于"OS renders"那一类。因此 `nativeTheme.themeSource='dark'` **理论上会让 vibrancy material 切到 dark 版本**。

### 做法

```ts
import { app, nativeTheme } from 'electron';

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';  // 必须在 createWindow 之前或之后立刻设
  createWindow();
});
```

这是**把 vibrancy 从浅色切到深色的最简方式**，不需要改 vibrancy 值本身。

---

## 3. 纯 CSS 方案（不用 vibrancy）

### 能不能对**桌面壁纸**做模糊？

**不能**。这是 Chromium 的硬限制：

- `backdrop-filter: blur()` 的"backdrop"指的是**同一 compositor 层里该元素后面的像素**。
- Electron 的 `transparent: true` 窗口确实让桌面壁纸透上来，但从 Chromium 的角度看，桌面壁纸**不在自己的合成树里**——它只是窗口外显示的东西。
- 因此 `backdrop-filter` 只能模糊**窗口内部、该元素下方的 DOM 元素**，无法模糊窗口外的桌面。

### 唯一能拿到"桌面壁纸模糊"效果的路径

只有系统级 blur，即 macOS 的 NSVisualEffectView（= Electron 的 vibrancy）或 Windows 的 Mica/Acrylic。**没有纯 CSS 替代方案**。

### 混合方案（推荐）

- **外层**靠 vibrancy 提供"桌面壁纸系统级模糊"这一层。
- **内层**用 `backdrop-filter: blur()` 在窗口内的卡片/气泡上做二次模糊 + 深色调。
- 深紫/深蓝色相由卡片的 `background: rgba(15,10,35,0.62)` 这类半透明色块叠出来。
- 项目知识库已存的 POC（mnemo id 314）验证过这套混合路径可行；当时调的是浅色系，改深色只需改 nativeTheme.themeSource + 把卡片背景换成深紫/深蓝。

---

## 4. backgroundMaterial

Electron 41 d.ts 第 3740 行：

```ts
backgroundMaterial?: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed';
```

注释明确标 `@platform win32`。**macOS 不支持 backgroundMaterial**。macOS 对应的能力就是 `vibrancy`。

---

## 5. 最小验证 demo

已写到 `/tmp/electron-glass-test/`：

- `main.js` — 顶部 `VIBRANCY` 和 `FORCE_DARK` 两个常量可调
- `index.html` — 5 张不同色/透明度卡片 + 一张完全透明卡片（直接显 vibrancy 材质本身颜色）
- 启动后 DevTools console 可运行时切换：
  ```js
  window.setVibrancy('hud')   // 试不同 material
  window.setTheme('light')    // 试 appearance 切换
  ```
- 顶部右上角 HUD 显示当前参数

运行：
```bash
cd /tmp/electron-glass-test && npm install && npm start
```

**观察要点**（需用户本机眼睛判断）：
1. 第 5 张完全透明卡片的背景颜色：深色 = `themeSource='dark'` 生效；白色 = 没生效
2. DevTools console 跑 `window.setTheme('light')` 看第 5 张卡片是否从深灰变白灰——验证 vibrancy 是否随 appearance 切换
3. 循环跑 `window.setVibrancy('hud' / 'sidebar' / 'under-window' / 'popover' / 'menu')`，对比哪个最接近设计图底色
4. 验证完后告诉实施成员："用 X material + themeSource=dark + 卡片 rgba(X,X,X,0.X)"

---

## 6. 参考其他 Electron 应用

- **Warp terminal**：公开博客里提到用 `vibrancy: 'hud'` 拿到"暗色半透明"效果，再用 CSS 叠窗口内容。
- **Hyper terminal**：早期版本用过 `vibrancy: 'ultra-dark'`（Electron 旧版），现在版本应该改成 appearance-based 方案（未逐行验证源码）。
- **社区共识**（Electron GitHub issue 20269、27956）：
  - 深色玻璃不是靠某个固定 material，而是"dark appearance + 合适 material + CSS 色块"三层叠加。
  - `hud` 是最省事的深色材质，但它的灰调偏冷，做不出深紫/深蓝饱和色相——必须在上层加 CSS。

---

## 7. 推荐方案（给实施成员）

**最确定的组合：`nativeTheme.themeSource = 'dark'` + `vibrancy: 'under-window'` + 卡片用深紫/深蓝半透明 CSS**。

### 主进程改动

```ts
import { app, BrowserWindow, nativeTheme } from 'electron';

app.whenReady().then(() => {
  // 关键一行: 让 vibrancy material 走 dark appearance
  nativeTheme.themeSource = 'dark';

  const win = new BrowserWindow({
    transparent: true,
    frame: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    vibrancy: 'under-window',      // 保持；dark appearance 下会变深色
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    // ... 其他
  });
});
```

### 渲染进程 CSS

```css
html, body, #root {
  background: transparent !important;
  overflow: hidden;
}

.glass-card {
  /* 设计图的深紫玻璃感 */
  background: rgba(15, 10, 35, 0.62);         /* 主色: 深紫，透明度 0.55-0.7 调 */
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(24px) saturate(160%); /* 叠一层窗口内模糊 */
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  color: rgba(255, 255, 255, 0.96);
  border-radius: 16px;
}

/* 深蓝变体 */
.glass-card.blue {
  background: rgba(10, 18, 40, 0.62);
}
```

### 调试时怎么找最佳值

1. 先跑 demo，用 DevTools console 切 `setVibrancy` 找"material 底色最贴近设计图"的一项
2. 固定 material 后，调卡片 `rgba(R,G,B,A)` 的 A（0.55 → 0.72 之间找平衡）
3. 最后看壁纸透出强度：太弱 → 降 A；太强 → 加 saturate

### 预期 Fallback

如果 `under-window` + dark appearance 仍然偏浅（极少数用户报告过），备选：
1. 换成 `vibrancy: 'hud'` —— 最稳的深色 material，色调中性
2. 或者直接不加 vibrancy，纯 CSS `rgba(15,10,35,0.85)` —— 失去桌面壁纸实时模糊，但保证深色 100% 可控
3. 用户可接受"窗口内模糊而非桌面模糊"时，第 2 条是最稳的降级

---

## 8. 关键不确定性（需用户 demo 验证）

- `nativeTheme.themeSource='dark'` 对 vibrancy material 的颜色影响是 Apple 系统级行为，Electron 文档**没明说 vibrancy 材质颜色会跟随**，只说"OS rendered UI 会走 dark"——vibrancy 属于 OS rendered，理论上跟随，但**必须实机验证**。
- 上次"`under-window` 出浅色毛玻璃"可能是因为没设 `nativeTheme.themeSource='dark'`，系统默认 light appearance → under-window material 用了 light 版本。
- `visualEffectState: 'active'` 只影响失焦时是否保持 vibrancy，和颜色无关，不用改。

## 9. 行动建议

1. 立即改：`packages/renderer/electron-main/main.ts:79` `app.whenReady()` 里加 `nativeTheme.themeSource = 'dark'`，保持 `under-window` 不动
2. 改卡片 CSS：`packages/renderer/src/styles/glass.css` 的 rgba 值从浅灰换成深紫（见上）
3. 跑 `/tmp/electron-glass-test/` demo 对照 5 张卡片，挑出 material + rgba 组合
4. 带着截图 + 具体值告诉实施成员改项目代码
