import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const output = fileURLToPath(new URL('./pages-dist', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./pages-src', import.meta.url)),
  base: '/IFA/',
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [
    react(),
    {
      name: 'github-pages-routes',
      closeBundle() {
        for (const route of ['colocalization', 'intensity']) {
          mkdirSync(`${output}/${route}`, { recursive: true });
          copyFileSync(`${output}/index.html`, `${output}/${route}/index.html`);
        }
        copyFileSync(`${output}/index.html`, `${output}/404.html`);
      },
    },
  ],
  build: {
    outDir: output,
    emptyOutDir: true,
  },
});
