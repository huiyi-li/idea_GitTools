import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  resolve: {
    dedupe: ['preact', '@codemirror/state', '@codemirror/view'],
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { target: 'es2022' },
});
