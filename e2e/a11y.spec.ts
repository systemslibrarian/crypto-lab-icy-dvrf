import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/**
 * Drive every exhibit into its post-interaction state before scanning — axe
 * only checks what's in the DOM, and the dynamic result regions are exactly
 * where contrast and live-region violations hide. The walk covers:
 * key ceremony → preprocessing → full stepped evaluation (steps, ladder
 * states, β/proof box) → subset comparison → public verification (equations
 * + compare table) → honest-cast break run → cheating cast (abort verdict,
 * blamed party cards, per-party check table).
 */
async function driveDemos(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important}`,
  })
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => {
      ;(d as HTMLDetailsElement).open = true
    })
  })

  // Exhibit 1 — key ceremony (n = 5, t = 3 defaults).
  await page.locator('#setup-btn').click()
  await expect(page.locator('#setup-out .groupkey')).toBeVisible()

  // Exhibit 2 — offline preprocessing.
  await page.locator('#pre-btn').click()
  await expect(page.locator('#pre-out .party-grid')).toBeVisible()

  // Exhibit 3 — one manual step (step-now highlight), then the rest.
  await page.locator('#step-btn').click()
  await expect(page.locator('#eval-steps .step')).toHaveCount(1)
  await page.locator('#runall-btn').click()
  await expect(page.locator('#eval-out .beta-box')).toBeVisible()

  // Exhibit 4 — subset comparison first, public verification last so the
  // equation rows and compare table are in the scanned DOM.
  await page.locator('#subset-btn').click()
  await expect(page.locator('#verify-out .compare-table')).toBeVisible()
  await page.locator('#verify-btn').click()
  await expect(page.locator('#verify-out .verdict-ok')).toBeVisible()

  // Verifier workbench — exported envelope round-trips into a verified state.
  const envelope = await page.locator('#export-box').inputValue()
  await page.locator('#wb-input').fill(envelope)
  await page.locator('#wb-verify-btn').click()
  await expect(page.locator('#wb-out .verdict-ok')).toBeVisible()

  // Exhibit 5 — selective abort (warn verdict + learned-β box)...
  await page.locator('#cheat-2').selectOption('withhold-response')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict-warn')).toBeVisible()
  // ...then a cheating cast: corrupt partial → abort verdict, blamed cards.
  await page.locator('#cheat-2').selectOption('corrupt-gamma')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict-bad')).toBeVisible()
  await expect(page.locator('#break-out .party-card.blamed')).toBeVisible()
  // ...and a MIXED cast, whose contested-aggregate box, unverifiable-partial
  // row and settled-subset box are markup no other run puts in the DOM.
  await page.locator('input[name="roster"][value="4"]').check()
  await page.locator('input[name="roster"][value="5"]').check()
  await page.locator('#cheat-1').selectOption('corrupt-gamma')
  await page.locator('#cheat-2').selectOption('withhold-response')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .beta-box-contested')).toBeVisible()
}

async function scan(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  expect(
    violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
    })),
  ).toEqual([])
}

test('no WCAG A/AA violations — dark theme', async ({ page }) => {
  await page.goto('.')
  await driveDemos(page)
  await scan(page)
})

test('no WCAG A/AA violations — light theme', async ({ page }) => {
  await page.goto('.')
  await page.locator('#cl-theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await driveDemos(page)
  await scan(page)
})
