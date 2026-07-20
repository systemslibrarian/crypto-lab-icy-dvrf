# crypto-lab-icy-dvrf

## What It Is

A browser-based educational demo of a **t-of-n distributed verifiable random function (DVRF)**
inspired by **Icy-DVRF** (Ağırtaş, Özer, Saygı, Yayla, [eprint 2026/969](https://eprint.iacr.org/2026/969)):
partial VRF evaluations proven with **Chaum–Pedersen DLEQ proofs** under one shared Fiat–Shamir
challenge, with **FROST-style preprocessed nonce commitments** so the online phase is two broadcast
rounds and the aggregated proof is **constant-size** — 128 bytes whether 3 parties contributed or 300.
This is the demo's *own instantiation* over ristretto255, not a conformant implementation of the
paper; equivalence has not been established, and every hashed byte, encoding, and deliberate
deviation is documented in [docs/CONSTRUCTION.md](docs/CONSTRUCTION.md) and pinned by frozen
transcript vectors in CI.

The security story it teaches, as four **separate** properties: *unpredictability* (before the
evaluation, nobody knows β), *fixed-input uniqueness* (for one group key and one message, no other β
can ever verify — so no t−1 coalition can steer the value), *public verifiability* (anyone checks
two DLEQ equations against the group key alone), and *liveness* — the one property cheaters can
attack: a coalition can learn β and then censor its publication (selective abort), which is why real
beacons must keep the message fixed on retry.

Everything cryptographic runs live in the page over **ristretto255** ([RFC 9496](https://www.rfc-editor.org/rfc/rfc9496)),
with the group arithmetic from [@noble/curves](https://github.com/paulmillr/noble-curves) pinned to the
RFC's known-answer vectors, and the protocol layer (Shamir, binding factors, DLEQ, aggregation,
envelope) hand-rolled in small, tested TypeScript modules. **Not production crypto** — a teaching
demo: one browser tab plays every party, a trusted dealer stands in for a DKG, and nothing is
constant-time.

## Exhibits

1. **Key ceremony** — deal a fresh secret into n Shamir shares with threshold t (n ≤ 7); see the group
   key PK and each party's verification share. The trusted dealer is labelled as the demo
   simplification it is, and changing the sliders afterwards flags the ceremony as stale instead of
   silently lying.
2. **Offline preprocessing** — each party publishes one-time nonce commitments (Dᵢ, Eᵢ) *before any
   message exists*, in numbered batches with a visible **queued → spent** lifecycle: a consumed batch
   stays on screen as evidence, so every binding factor and proof traces back to commitments you can
   still see.
3. **Two online rounds** — step the real evaluation: hash-to-curve, round 1 (partials Γᵢ = xᵢ·P plus
   input-base nonces), one shared challenge with Lagrange weights, round 2 (responses zᵢ), per-party
   DLEQ checks, aggregation to β = H(Γ). Upstream controls lock while a walk is on screen, so nothing
   visible can contradict the transcript. A **round ladder** alongside compares pairing-based DVRFs
   (1 round, linear-size work), interactive Chaum–Pedersen DVRFs (3 rounds), and the preprocessed
   2-round path — the demo's central "aha".
4. **Public verification** — check the constant-size proof (Γ, R_B, R_P, z) with nothing but the group
   key: two DLEQ equations reported independently, plus β = H(Γ). A compute-both-sides table compares
   the threshold β byte-for-byte against the dealer's direct sk·P evaluation; a subset swap shows two
   committees producing the identical output; an **export** produces a canonical JSON proof envelope;
   and a **verifier workbench** — sharing no state with the other exhibits — strictly parses any
   pasted envelope (exact fields, canonical encodings) before running the equations, so "anyone can
   check it" is demonstrated, not asserted.
5. **Break it yourself** — script a cast: corrupt a partial (fails the DLEQ *input* equation), swap a
   nonce after seeing the message (fails the *key* equation — the substitution can be attempted, it
   just can't verify against the precommitted slot), **withhold round 2** (learn β, then censor it —
   the selective-abort limit of "no bias"), or go absent (tolerated at ≥ t responders, refused below —
   fail closed, never "best effort"). Rerun with an honest threshold and watch the byte-identical β
   appear: cheating can delay or censor the beacon, never steer it.

## When to Use It

- To understand why "trust our random number" is fixable — how VRF proofs make randomness auditable.
- To see what FROST-style preprocessing actually buys: which round disappears, and why the pinned
  nonce commitment is also what defeats post-message nonce substitution.
- To learn the exact boundary of threshold "no bias": uniqueness (unbeatable) vs. liveness
  (attackable by selective abort) — and the retry rule that keeps beacons honest.
- **Do NOT use it** as a randomness beacon, as a reference implementation of eprint 2026/969, or as a
  source of key material — the dealer holds the whole secret and the code is optimized for
  inspectability, not side-channel resistance.

## Live Demo

**<https://systemslibrarian.github.io/crypto-lab-icy-dvrf/>**

Deal shares, publish a preprocessing batch, step the two online rounds for any message, export the
proof and verify it in the workbench (or another machine), then make parties cheat and watch the
math name them.

## What Can Go Wrong

- **Nonce reuse** — a preprocessed pair is one-time; the code hard-refuses a second spend (as FROST
  deployments must, or the key leaks).
- **Nonce substitution** — a party that picks a fresh nonce after seeing the message can still send
  it, but no substituted nonce can produce a proof that verifies against its published (Dᵢ, Eᵢ)
  commitment, and the key equation names the party.
- **Corrupt partials** — an invented Γᵢ breaks the input equation; the evaluation aborts with no
  output rather than emitting something unverifiable.
- **Selective abort** — after round 1, everyone (including a withholder) can compute β; refusing
  round 2 censors publication. No alternative β exists, but a surrounding beacon that changes the
  message or rolls a fresh candidate on retry converts censorship into bias — the retry rule matters.
- **Too few parties** — below t the protocol refuses outright. Cheaters plus absentees reaching
  n − t + 1 can *halt* the beacon (liveness), but can never bias a published output for a fixed
  message (safety).
- **Trusted dealer** — the demo's dealer momentarily knows everything; real systems must use a DKG so
  no one ever does.

## Real-World Usage

Distributed randomness beacons power validator and leader elections (Algorand-style sortition,
drand/League of Entropy), on-chain lotteries and gaming (Chainlink VRF is single-party VRF; DVRFs like
GLOW and DDH-DVRF decentralize the trust), and committee sampling in consensus protocols. Icy-DVRF's
contribution is doing this pairing-free with constant-size proofs and FROST-style low online latency —
the properties this demo makes visible.

## How to Run Locally

```bash
npm ci
npm run dev        # dev server
npm test           # 89 Vitest tests incl. 52 RFC 9496 KATs + frozen transcript vectors
npm run build      # typecheck + production build
npm run test:a11y  # Playwright: axe WCAG 2.1 A/AA gate (both themes) + UI regression suite (build first)
```

Requires Node ≥ 22 (declared in `engines`).

## Related Demos

- [crypto-lab-vrf-gate](https://systemslibrarian.github.io/crypto-lab-vrf-gate/) — the single-party VRF this page distributes
- [crypto-lab-frost-threshold](https://systemslibrarian.github.io/crypto-lab-frost-threshold/) — FROST threshold *signing*, where the preprocessing trick comes from
- [crypto-lab-shamir-gate](https://systemslibrarian.github.io/crypto-lab-shamir-gate/) — Shamir secret sharing on its own
- [crypto-lab-vss-gate](https://systemslibrarian.github.io/crypto-lab-vss-gate/) — verifiable sharing, the road toward the DKG this demo leaves out

## Build & Verify

- **89 unit tests** (Vitest, colocated in `src/`): Shamir round-trips and Lagrange identities, DLEQ
  accept/reject per equation, full-protocol tests (threshold output ≡ direct evaluation, subset
  independence, tamper rejection for every proof component, cheater blame, selective abort with
  learned-output equality, nonce single-use, zero-scalar rejection, below-threshold refusal, 2-of-2
  through 4-of-7 shapes), and strict envelope parsing (tamper/malformed/non-canonical rejection with
  the field named).
- **52 spec KATs** from RFC 9496 in `src/dvrf/rfc9496.test.ts`: 16 generator multiples, 29 invalid
  encodings rejected, 7 element-derivation vectors.
- **Frozen transcript vectors** (`src/dvrf/golden.test.ts`): a deterministic 3-of-5 evaluation's
  every value — dealer key, challenge, β, proof, byte-exact envelope — pinned so no hashed byte of
  the construction can change silently. Construction map: [docs/CONSTRUCTION.md](docs/CONSTRUCTION.md).
- **8 UI regression tests** (`e2e/ui.spec.ts`): control locking during walks, spent-batch
  traceability, stale-settings flagging, effective-cast honesty, fail-closed refusal, selective-abort
  equality, cross-context envelope verification with tamper rejection, and no horizontal overflow at
  390/320 px in the longest completed states.
- **Accessibility gate**: `e2e/a11y.spec.ts` drives every exhibit into its post-interaction state
  (including workbench, selective-abort, and abort/blame paths) and asserts **zero axe-core WCAG 2.1
  A/AA violations in both themes** against the production build; the Pages deploy is blocked if it
  fails.

---

*One of 120+ browser demos in the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
