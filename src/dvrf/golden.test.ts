/**
 * Frozen deterministic transcript vectors for THIS construction
 * (crypto-lab-icy-dvrf:v1:ristretto255-SHA512).
 *
 * These are not Icy-DVRF paper vectors — none are published; see
 * docs/CONSTRUCTION.md for the construction map and deviations. What they
 * guarantee is that every hashed byte of this demo's instantiation (framing,
 * domain separation, binding factors, challenge input order, output hash,
 * envelope serialization) is pinned: any silent change to the construction
 * breaks this test rather than silently changing what the page teaches.
 */
import { describe, expect, it } from 'vitest'
import { bytesToHex } from './group.ts'
import { serializeEnvelope, verifyEnvelope } from './envelope.ts'
import { betaHex, dealerKeygen, preprocess, runEvaluation } from './protocol.ts'
import { seededRng } from './testutil.ts'

const GOLDEN = {
  dealerSecret: '02f75b121fcb604217fb8161d22461022a079358e8123105542fd990b1542d02',
  groupPk: '4c36b4fdbecb6dbf53207dbf2a7fe43277d8dc2f239a5059d5551f3b30eb493e',
  input: 'fa6d4a0b24f363c6675b2c0aa45d70bf74043695d4225f25145000e8d6cf7363',
  c: '0e6d1592ac9a143c01872eafd89f3cecf00c61d2e58964e6b6b609316ee9c7f0',
  beta: 'e1dfd582f356b9a1be685ec22d3f836f0b766d992a31b4d56997acc44332c195226296f139ed2df5a190ded131b316e82106466babedfbb7ad05bffddd4afe24',
  gamma: 'e48a00134ec1249d6c86e77157e3c27d87852b6dac993bd6f3d5a3965581b43a',
  rB: '7e8806af80b3090a6e5a8eeea1038012c968515fe775cdf21267b9456590c538',
  rP: '4a43e2cfd005c38ebf9c6747e832a91ed0f64c31ab70669562b32a8a40dcd643',
  z: '02445ca186cd627f52232374adecd398da6f40ab5a2393607fc84f49b9aab444',
}

const GOLDEN_ENVELOPE = `{
  "v": 1,
  "suite": "crypto-lab-icy-dvrf:v1:ristretto255-SHA512",
  "groupPk": "${GOLDEN.groupPk}",
  "message": "golden transcript v1",
  "beta": "${GOLDEN.beta}",
  "gamma": "${GOLDEN.gamma}",
  "rB": "${GOLDEN.rB}",
  "rP": "${GOLDEN.rP}",
  "z": "${GOLDEN.z}"
}`

describe('golden transcript vectors (construction v1, frozen)', () => {
  it('the seeded 3-of-5 evaluation reproduces every frozen value', () => {
    const cer = dealerKeygen(5, 3, seededRng('golden-keys-v1'))
    const nonces = new Map(cer.parties.map((p) => [p.index, preprocess(p, seededRng(`golden-nonce-v1-${p.index}`))]))
    const tr = runEvaluation(cer, nonces, 'golden transcript v1', [1, 3, 5])
    expect(tr.status).toBe('ok')
    expect(cer.dealerSecret.toString(16).padStart(64, '0')).toBe(GOLDEN.dealerSecret)
    expect(bytesToHex(cer.groupPk.toBytes())).toBe(GOLDEN.groupPk)
    expect(bytesToHex(tr.input.toBytes())).toBe(GOLDEN.input)
    expect(tr.c!.toString(16).padStart(64, '0')).toBe(GOLDEN.c)
    expect(betaHex(tr.beta!)).toBe(GOLDEN.beta)
    expect(bytesToHex(tr.proof!.gamma.toBytes())).toBe(GOLDEN.gamma)
    expect(bytesToHex(tr.proof!.rB.toBytes())).toBe(GOLDEN.rB)
    expect(bytesToHex(tr.proof!.rP.toBytes())).toBe(GOLDEN.rP)
    expect(tr.proof!.z.toString(16).padStart(64, '0')).toBe(GOLDEN.z)
    expect(serializeEnvelope(cer.groupPk, tr.message, tr.beta!, tr.proof!)).toBe(GOLDEN_ENVELOPE)
  })

  it('the frozen envelope verifies on its own, with no regeneration', () => {
    expect(verifyEnvelope(GOLDEN_ENVELOPE).result.valid).toBe(true)
  })
})
