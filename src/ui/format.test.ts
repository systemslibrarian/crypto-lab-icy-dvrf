import { describe, expect, it } from 'vitest'
import { chip, escapeHtml, staleChipHtml } from './format.ts'

/**
 * The guard for CodeQL js/xss-through-dom (sink src/main.ts:140).
 *
 * The flow was tInput.value / nInput.value -> chip()'s label -> innerHTML. A
 * browser test cannot reach it: both sliders are `<input type="range">`, and
 * the HTML value sanitization algorithm replaces anything that is not a valid
 * floating-point number, so markup assigned to either one is gone before the
 * handler reads it. These assertions call the render path directly instead, so
 * removing the escape reddens them.
 */
describe('staleChipHtml', () => {
  const applied = { t: 3, n: 5 }

  it('escapes the pending slider values instead of emitting their markup', () => {
    const html = staleChipHtml('<img src=x data-injected=yes>', '5', applied)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x data-injected=yes&gt;')
  })

  it('escapes every metacharacter that could end the attribute or the tag', () => {
    const html = staleChipHtml('"\'<>&', '5', applied)
    for (const raw of ['"', "'", '<', '>']) {
      expect(html.split('chip-warn')[1]).not.toContain(raw + 'of')
    }
    expect(html).toContain('&quot;&#39;&lt;&gt;&amp;')
  })

  it('escapes the n value too, not only t', () => {
    const html = staleChipHtml('2', '<svg data-injected=yes>', applied)
    expect(html).not.toContain('<svg')
    expect(html).toContain('&lt;svg data-injected=yes&gt;')
  })

  it('names both ceremonies in the ordinary case, unescaped output unchanged', () => {
    expect(staleChipHtml('2', '5', applied)).toBe(
      '<span class="chip chip-warn"><span aria-hidden="true">⚠</span> ' +
        'showing a 3-of-5 ceremony — run the ceremony again to apply 2-of-5</span>',
    )
  })

  it('says nothing when no ceremony has run, or when the sliders match it', () => {
    expect(staleChipHtml('2', '5', undefined)).toBe('')
    expect(staleChipHtml('3', '5', applied)).toBe('')
  })

  it('chip() and escapeHtml() are the pieces it is built from', () => {
    expect(chip('ok', '✓', 'x')).toBe(
      '<span class="chip chip-ok"><span aria-hidden="true">✓</span> x</span>',
    )
    expect(escapeHtml('<&">')).toBe('&lt;&amp;&quot;&gt;')
  })
})
