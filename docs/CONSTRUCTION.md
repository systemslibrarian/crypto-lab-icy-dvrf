# Construction Map — `crypto-lab-icy-dvrf:v1:ristretto255-SHA512`

This document pins down **exactly what this demo computes**: every hashed byte, every encoding,
and every place where this instantiation deliberately differs from the paper that inspired it.
A reader should be able to answer "which construction, which bytes, which deviations" from this
file alone, without inferring anything from source code.

## Provenance and status

- **Inspiration:** Ağırtaş, Özer, Saygı, Yayla, *"Icy-DVRF: A Distributed Verifiable Random
  Function based on FROST signatures"*, [eprint 2026/969](https://eprint.iacr.org/2026/969).
  Information used from the paper: the publicly available abstract (consulted 2026-07-19), which
  describes FROST-style preprocessing to reduce interaction rounds over DVRFwCP, O(t) added
  communication, constant-size proofs, and one additional off-chain round relative to DDH-DVRF and
  GLOW-DVRF. The ePrint has had multiple revisions (a revision was posted 2026-07-15); no revision's
  full construction has been transcribed into this repository.
- **Status:** this is an **Icy-DVRF-inspired educational instantiation**, not a conformant
  implementation. **Equivalence to the paper has not been established** and is not claimed. No
  official test vectors exist for Icy-DVRF as of this writing; if any are published, they should be
  added as differential tests alongside (not replacing) the frozen local vectors.
- **Review status:** the equations and this map have **not** been independently reviewed by a
  cryptographer who did not author the code. The code is **not audited**.
- **Version discipline:** the suite string `crypto-lab-icy-dvrf:v1:ristretto255-SHA512`
  (`SUITE` in [`src/dvrf/envelope.ts`](../src/dvrf/envelope.ts)) is the construction fingerprint.
  Any change to a hashed byte, an encoding, or the envelope format requires bumping `v1` and
  regenerating the frozen vectors in [`src/dvrf/golden.test.ts`](../src/dvrf/golden.test.ts).

## Group, hash, and encodings

| Item | Definition |
| --- | --- |
| Group | ristretto255 ([RFC 9496](https://www.rfc-editor.org/rfc/rfc9496)), prime order L = 2²⁵² + 27742317777372353535851937790883648493 |
| Group implementation | `@noble/curves` (`ristretto255.Point`), pinned by 52 RFC 9496 KATs in [`src/dvrf/rfc9496.test.ts`](../src/dvrf/rfc9496.test.ts) |
| Point encoding | 32-byte canonical RFC 9496 encode/decode (`toBytes`/`fromHex`); non-canonical encodings are rejected |
| Scalar encoding (hex contexts) | 64 lowercase hex chars, **big-endian**, zero-padded (`z.toString(16).padStart(64, '0')`) |
| Hash | SHA-512 throughout |
| Framing | Every hash input is `frame(part₁, …, partₙ)`: each part prefixed with its 4-byte **big-endian** length, then concatenated ([`src/dvrf/group.ts`](../src/dvrf/group.ts) `frame`) |
| Domain separation | Every hash uses the prefix `crypto-lab-icy-dvrf:v1:` + a per-use tag (below) |
| Hash-to-group | RFC 9380 `hash_to_ristretto255` with DST `crypto-lab-icy-dvrf:v1:h2g` (`hashToPoint`) |
| Hash-to-scalar | `expand_message_xmd(SHA-512)` → 64 bytes → **little-endian** integer reduced mod L (noble's ristretto255 `hashToScalar`), with DST `crypto-lab-icy-dvrf:v1:<tag>` |
| Party indices in hashes | Decimal ASCII of the 1-based index (e.g. `"3"`), framed like any other part |
| Randomness | 48 uniform bytes → big-endian integer mod L, zero rejected and resampled (`randomScalar`) |

## Phase map (paper concept → this repository)

| Phase | What is computed | Where |
| --- | --- | --- |
| 0. Key generation | Trusted dealer samples sk, Shamir-shares it (degree t−1, f(0)=sk, shares f(1..n)); PK = sk·B, PKᵢ = xᵢ·B | `dealerKeygen` in [`src/dvrf/protocol.ts`](../src/dvrf/protocol.ts), `dealShares` in [`src/dvrf/shamir.ts`](../src/dvrf/shamir.ts) |
| 1. Offline preprocessing | Party i samples one-time (dᵢ, eᵢ), publishes (Dᵢ, Eᵢ) = (dᵢ·B, eᵢ·B); pairs are single-use and batch-tagged | `preprocess` |
| 2. Online round 1 | P = H2G(m); ρᵢ = binding factor (below); kᵢ = dᵢ + ρᵢ·eᵢ; broadcast (Γᵢ = xᵢ·P, Rᵢᴾ = kᵢ·P) | `round1`, `bindingFactor` |
| 3. Shared challenge | λᵢ = Lagrange at 0 over the **responder set**; Rᵢᴮ = Dᵢ + ρᵢ·Eᵢ; R_B = Σλᵢ·Rᵢᴮ; R_P = Σλᵢ·Rᵢᴾ; Γ = Σλᵢ·Γᵢ; c = H2S(challenge transcript) | `sharedChallenge`, `lagrangeAt0` |
| 4. Online round 2 | zᵢ = kᵢ + c·xᵢ | `round2` |
| 5. Per-party check + aggregation | For each i: zᵢ·B = Rᵢᴮ + c·PKᵢ and zᵢ·P = Rᵢᴾ + c·Γᵢ (blame on failure, abort fail-closed); else z = Σλᵢ·zᵢ; proof π = (Γ, R_B, R_P, z); β = H(Γ) | `runEvaluation`, `verifyDleq` in [`src/dvrf/dleq.ts`](../src/dvrf/dleq.ts), `outputBeta` |
| 6. Public verification | c′ = H2S(challenge transcript); check z·B = R_B + c′·PK, z·P = R_P + c′·Γ, β = H(Γ) — each reported independently | `verify` |

## Exact hash transcripts

With `frame` = 4-byte-BE length-prefixed concatenation, `‖` denoting frame parts, and all points
as 32-byte RFC 9496 encodings:

- **Input point:** `P = hash_to_ristretto255(m)`, DST `crypto-lab-icy-dvrf:v1:h2g`; `m` is the
  UTF-8 encoding of the message string.
- **Binding factor** (tag `binding`), roster sorted ascending by index:
  `ρᵢ = H2S( ascii(i) ‖ m ‖ ascii(j₁) ‖ D_{j₁} ‖ E_{j₁} ‖ … ‖ ascii(j_k) ‖ D_{j_k} ‖ E_{j_k} )`
  over the responder roster — so preprocessed material is bound to this message **and** this
  participant set and cannot be replayed into another evaluation.
- **Challenge** (tag `dleq-chal`), identical for per-party checks and the final proof:
  `c = H2S( PK* ‖ P ‖ Γ* ‖ R_B* ‖ R_P* )` where the starred values are the group key and
  aggregates for the final proof, or PKᵢ/Γᵢ/Rᵢᴮ/Rᵢᴾ — with the same shared `c` — for per-party
  checks.
- **Output** (tag `output`): `β = SHA-512( frame( utf8("crypto-lab-icy-dvrf:v1:output") ‖ Γ ) )`,
  64 bytes.

## Proof envelope (portable verification artifact)

Canonical JSON, exact field set, defined in [`src/dvrf/envelope.ts`](../src/dvrf/envelope.ts):

```json
{
  "v": 1,
  "suite": "crypto-lab-icy-dvrf:v1:ristretto255-SHA512",
  "groupPk": "<64 hex, canonical point>",
  "message": "<UTF-8 string, ≤ 1024 chars>",
  "beta": "<128 hex>",
  "gamma": "<64 hex, canonical point>",
  "rB": "<64 hex, canonical point>",
  "rP": "<64 hex, canonical point>",
  "z": "<64 hex, big-endian scalar < L>"
}
```

Parsing is strict and fail-closed: unknown/missing/extra fields, wrong lengths, non-lowercase hex,
non-canonical point encodings, and out-of-range scalars are all rejected with the field named,
before any curve math runs. Serialized proof size: **128 bytes** (three points + one scalar),
independent of t and n.

## Abort and retry semantics

- **Below threshold** (responders < t): refuse, emit nothing.
- **DLEQ failure**: abort with the failing parties named (per-equation results are public); no
  output. The shared challenge binds the whole responder set, so the evaluation restarts with an
  honest roster rather than patching around the cheater.
- **Withheld round 2**: abort; the withheld β (computable by everyone from round 1) is displayed
  to teach that selective abort censors publication but cannot select a different output.
- **Retry rule** (taught, and required for the no-steering claim): retries keep the group key and
  message fixed and replace the misbehaving party. Rolling a fresh candidate output on retry would
  let an aborting coalition bias the *published* distribution.

## Round-ladder comparison basis

Counted as **online broadcast rounds per evaluation** under a synchronous broadcast model,
excluding request/response transport:

| Design | Online rounds | Proof/verification size | Basis |
| --- | --- | --- | --- |
| GLOW / DDH-style DVRF | 1 (partials + individual NIZKs, non-interactive) | t proofs to check, or pairing operations | literature-standard structure of these schemes |
| Interactive CP-DVRF, no preprocessing | 3 (commit nonces; broadcast partials/derive challenge; respond) | constant | the shared-challenge structure of this instantiation with the commit round forced online |
| This instantiation (Icy-style) | 2 (+ offline, message-independent preprocessing) | constant (128 bytes) | measured here; consistent with the Icy-DVRF abstract's "one additional off-chain round vs. DDH-DVRF/GLOW-DVRF" |

Labels: the middle column values for this instantiation are **measured** by the demo; the other
rows are **derived** from the schemes' published structure, not benchmarked here.

## Deliberate deviations from the paper

1. **Group:** ristretto255 instead of the paper's EVM-oriented curve setting (its abstract benchmarks
   on-chain verification on Sepolia via the **EIP-2537 BLS12-381 precompiles** at 88,803 gas; nothing
   EVM-related, and no BLS12-381 arithmetic, is reproduced here).
2. **Key generation:** trusted dealer instead of a DKG. The dealer's secret is retained solely to
   power the compare-both-sides exhibit.
3. **Transcripts:** the framing, domain-separation strings, binding-factor inputs, challenge input
   order, and output hash are this demo's own definitions (documented above), not transcribed from
   the paper.
4. **Network:** all parties are objects in one browser tab; "rounds" are simulated synchronous
   broadcasts.
5. **Robustness:** blame-then-restart with a fixed message, as described above; the paper's exact
   identifiable-abort/robustness mechanics have not been transcribed.
6. **No side-channel hardening:** nothing is constant-time.

## Frozen vectors

[`src/dvrf/golden.test.ts`](../src/dvrf/golden.test.ts) freezes a deterministic 3-of-5 transcript
(seeded RNG): dealer secret, group key, input point, challenge, β, all four proof components, and
the byte-exact envelope. CI fails if any hashed byte of the construction changes without a version
bump.
