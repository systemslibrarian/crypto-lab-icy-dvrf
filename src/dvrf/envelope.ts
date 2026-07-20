/**
 * Canonical, versioned proof envelope — the portable artifact that makes
 * "anyone can check it" literal. An envelope produced in one browser context
 * verifies in another with no shared state: it carries the construction
 * identifier, the group public key, the message, the output β, and the
 * four-value proof, all in fixed-width lowercase hex.
 *
 * Parsing is strict and fail-closed: exact field set, exact lengths,
 * canonical ristretto255 point encodings (non-canonical bytes are rejected by
 * the RFC 9496 decoder), and a canonical scalar (z < L). Every rejection
 * names the offending field so a tampered envelope fails intelligibly.
 */
import { ORDER, Point, type GroupElement, bytesToHex, hexToBytes, utf8ToBytes } from './group.ts'
import { type Proof, type VerifyResult, betaHex, verify } from './protocol.ts'

export const ENVELOPE_VERSION = 1
/** Construction fingerprint: bump when any hashed byte or encoding changes. */
export const SUITE = 'crypto-lab-icy-dvrf:v1:ristretto255-SHA512'

/** Serialized proof size: Γ, R_B, R_P (32-byte points) + z (32-byte scalar). */
export const PROOF_BYTES = 128

export interface ParsedEnvelope {
  groupPk: GroupElement
  message: string
  beta: Uint8Array
  proof: Proof
}

export class EnvelopeError extends Error {
  constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`${field}: ${reason}`)
    this.name = 'EnvelopeError'
  }
}

const FIELDS = ['v', 'suite', 'groupPk', 'message', 'beta', 'gamma', 'rB', 'rP', 'z'] as const

export function serializeEnvelope(groupPk: GroupElement, message: string, beta: Uint8Array, proof: Proof): string {
  return JSON.stringify(
    {
      v: ENVELOPE_VERSION,
      suite: SUITE,
      groupPk: bytesToHex(groupPk.toBytes()),
      message,
      beta: betaHex(beta),
      gamma: bytesToHex(proof.gamma.toBytes()),
      rB: bytesToHex(proof.rB.toBytes()),
      rP: bytesToHex(proof.rP.toBytes()),
      z: proof.z.toString(16).padStart(64, '0'),
    },
    null,
    2,
  )
}

function requireHex(field: string, value: unknown, chars: number): string {
  if (typeof value !== 'string') throw new EnvelopeError(field, 'must be a string')
  if (value.length !== chars) throw new EnvelopeError(field, `must be exactly ${chars} hex characters, got ${value.length}`)
  if (!/^[0-9a-f]+$/.test(value)) throw new EnvelopeError(field, 'must be lowercase hex')
  return value
}

function requirePoint(field: string, value: unknown): GroupElement {
  const hex = requireHex(field, value, 64)
  try {
    return Point.fromHex(hex)
  } catch {
    throw new EnvelopeError(field, 'is not a canonical ristretto255 encoding')
  }
}

export function parseEnvelope(text: string): ParsedEnvelope {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new EnvelopeError('envelope', 'is not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EnvelopeError('envelope', 'must be a JSON object')
  }
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new EnvelopeError(key, 'is not an envelope field')
  }
  for (const key of FIELDS) {
    if (!(key in obj)) throw new EnvelopeError(key, 'is missing')
  }
  if (obj.v !== ENVELOPE_VERSION) throw new EnvelopeError('v', `unsupported version (expected ${ENVELOPE_VERSION})`)
  if (obj.suite !== SUITE) throw new EnvelopeError('suite', `unknown construction (expected "${SUITE}")`)
  if (typeof obj.message !== 'string') throw new EnvelopeError('message', 'must be a string')
  if (obj.message.length > 1024) throw new EnvelopeError('message', 'exceeds 1024 characters')

  const groupPk = requirePoint('groupPk', obj.groupPk)
  const beta = hexToBytes(requireHex('beta', obj.beta, 128))
  const gamma = requirePoint('gamma', obj.gamma)
  const rB = requirePoint('rB', obj.rB)
  const rP = requirePoint('rP', obj.rP)
  const z = BigInt('0x' + requireHex('z', obj.z, 64))
  if (z >= ORDER) throw new EnvelopeError('z', 'is not a canonical scalar (must be < the group order)')

  return { groupPk, message: obj.message, beta, proof: { gamma, rB, rP, z } }
}

/** Parse, then run the public verification — the whole trust boundary in one call. */
export function verifyEnvelope(text: string): { parsed: ParsedEnvelope; result: VerifyResult } {
  const parsed = parseEnvelope(text)
  return { parsed, result: verify(parsed.groupPk, utf8ToBytes(parsed.message), parsed.beta, parsed.proof) }
}
