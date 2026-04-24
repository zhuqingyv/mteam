import { useState } from 'react';
import GlassCard3D from './components/GlassCard3D';
import ChatView from './components/ChatView';
import './styles/glass.css';

type Rect = { x: number; y: number; width: number; height: number };
type WinRect = Rect & { display: Rect; displayAspect: number };
type Wallpaper = { dataUrl: string; width: number; height: number };

declare global {
  interface Window {
    electronAPI?: {
      resize: (width: number, height: number) => void;
      getInitialFrame: () => Promise<{
        frame: Wallpaper | null;
        rect: WinRect | null;
      }>;
      onWallpaperUpdate: (cb: (payload: Wallpaper) => void) => () => void;
      onWindowRect: (cb: (rect: WinRect) => void) => () => void;
    };
  }
}

const PET_SIZE = { width: 500, height: 320 };
const CHAT_SIZE = { width: 900, height: 680 };

type Mode = 'pet' | 'chat';

// 展开动画曲线由 3D 侧推进（useFrame 里的 easeOutCubic），
// 这里收到的 t 已经是线性 0→1 进度；乘上宽高差即可同拍推送窗口 resize。
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export default function App() {
  const [mode, setMode] = useState<Mode>('pet');

  const onExpandProgress = (t: number) => {
    const w = Math.round(lerp(PET_SIZE.width, CHAT_SIZE.width, t));
    const h = Math.round(lerp(PET_SIZE.height, CHAT_SIZE.height, t));
    window.electronAPI?.resize(w, h);
  };

  // 3D 动画完成后暂不切 ChatView，先看效果
  const onExpandDone = () => {
    // TODO: setMode('chat');
  };

  const collapse = () => {
    window.electronAPI?.resize(PET_SIZE.width, PET_SIZE.height);
    setMode('pet');
  };

  return mode === 'pet' ? (
    <GlassCard3D onExpandProgress={onExpandProgress} onExpandDone={onExpandDone} />
  ) : (
    <ChatView onCollapse={collapse} />
  );
}
