/**
 * Chaum–Pedersen DLEQ verification — the equation at the heart of the DVRF.
 *
 * A prover who knows x with PK = x·B claims Γ = x·P for a public point P.
 * Given nonce commitments R_B = k·B and R_P = k·P and response z = k + c·x,
 * the verifier checks BOTH:
 *
 *   (key equation)    z·B == R_B + c·PK
 *   (input equation)  z·P == R_P + c·Γ
 *
 * The same two equations verify a single party's partial evaluation (with
 * that party's PK_i, Γ_i) and the aggregated constant-size proof (with the
 * group PK and the combined Γ) — aggregation is just a Lagrange-weighted sum
 * of honest transcripts, which is the reason the final proof stays the same
 * size no matter how many parties contributed.
 */
import { Point, type GroupElement, hashToScalar, mul } from './group.ts'

/** Fiat–Shamir challenge binding the full statement. */
export function challenge(
  pk: GroupElement,
  input: GroupElement,
  gamma: GroupElement,
  rB: GroupElement,
  rP: GroupElement,
): bigint {
  return hashToScalar('dleq-chal', pk.toBytes(), input.toBytes(), gamma.toBytes(), rB.toBytes(), rP.toBytes())
}

export interface DleqCheck {
  /** z·B == R_B + c·PK — proves the responder used the committed nonce and the real key share. */
  keyEquation: boolean
  /** z·P == R_P + c·Γ — proves Γ really is that same secret applied to the input point. */
  inputEquation: boolean
  ok: boolean
}

/** Verify the two DLEQ equations independently and report each result on its own. */
export function verifyDleq(
  pk: GroupElement,
  input: GroupElement,
  gamma: GroupElement,
  rB: GroupElement,
  rP: GroupElement,
  c: bigint,
  z: bigint,
): DleqCheck {
  const keyEquation = mul(Point.BASE, z).equals(rB.add(mul(pk, c)))
  const inputEquation = mul(input, z).equals(rP.add(mul(gamma, c)))
  return { keyEquation, inputEquation, ok: keyEquation && inputEquation }
}
