import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
const S = (f) => path.resolve('src/shims', f);

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom', 'lucide-react'],
    alias: [
      { find: /^react-router-dom$/, replacement: path.resolve('src/router-shim.js') },
      { find: /^better-sqlite3$/, replacement: path.resolve('src/sqlite-adapter.js') },
      { find: /^express$/, replacement: path.resolve('src/express-shim.js') },
      { find: /^exceljs$/, replacement: S('exceljs.js') },
      { find: /^pdfkit$/, replacement: S('pdfkit.js') },
      { find: /^multer$/, replacement: S('multer.js') },
      { find: /^node:fs$/, replacement: S('fs.js') },
      { find: /^node:path$/, replacement: S('path.js') },
      { find: /^node:url$/, replacement: S('url.js') },
      { find: /^node:os$/, replacement: S('os.js') },
      { find: /^node:crypto$/, replacement: S('crypto.js') },
    ],
  },
  server: { fs: { allow: ['..'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 5000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
