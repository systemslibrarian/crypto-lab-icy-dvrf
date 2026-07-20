import { beforeEach, describe, expect, it } from 'vitest'
import { bytesToHex, utf8ToBytes } from './group.ts'
import {
  type CheatMode,
  type KeyCeremony,
  type NoncePair,
  dealerKeygen,
  evaluateDirect,
  preprocess,
  runEvaluation,
  verify,
} from './protocol.ts'
import { seededRng } from './testutil.ts'

const MESSAGE = 'beacon round #42'

function freshNonces(ceremony: KeyCeremony, seed: string): Map<number, NoncePair> {
  const rng = seededRng(seed)
  return new Map(ceremony.parties.map((p) => [p.index, preprocess(p, rng)]))
}

describe('Icy-style DVRF — full protocol', () => {
  let ceremony: KeyCeremony

  beforeEach(() => {
    ceremony = dealerKeygen(5, 3, seededRng('keys'))
  })

  it('a t-of-n evaluation matches the dealer direct evaluation byte for byte', () => {
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n1'), MESSAGE, [1, 2, 3])
    expect(out.status).toBe('ok')
    const direct = evaluateDirect(ceremony.dealerSecret, utf8ToBytes(MESSAGE))
    expect(bytesToHex(out.beta!)).toBe(bytesToHex(direct.beta))
    expect(out.proof!.gamma.equals(direct.gamma)).toBe(true)
  })

  it('different participant subsets produce the identical output (uniqueness / no bias)', () => {
    const a = runEvaluation(ceremony, freshNonces(ceremony, 'n2a'), MESSAGE, [1, 2, 3])
    const b = runEvaluation(ceremony, freshNonces(ceremony, 'n2b'), MESSAGE, [2, 4, 5])
    const c = runEvaluation(ceremony, freshNonces(ceremony, 'n2c'), MESSAGE, [1, 3, 4, 5])
    expect(a.status).toBe('ok')
    expect(bytesToHex(a.beta!)).toBe(bytesToHex(b.beta!))
    expect(bytesToHex(a.beta!)).toBe(bytesToHex(c.beta!))
  })

  it('different messages produce different outputs', () => {
    const a = runEvaluation(ceremony, freshNonces(ceremony, 'n3a'), MESSAGE, [1, 2, 3])
    const b = runEvaluation(ceremony, freshNonces(ceremony, 'n3b'), 'beacon round #43', [1, 2, 3])
    expect(bytesToHex(a.beta!)).not.toBe(bytesToHex(b.beta!))
  })

  it('the constant-size proof verifies publicly against the group key alone', () => {
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n4'), MESSAGE, [2, 3, 5])
    const res = verify(ceremony.groupPk, utf8ToBytes(MESSAGE), out.beta!, out.proof!)
    expect(res).toEqual({ keyEquation: true, inputEquation: true, betaMatches: true, ok: true, valid: true })
  })

  it('verification rejects a proof checked against the wrong message or wrong key', () => {
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n5'), MESSAGE, [1, 2, 3])
    expect(verify(ceremony.groupPk, utf8ToBytes('other message'), out.beta!, out.proof!).valid).toBe(false)
    const other = dealerKeygen(5, 3, seededRng('other-keys'))
    expect(verify(other.groupPk, utf8ToBytes(MESSAGE), out.beta!, out.proof!).valid).toBe(false)
  })

  it('verification rejects tampering with every component independently', () => {
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n6'), MESSAGE, [1, 2, 3])
    const msg = utf8ToBytes(MESSAGE)
    const { gamma, rB, rP, z } = out.proof!
    const beta = out.beta!
    expect(verify(ceremony.groupPk, msg, beta, { gamma: gamma.double(), rB, rP, z }).valid).toBe(false)
    expect(verify(ceremony.groupPk, msg, beta, { gamma, rB: rB.double(), rP, z }).valid).toBe(false)
    expect(verify(ceremony.groupPk, msg, beta, { gamma, rB, rP: rP.double(), z }).valid).toBe(false)
    expect(verify(ceremony.groupPk, msg, beta, { gamma, rB, rP, z: z + 1n }).valid).toBe(false)
    const flipped = new Uint8Array(beta)
    flipped[0] ^= 1
    const res = verify(ceremony.groupPk, msg, flipped, out.proof!)
    expect(res.betaMatches).toBe(false)
    expect(res.valid).toBe(false)
  })

  it('a corrupted partial is detected, blamed, and the evaluation aborts with no output', () => {
    const cheats = new Map<number, CheatMode>([[2, 'corrupt-gamma']])
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n7'), MESSAGE, [1, 2, 3], { cheats })
    expect(out.status).toBe('aborted-cheater')
    expect(out.blamed).toEqual([2])
    expect(out.beta).toBeUndefined()
    expect(out.proof).toBeUndefined()
    const honest = out.partials.filter((p) => p.index !== 2)
    expect(honest.every((p) => p.check.ok)).toBe(true)
    const cheater = out.partials.find((p) => p.index === 2)!
    expect(cheater.check.inputEquation).toBe(false)
  })

  it('rerunning without the cheater still produces the one true output', () => {
    const cheats = new Map<number, CheatMode>([[2, 'corrupt-gamma']])
    const aborted = runEvaluation(ceremony, freshNonces(ceremony, 'n8a'), MESSAGE, [1, 2, 3], { cheats })
    expect(aborted.status).toBe('aborted-cheater')
    const rerun = runEvaluation(ceremony, freshNonces(ceremony, 'n8b'), MESSAGE, [1, 3, 4])
    expect(rerun.status).toBe('ok')
    const direct = evaluateDirect(ceremony.dealerSecret, utf8ToBytes(MESSAGE))
    expect(bytesToHex(rerun.beta!)).toBe(bytesToHex(direct.beta))
  })

  it('nonce grinding is caught by the key equation (preprocessing pinned the nonce)', () => {
    const cheats = new Map<number, CheatMode>([[3, 'grind-nonce']])
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n9'), MESSAGE, [1, 2, 3], {
      cheats,
      rng: seededRng('grind'),
    })
    expect(out.status).toBe('aborted-cheater')
    expect(out.blamed).toEqual([3])
    const cheater = out.partials.find((p) => p.index === 3)!
    expect(cheater.check.keyEquation).toBe(false)
  })

  it('refuses (fail closed) when absences leave fewer than t responders', () => {
    const cheats = new Map<number, CheatMode>([[1, 'absent']])
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n10'), MESSAGE, [1, 2, 3], { cheats })
    expect(out.status).toBe('refused-below-threshold')
    expect(out.beta).toBeUndefined()
    expect(out.partials).toEqual([])
  })

  it('tolerates an absence when enough responders remain — and the output is unchanged', () => {
    const cheats = new Map<number, CheatMode>([[4, 'absent']])
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n11'), MESSAGE, [1, 2, 4, 5], { cheats })
    expect(out.status).toBe('ok')
    expect(out.responders).toEqual([1, 2, 5])
    const direct = evaluateDirect(ceremony.dealerSecret, utf8ToBytes(MESSAGE))
    expect(bytesToHex(out.beta!)).toBe(bytesToHex(direct.beta))
  })

  it('a withholder aborts the evaluation after learning the output (selective abort)', () => {
    const cheats = new Map<number, CheatMode>([[3, 'withhold-response']])
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n15'), MESSAGE, [1, 2, 3], { cheats })
    expect(out.status).toBe('aborted-withheld')
    expect(out.withheld).toEqual([3])
    // Censorship, not steering: no publishable output exists...
    expect(out.beta).toBeUndefined()
    expect(out.proof).toBeUndefined()
    // ...but the withholder (and everyone else) already knew β from round 1,
    // and it is exactly the β an honest rerun without the withholder produces.
    expect(out.learnedBeta).toBeDefined()
    const rerun = runEvaluation(ceremony, freshNonces(ceremony, 'n15b'), MESSAGE, [1, 2, 4])
    expect(rerun.status).toBe('ok')
    expect(bytesToHex(out.learnedBeta!)).toBe(bytesToHex(rerun.beta!))
  })

  it('a preprocessed nonce pair cannot be spent twice', () => {
    const nonces = freshNonces(ceremony, 'n12')
    expect(runEvaluation(ceremony, nonces, MESSAGE, [1, 2, 3]).status).toBe('ok')
    expect(() => runEvaluation(ceremony, nonces, 'second use', [1, 2, 3])).toThrow(/already spent/)
  })

  it('rejects malformed rosters (fail closed)', () => {
    const nonces = freshNonces(ceremony, 'n13')
    expect(() => runEvaluation(ceremony, nonces, MESSAGE, [1, 1, 2])).toThrow(/duplicate/)
    expect(() => runEvaluation(ceremony, nonces, MESSAGE, [1, 2, 9])).toThrow(/unknown/)
  })

  it('works across other (t, n) shapes, including 2-of-2 and 4-of-7', () => {
    for (const [t, n, roster] of [
      [2, 2, [1, 2]],
      [4, 7, [2, 3, 5, 7]],
    ] as const) {
      const cer = dealerKeygen(n, t, seededRng(`shape-${t}-${n}`))
      const out = runEvaluation(cer, freshNonces(cer, `shape-n-${t}-${n}`), MESSAGE, [...roster])
      expect(out.status).toBe('ok')
      const direct = evaluateDirect(cer.dealerSecret, utf8ToBytes(MESSAGE))
      expect(bytesToHex(out.beta!)).toBe(bytesToHex(direct.beta))
      expect(verify(cer.groupPk, utf8ToBytes(MESSAGE), out.beta!, out.proof!).valid).toBe(true)
    }
  })

  it('an empty message is still a valid, verifiable evaluation', () => {
    const out = runEvaluation(ceremony, freshNonces(ceremony, 'n14'), '', [1, 2, 3])
    expect(out.status).toBe('ok')
    expect(verify(ceremony.groupPk, utf8ToBytes(''), out.beta!, out.proof!).valid).toBe(true)
  })
})
