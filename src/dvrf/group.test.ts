import { describe, expect, it } from 'vitest'
import { randomScalar, type Rng } from './group.ts'
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
