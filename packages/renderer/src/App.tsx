import { useState } from 'react';
import GlassCard3D from './components/GlassCard3D';
import ChatView from './components/ChatView';
import './styles/glass.css';

declare global {
  interface Window {
    electronAPI?: {
      resize: (width: number, height: number) => void;
    };
  }
}

const PET_SIZE = { width: 500, height: 320 };
const CHAT_SIZE = { width: 900, height: 680 };

type Mode = 'pet' | 'chat';

export default function App() {
  const [mode, setMode] = useState<Mode>('pet');

  // 点击液态体：窗口撑大 + 3D 放大动画
  const onExpandStart = () => {
    window.electronAPI?.resize(CHAT_SIZE.width, CHAT_SIZE.height);
  };

  // 放大动画完成后暂不切 ChatView，先看效果
  const onExpandDone = () => {
    // TODO: setMode('chat');
  };

  const collapse = () => {
    window.electronAPI?.resize(PET_SIZE.width, PET_SIZE.height);
    setMode('pet');
  };

  return mode === 'pet' ? (
    <GlassCard3D onExpandStart={onExpandStart} onExpandDone={onExpandDone} />
  ) : (
    <ChatView onCollapse={collapse} />
  );
}
