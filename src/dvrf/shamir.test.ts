import { describe, expect, it } from 'vitest'
import { Fn } from './group.ts'
import { dealShares, lagrangeAt0, reconstructSecret } from './shamir.ts'
import { seededRng } from './testutil.ts'

const SECRET = Fn.create(123456789123456789123456789n)

describe('Shamir secret sharing over Z_L', () => {
  it('any t of n shares reconstruct the secret', () => {
    const shares = dealShares(SECRET, 3, 5, seededRng('shamir-1'))
    expect(reconstructSecret([shares[0], shares[1], shares[2]])).toBe(SECRET)
    expect(reconstructSecret([shares[1], shares[3], shares[4]])).toBe(SECRET)
    expect(reconstructSecret([shares[0], shares[2], shares[4]])).toBe(SECRET)
  })

  it('more than t shares also reconstruct the secret', () => {
    const shares = dealShares(SECRET, 2, 4, seededRng('shamir-2'))
    expect(reconstructSecret(shares)).toBe(SECRET)
  })

  it('t-1 shares interpolate to a wrong value, not the secret', () => {
    const shares = dealShares(SECRET, 3, 5, seededRng('shamir-3'))
    expect(reconstructSecret([shares[0], shares[1]])).not.toBe(SECRET)
  })

  it('lagrange coefficients at 0 sum to 1 for the constant polynomial', () => {
    const indices = [1, 3, 4, 7]
    const sum = indices.reduce((acc, i) => Fn.add(acc, lagrangeAt0(indices, i)), 0n)
    expect(sum).toBe(1n)
  })

  it('rejects bad parameters and malformed share sets (fail closed)', () => {
    expect(() => dealShares(SECRET, 1, 5)).toThrow()
    expect(() => dealShares(SECRET, 4, 3)).toThrow()
    expect(() => dealShares(SECRET, 2.5, 5)).toThrow()
    expect(() => lagrangeAt0([1, 1, 2], 1)).toThrow()
    expect(() => lagrangeAt0([1, 2], 3)).toThrow()
    expect(() => lagrangeAt0([0, 1], 0)).toThrow()
    expect(() => reconstructSecret([])).toThrow()
  })

  it('shares of the same secret differ between dealings (fresh polynomial)', () => {
    const a = dealShares(SECRET, 3, 5, seededRng('shamir-4a'))
    const b = dealShares(SECRET, 3, 5, seededRng('shamir-4b'))
    expect(a[0].value).not.toBe(b[0].value)
    expect(reconstructSecret(a.slice(0, 3))).toBe(reconstructSecret(b.slice(0, 3)))
  })
})
