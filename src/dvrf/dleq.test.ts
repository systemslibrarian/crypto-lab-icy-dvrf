import { describe, expect, it } from 'vitest'
import { Fn, Point, baseMul, hashToPoint, mul, randomScalar, utf8ToBytes } from './group.ts'
import { challenge, verifyDleq } from './dleq.ts'
import { seededRng } from './testutil.ts'

function honestTranscript(seed: string) {
  const rng = seededRng(seed)
  const x = randomScalar(rng)
  const k = randomScalar(rng)
  const input = hashToPoint(utf8ToBytes('dleq test input'))
  const pk = baseMul(x)
  const gamma = mul(input, x)
  const rB = baseMul(k)
  const rP = mul(input, k)
  const c = challenge(pk, input, gamma, rB, rP)
  const z = Fn.add(k, Fn.mul(c, x))
  return { x, k, input, pk, gamma, rB, rP, c, z }
}

describe('Chaum–Pedersen DLEQ', () => {
  it('accepts an honest transcript on both equations', () => {
    const t = honestTranscript('dleq-1')
    const check = verifyDleq(t.pk, t.input, t.gamma, t.rB, t.rP, t.c, t.z)
    expect(check).toEqual({ keyEquation: true, inputEquation: true, ok: true })
  })

  it('a corrupt gamma fails the input equation but not the key equation', () => {
    const t = honestTranscript('dleq-2')
    const check = verifyDleq(t.pk, t.input, t.gamma.add(Point.BASE), t.rB, t.rP, t.c, t.z)
    expect(check.keyEquation).toBe(true)
    expect(check.inputEquation).toBe(false)
    expect(check.ok).toBe(false)
  })

  it('a swapped nonce fails the key equation (the preprocessing commitment pins it)', () => {
    const t = honestTranscript('dleq-3')
    const kFresh = randomScalar(seededRng('dleq-3-fresh'))
    const zFresh = Fn.add(kFresh, Fn.mul(t.c, t.x))
    const check = verifyDleq(t.pk, t.input, t.gamma, t.rB, mul(t.input, kFresh), t.c, zFresh)
    expect(check.keyEquation).toBe(false)
    expect(check.ok).toBe(false)
  })

  it('a tampered response z fails both equations', () => {
    const t = honestTranscript('dleq-4')
    const check = verifyDleq(t.pk, t.input, t.gamma, t.rB, t.rP, t.c, Fn.add(t.z, 1n))
    expect(check.keyEquation).toBe(false)
    expect(check.inputEquation).toBe(false)
  })

  it('the challenge binds every element of the statement', () => {
    const t = honestTranscript('dleq-5')
    const c2 = challenge(t.pk, t.input, t.gamma.add(Point.BASE), t.rB, t.rP)
    const c3 = challenge(t.pk.add(Point.BASE), t.input, t.gamma, t.rB, t.rP)
    expect(c2).not.toBe(t.c)
    expect(c3).not.toBe(t.c)
    expect(challenge(t.pk, t.input, t.gamma, t.rB, t.rP)).toBe(t.c)
  })
})
