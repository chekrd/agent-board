import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.AGENT_BOARD_API ?? 'http://127.0.0.1:7420';

export default defineConfig({
  root: 'web',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  css: { transformer: 'lightningcss' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext', cssMinify: 'lightningcss' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
});
