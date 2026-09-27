import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', watch: { ignored: ['**/shots/**', '**/test/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
