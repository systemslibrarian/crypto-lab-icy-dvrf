import { expect, test } from '@playwright/test'
import {
  boot,
  driveAllStates,
  expectBaselineNotStale,
  NARROW,
  reportCollected,
  watchPageErrors,
} from './gate'

/**
 * WCAG A/AA regression gate. Deploys are already gated on the RFC 9496 known-
 * answer vectors, the frozen transcript vectors and `ui.spec.ts`; this gates
 * them on accessibility the same way.
 *
 * The lab is driven along everything it teaches: the locked arrival state, where
 * seven controls are disabled and all six result regions are empty; the skip
 * link focused; the glossary opened through its summary; both sliders at both
 * extremes and a ceremony dealt at each; the nonce batch; one manual protocol
 * step, a reset, and the full run; public verification and the subset
 * comparison; the verifier workbench on a valid envelope, a tampered one and an
 * empty one; every cheat cast — selective abort, corrupt partial, nonce
 * grinding, absence, and the MIXED cast that is the only route to the contested
 * aggregate; the honest rerun; the empty-roster refusal; and a long unbroken
 * message echoed into the step log. Every one of those states is scanned, in
 * both themes, at desktop and phone width.
 *
 * See `gate.ts` for why nothing is injected into the page, why the disclosure is
 * opened by clicking rather than by setting `.open`, why the lab's defaults are
 * asserted rather than assumed, and why `violations` is not the whole oracle.
 */

for (const theme of ['dark', 'light'] as const) {
  test(`no WCAG A/AA violations — ${theme} theme`, async ({ page }) => {
    test.setTimeout(900_000)
    const errors = watchPageErrors(page)
    await boot(page, theme)
    await driveAllStates(page, theme)
    expect(errors, errors.join('\n')).toEqual([])
    reportCollected()

    // The third ratchet rule — a baselined finding that no longer appears must
    // be deleted, so the list can only shrink toward empty.
    // `expectBaselineNotStale` was exported from `gate.ts` and imported by
    // nothing, so it had never run and only two of the three rules were live.
    //
    // Called in all four configurations: both entries are produced by all four
    // drives, confirmed through the gate's own capture path rather than
    // assumed. (Sibling labs do not have that luxury — an accent-bordered
    // control fails in one theme only, and there the check has to be scoped to
    // the drive that sees it.)
    //
    // After `reportCollected()`, deliberately: in an `A11Y_COLLECT` run that
    // call throws to stop a collecting pass being read as green, and it should
    // keep doing so before this hard assertion fires.
    expectBaselineNotStale()
  })

  test(`no WCAG A/AA violations — ${theme} theme at 380px`, async ({ page }) => {
    test.setTimeout(900_000)
    const errors = watchPageErrors(page)
    await page.setViewportSize(NARROW)
    await boot(page, theme)
    await driveAllStates(page, `${theme} @380px`)
    expect(errors, errors.join('\n')).toEqual([])
    reportCollected()
    expectBaselineNotStale()
  })
}
