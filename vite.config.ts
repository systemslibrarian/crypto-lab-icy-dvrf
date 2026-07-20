/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/crypto-lab-icy-dvrf/',
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
