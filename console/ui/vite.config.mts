import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svgr(), react()],
  optimizeDeps: {
    exclude: ['js-big-decimal'],
  },
  preview: {
    port: 8080,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
      '@app': resolve(import.meta.dirname, './src/app'),
      '@assets': resolve(import.meta.dirname, './src/shared/assets'),
      '@entities': resolve(import.meta.dirname, './src/entities'),
      '@features': resolve(import.meta.dirname, './src/features'),
      '@pages': resolve(import.meta.dirname, './src/pages'),
      '@widgets': resolve(import.meta.dirname, './src/widgets'),
      '@shared': resolve(import.meta.dirname, './src/shared'),
    },
  },
});
