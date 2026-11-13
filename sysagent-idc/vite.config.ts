import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { demoApi } from './demo-api';
import { version } from './package.json';

export default defineConfig({
  plugins: [react(), demoApi()],
  base: './',
  define: { 'import.meta.env.VITE_SYSAGENT_VERSION': JSON.stringify(version) },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
