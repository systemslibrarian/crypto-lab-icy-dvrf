# crypto-lab-icy-dvrf

## What It Is

A browser-based educational demo of a **t-of-n distributed verifiable random function (DVRF)** in the
style of **Icy-DVRF** (Ağırtaş, Özer, Saygı, Yayla, [eprint 2026/969](https://eprint.iacr.org/2026/969)):
partial VRF evaluations proven with **Chaum–Pedersen DLEQ proofs** under one shared Fiat–Shamir
challenge, with **FROST-style preprocessed nonce commitments** so the online phase is two broadcast
rounds and the aggregated proof is **constant-size** — four values whether 3 parties contributed or 300.

The security model it teaches: a VRF output β is a deterministic, unpredictable, publicly verifiable
function of a group key and a message. Distributing the key with Shamir sharing means any t parties can
produce β, no t−1 can produce, predict, or bias it, and cheating is *detected and named* by the DLEQ
math rather than trusted away.

Everything cryptographic runs live in the page over **ristretto255** ([RFC 9496](https://www.rfc-editor.org/rfc/rfc9496)),
with the group arithmetic from [@noble/curves](https://github.com/paulmillr/noble-curves) pinned to the
RFC's known-answer vectors, and the protocol layer (Shamir, binding factors, DLEQ, aggregation)
hand-rolled in small, tested TypeScript modules. **Not production crypto** — a teaching demo: one
browser tab plays every party, a trusted dealer stands in for a DKG, and nothing is constant-time.

## Exhibits

1. **Key ceremony** — deal a fresh secret into n Shamir shares with threshold t (n ≤ 7); see the group
   key PK and each party's verification share. The trusted dealer is labelled as the demo
   simplification it is.
2. **Offline preprocessing** — each party publishes one-time nonce commitments (Dᵢ, Eᵢ) *before any
   message exists*. This is the FROST idea, and the round it deletes from the online path.
3. **Two online rounds** — step the real evaluation: hash-to-curve, round 1 (partials Γᵢ = xᵢ·P plus
   input-base nonces), one shared challenge with Lagrange weights, round 2 (responses zᵢ), per-party
   DLEQ checks, aggregation to β = H(Γ). A **round ladder** alongside compares pairing-based DVRFs
   (1 round, linear-size work), interactive Chaum–Pedersen DVRFs (3 rounds), and the
   preprocessed 2-round path — the demo's central "aha".
4. **Public verification** — check the constant-size proof (Γ, R_B, R_P, z) with nothing but the group
   key: two DLEQ equations reported independently, plus β = H(Γ). A compute-both-sides table compares
   the threshold β byte-for-byte against the dealer's direct sk·P evaluation, and a subset swap shows
   two different committees producing the identical output.
5. **Break it yourself** — script a cast: corrupt a partial (fails the DLEQ *input* equation), swap a
   nonce after seeing the message (fails the *key* equation, because preprocessing pinned it), or go
   absent (tolerated at ≥ t responders, refused below — fail closed, never "best effort"). Rerun with
   honest parties and watch the identical β appear: cheating can delay the beacon, never bend it.

## When to Use It

- To understand why "trust our random number" is fixable — how VRF proofs make randomness auditable.
- To see what FROST-style preprocessing actually buys: which round disappears and why the pinned
  nonce commitment is also what defeats nonce-grinding.
- To learn why threshold outputs are *unique* — why changing the committee cannot change the answer.
- **Do NOT use it** as a randomness beacon, as a reference implementation of eprint 2026/969, or as a
  source of key material — the dealer holds the whole secret and the code is optimized for
  inspectability, not side-channel resistance.

## Live Demo

**<https://systemslibrarian.github.io/crypto-lab-icy-dvrf/>**

Deal shares, publish a preprocessing batch, step the two online rounds for any message, verify the
output publicly, then make parties cheat and watch the math name them.

## What Can Go Wrong

- **Nonce reuse** — a preprocessed pair is one-time; the code hard-refuses a second spend (as FROST
  deployments must, or the key leaks).
- **Nonce grinding** — a party that picks its nonce after seeing the message breaks the DLEQ key
  equation against its published (Dᵢ, Eᵢ) commitment and is blamed.
- **Corrupt partials** — an invented Γᵢ breaks the input equation; the evaluation aborts with no
  output rather than emitting something unverifiable.
- **Too few parties** — below t the protocol refuses outright. Cheaters plus absentees reaching
  n − t + 1 can *halt* the beacon (liveness), but can never bias it (safety).
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
npm test           # 78 Vitest tests incl. 52 RFC 9496 KATs
npm run build      # typecheck + production build
npm run test:a11y  # axe-core WCAG 2.1 A/AA gate, both themes (build first)
```

## Related Demos

- [crypto-lab-vrf-gate](https://systemslibrarian.github.io/crypto-lab-vrf-gate/) — the single-party VRF this page distributes
- [crypto-lab-frost-threshold](https://systemslibrarian.github.io/crypto-lab-frost-threshold/) — FROST threshold *signing*, where the preprocessing trick comes from
- [crypto-lab-shamir-gate](https://systemslibrarian.github.io/crypto-lab-shamir-gate/) — Shamir secret sharing on its own
- [crypto-lab-vss-gate](https://systemslibrarian.github.io/crypto-lab-vss-gate/) — verifiable sharing, the road toward the DKG this demo leaves out

## Build & Verify

- **78 unit tests** (Vitest, colocated in `src/`): Shamir round-trips and Lagrange identities, DLEQ
  accept/reject per equation, full-protocol tests (threshold output ≡ direct evaluation, subset
  independence, tamper rejection for every proof component, cheater blame, nonce single-use,
  below-threshold refusal, 2-of-2 through 4-of-7 shapes).
- **52 spec KATs** from RFC 9496 in `src/dvrf/rfc9496.test.ts`: 16 generator multiples, 29 invalid
  encodings rejected, 7 element-derivation vectors.
- **Accessibility gate**: `e2e/a11y.spec.ts` drives every exhibit into its post-interaction state
  (including the abort/blame path) and asserts **zero axe-core WCAG 2.1 A/AA violations in both
  themes** against the production build; the Pages deploy is blocked if it fails.

---

*One of 120+ browser demos in the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
