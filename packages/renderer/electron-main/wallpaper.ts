// 读取 macOS 桌面壁纸文件，解码成 {dataUrl, width, height} 供 renderer 做折射纹理。
//
// 为什么 main 侧解码而不是直接传路径：
//   macOS 壁纸是 HEIC，Chromium 不解；file:// 访问 /System/ 受 sandbox 限。
//   NativeImage 对部分 HEIC 也返回 isEmpty（本机实测 Sequoia Sunrise），
//   所以再叠一层 sips 转码兜底到 temp PNG，这一条链实测稳定。
//
// 为什么要推图像原始尺寸：
//   shader 需要 cover-fit UV 映射 — 壁纸图片宽高比 vs 屏幕宽高比不同时，
//   macOS 会居中裁剪壁纸以 cover 屏幕。renderer 拿到原始宽高才能复现
//   裁剪映射，否则玻璃里看到的是"壁纸整张拉伸"而不是"壁纸被屏幕裁过的那块"。
//
// osascript 的坑：
//   - Finder 'desktop picture' 在 Sonoma+ 返回 missing value（team-lead
//     brief 原命令不工作），用 System Events 'every desktop to get picture'。
//   - 多 desktop 返回逗号分隔列表，取第一个。
//   - 失败→兜底 DefaultDesktop.heic→再失败返回 null。
import { app, BrowserWindow, nativeImage, screen } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM_DEFAULT = '/System/Library/CoreServices/DefaultDesktop.heic';

export type Rect = { x: number; y: number; width: number; height: number };
export type WinRect = Rect & {
  // 逻辑像素 bounds（跟 win x/y/w/h 同量纲，renderer 用来算 winRectUV 分母）
  display: Rect;
  // display 物理像素 aspect（= size × scaleFactor），renderer 用来匹配
  // 壁纸图片的物理像素比例做 cover-fit
  displayAspect: number;
};
export type WallpaperFrame = {
  dataUrl: string;
  width: number;
  height: number;
};

export function getWallpaperPath(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      'osascript',
      [
        '-e',
        'tell application "System Events" to tell every desktop to get picture',
      ],
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    const first = out.split(',')[0]?.trim();
    if (first && existsSync(first)) return first;
  } catch {
    // osascript 失败/超时，走兜底
  }
  if (existsSync(SYSTEM_DEFAULT)) return SYSTEM_DEFAULT;
  return null;
}

function tempPng(): string {
  // 用 app.getPath('temp') 比硬编码 /tmp 更规范，跨用户隔离
  try {
    return join(app.getPath('temp'), 'mteam-wallpaper.png');
  } catch {
    return '/tmp/mteam-wallpaper.png';
  }
}

// 统一走 sips 转 JPEG：保原分辨率，只压质量。
// 原因：
//   - HEIC 在 Electron NativeImage 返回 isEmpty，只能走 sips 转码
//   - 保原分辨率：4K 屏上折射的细节不丢；aspect 天然正确
//   - quality 60：Sequoia Sunrise 3840×2160 从 14MB PNG → 1.15MB JPEG（12 倍），
//     肉眼看不出差异，折射还叠液态 noise 扭曲掩盖压缩痕迹
//   - 非 HEIC 壁纸也统一走 sips，管线单一、死码少
export function loadWallpaperDataUrl(path: string): WallpaperFrame | null {
  try {
    const out = tempPng().replace(/\.png$/, '.jpg');
    execFileSync(
      'sips',
      [
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', '60',
        path,
        '--out', out,
      ],
      { timeout: 10_000 },
    );
    const img = nativeImage.createFromPath(out);
    if (img.isEmpty()) return null;
    const s = img.getSize();
    return { dataUrl: img.toDataURL(), width: s.width, height: s.height };
  } catch {
    return null;
  }
}

function getDisplayForWindow(win: BrowserWindow) {
  return screen.getDisplayMatching(win.getBounds());
}

export function getWinRect(win: BrowserWindow | null): WinRect | null {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  const d = getDisplayForWindow(win);
  // 物理像素尺寸：内置屏 3024×1964（scaleFactor=2，逻辑 1512×982），
  // 外接 4K 3840×2160（scaleFactor=1 或 2，逻辑同样 3840 或 1920）。
  // 这两种物理 aspect 不同（1.540 vs 1.778），cover-fit 必须用物理 aspect
  // 才能跟壁纸图片的物理像素比例对齐。
  const physW = d.size.width * d.scaleFactor;
  const physH = d.size.height * d.scaleFactor;
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    display: {
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
    },
    displayAspect: physW / physH,
  };
}

// 60fps throttle 用于高频推 winRect（几个 float，很便宜）。
// leading + trailing，保证静止瞬间也会推最后一帧。
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  waitMs: number,
): (...args: Parameters<T>) => void {
  let last = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  return (...args) => {
    const now = Date.now();
    const remaining = waitMs - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!trailing) {
      trailing = setTimeout(() => {
        last = Date.now();
        trailing = null;
        fn(...args);
      }, remaining);
    }
  };
}
