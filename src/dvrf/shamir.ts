/**
 * Shamir secret sharing over Z_L (the ristretto255 scalar field).
 *
 * The demo uses a trusted dealer to distribute shares — a deliberate,
 * labelled simplification. A production DVRF runs a distributed key
 * generation ceremony so no single party ever holds the whole secret.
 */
import { Fn, randomScalar, type Rng, defaultRng } from './group.ts'

export interface Share {
  /** Party index i >= 1 (the x-coordinate of the share). */
  index: number
  /** f(i) — the party's secret evaluation of the dealer polynomial. */
  value: bigint
}

function assertParams(t: number, n: number): void {
  if (!Number.isInteger(t) || !Number.isInteger(n)) throw new Error('t and n must be integers')
  if (t < 2) throw new Error('threshold t must be at least 2')
  if (n < t) throw new Error('n must be at least t')
  if (n > 64) throw new Error('demo supports at most 64 parties')
}

/** Split `secret` into n shares with threshold t (degree t-1 polynomial, f(0) = secret). */
export function dealShares(secret: bigint, t: number, n: number, rng: Rng = defaultRng): Share[] {
  assertParams(t, n)
  const coeffs = [Fn.create(secret)]
  for (let j = 1; j < t; j++) coeffs.push(randomScalar(rng))
  const shares: Share[] = []
  for (let i = 1; i <= n; i++) {
    const x = BigInt(i)
    let acc = 0n
    for (let j = coeffs.length - 1; j >= 0; j--) acc = Fn.add(Fn.mul(acc, x), coeffs[j])
    shares.push({ index: i, value: acc })
  }
  return shares
}

function assertDistinct(indices: number[]): void {
  if (indices.length === 0) throw new Error('empty participant set')
  if (new Set(indices).size !== indices.length) throw new Error('duplicate party index in participant set')
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 1) throw new Error(`invalid party index ${i}`)
  }
}

/**
 * Lagrange coefficient λ_i for interpolating at x = 0 over the given index set:
 * λ_i = Π_{j ≠ i} j / (j − i)  (mod L).
 */
export function lagrangeAt0(indices: number[], i: number): bigint {
  assertDistinct(indices)
  if (!indices.includes(i)) throw new Error(`index ${i} not in participant set`)
  let num = 1n
  let den = 1n
  for (const j of indices) {
    if (j === i) continue
    num = Fn.mul(num, Fn.create(BigInt(j)))
    den = Fn.mul(den, Fn.create(BigInt(j) - BigInt(i)))
  }
  return Fn.mul(num, Fn.inv(den))
}

/** Reconstruct f(0) from shares — used in tests and the dealer's compare-both-sides exhibit. */
export function reconstructSecret(shares: Share[]): bigint {
  const indices = shares.map((s) => s.index)
  assertDistinct(indices)
  let acc = 0n
  for (const s of shares) acc = Fn.add(acc, Fn.mul(lagrangeAt0(indices, s.index), s.value))
  return acc
}
