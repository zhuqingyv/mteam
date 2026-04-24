import { useState } from 'react';
import PetCard from './components/PetCard';
import ChatView from './components/ChatView';
import './styles/glass.css';

declare global {
  interface Window {
    electronAPI?: {
      resize: (width: number, height: number) => void;
    };
  }
}

const PET_SIZE = { width: 220, height: 96 };
const CHAT_SIZE = { width: 900, height: 680 };

type Mode = 'pet' | 'chat';

export default function App() {
  const [mode, setMode] = useState<Mode>('pet');

  const expand = () => {
    window.electronAPI?.resize(CHAT_SIZE.width, CHAT_SIZE.height);
    setMode('chat');
  };

  const collapse = () => {
    window.electronAPI?.resize(PET_SIZE.width, PET_SIZE.height);
    setMode('pet');
  };

  return mode === 'pet' ? (
    <PetCard face="(^_^)" text="嗨嗨，我在这里陪你~" onClick={expand} />
  ) : (
    <ChatView onCollapse={collapse} />
  );
}
