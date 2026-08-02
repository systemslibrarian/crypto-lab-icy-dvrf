import { expect, test, type Page } from '@playwright/test'

/**
 * Regression tests for the invariants users can SEE — the layer the unit
 * suite cannot reach: snapshot consistency, control locking, batch
 * traceability, effective-cast honesty, portable verification, and layout.
 */

async function setupAndPreprocess(page: Page): Promise<void> {
  await page.goto('.')
  await page.locator('#setup-btn').click()
  await expect(page.locator('#setup-out .groupkey')).toBeVisible()
  await page.locator('#pre-btn').click()
  await expect(page.locator('#pre-out .party-grid')).toBeVisible()
}

async function runFullWalk(page: Page): Promise<void> {
  await page.locator('#runall-btn').click()
  await expect(page.locator('#eval-out .beta-box')).toBeVisible()
}

test('upstream controls lock during a walk and unlock when it completes', async ({ page }) => {
  await setupAndPreprocess(page)
  await page.locator('#step-btn').click()
  await expect(page.locator('#eval-steps .step')).toHaveCount(1)
  // Mid-walk: nothing upstream of the transcript can change.
  for (const sel of ['#setup-btn', '#pre-btn', '#msg-input', '#n-input', '#t-input', '#break-btn']) {
    await expect(page.locator(sel), sel).toBeDisabled()
  }
  await expect(page.locator('input[name="roster"]').first()).toBeDisabled()
  await expect(page.locator('#cheat-1')).toBeDisabled()
  // Completing the walk unlocks everything.
  await page.locator('#runall-btn').click()
  await expect(page.locator('#eval-out .beta-box')).toBeVisible()
  for (const sel of ['#setup-btn', '#pre-btn', '#msg-input', '#n-input', '#break-btn']) {
    await expect(page.locator(sel), sel).toBeEnabled()
  }
})

test('the consumed nonce batch stays visible and the transcript names it', async ({ page }) => {
  await setupAndPreprocess(page)
  await expect(page.locator('#pre-out')).toContainText('Batch #1 — queued')
  await runFullWalk(page)
  // Historical evidence is preserved, not replaced: batch #1 shown as consumed
  // (with spent slots), batch #2 queued separately, and the walk cites #1.
  await expect(page.locator('#pre-out')).toContainText('Batch #1 — consumed')
  await expect(page.locator('#pre-out')).toContainText('Batch #2 — queued')
  await expect(page.locator('#pre-out .chip-warn', { hasText: 'spent' }).first()).toBeVisible()
  await expect(page.locator('#eval-steps')).toContainText('batch #1')
})

test('changing n/t after a ceremony flags the stale settings instead of lying', async ({ page }) => {
  await setupAndPreprocess(page)
  await page.locator('#n-input').fill('7')
  await expect(page.locator('#setup-stale')).toContainText('showing a 3-of-5 ceremony')
  await page.locator('#setup-btn').click()
  await expect(page.locator('#setup-stale')).toBeEmpty()
  await expect(page.locator('#setup-out')).toContainText('3-of-7')
})

test('cheat controls exist only for the selected roster and the cast is honest about it', async ({ page }) => {
  await setupAndPreprocess(page)
  // Parties 4 and 5 are not in the default roster {1,2,3}.
  await expect(page.locator('#cheat-4')).toBeDisabled()
  await expect(page.locator('#cheat-5')).toBeDisabled()
  await expect(page.locator('#cheat-2')).toBeEnabled()
  // A run with no participating cheats says exactly that.
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out')).toContainText('Every participant played honest')
  await expect(page.locator('#break-out .verdict-ok')).toBeVisible()
})

test('below-threshold roster refuses fail-closed', async ({ page }) => {
  await setupAndPreprocess(page)
  await page.locator('input[name="roster"][value="3"]').uncheck()
  await page.locator('#runall-btn').click()
  await expect(page.locator('#eval-out .verdict-warn')).toContainText('Refused — below threshold')
  await expect(page.locator('#eval-out .beta-box')).toHaveCount(0)
})

test('selective abort: withholder learns β, honest rerun publishes the identical β', async ({ page }) => {
  await setupAndPreprocess(page)
  await page.locator('#cheat-2').selectOption('withhold-response')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict-warn')).toContainText('Selective abort')
  const learned = (await page.locator('#break-out .beta-hex').textContent())!.trim()
  expect(learned).toMatch(/^[0-9a-f]{128}$/)
  await page.locator('#cheat-2').selectOption('honest')
  await page.locator('#honest-rerun-btn').click()
  await expect(page.locator('#break-out .verdict-ok')).toContainText('Honest threshold delivers')
  const published = (await page.locator('#break-out .beta-hex').textContent())!.trim()
  expect(published).toBe(learned)
})

/**
 * A MIXED cast (corrupted partial + withholder) must never present the round-1
 * aggregate as "the β the withholder already knew": that aggregate contains a
 * partial verification rejects, so it is not any publishable output. Both
 * sub-cases are pinned — the one where enough verified partials remain to
 * settle a real output, and the one where they do not.
 */
test('a mixed cast reports a contested aggregate, and settles on the verified subset', async ({
  page,
}) => {
  await setupAndPreprocess(page)
  // Widen the roster so the verified partials still reach t after the blame.
  await page.locator('input[name="roster"][value="4"]').check()
  await page.locator('input[name="roster"][value="5"]').check()
  await page.locator('#cheat-1').selectOption('corrupt-gamma')
  await page.locator('#cheat-2').selectOption('withhold-response')
  await page.locator('#break-btn').click()

  const out = page.locator('#break-out')
  await expect(out.locator('.verdict-warn')).toContainText('contested aggregate')
  // The discredited claim must be gone, and the value relabelled for what it is.
  await expect(out).not.toContainText('The β the withholder already knew')
  await expect(out.locator('.beta-box-contested h3')).toContainText('H(Γ), not β')
  // The verified subset is named, and the withholder is marked unverifiable
  // rather than silently folded in.
  await expect(out).toContainText('parties 3, 4, 5')
  await expect(out).toContainText('no z_i sent')

  const settled = (
    await out.locator('.beta-box:not(.beta-box-contested) .beta-hex').textContent()
  )!.trim()
  const contested = (await out.locator('.beta-box-contested .beta-hex').textContent())!.trim()
  expect(settled).toMatch(/^[0-9a-f]{128}$/)
  expect(settled).not.toBe(contested)

  // The honest rerun reproduces the settled value byte-for-byte — the mixed
  // cast no longer manufactures a "this should never happen" mismatch.
  await page.locator('#cheat-1').selectOption('honest')
  await page.locator('#cheat-2').selectOption('honest')
  await page.locator('#honest-rerun-btn').click()
  await expect(out.locator('.verdict-ok')).toContainText('Honest threshold delivers')
  await expect(out.locator('.compare-table')).toContainText('identical')
  await expect(out).not.toContainText('should never happen')
})

test('a mixed cast below threshold says plainly that nothing was determined', async ({ page }) => {
  await setupAndPreprocess(page)
  // The default roster is exactly t, so blaming one and withholding one leaves
  // a single verified partial — not enough to settle anything.
  await page.locator('#cheat-1').selectOption('corrupt-gamma')
  await page.locator('#cheat-2').selectOption('withhold-response')
  await page.locator('#break-btn').click()

  const out = page.locator('#break-out')
  await expect(out.locator('.verdict-warn')).toContainText('no output was learned')
  await expect(out).toContainText('nothing publishable')
  await expect(out).toContainText('Only 1 partial verified but t = 3')
  await expect(out).not.toContainText('The β the withholder already knew')
  // Exactly one β-shaped value on screen: the contested one, labelled as such.
  await expect(out.locator('.beta-box')).toHaveCount(1)
  await expect(out.locator('.beta-box-contested')).toHaveCount(1)
})

test('an exported envelope verifies in a fresh context; one flipped character fails, named', async ({
  page,
  context,
}) => {
  await setupAndPreprocess(page)
  await runFullWalk(page)
  const envelope = await page.locator('#export-box').inputValue()

  // Fresh page: no shared JS state with the producer.
  const other = await context.newPage()
  await other.goto('.')
  await other.locator('#wb-input').fill(envelope)
  await other.locator('#wb-verify-btn').click()
  await expect(other.locator('#wb-out .verdict-ok')).toContainText('Envelope verifies')

  // Flip one hex character of gamma: strict parse or verification must fail.
  const obj = JSON.parse(envelope)
  obj.gamma = obj.gamma.slice(0, 10) + (obj.gamma[10] === '0' ? '1' : '0') + obj.gamma.slice(11)
  await other.locator('#wb-input').fill(JSON.stringify(obj))
  await other.locator('#wb-verify-btn').click()
  await expect(other.locator('#wb-out .verdict-bad')).toBeVisible()

  // Garbage never reaches the curve math and says which field failed.
  await other.locator('#wb-input').fill('{"v":1,"nope":true}')
  await other.locator('#wb-verify-btn').click()
  await expect(other.locator('#wb-out .verdict-bad')).toContainText('Rejected before verification')
  await other.close()
})

test('no horizontal overflow in the longest completed states at 390px and 320px', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await setupAndPreprocess(page)
    await runFullWalk(page)
    await page.locator('#verify-btn').click()
    await expect(page.locator('#verify-out .compare-table')).toBeVisible()
    await page.locator('#cheat-2').selectOption('corrupt-gamma')
    await page.locator('#break-btn').click()
    await expect(page.locator('#break-out .verdict-bad')).toBeVisible()
    const { clientWidth, scrollWidth } = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(scrollWidth, `viewport ${width}px`).toBeLessThanOrEqual(clientWidth)
  }
})
