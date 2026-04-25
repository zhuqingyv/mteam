import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite 配置：启用 React 插件（支持 JSX、Fast Refresh）+ Tailwind CSS v4
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5180 },
});
