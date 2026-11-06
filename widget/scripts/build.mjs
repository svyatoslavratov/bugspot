// Builds the widget into ../internal/widgetfs/dist, which the Go binary embeds:
//   1. the app: an ES module with hashed chunks in assets/;
//   2. the loader: widget.js (IIFE), which knows the app entry file name.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../../internal/widgetfs/dist', import.meta.url));

await build({
  root,
  configFile: false,
  base: './',
  plugins: [react()],
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    manifest: true,
    target: 'es2020',
    cssCodeSplit: false,
    reportCompressedSize: false,
    rolldownOptions: {
      input: { app: 'src/app/main.tsx' },
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

const manifest = JSON.parse(await readFile(`${outDir}/.vite/manifest.json`, 'utf8'));
const entry = manifest['src/app/main.tsx'].file;
await rm(`${outDir}/.vite`, { recursive: true, force: true });

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  define: { __APP_ENTRY__: JSON.stringify(entry) },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'es2020',
    reportCompressedSize: false,
    lib: { entry: 'src/loader.ts', name: 'bugspotLoader', formats: ['iife'], fileName: () => 'widget.js' },
  },
});

await writeFile(
  `${outDir}/README.md`,
  '# Built widget\n\n`make widget` writes widget.js and assets/ here; the Go binary embeds them.\n',
);
console.log(`widget built: widget.js → ${entry}`);
