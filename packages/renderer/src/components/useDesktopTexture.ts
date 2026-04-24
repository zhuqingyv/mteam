// 接收 main 推来的壁纸 {dataUrl, width, height} + 窗口 rect，
// 解码成 Texture + 算 aspect 供 shader 做 cover-fit UV 映射。
//
// 性能拆分：
//   - state：texture / imgAspect — 壁纸变动才更新（30s 轮询级别），state 足够
//   - ref：winRectUV / dispAspect — 拖动 60Hz 推送，state 会触发 React 树
//     re-render 每帧一次 → 导致拖动卡顿。改成 ref 直接在 IPC 回调里 mutate，
//     consumer 在 useFrame 里每帧读进 uniform，整条链 0 次 React 渲染。
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

export type Rect = { x: number; y: number; width: number; height: number };
export type WinRectPayload = Rect & {
  display: Rect;
  // 物理像素 aspect（= display.size × scaleFactor）。壁纸 aspect 匹配用。
  displayAspect: number;
};
export type WallpaperPayload = { dataUrl: string; width: number; height: number };

export type DesktopState = {
  texture: THREE.Texture | null;
  imgAspect: number;
  // 下面两个是 ref：useFrame 里每帧读 .current 即可，拖动时不引发 React 渲染
  winRectUV: React.MutableRefObject<THREE.Vector4>;
  dispAspect: React.MutableRefObject<number>;
};

function toWinRectUV(rect: WinRectPayload | null): THREE.Vector4 {
  if (!rect) return new THREE.Vector4(0, 0, 1, 1);
  const dw = rect.display.width;
  const dh = rect.display.height;
  const uv = new THREE.Vector4(
    (rect.x - rect.display.x) / dw,
    (rect.y - rect.display.y) / dh,
    rect.width / dw,
    rect.height / dh,
  );
  // 调试：看窗口在屏幕中的归一化位置是否符合预期
  // xy 应为窗口左上 (0..1)，zw 应为窗口宽高比例 (~0.26, 0.30 对于 500×320 on 1920×1080)
  console.log(
    '[winRectUV]',
    uv.x.toFixed(3),
    uv.y.toFixed(3),
    uv.z.toFixed(3),
    uv.w.toFixed(3),
    '  win=',
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    '  display=',
    rect.display.x,
    rect.display.y,
    rect.display.width,
    rect.display.height,
  );
  return uv;
}

export function useDesktopTexture(): DesktopState {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [imgAspect, setImgAspect] = useState<number>(1);

  // ref 承载高频更新值。初始化为安全兜底（铺满整个 display、aspect=1）
  const winRectUV = useRef(new THREE.Vector4(0, 0, 1, 1));
  const dispAspect = useRef(1);

  useEffect(() => {
    let cancelled = false;
    let currentTex: THREE.Texture | null = null;

    const applyFrame = (payload: WallpaperPayload | null | undefined) => {
      if (!payload?.dataUrl || cancelled) return;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        currentTex?.dispose();
        currentTex = tex;
        setTexture(tex);
        setImgAspect(payload.width / payload.height);
      };
      img.src = payload.dataUrl;
    };

    const updateRect = (rect: WinRectPayload) => {
      const uv = toWinRectUV(rect);
      winRectUV.current.copy(uv);
      if (rect.displayAspect > 0) dispAspect.current = rect.displayAspect;
    };

    const api = window.electronAPI;
    if (!api?.getInitialFrame) return;

    void api.getInitialFrame().then((res) => {
      if (!res) return;
      applyFrame(res.frame);
      if (res.rect) updateRect(res.rect);
    });

    const unsubWallpaper = api.onWallpaperUpdate?.((payload) =>
      applyFrame(payload),
    );
    const unsubRect = api.onWindowRect?.((rect) => updateRect(rect));

    return () => {
      cancelled = true;
      unsubWallpaper?.();
      unsubRect?.();
      currentTex?.dispose();
    };
  }, []);

  return { texture, imgAspect, winRectUV, dispAspect };
}
