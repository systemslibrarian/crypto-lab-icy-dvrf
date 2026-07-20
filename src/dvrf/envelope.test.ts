import { beforeAll, describe, expect, it } from 'vitest'
import { EnvelopeError, parseEnvelope, serializeEnvelope, verifyEnvelope } from './envelope.ts'
import { type KeyCeremony, type Transcript, dealerKeygen, preprocess, runEvaluation } from './protocol.ts'
import { seededRng } from './testutil.ts'

let ceremony: KeyCeremony
let transcript: Transcript
let envelope: string

beforeAll(() => {
  ceremony = dealerKeygen(5, 3, seededRng('env-keys'))
  const nonces = new Map(ceremony.parties.map((p) => [p.index, preprocess(p, seededRng(`env-n${p.index}`))]))
  transcript = runEvaluation(ceremony, nonces, 'envelope test', [1, 2, 3])
  envelope = serializeEnvelope(ceremony.groupPk, transcript.message, transcript.beta!, transcript.proof!)
})

describe('proof envelope — canonical export/import', () => {
  it('round-trips and verifies with no shared state', () => {
    const { parsed, result } = verifyEnvelope(envelope)
    expect(result.valid).toBe(true)
    expect(parsed.message).toBe('envelope test')
    expect(parsed.groupPk.equals(ceremony.groupPk)).toBe(true)
  })

  it('serialization is deterministic', () => {
    expect(serializeEnvelope(ceremony.groupPk, transcript.message, transcript.beta!, transcript.proof!)).toBe(envelope)
  })

  it('a one-character tamper in any hex field fails with the field named', () => {
    for (const field of ['groupPk', 'beta', 'gamma', 'rB', 'rP', 'z'] as const) {
      const obj = JSON.parse(envelope)
      const hex: string = obj[field]
      // Flip one nibble mid-string (avoids producing an identical value).
      obj[field] = hex.slice(0, 10) + (hex[10] === '0' ? '1' : '0') + hex.slice(11)
      const text = JSON.stringify(obj)
      let outcome: 'parse-rejected' | 'verify-rejected' | 'accepted'
      try {
        outcome = verifyEnvelope(text).result.valid ? 'accepted' : 'verify-rejected'
      } catch (e) {
        expect(e).toBeInstanceOf(EnvelopeError)
        outcome = 'parse-rejected'
      }
      expect(outcome, field).not.toBe('accepted')
    }
  })

  it('rejects a tampered message (verification fails, parse succeeds)', () => {
    const obj = JSON.parse(envelope)
    obj.message = 'a different message'
    expect(verifyEnvelope(JSON.stringify(obj)).result.valid).toBe(false)
  })

  it('rejects wrong version, wrong suite, missing and extra fields', () => {
    const cases: Array<[string, (o: Record<string, unknown>) => void, string]> = [
      ['version', (o) => (o.v = 2), 'v'],
      ['suite', (o) => (o.suite = 'other-suite'), 'suite'],
      ['missing field', (o) => delete o.beta, 'beta'],
      ['extra field', (o) => (o.extra = 1), 'extra'],
      ['non-string message', (o) => (o.message = 42), 'message'],
      ['oversized message', (o) => (o.message = 'x'.repeat(1025)), 'message'],
    ]
    for (const [label, mutate, field] of cases) {
      const obj = JSON.parse(envelope)
      mutate(obj)
      expect(() => parseEnvelope(JSON.stringify(obj)), label).toThrow(EnvelopeError)
      try {
        parseEnvelope(JSON.stringify(obj))
      } catch (e) {
        expect((e as EnvelopeError).field, label).toBe(field)
      }
    }
  })

  it('rejects wrong lengths, non-hex, non-canonical points, and out-of-range scalars', () => {
    const bad: Array<[string, string, string]> = [
      ['gamma', 'short length', 'deadbeef'],
      ['gamma', 'uppercase hex', 'A'.repeat(64)],
      // A negative-field-element encoding from RFC 9496 A.2 — 64 valid hex chars, invalid point.
      ['gamma', 'non-canonical point', 'ed57ffd8c914fb201471d1c3d245ce3c746fcbe63a3679d51b6a516ebebe0e20'],
      ['z', 'scalar >= group order', 'f'.repeat(64)],
    ]
    for (const [field, label, value] of bad) {
      const obj = JSON.parse(envelope)
      obj[field] = value
      expect(() => parseEnvelope(JSON.stringify(obj)), `${field}: ${label}`).toThrow(EnvelopeError)
    }
    expect(() => parseEnvelope('not json')).toThrow(EnvelopeError)
    expect(() => parseEnvelope('[1,2]')).toThrow(EnvelopeError)
  })
})
