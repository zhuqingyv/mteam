import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// 应用入口：将 App 挂载到 index.html 的 #root 节点
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
