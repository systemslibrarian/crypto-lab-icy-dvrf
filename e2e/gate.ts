import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import { auditContrast, formatContrastFailures } from './contrast'
import { auditNonText, formatNonTextFailures } from './nontext'
import { NONTEXT_BASELINE } from './nontext-baseline';

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/** A phone-width viewport, for the WCAG 1.4.10 reflow half of the gate. */
export const NARROW = { width: 380, height: 800 }

/**
 * Shared machinery for the WCAG gate.
 *
 * Five rules govern everything here, each one a correction of the gate this
 * replaces:
 *
 *  1. NOTHING IS INJECTED INTO THE PAGE BEFORE A SCAN. `driveDemos()` pushed
 *     `animation:none!important; transition:none!important` at
 *     `*,*::before,*::after` through `addStyleTag`. That BYPASSED this
 *     stylesheet's own `prefers-reduced-motion` block instead of exercising it,
 *     and this page has exactly the shape that makes the difference matter: the
 *     `.msg-chip` protocol-message chips animate `chip-in`, which starts at
 *     `opacity: 0`. If the reduced-motion block ever cancelled that animation
 *     without a declared end state, every chip would render invisible for every
 *     reader with the preference set — and an injected `animation: none` would
 *     hide that, because it produces the same rendering by a different route.
 *     `boot` asks for the preference, ASSERTS it took effect, and
 *     `expectNotBlank` measures the outcome in every state.
 *
 *  2. IT FORCE-OPENED THE DISCLOSURE FROM SCRIPT. `driveDemos()` set
 *     `details.open = true` directly. This gate clicks the `<summary>`, which
 *     is the only route a reader has.
 *
 *  3. IT SCANNED ONCE, AT ONE VIEWPORT, AFTER THE WHOLE DRIVE. Every state the
 *     walk built — the locked arrival state, the ceremony, the nonce batch, the
 *     single stepped round, the reset, the subset comparison, the workbench, and
 *     three of the four cheat casts — was overwritten before anything measured
 *     it. Only the final MIXED-cast rendering was ever scanned, in one theme at
 *     one width. This drive scans after every step, in {dark, light} x
 *     {1280, 380}.
 *
 *  4. `violations` IS NOT THE WHOLE ORACLE. See `scan`. Two things on this page
 *     are invisible to a violations-only assertion in particular: every verdict,
 *     chip and status surface is an `rgba()` wash over a panel, which axe files
 *     under `incomplete`; and SC 1.4.11 has no axe rule at all, which is where
 *     this lab's real defects were.
 *
 *  5. IT HAD NO REFLOW OR KEYBOARD-SCROLLER ORACLE, and this page needs both.
 *     Every table on the page carries 64-hex-character values inside a
 *     `.table-scroll` wrapper, and those wrappers only overflow once a run has
 *     produced values to put in them — a 2.1.1 failure that exists only in a
 *     state the drive has to go and build.
 */

/**
 * Wait for every running animation and transition to drain.
 *
 * Transitions drain in waves, not in one batch, so a poll for "nothing running
 * right now" can exit through a gap between waves. Require quiescence to hold
 * for several consecutive frames instead.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __quietFrames?: number }
      const running = document.getAnimations().filter((a) => a.playState === 'running')
      w.__quietFrames = running.length === 0 ? (w.__quietFrames ?? 0) + 1 : 0
      return w.__quietFrames >= 6
    },
    undefined,
    { timeout: 20_000, polling: 'raf' },
  )
}

/**
 * Assert that reduced motion left the page visible, not merely un-animated.
 *
 * The failure mode this guards against is an element whose only route to its
 * visible state is an animation, in a stylesheet whose reduced-motion block
 * cancels that animation without restoring its end state — the element then
 * renders at `opacity: 0` for every reader with the preference set.
 *
 * This page is one edit away from that shape, which is why the check runs in
 * every state rather than once. `.msg-chip` carries `animation: chip-in`, whose
 * `from` is `opacity: 0`, and the reduced-motion block cancels it with
 * `animation: none`. That is currently safe only because `.msg-chip` declares no
 * `opacity` of its own, so cancelling the animation leaves the initial value of
 * 1. Every round-1 and round-2 message chip in Exhibit 3 depends on that.
 */
async function expectNotBlank(page: Page, label: string): Promise<void> {
  const invisible = await page.evaluate(() => {
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim()
      if (!own) continue
      // Deliberately hidden subtrees are not "blank", they are closed.
      if (!(el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true })) continue
      let effective = 1
      let node: Element | null = el
      while (node) {
        effective *= parseFloat(getComputedStyle(node).opacity)
        node = node.parentElement
      }
      if (effective === 0) {
        out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}`)
      }
    }
    return Array.from(new Set(out))
  })
  expect(invisible, `no visible text may render at opacity 0 in state: ${label}`).toEqual([])
}

/**
 * Uncaught page errors and console errors, collected from the moment the page
 * is created. This lab runs real ristretto255 arithmetic on every click and
 * writes each result into a `role="status"` region with `innerHTML`; a throw
 * halfway through leaves the PREVIOUS result on screen, and a gate that scans
 * that state reports green for a page that is broken. Attach before `boot`,
 * assert after the drive.
 */
export function watchPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/**
 * Exactly one banner landmark: the shared bar.
 *
 * The lab's own `<header class="cl-hero">` renders inside `<main>`, which scopes
 * it out of the banner role by nesting alone — `index.html`'s `dedupeBanner()`
 * never has to touch it. Asserting the OUTCOME rather than either mechanism
 * means a change to the nesting is caught as well as a change to the script.
 */
export async function assertSingleBanner(page: Page): Promise<void> {
  const banners = await page.evaluate(() => {
    const scoped = new Set(['MAIN', 'ARTICLE', 'ASIDE', 'NAV', 'SECTION'])
    const isBanner = (el: Element): boolean => {
      if (el.getAttribute('role') === 'banner') return true
      if (el.tagName !== 'HEADER') return false
      if (el.getAttribute('role')) return false // explicit non-banner role wins
      for (let p = el.parentElement; p; p = p.parentElement) if (scoped.has(p.tagName)) return false
      return true
    }
    return [...document.querySelectorAll('header,[role="banner"]')].filter(isBanner).length
  })
  expect(banners, 'exactly one banner landmark').toBe(1)
}

/** The six controls that ship DISABLED until a prerequisite has been run. */
export const LOCKED_CONTROLS = [
  '#pre-btn',
  '#step-btn',
  '#runall-btn',
  '#verify-btn',
  '#subset-btn',
  '#break-btn',
  '#honest-rerun-btn',
] as const

/**
 * Load the page in a known theme with reduced motion actually in effect, and
 * assert the content every scan relies on is really on the page — including the
 * lab's DEFAULTS, which are never assumed.
 *
 * `test.use({ reducedMotion })` silently does nothing on Playwright 1.61.1, so
 * the emulation is applied imperatively BEFORE the navigation and then
 * *asserted* from inside the page.
 *
 * The theme is seeded through `localStorage` rather than by clicking the toggle,
 * which also pins down a real failure mode: `index.html`'s anti-flash script
 * reads `localStorage.getItem('theme')` and the shared bar's toggle writes
 * `localStorage.setItem('theme', …)`. If those keys drift apart the theme
 * silently stops persisting, and this boot fails on `data-theme` rather than
 * quietly scanning dark twice.
 *
 * The defaults are asserted at length because this lab ships almost entirely
 * LOCKED and EMPTY: seven controls are `disabled`, all six `.result` regions are
 * empty (and `:empty { display: none }`, so they are not even boxes yet), the
 * roster and the cheat cast do not exist until a ceremony has been dealt, and
 * the two sliders carry the n = 5 / t = 3 the whole page is written around.
 * That arrival state is the first one every reader sees, and the gate this
 * replaces never scanned it.
 */
export async function boot(page: Page, theme: 'dark' | 'light'): Promise<void> {
  // A click on a control that never becomes actionable otherwise burns the whole
  // test timeout and reports nothing useful. 20s turns that silent hang into a
  // named failure naming the locator.
  page.setDefaultTimeout(20_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((t) => localStorage.setItem('theme', t), theme)
  await page.goto('.')
  expect(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    'reduced-motion emulation must actually be in effect',
  ).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await assertSingleBanner(page)

  // ── Everything this lab computes ships absent ───────────────────────────
  await expect(page.locator('#setup-btn')).toBeEnabled()
  for (const sel of LOCKED_CONTROLS) await expect(page.locator(sel)).toBeDisabled()
  for (const sel of ['#setup-out', '#pre-out', '#eval-out', '#verify-out', '#export-out', '#break-out']) {
    await expect(page.locator(sel)).toBeEmpty()
  }
  await expect(page.locator('#roster-checks input[name="roster"]')).toHaveCount(0)
  await expect(page.locator('#cheat-controls select')).toHaveCount(0)

  // ── Every shipped control default ────────────────────────────────────────
  // The whole page's prose is written around n = 5, t = 3; a slider that shipped
  // at a different value would make the exhibits contradict the text around them.
  await expect(page.locator('#n-input')).toHaveValue('5')
  await expect(page.locator('#t-input')).toHaveValue('3')
  await expect(page.locator('#n-value')).toHaveText('5')
  await expect(page.locator('#t-value')).toHaveText('3')
  await expect(page.locator('#msg-input')).toHaveValue('beacon round #42')
  await expect(page.locator('#wb-input')).toHaveValue('')

  // The one disclosure ships shut.
  await expect(page.locator('details')).toHaveCount(1)
  await expect(page.locator('details[open]')).toHaveCount(0)

  await settle(page)
  await expectNotBlank(page, `${theme} first paint`)
}

/**
 * Assert the page does not require horizontal scrolling.
 *
 * WCAG 1.4.10 (Reflow, AA). axe has no rule for this at all, and this page is a
 * plausible offender: every result region prints 64-hex-character points and
 * scalars, the message input is free text echoed into the step log, and the
 * cheat cast is a row of `<select>`s whose width comes from their widest option.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    // `body { overflow-x: hidden }` propagates to the viewport when `html`
    // leaves `overflow` at `visible`, so `scrollWidth` stays equal to
    // `clientWidth` even when content is CUT OFF — a worse 1.4.10 outcome than
    // a scrollbar, and invisible to the standard check. This lab does NOT have
    // that rule today; the test is kept because adding one is the usual way a
    // reflow failure gets "fixed", and this oracle has to survive that.
    const clippedByViewport = ['hidden', 'clip'].includes(
      getComputedStyle(document.body).overflowX,
    )
    if (!clippedByViewport && doc.scrollWidth <= doc.clientWidth) return null

    // Only elements that actually push the DOCUMENT sideways are culprits. Every
    // hex table here has a huge bounding rect but is clipped by its own
    // `.table-scroll` and contributes nothing to the document's scroll width —
    // naming it sends you off fixing the wrong element, which has cost a run
    // elsewhere in this fleet.
    const clipped = (el: Element): boolean => {
      let n = el.parentElement
      // Stop BEFORE <body>. When `body { overflow-x: hidden }` propagates to the
      // viewport, body itself answers "hidden" to this walk — so every element
      // on the page reads as clipped, `escaping` is always empty, and the oracle
      // reports nothing at all. That is the failure this whole check exists to
      // avoid: a viewport-level clip is the DEFECT, not a legitimate scroller.
      // Only a genuine scrolling container INSIDE the page excuses an overflow.
      while (n && n !== doc && n !== document.body) {
        const ox = getComputedStyle(n).overflowX
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true
        n = n.parentElement
      }
      return false
    }

    const over = Array.from(document.querySelectorAll('body *'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > doc.clientWidth + 1)
      .sort((a, b) => b.r.right - a.r.right)
    // Anything inside a real scroller is reachable and is not a finding; only
    // what escapes the viewport with no way back is. With the viewport clipping,
    // falling back to the widest CLIPPED element would report a decoy forever.
    const escaping = over.filter((x) => !clipped(x.el))
    if (!escaping.length) return null
    const widest = escaping[0]!
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      widest:
        `${widest.el.tagName.toLowerCase()}${widest.el.id ? '#' + widest.el.id : ''}` +
        `${widest.el.getAttribute('class') ? '.' + widest.el.getAttribute('class')!.trim().split(/\s+/).join('.') : ''}` +
        ` @${Math.round(widest.r.width)}px right=${Math.round(widest.r.right)}`,
    }
  })
  expect(overflow, `page must not scroll horizontally in state: ${label}`).toBeNull()
}

/**
 * Every scrolling container must be operable from the keyboard (WCAG 2.1.1).
 * If it holds no focusable content it needs `tabindex="0"`, so it becomes a
 * focus target arrow keys can then scroll.
 *
 * This is the check the old gate had no equivalent of, and the one this page
 * most needed: `.table-scroll` is the wrapper around every comparison and
 * per-party check table, it is `overflow-x: auto`, and it holds nothing
 * focusable — but it only scrolls once a run has put 64-hex-character values
 * inside it, so the failure exists only in states a drive has to build.
 */
export async function expectScrollersReachable(page: Page, label: string): Promise<void> {
  const unreachable = await page.evaluate(() => {
    const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'
    return Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .filter((el) => {
        const cs = getComputedStyle(el)
        return (
          ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)
        )
      })
      .filter((el) => el.tabIndex < 0 && !el.querySelector(FOCUSABLE))
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}` +
          ` (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`,
      )
  })
  expect(
    Array.from(new Set(unreachable)),
    `scrolling regions with no keyboard route in state: ${label}`,
  ).toEqual([])
}

/**
 * SC 1.4.11 and generated content live in `nontext.ts`.
 *
 * There was no such check here before, and the palette shows exactly why one was
 * needed. `style.css` defines `--border-strong` with a comment deriving six
 * ratios for it — and applies it to three rules: `input[type='text']`,
 * `textarea.envelope-box` and `select`. Those are the three controls whose fill
 * is `--code-bg`, which is the case the token was written for and correctly
 * solves. Every BUTTON on this page draws its boundary from `--accent`
 * (`#4fd0e0`, the same value in both themes) or from `--accent-border`, and
 * neither was ever measured against anything. Do not narrow this back to the
 * inputs; that is precisely the set the token was already kept for.
 *
 * One exclusion is applied here rather than in `nontext.ts`: the shared top bar.
 * It is not this lab's to change — every repo in the fleet carries a copy — and
 * its `.cl-btn` boundary (`color-mix(in srgb, var(--accent) 38%, transparent)`
 * over `#0b1512`) measures under 3:1 here as it does everywhere. That is
 * reported upward as a fleet-wide observation rather than patched in one repo,
 * and it is written down so the exclusion is a decision and not an oversight.
 */
const SHARED_HEADER_PREFIXES = ['a.cl-skip-link', 'button#cl-theme-toggle', 'a.cl-btn']

/**
 * When `A11Y_COLLECT` is set, `scan` records failures instead of throwing.
 *
 * A strict gate reports the first failing assertion in the first failing state
 * and stops, so a page with defects in several states needs one full run per
 * defect to enumerate them. The collection pass turns that into a single run. It
 * is a debugging aid only: `A11Y_COLLECT` is never set in CI or in the committed
 * workflow, and a run with it set prints every finding as it happens and then
 * fails at the end, so a green collection run cannot be mistaken for a green
 * gate.
 */
const COLLECTING = !!process.env.A11Y_COLLECT
const collected: string[] = []

function record(entry: string): void {
  collected.push(entry)
  // Printed as it happens, not only at the end: a hard assertion later in the
  // drive would otherwise abort the test before anything collected so far was
  // ever shown.
  console.log(`\n[A11Y_COLLECT #${collected.length}] ${entry}`)
}

export function softExpect(actual: unknown, message: string, expected: unknown): void {
  if (!COLLECTING) {
    expect(actual, message).toEqual(expected)
    return
  }
  try {
    expect(actual, message).toEqual(expected)
  } catch {
    record(`${message}\n  ${JSON.stringify(actual, null, 2)}`)
  }
}

/**
 * Fail the test if the collection pass recorded anything. Without this a
 * collection run would end green, and a green collection run is
 * indistinguishable from a green gate — which is the exact confusion the whole
 * exercise exists to remove.
 */
export function reportCollected(): void {
  if (!COLLECTING) return
  expect(collected, `A11Y_COLLECT recorded ${collected.length} failure(s)`).toEqual([])
}

async function expectScrollersReachableSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectScrollersReachable(page, label)
  try {
    await expectScrollersReachable(page, label)
  } catch (e) {
    record(String(e).slice(0, 900))
  }
}

async function expectNoHorizontalOverflowSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectNoHorizontalOverflow(page, label)
  try {
    await expectNoHorizontalOverflow(page, label)
  } catch (e) {
    record(String(e).slice(0, 900))
  }
}

/**
 * Scan the page as it currently stands.
 *
 * Seven assertions, because axe's `violations` array alone is not a complete
 * oracle:
 *
 *  - reduced-motion end state — see `expectNotBlank`.
 *  - `violations` — the usual WCAG A/AA rule failures.
 *  - `incomplete` — axe's "could not decide" bucket, which never reaches the
 *    violations array. The one rule id allowed to remain incomplete is
 *    `color-contrast`, and only because the next assertion computes those ratios
 *    arithmetically — which matters more here than in most labs, since every
 *    verdict, chip and blamed-party surface is an `rgba()` wash over a panel.
 *    Everything else in that bucket is a real result axe simply could not
 *    finish — including `aria-prohibited-attr`, which is where an `aria-label`
 *    on a role-less element hides, a defect that never reaches the violations
 *    array at all.
 *  - arithmetic contrast — composite-aware WCAG 1.4.3 over every text node.
 *  - non-text contrast for controls, and the ink of every `::before`/`::after`
 *    — SC 1.4.11 and 1.4.3 for generated content, neither of which axe has any
 *    rule for and neither of which the element walk in `contrast.ts` can reach.
 *  - keyboard reachability of scrolling regions — WCAG 2.1.1.
 *  - reflow — WCAG 1.4.10, which axe has no rule for at all.
 */
/**
 * WCAG 1.4.11 and generated content, ratcheted against a per-repo baseline.
 *
 * Neither class has ANY other oracle: axe has no rule for non-text contrast,
 * and the arithmetic text walk cannot reach a control's boundary or a
 * `::before` glyph, because a pseudo-element is not an element and owns no text
 * node. Both were being found by hand-sampling screenshot pixels, which does
 * not regress-test.
 *
 * The backlog is real, so this does not block on it — but a check that merely
 * logs is not a gate, and this sweep has spent its whole length deleting checks
 * that could not fail. So it ratchets instead: anything NOT in the baseline
 * fails, anything in the baseline that got WORSE fails, and anything in the
 * baseline that has been FIXED fails until its entry is deleted. That last rule
 * is what stops the allowlist becoming a permanent exemption.
 */
const nonTextSeen = new Set<string>();

export async function expectNoNewNonTextFailures(page: Page, label: string): Promise<void> {
  const found = await auditNonText(page);
  // Capture mode: emit every finding and assert nothing, so a baseline can be
  // generated by the SAME path that checks it. Opt-in via env, and the run is
  // deliberately left failing at the end by `expectBaselineNotStale` so a
  // capture pass can never be mistaken for a passing gate.
  if (process.env.NT_BASELINE_CAPTURE) {
    for (const f of found) {
      console.log(`NTCAP|${f.kind}|${f.selector}|${f.ratio}|${f.required}|${/POSITIONED/.test(f.detail)}`);
    }
    return;
  }
  const problems: string[] = [];
  for (const f of found) {
    const key = `${f.kind}|${f.selector}`;
    nonTextSeen.add(key);
    const base = NONTEXT_BASELINE[key];
    if (!base) {
      problems.push(`NEW ${f.ratio}:1 (needs ${f.required}:1) [${f.kind}] ${f.selector} — ${f.detail}`);
    } else if (f.ratio < base.ratio - 0.01) {
      problems.push(
        `WORSE ${f.selector}: ${f.ratio}:1, baseline recorded ${base.ratio}:1`
      );
    }
  }
  expect(problems, `new or worsened non-text contrast in state: ${label}`).toEqual([]);
}

/**
 * Fail if a baselined finding never appeared during the whole drive.
 *
 * It has either been fixed — in which case delete the entry, which is the point
 * — or the drive stopped reaching the state that shows it, which is a coverage
 * regression worth knowing about. Call once, after `driveAllStates`.
 */
export function expectBaselineNotStale(): void {
  const unseen = Object.keys(NONTEXT_BASELINE).filter((k) => !nonTextSeen.has(k));
  expect(
    unseen,
    'baselined non-text findings that no longer appear — delete them from nontext-baseline.ts (or restore the drive state that showed them)'
  ).toEqual([]);
}

export async function scan(page: Page, label: string): Promise<void> {
  await settle(page)
  await expectNotBlank(page, label)
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()

  const violations = results.violations.map((v) => ({
    state: label,
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
  }))
  softExpect(violations, `axe violations in state: ${label}`, [])

  const unexplainedIncomplete = results.incomplete
    .filter((v) => v.id !== 'color-contrast')
    .map((v) => ({
      state: label,
      id: v.id,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
    }))
  softExpect(unexplainedIncomplete, `axe incomplete results in state: ${label}`, [])

  const contrast = Array.from(new Set(formatContrastFailures(await auditContrast(page))))
  softExpect(contrast, `measured contrast failures in state: ${label}`, [])

  const nonText = (await auditNonText(page)).filter(
    (f) => !SHARED_HEADER_PREFIXES.some((p) => f.selector.startsWith(p)),
  )
  softExpect(
    Array.from(new Set(formatNonTextFailures(nonText))),
    `non-text contrast (SC 1.4.11) and generated content in state: ${label}`,
    [],
  )

  await expectScrollersReachableSoft(page, label)
  await expectNoHorizontalOverflowSoft(page, label)
  await expectNoNewNonTextFailures(page, label);
}

// ── The drive ───────────────────────────────────────────────────────────────

/** Focus the shared skip link so its "hidden until focused" state is measured. */
async function focusSkipLink(page: Page): Promise<void> {
  await page.locator('.cl-skip-link').focus()
  await expect(page.locator('.cl-skip-link')).toBeFocused()
}

/** Set a range input to a value and assert its `<output>` followed. */
async function setSlider(page: Page, id: string, value: string, out: string): Promise<void> {
  await page.locator(id).fill(value)
  await expect(page.locator(out)).toHaveText(value)
}

/** Deal a fresh ceremony with the sliders where they currently sit. */
async function runCeremony(page: Page, parties: number): Promise<void> {
  await page.locator('#setup-btn').click()
  await expect(page.locator('#setup-out .groupkey')).toBeVisible()
  await expect(page.locator('#roster-checks input[name="roster"]')).toHaveCount(parties)
  await expect(page.locator('#pre-btn')).toBeEnabled()
}

/**
 * Drive the lab through the states that render content, scanning each.
 *
 * The shape is set by the lab's prerequisite chain, which is strict: nothing
 * works until a ceremony has been dealt, the evaluation needs a published nonce
 * batch on top of that, verification and the subset comparison need a completed
 * evaluation, and the honest rerun needs a cheating cast to have run first. So
 * the order is locked state -> slider extremes -> ceremony -> preprocessing ->
 * one manual step -> reset -> full run -> verify -> subset -> workbench (valid,
 * tampered and empty) -> each cheat cast -> honest rerun -> empty roster.
 */
export async function driveAllStates(page: Page, theme: string): Promise<void> {
  const s = (label: string): Promise<void> => scan(page, `${theme} / ${label}`)

  // ── The arrival state: one enabled control, six empty result regions ─────
  await s('first paint (all locked)')

  await focusSkipLink(page)
  await s('skip link focused')

  // The one disclosure, opened through its own summary rather than from script.
  const gloss = page.locator('details').first()
  await gloss.locator('summary').click()
  await expect(gloss).toHaveAttribute('open', '')
  await s('glossary disclosure open')

  // ── Both sliders at both extremes ───────────────────────────────────────
  // `syncThresholdRange` couples them (t <= n), so the maximum and the minimum
  // are genuinely different renderings of the same two controls, and the party
  // grid they produce is a different size in each.
  await setSlider(page, '#n-input', '7', '#n-value')
  await setSlider(page, '#t-input', '5', '#t-value')
  await s('sliders at maximum (n=7, t=5)')
  await runCeremony(page, 7)
  await s('ceremony at n=7, t=5')

  await setSlider(page, '#n-input', '2', '#n-value')
  await expect(page.locator('#t-value')).toHaveText('2')
  await s('sliders at minimum (n=2, t=2)')
  await runCeremony(page, 2)
  await s('ceremony at n=2, t=2')

  // Back to the defaults the page's prose is written around, for the rest.
  await setSlider(page, '#n-input', '5', '#n-value')
  await setSlider(page, '#t-input', '3', '#t-value')
  await runCeremony(page, 5)
  await s('ceremony at the shipped n=5, t=3')

  // ── Exhibit 2: offline preprocessing ────────────────────────────────────
  await page.locator('#pre-btn').click()
  await expect(page.locator('#pre-out .party-grid')).toBeVisible()
  await expect(page.locator('#step-btn')).toBeEnabled()
  await s('nonce commitments published')

  // ── Exhibit 3: one manual step, then a reset, then the full run ─────────
  await page.locator('#step-btn').click()
  await expect(page.locator('#eval-steps .step')).toHaveCount(1)
  await s('one protocol step revealed')

  await page.locator('#reset-eval-btn').click()
  await expect(page.locator('#eval-steps .step')).toHaveCount(0)
  await s('evaluation reset')

  await page.locator('#runall-btn').click()
  await expect(page.locator('#eval-out .beta-box')).toBeVisible()
  await expect(page.locator('#verify-btn')).toBeEnabled()
  await s('full evaluation run')

  // ── Exhibit 4: public verification and the subset comparison ────────────
  await page.locator('#verify-btn').click()
  await expect(page.locator('#verify-out .verdict-ok')).toBeVisible()
  await s('public verification')

  await page.locator('#subset-btn').click()
  await expect(page.locator('#verify-out .compare-table')).toBeVisible()
  await s('subset comparison')

  // ── The verifier workbench: valid, tampered, and empty ──────────────────
  const envelope = await page.locator('#export-box').inputValue()
  expect(envelope.length, 'the export box must hold a real envelope').toBeGreaterThan(100)

  await page.locator('#wb-input').fill(envelope)
  await page.locator('#wb-verify-btn').click()
  await expect(page.locator('#wb-out .verdict-ok')).toBeVisible()
  await s('workbench: valid envelope')

  // One flipped hex character. The error verdict names the field that failed,
  // and that rendering exists in no other state.
  const tampered = envelope.replace(/([0-9a-f]{16})/, (m) => (m[0] === 'a' ? 'b' : 'a') + m.slice(1))
  expect(tampered, 'the tamper must actually change the envelope').not.toBe(envelope)
  await page.locator('#wb-input').fill(tampered)
  await page.locator('#wb-verify-btn').click()
  await expect(page.locator('#wb-out .verdict-bad')).toBeVisible()
  await s('workbench: tampered envelope rejected')

  await page.locator('#wb-input').fill('')
  await page.locator('#wb-verify-btn').click()
  await expect(page.locator('#wb-out')).not.toBeEmpty()
  await s('workbench: empty input')

  // ── Exhibit 5: every branch of the cheat fork ───────────────────────────
  // Each cast produces markup no other cast does, which is why all four run.
  await page.locator('#cheat-2').selectOption('withhold-response')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict-warn')).toBeVisible()
  await expect(page.locator('#break-out .beta-box')).toBeVisible()
  await s('cheat cast: selective abort (β learned, publication censored)')

  // The honest rerun is armed only by a cheating run, and its whole point is the
  // byte-for-byte comparison against the β the withholder already had.
  await expect(page.locator('#honest-rerun-btn')).toBeEnabled()
  await page.locator('#honest-rerun-btn').click()
  await expect(page.locator('#break-out .compare-table')).toBeVisible()
  await s('honest rerun after the abort')

  await page.locator('#cheat-2').selectOption('corrupt-gamma')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict-bad')).toBeVisible()
  await expect(page.locator('#break-out .party-card.blamed')).toBeVisible()
  await s('cheat cast: corrupt partial (blamed party cards)')

  await page.locator('#cheat-2').selectOption('grind-nonce')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict')).toBeVisible()
  await s('cheat cast: nonce grinding')

  await page.locator('#cheat-2').selectOption('absent')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict')).toBeVisible()
  await s('cheat cast: absent party')

  // A MIXED cast — one corrupt partial plus one withholder — is the only route
  // to the contested-aggregate box and the unverifiable-partial row.
  await page.locator('input[name="roster"][value="4"]').check()
  await page.locator('input[name="roster"][value="5"]').check()
  await page.locator('#cheat-1').selectOption('corrupt-gamma')
  await page.locator('#cheat-2').selectOption('withhold-response')
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .beta-box-contested')).toBeVisible()
  await s('cheat cast: mixed (contested aggregate)')

  // ── The empty-roster refusal ────────────────────────────────────────────
  const boxes = page.locator('#roster-checks input[name="roster"]:checked')
  for (let n = await boxes.count(); n > 0; n = await boxes.count()) {
    await boxes.first().uncheck()
  }
  await page.locator('#break-btn').click()
  await expect(page.locator('#break-out .verdict-warn')).toContainText('Pick participants')
  await s('empty roster refusal')

  // ── A long unbroken message, echoed into the step log ───────────────────
  await page.locator('input[name="roster"][value="1"]').check()
  await page.locator('input[name="roster"][value="2"]').check()
  await page.locator('input[name="roster"][value="3"]').check()
  await page.locator('#cheat-1').selectOption('honest')
  await page.locator('#cheat-2').selectOption('honest')
  await page.locator('#msg-input').fill('a'.repeat(120))
  await page.locator('#runall-btn').click()
  await expect(page.locator('#eval-out .beta-box')).toBeVisible()
  await s('long unbroken message echoed into the step log')
}
