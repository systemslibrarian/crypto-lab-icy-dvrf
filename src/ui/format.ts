import { bytesToHex, type GroupElement } from '../dvrf/group.ts'

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function pointHex(p: GroupElement): string {
  return bytesToHex(p.toBytes())
}

/** Truncate long hex for chips; full values appear where byte-for-byte comparison matters. */
export function short(hex: string, head = 12, tail = 6): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`
}

export function scalarHex(s: bigint): string {
  return s.toString(16).padStart(64, '0')
}

/**
 * A small status pill. Lives here rather than in main.ts so the markup it
 * builds can be asserted without a DOM.
 */
export function chip(kind: 'ok' | 'bad' | 'warn', icon: string, label: string): string {
  return `<span class="chip chip-${kind}"><span aria-hidden="true">${icon}</span> ${label}</span>`
}

/**
 * The staleness pill for the key ceremony: shown when the sliders no longer
 * match the ceremony on screen, naming both.
 *
 * `pendingT` and `pendingN` are raw input values, so they are escaped. This is
 * the markup CodeQL named for js/xss-through-dom (sink main.ts:140, via
 * chip()'s label). Separated from the DOM handler so a test can feed it markup
 * directly: both sliders are `<input type="range">`, whose value sanitization
 * replaces anything non-numeric, so no test driving the real control can
 * exercise this.
 */
export function staleChipHtml(
  pendingT: string,
  pendingN: string,
  applied: { t: number; n: number } | undefined,
): string {
  if (applied === undefined) return ''
  const stale = applied.n !== Number(pendingN) || applied.t !== Number(pendingT)
  if (!stale) return ''
  return chip(
    'warn',
    '⚠',
    `showing a ${applied.t}-of-${applied.n} ceremony — run the ceremony again to apply ` +
      `${escapeHtml(pendingT)}-of-${escapeHtml(pendingN)}`,
  )
}
