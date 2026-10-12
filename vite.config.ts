import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    testTimeout: 30000,
    include: ['src/**/*.test.ts'],
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: 'index.html',
        cards: 'cards.html',
      },
    },
  },
});
