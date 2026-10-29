import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.PITWALL_API ?? 'http://127.0.0.1:7420';

export default defineConfig({
  root: 'web',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // Animation names stay global, so a module can use the keyframes that tokens.css shares.
  css: { transformer: 'lightningcss', lightningcss: { cssModules: { animation: false } } },
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
