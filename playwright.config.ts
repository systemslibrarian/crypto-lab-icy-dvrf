import { defineConfig } from '@playwright/test'

/**
 * Accessibility gate. Tests run against the production build served by
 * `vite preview`, so what passes here is what actually ships to Pages.
 * Run `npm run build` first (CI does).
 */
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4368/crypto-lab-icy-dvrf/',
    colorScheme: 'dark',
  },
  webServer: {
    command: 'npm run preview -- --port 4368 --strictPort',
    url: 'http://localhost:4368/crypto-lab-icy-dvrf/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
