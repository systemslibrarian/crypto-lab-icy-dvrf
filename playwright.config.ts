import { defineConfig } from '@playwright/test'

/**
 * Accessibility gate. Tests run against the production build served by
 * `vite preview`, so what passes here is what actually ships to Pages.
 * The build runs as part of the webServer command, so a run always tests the
 * current source rather than whatever bundle happens to be sitting in dist/.
 */
// Overridable so a busy port on a dev box does not block the gate.
const PORT = process.env.PREVIEW_PORT ?? '4368'
const URL = `http://localhost:${PORT}/crypto-lab-icy-dvrf/`

export default defineConfig({
  testDir: './e2e',
  // Driving every exhibit (real curve math per click) plus two axe scans can
  // exceed the 30 s default on slower machines — measured headroom, no sleeps.
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: URL,
    colorScheme: 'dark',
  },
  webServer: {
    // Build first: `vite preview` only serves the existing dist/, so without
    // this a broken build leaves the last good bundle in place and the suite
    // passes green against source that no longer compiles.
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
