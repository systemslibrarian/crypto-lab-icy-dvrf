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
