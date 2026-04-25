# 果冻桌宠交接文档

## 当前状态

3D 果冻桌宠代码已写好但在 Electron 透明窗口里看不到 3D 效果（只看到背景毛玻璃）。需要先在普通浏览器网页里调好效果再搬回 Electron。

## 项目路径

```
packages/renderer/
├── src/
│   ├── App.tsx                      ← 根组件，挂载 JellyPet
│   ├── components/
│   │   └── JellyPet.tsx             ← 3D 果冻组件（核心）
│   ├── styles/
│   │   └── glass.css                ← 基础样式（透明背景）
│   └── assets/
│       ├── design-pet-states.jpeg   ← 设计参考图（多状态桌宠）
│       ├── design-chat-expanded.jpeg← 设计参考图（展开态聊天）
│       └── design-mockup.png        ← 设计参考图（完整界面）
├── electron-main/
│   ├── main.ts                      ← Electron 主进程（transparent 窗口 300x200）
│   ├── backend.ts                   ← 启动 backend 子进程
│   └── preload.cjs                  ← IPC（只有 resize）
├── package.json                     ← 依赖含 @react-three/fiber + drei + three
└── vite.config.ts                   ← Vite 配置，端口 5180
```

## 目标效果

软糖/果冻质感的桌宠：
- 立体有厚度（3D 圆角方块）
- 软糖质感（柔和、半透明、朦胧）
- 边缘蠕动（低频 noise 顶点变形，像呼吸）
- 边缘光带（一条柔光沿边缘缓慢游走）
- 暖紫/粉色调
- 表情 + 文字
- 参考图见 src/assets/design-pet-states.jpeg

## 当前技术实现（JellyPet.tsx）

- R3F Canvas + RoundedBox(1.6, 1.2, 1.0)
- MeshPhysicalMaterial（transmission + clearcoat）
- 顶点 shader noise 蠕动（onBeforeCompile 注入）
- SpotLight 绕物体旋转做光带
- Environment preset='apartment'
- HTML 文字叠层（Canvas 上方）

## 下一步建议

1. 在普通网页（localhost:5180）里调好效果 — 加深色背景方便看清 3D 体
2. 调参让果冻体明显可见：颜色更饱和、opacity 更低、光照更强
3. 确认蠕动和光带效果
4. 效果满意后再搬回 Electron 透明窗口

## 启动方式

```bash
# 只起前端 Vite（浏览器调试用）
cd packages/renderer && bun run dev
# 访问 http://localhost:5180

# 完整启动（Electron + backend）
bun start
```

## 已知问题

- Electron 透明窗口 + WebGL alpha:true 时，半透明 3D 物体几乎不可见
- 可能需要给 Canvas 加一个半透明深色背景辅助显示，或者调高 opacity/降低 transmission
