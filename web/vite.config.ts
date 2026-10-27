import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The demo lives in demo/; `npm run dev` serves it. The library itself is
// bundled by its consumers from src/ (package.json "exports").
export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      // Two demo pages: the System view (index.html) and the orbit brain (orbit.html).
      input: {
        index: fileURLToPath(new URL('./demo/index.html', import.meta.url)),
        orbit: fileURLToPath(new URL('./demo/orbit.html', import.meta.url)),
      },
    },
  },
});
