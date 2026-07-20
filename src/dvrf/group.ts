/**
 * Thin wrapper over the ristretto255 prime-order group (@noble/curves).
 *
 * The group arithmetic itself comes from a maintained, audited library —
 * hand-rolling curve formulas is where teaching demos silently go wrong.
 * Everything protocol-shaped (Shamir, DLEQ, FROST-style preprocessing,
 * aggregation) is hand-rolled in the sibling modules so it stays inspectable.
 *
 * ristretto255 is specified in RFC 9496; the KATs in rfc9496.test.ts pin this
 * wrapper to the spec's test vectors (generator multiples, invalid encodings,
 * and the element-derivation one-way map).
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export const Point = ristretto255.Point
export type GroupElement = InstanceType<typeof Point>

/** Scalar field Z_L, L = order of the ristretto255 group. */
export const Fn = Point.Fn
export const ORDER = Fn.ORDER

export type Rng = (len: number) => Uint8Array
export const defaultRng: Rng = (len) => randomBytes(len)

/** Domain-separation prefix for every hash this demo computes. */
const DST_BASE = 'crypto-lab-icy-dvrf:v1:'

/** Length-prefix and concatenate byte strings so hash inputs can't collide across framings. */
export function frame(...parts: Uint8Array[]): Uint8Array {
  const out: Uint8Array[] = []
  for (const p of parts) {
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, p.length)
    out.push(len, p)
  }
  return concatBytes(...out)
}

/**
 * Uniform nonzero scalar from 48 uniform bytes (384 bits >> 253-bit order:
 * negligible bias). Zero is rejected and resampled — a zero dealer key would
 * make every output predictable, and a zero nonce leaks structure, so the
 * impossible-in-practice case is excluded by construction rather than by luck.
 */
export function randomScalar(rng: Rng = defaultRng): bigint {
  for (;;) {
    const s = Fn.create(BigInt('0x' + bytesToHex(rng(48))))
    if (s !== 0n) return s
  }
}

/** Hash arbitrary framed bytes to a scalar, domain-separated per use. */
export function hashToScalar(dst: string, ...parts: Uint8Array[]): bigint {
  return ristretto255_hasher.hashToScalar(frame(...parts), { DST: DST_BASE + dst })
}

/** Hash a message to a group element (RFC 9380 hash_to_ristretto255 with our DST). */
export function hashToPoint(msg: Uint8Array): GroupElement {
  return ristretto255_hasher.hashToCurve(msg, { DST: DST_BASE + 'h2g' })
}

/** Scalar multiplication that tolerates the zero scalar and the identity. */
export function mul(p: GroupElement, s: bigint): GroupElement {
  const k = Fn.create(s)
  if (k === 0n || p.is0()) return Point.ZERO
  return p.multiply(k)
}

export function baseMul(s: bigint): GroupElement {
  return mul(Point.BASE, s)
}

/** SHA-512 with the demo's domain separation, framed. */
export function hashBytes(dst: string, ...parts: Uint8Array[]): Uint8Array {
  return sha512(frame(utf8ToBytes(DST_BASE + dst), ...parts))
}

export function scalarToBytes(s: bigint): Uint8Array {
  return hexToBytes(s.toString(16).padStart(64, '0'))
}

export { bytesToHex, hexToBytes, utf8ToBytes }
