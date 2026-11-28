import { hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { ORDER, randomScalar, type Rng } from './group.ts'
import { dealerKeygen } from './protocol.ts'
import { seededRng } from './testutil.ts'

describe('scalar sampling', () => {
  it('rejects and resamples a zero candidate', () => {
    let calls = 0
    const zeroThenReal: Rng = (len) => {
      calls += 1
      return calls === 1 ? new Uint8Array(len) : seededRng('nonzero')(len)
    }
    const s = randomScalar(zeroThenReal)
    expect(s).not.toBe(0n)
    expect(calls).toBe(2)
  })

  it('rejects incomplete residue groups and accepts the last value of a complete group', () => {
    const range = 1n << 384n
    const limit = range - range % ORDER
    const draws = [range - 1n, limit + 1n, limit, limit - 1n]
    const scalar = randomScalar((size) => {
      const draw = draws.shift()!
      return hexToBytes(draw.toString(16).padStart(size * 2, '0'))
    })
    expect(scalar).toBe(ORDER - 1n)
    expect(draws).toHaveLength(0)
  })

  it('a dealer key is never zero, so the group key is never the identity', () => {
    let calls = 0
    const zeroFirst: Rng = (len) => {
      calls += 1
      return calls === 1 ? new Uint8Array(len) : seededRng('dealer-nonzero')(len)
    }
    const ceremony = dealerKeygen(3, 2, zeroFirst)
    expect(ceremony.dealerSecret).not.toBe(0n)
    expect(ceremony.groupPk.is0()).toBe(false)
  })
})
