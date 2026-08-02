/**
 * A t-of-n distributed verifiable random function in the style of Icy-DVRF
 * (Ağırtaş, Özer, Saygı, Yayla — eprint 2026/969): partial VRF evaluations
 * proven with Chaum–Pedersen DLEQ proofs under a shared challenge, with
 * FROST-style preprocessed nonce commitments so the per-evaluation online
 * interaction shrinks and the aggregated proof stays constant-size.
 *
 * Phases (each phase is a plain function so the UI can step them):
 *
 *   0. dealerKeygen    — trusted-dealer Shamir setup (labelled simplification;
 *                        the paper assumes a DKG).
 *   1. preprocess      — OFFLINE, message-independent: each party publishes a
 *                        one-time nonce commitment pair (D_i, E_i) = (d_i·B, e_i·B).
 *   2. round1          — online: given the message, party i derives its binding
 *                        factor ρ_i, effective nonce k_i = d_i + ρ_i·e_i, and
 *                        broadcasts its partial Γ_i = x_i·P plus R_i^P = k_i·P.
 *   3. sharedChallenge — everyone (or anyone) combines the broadcasts with
 *                        Lagrange weights and hashes one challenge c for all.
 *   4. round2          — online: party i broadcasts z_i = k_i + c·x_i.
 *   5. aggregate       — public: check every partial's DLEQ (blame cheaters,
 *                        fail closed), then fold t transcripts into ONE proof
 *                        (Γ, R_B, R_P, z) and the output β = H(Γ).
 *   6. verify          — public, non-interactive: two DLEQ equations against
 *                        the group key plus recomputing β from Γ.
 *
 * The FROST idea, in one sentence: because (D_i, E_i) was pinned to the
 * transcript BEFORE the message existed and ρ_i re-binds it to this exact
 * evaluation, a party cannot pick its nonce after seeing everyone else's
 * contributions — which is what removes the nonce-commitment round that a
 * naive interactive DVRF has to run per evaluation.
 *
 * NOT production crypto: no networking, no constant-time guarantees, no DKG,
 * and per-session keys that live in browser memory only.
 */
import {
  Point,
  type GroupElement,
  type Rng,
  defaultRng,
  Fn,
  baseMul,
  mul,
  hashToPoint,
  hashToScalar,
  hashBytes,
  randomScalar,
  bytesToHex,
  utf8ToBytes,
} from './group.ts'
import { dealShares, lagrangeAt0 } from './shamir.ts'
import { challenge, verifyDleq, type DleqCheck } from './dleq.ts'

// ---------------------------------------------------------------------------
// Types

export interface PartyKey {
  index: number
  /** Secret Shamir share x_i — stays with the party. */
  secret: bigint
  /** Public verification share PK_i = x_i·B. */
  pk: GroupElement
}

export interface KeyCeremony {
  n: number
  t: number
  /** Group public key PK = sk·B — the only key a verifier ever needs. */
  groupPk: GroupElement
  parties: PartyKey[]
  /**
   * The dealer's master secret. A real deployment must never have this in one
   * place; the demo keeps it ONLY to power the compare-against-direct-
   * evaluation exhibit.
   */
  dealerSecret: bigint
}

/** One-time preprocessed nonce material for one party. */
export interface NoncePair {
  index: number
  /** Which preprocessing batch this pair belongs to — makes spent material traceable. */
  batch: number
  /** Secret nonces (d_i, e_i) — stay with the party. */
  d: bigint
  e: bigint
  /** Published commitments (D_i, E_i) = (d_i·B, e_i·B). */
  D: GroupElement
  E: GroupElement
  /** Guards the FROST rule: a preprocessed pair is spent by its first use. */
  used: boolean
}

/** What a party broadcasts in the first online round. */
export interface Round1Msg {
  index: number
  /** Partial evaluation Γ_i = x_i·P. */
  gamma: GroupElement
  /** Nonce commitment on the input base, R_i^P = k_i·P. */
  rP: GroupElement
}

export interface PartialRecord extends Round1Msg {
  /** Binding factor ρ_i (public — anyone can recompute it). */
  rho: bigint
  /** Effective nonce commitment on the key base, R_i^B = D_i + ρ_i·E_i (public). */
  rB: GroupElement
  /** Lagrange weight λ_i over the responding set. */
  lambda: bigint
  /** Round-2 response z_i = k_i + c·x_i. */
  z: bigint
  /** Public DLEQ check of this partial — how cheaters get blamed. */
  check: DleqCheck
}

/** Constant-size aggregated proof: four values regardless of t or n. */
export interface Proof {
  gamma: GroupElement
  rB: GroupElement
  rP: GroupElement
  z: bigint
}

export type EvalStatus = 'ok' | 'refused-below-threshold' | 'aborted-cheater' | 'aborted-withheld'

export type CheatMode =
  | 'absent' // party never responds
  | 'corrupt-gamma' // party lies about its partial Γ_i
  | 'grind-nonce' // party swaps in a fresh nonce, ignoring its preprocessed commitment
  | 'withhold-response' // party broadcasts round 1, computes the output, then refuses round 2

export interface Transcript {
  status: EvalStatus
  message: string
  /** Input point P = H2G(message). */
  input: GroupElement
  /** Preprocessing batch this evaluation consumed. */
  batch: number
  /** The exact (D_i, E_i) commitments the binding factors and proof trace back to. */
  commitments: RosterCommitment[]
  /** Indices asked to participate, and those that actually responded. */
  roster: number[]
  responders: number[]
  absent: number[]
  /** Parties that broadcast round 1 but refused round 2 (selective abort). */
  withheld: number[]
  partials: PartialRecord[]
  /** Aggregates (present when enough parties responded). */
  rB?: GroupElement
  rP?: GroupElement
  c?: bigint
  gamma?: GroupElement
  /** Final output and proof (present only when status === 'ok'). */
  beta?: Uint8Array
  proof?: Proof
  /**
   * What everyone — including a withholder — could already compute from the
   * round-1 broadcasts alone. Selective abort censors publication; it cannot
   * select a different output.
   *
   * Set ONLY when every partial in that round-1 aggregate went on to pass its
   * DLEQ check. An aggregate containing a partial that fails verification is
   * not an output at all, so it is reported as {@link contestedBeta} instead.
   */
  learnedBeta?: Uint8Array
  /**
   * H(Γ) over a round-1 aggregate that contains at least one partial which
   * later failed its DLEQ — the value a withholder in a mixed cast actually
   * computed. It is deliberately NOT called β: no participant set could ever
   * have published it, because round 2 names the bad partial and aborts.
   */
  contestedBeta?: Uint8Array
  /**
   * In an aborted-withheld run, the responders whose partials did answer
   * round 2 and passed DLEQ. Withholders are absent from this list by
   * construction: with no z_i there is nothing to verify.
   */
  verifiedPartials?: number[]
  /**
   * The output determined by {@link verifiedPartials} alone, recomputed with
   * Lagrange weights over that subset — present only when those partials still
   * reach t. When it is absent, the cast determines no publishable output.
   */
  verifiedSubsetBeta?: Uint8Array
  /** Parties whose DLEQ failed — publicly identifiable. */
  blamed: number[]
}

// ---------------------------------------------------------------------------
// Phase 0 — trusted-dealer key ceremony (labelled demo simplification)

export function dealerKeygen(n: number, t: number, rng: Rng = defaultRng): KeyCeremony {
  const dealerSecret = randomScalar(rng)
  const shares = dealShares(dealerSecret, t, n, rng)
  return {
    n,
    t,
    groupPk: baseMul(dealerSecret),
    parties: shares.map((s) => ({ index: s.index, secret: s.value, pk: baseMul(s.value) })),
    dealerSecret,
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — offline preprocessing (message-independent, FROST-style)

export function preprocess(party: PartyKey, rng: Rng = defaultRng, batch = 1): NoncePair {
  const d = randomScalar(rng)
  const e = randomScalar(rng)
  return { index: party.index, batch, d, e, D: baseMul(d), E: baseMul(e), used: false }
}

// ---------------------------------------------------------------------------
// Phase 2 — online round 1: partials + input-base nonce commitments

/** Public commitment list for the responding set, in ascending index order. */
export interface RosterCommitment {
  index: number
  D: GroupElement
  E: GroupElement
}

function rosterBytes(msg: Uint8Array, roster: RosterCommitment[]): Uint8Array[] {
  const parts: Uint8Array[] = [msg]
  for (const r of roster) {
    parts.push(utf8ToBytes(String(r.index)), r.D.toBytes(), r.E.toBytes())
  }
  return parts
}

/**
 * Binding factor ρ_i: re-binds party i's preprocessed nonce to THIS message
 * and THIS responding set, so preprocessed material can't be replayed into a
 * different evaluation.
 */
export function bindingFactor(index: number, msg: Uint8Array, roster: RosterCommitment[]): bigint {
  return hashToScalar('binding', utf8ToBytes(String(index)), ...rosterBytes(msg, roster))
}

export interface Round1State {
  /** Effective secret nonce k_i = d_i + ρ_i·e_i — never leaves the party. */
  k: bigint
}

export function round1(
  party: PartyKey,
  nonce: NoncePair,
  msg: Uint8Array,
  roster: RosterCommitment[],
): { msg1: Round1Msg; state: Round1State } {
  if (nonce.index !== party.index) throw new Error('nonce pair belongs to a different party')
  if (nonce.used) throw new Error(`party ${party.index}: preprocessed nonce already spent — FROST nonces are one-time`)
  nonce.used = true
  const input = hashToPoint(msg)
  const rho = bindingFactor(party.index, msg, roster)
  const k = Fn.add(nonce.d, Fn.mul(rho, nonce.e))
  return {
    msg1: { index: party.index, gamma: mul(input, party.secret), rP: mul(input, k) },
    state: { k },
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — one shared challenge for the whole set

export interface SharedChallenge {
  rB: GroupElement
  rP: GroupElement
  gamma: GroupElement
  c: bigint
  lambdas: Map<number, bigint>
  rhos: Map<number, bigint>
  rBs: Map<number, GroupElement>
}

export function sharedChallenge(
  groupPk: GroupElement,
  msg: Uint8Array,
  roster: RosterCommitment[],
  round1Msgs: Round1Msg[],
): SharedChallenge {
  const input = hashToPoint(msg)
  const indices = round1Msgs.map((m) => m.index)
  const lambdas = new Map<number, bigint>()
  const rhos = new Map<number, bigint>()
  const rBs = new Map<number, GroupElement>()
  let rB = Point.ZERO
  let rP = Point.ZERO
  let gamma = Point.ZERO
  for (const m of round1Msgs) {
    const entry = roster.find((r) => r.index === m.index)
    if (!entry) throw new Error(`round-1 message from party ${m.index} not in commitment roster`)
    const lambda = lagrangeAt0(indices, m.index)
    const rho = bindingFactor(m.index, msg, roster)
    const rBi = entry.D.add(mul(entry.E, rho))
    lambdas.set(m.index, lambda)
    rhos.set(m.index, rho)
    rBs.set(m.index, rBi)
    rB = rB.add(mul(rBi, lambda))
    rP = rP.add(mul(m.rP, lambda))
    gamma = gamma.add(mul(m.gamma, lambda))
  }
  return { rB, rP, gamma, c: challenge(groupPk, input, gamma, rB, rP), lambdas, rhos, rBs }
}

// ---------------------------------------------------------------------------
// Phase 4 — online round 2: responses

export function round2(party: PartyKey, state: Round1State, c: bigint): bigint {
  return Fn.add(state.k, Fn.mul(c, party.secret))
}

// ---------------------------------------------------------------------------
// Phase 5/6 — output, aggregation, public verification

export function outputBeta(gamma: GroupElement): Uint8Array {
  return hashBytes('output', gamma.toBytes())
}

export function betaHex(beta: Uint8Array): string {
  return bytesToHex(beta)
}

export interface VerifyResult extends DleqCheck {
  /** β == H(Γ) — the output really is the hash of the proven point. */
  betaMatches: boolean
  valid: boolean
}

export function verify(groupPk: GroupElement, msg: Uint8Array, beta: Uint8Array, proof: Proof): VerifyResult {
  const input = hashToPoint(msg)
  const c = challenge(groupPk, input, proof.gamma, proof.rB, proof.rP)
  const dleq = verifyDleq(groupPk, input, proof.gamma, proof.rB, proof.rP, c, proof.z)
  const betaMatches = bytesToHex(outputBeta(proof.gamma)) === bytesToHex(beta)
  return { ...dleq, betaMatches, valid: dleq.ok && betaMatches }
}

/** The dealer's demo-only direct evaluation β = H(sk·P) for compare-both-sides. */
export function evaluateDirect(dealerSecret: bigint, msg: Uint8Array): { gamma: GroupElement; beta: Uint8Array } {
  const gamma = mul(hashToPoint(msg), dealerSecret)
  return { gamma, beta: outputBeta(gamma) }
}

// ---------------------------------------------------------------------------
// Coordinator — runs all phases and records a transcript for the UI and tests

export interface RunOptions {
  cheats?: Map<number, CheatMode>
  rng?: Rng
}

export function runEvaluation(
  ceremony: KeyCeremony,
  nonces: Map<number, NoncePair>,
  message: string,
  rosterIndices: number[],
  opts: RunOptions = {},
): Transcript {
  const { cheats = new Map<number, CheatMode>(), rng = defaultRng } = opts
  const msg = utf8ToBytes(message)
  const input = hashToPoint(msg)
  const roster = [...rosterIndices].sort((a, b) => a - b)
  if (new Set(roster).size !== roster.length) throw new Error('duplicate party index in roster')
  const partiesByIndex = new Map(ceremony.parties.map((p) => [p.index, p]))
  for (const i of roster) {
    if (!partiesByIndex.has(i)) throw new Error(`unknown party index ${i}`)
    if (!nonces.has(i)) throw new Error(`party ${i} has no preprocessed nonce pair`)
  }

  const absent = roster.filter((i) => cheats.get(i) === 'absent')
  const responders = roster.filter((i) => cheats.get(i) !== 'absent')
  const withheld = responders.filter((i) => cheats.get(i) === 'withhold-response')
  const batch = roster.length > 0 ? nonces.get(roster[0])!.batch : 0

  const commitments: RosterCommitment[] = responders.map((i) => {
    const np = nonces.get(i)!
    return { index: i, D: np.D, E: np.E }
  })

  const base: Omit<Transcript, 'status'> = {
    message,
    input,
    batch,
    commitments,
    roster,
    responders,
    absent,
    withheld,
    partials: [],
    blamed: [],
  }

  // Fail closed: an aggregator that cannot reach t honest partials refuses to
  // emit anything rather than emitting something unverifiable.
  if (responders.length < ceremony.t) {
    return { ...base, status: 'refused-below-threshold' }
  }

  // Round 1 — each responder broadcasts (Γ_i, R_i^P).
  const states = new Map<number, Round1State>()
  const round1Msgs: Round1Msg[] = []
  for (const i of responders) {
    const party = partiesByIndex.get(i)!
    const { msg1, state } = round1(party, nonces.get(i)!, msg, commitments)
    const cheat = cheats.get(i)
    if (cheat === 'corrupt-gamma') {
      // A lying party shifts its partial — the curve math still "works", only
      // the DLEQ check can tell this apart from an honest contribution.
      msg1.gamma = msg1.gamma.add(Point.BASE)
    } else if (cheat === 'grind-nonce') {
      // A grinding party discards its preprocessed nonce and picks a fresh one
      // after seeing the message — its R_i^P changes accordingly, but its
      // (D_i, E_i) commitment on the key base is already pinned.
      const kFresh = randomScalar(rng)
      state.k = kFresh
      msg1.rP = mul(input, kFresh)
    }
    states.set(i, state)
    round1Msgs.push(msg1)
  }

  // Phase 3 — everyone derives the same challenge from the broadcasts.
  const shared = sharedChallenge(ceremony.groupPk, msg, commitments, round1Msgs)

  /** Round 2 + public DLEQ check for a set of round-1 broadcasts. */
  const respond = (msgs: Round1Msg[]): PartialRecord[] =>
    msgs.map((m) => {
      const party = partiesByIndex.get(m.index)!
      const z = round2(party, states.get(m.index)!, shared.c)
      const check = verifyDleq(party.pk, input, m.gamma, shared.rBs.get(m.index)!, m.rP, shared.c, z)
      return {
        ...m,
        rho: shared.rhos.get(m.index)!,
        rB: shared.rBs.get(m.index)!,
        lambda: shared.lambdas.get(m.index)!,
        z,
        check,
      }
    })

  // Selective abort: a withholder has everything it needs to compute the
  // output right now (Γ = Σ λ_i·Γ_i is public after round 1) — but by refusing
  // round 2 it stops the proof from being completed with this participant set.
  // λ was fixed over the round-1 set, so the others cannot route around the
  // missing z_i; the evaluation aborts and must rerun without the withholder.
  if (withheld.length > 0) {
    // Everyone who did NOT withhold still publishes round 2 — that is exactly
    // the step that exposes a corrupted or reground partial. Run it, so a
    // MIXED cast is scored against what actually verified rather than against
    // the raw round-1 aggregate.
    const answered = respond(round1Msgs.filter((m) => !withheld.includes(m.index)))
    const blamed = answered.filter((p) => !p.check.ok).map((p) => p.index)
    const verifiedPartials = answered.filter((p) => p.check.ok).map((p) => p.index)
    const rawBeta = outputBeta(shared.gamma)

    // Uncontested: every partial that could be checked passed, so the round-1
    // aggregate really is the protocol's output and the withholder knows it.
    if (blamed.length === 0) {
      return {
        ...base,
        status: 'aborted-withheld',
        partials: answered,
        rB: shared.rB,
        rP: shared.rP,
        c: shared.c,
        gamma: shared.gamma,
        learnedBeta: rawBeta,
      }
    }

    // Contested: the aggregate the withholder saw includes a partial that
    // fails verification, so H(Γ) over it is not β — it is a value no
    // participant set could have published. What the cast CAN determine is
    // whatever the verified partials determine, and only if they still reach t.
    let verifiedSubsetBeta: Uint8Array | undefined
    if (verifiedPartials.length >= ceremony.t) {
      let subsetGamma = Point.ZERO
      for (const p of answered) {
        if (!p.check.ok) continue
        subsetGamma = subsetGamma.add(mul(p.gamma, lagrangeAt0(verifiedPartials, p.index)))
      }
      verifiedSubsetBeta = outputBeta(subsetGamma)
    }

    return {
      ...base,
      status: 'aborted-withheld',
      partials: answered,
      blamed,
      rB: shared.rB,
      rP: shared.rP,
      c: shared.c,
      gamma: shared.gamma,
      contestedBeta: rawBeta,
      verifiedPartials,
      verifiedSubsetBeta,
    }
  }

  // Round 2 — responses, then public per-party DLEQ checks.
  const partials: PartialRecord[] = respond(round1Msgs)

  const blamed = partials.filter((p) => !p.check.ok).map((p) => p.index)
  const aggregates = { partials, rB: shared.rB, rP: shared.rP, c: shared.c, gamma: shared.gamma, blamed }

  // Fail closed: one bad partial poisons the shared-challenge transcript, so
  // the evaluation aborts with the cheater named — rerun without them.
  if (blamed.length > 0) {
    return { ...base, ...aggregates, status: 'aborted-cheater' }
  }

  const z = partials.reduce((acc, p) => Fn.add(acc, Fn.mul(p.lambda, p.z)), 0n)
  const proof: Proof = { gamma: shared.gamma, rB: shared.rB, rP: shared.rP, z }
  return { ...base, ...aggregates, status: 'ok', beta: outputBeta(shared.gamma), proof }
}
