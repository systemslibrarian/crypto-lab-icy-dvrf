import './style.css'
import { bytesToHex, utf8ToBytes } from './dvrf/group.ts'
import {
  type CheatMode,
  type KeyCeremony,
  type NoncePair,
  type Transcript,
  betaHex,
  dealerKeygen,
  evaluateDirect,
  preprocess,
  runEvaluation,
  verify,
} from './dvrf/protocol.ts'
import { EnvelopeError, PROOF_BYTES, serializeEnvelope, verifyEnvelope } from './dvrf/envelope.ts'
import { escapeHtml, pointHex, scalarHex, short } from './ui/format.ts'

// ---------------------------------------------------------------------------
// State
//
// The page renders only from immutable snapshots: an evaluation captures the
// ceremony, message, roster, cheat cast, and the exact nonce batch it consumed
// (`Transcript`), and upstream controls are locked while a walk is revealing
// one. A spent batch stays on screen — historical evidence is never replaced
// in place.

interface Batch {
  id: number
  nonces: Map<number, NoncePair>
}

interface SpentBatch extends Batch {
  message: string
  responders: number[]
}

interface AppState {
  ceremony?: KeyCeremony
  ceremonyParams?: { n: number; t: number }
  queued?: Batch
  spent?: SpentBatch
  nextBatchId: number
  /** Last successful evaluation (feeds Exhibits 4 and 5). */
  lastOk?: Transcript
  /**
   * The β a withholder learned in the most recent selective abort. Kept so the
   * honest rerun can actually show the byte-for-byte comparison the abort
   * verdict promises, even when no successful run preceded it.
   */
  lastWithheld?: { message: string; beta: Uint8Array; label: string }
  steps: string[]
  ladderRungs: string[][]
  stepIndex: number
}

const state: AppState = { nextBatchId: 1, steps: [], ladderRungs: [], stepIndex: 0 }

/** The transcript currently being revealed step by step, if any. */
let current: Transcript | undefined

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const nInput = $<HTMLInputElement>('n-input')
const tInput = $<HTMLInputElement>('t-input')
const msgInput = $<HTMLInputElement>('msg-input')
const setupBtn = $<HTMLButtonElement>('setup-btn')
const preBtn = $<HTMLButtonElement>('pre-btn')
const stepBtn = $<HTMLButtonElement>('step-btn')
const runAllBtn = $<HTMLButtonElement>('runall-btn')
const resetEvalBtn = $<HTMLButtonElement>('reset-eval-btn')
const verifyBtn = $<HTMLButtonElement>('verify-btn')
const subsetBtn = $<HTMLButtonElement>('subset-btn')
const breakBtn = $<HTMLButtonElement>('break-btn')
const honestRerunBtn = $<HTMLButtonElement>('honest-rerun-btn')
const wbVerifyBtn = $<HTMLButtonElement>('wb-verify-btn')
const wbInput = $<HTMLTextAreaElement>('wb-input')

// ---------------------------------------------------------------------------
// Small render helpers

function chip(kind: 'ok' | 'bad' | 'warn', icon: string, label: string): string {
  return `<span class="chip chip-${kind}"><span aria-hidden="true">${icon}</span> ${label}</span>`
}

function verdict(kind: 'ok' | 'bad' | 'warn', title: string, body: string): string {
  return `<div class="verdict verdict-${kind}"><h3>${title}</h3>${body}</div>`
}

function msgChip(label: string, value: string): string {
  return `<span class="msg-chip"><b>${label}</b> ${value}</span>`
}

function partyCards(ceremony: KeyCeremony, extras?: (i: number) => string, blamed: number[] = []): string {
  return `<div class="party-grid">${ceremony.parties
    .map(
      (p) => `
      <div class="party-card${blamed.includes(p.index) ? ' blamed' : ''}">
        <h3>Party ${p.index}${blamed.includes(p.index) ? ` ${chip('bad', '✘', 'blamed')}` : ''}</h3>
        <p class="kv"><b>PK<sub>${p.index}</sub></b> ${short(pointHex(p.pk))}</p>
        ${extras ? extras(p.index) : ''}
      </div>`,
    )
    .join('')}</div>`
}

// ---------------------------------------------------------------------------
// Walk locking — while a transcript is being revealed, nothing upstream of it
// may change, so no visible control can contradict the transcript on screen.

function setLocked(locked: boolean): void {
  const haveCeremony = state.ceremony !== undefined
  const haveBatch = state.queued !== undefined
  nInput.disabled = locked
  tInput.disabled = locked
  setupBtn.disabled = locked
  preBtn.disabled = locked || !haveCeremony
  msgInput.disabled = locked
  runAllBtn.disabled = !haveBatch
  stepBtn.disabled = !haveBatch
  resetEvalBtn.disabled = !haveBatch && !locked
  breakBtn.disabled = locked || !haveBatch
  honestRerunBtn.disabled = locked || !haveBatch || honestRerunBtn.dataset.armed !== 'yes'
  document
    .querySelectorAll<HTMLInputElement>('input[name="roster"]')
    .forEach((el) => (el.disabled = locked))
  syncCheatControls(locked)
}

// ---------------------------------------------------------------------------
// Exhibit 1 — key ceremony

function syncThresholdRange(): void {
  const n = Number(nInput.value)
  tInput.max = String(n)
  if (Number(tInput.value) > n) tInput.value = String(n)
  $('n-value').textContent = nInput.value
  $('t-value').textContent = tInput.value
  const p = state.ceremonyParams
  const stale = p !== undefined && (p.n !== Number(nInput.value) || p.t !== Number(tInput.value))
  $('setup-stale').innerHTML = stale
    ? chip('warn', '⚠', `showing a ${p!.t}-of-${p!.n} ceremony — run the ceremony again to apply ${tInput.value}-of-${nInput.value}`)
    : ''
}

function runSetup(): void {
  const n = Number(nInput.value)
  const t = Number(tInput.value)
  // A new ceremony atomically invalidates every descendant: the in-progress
  // walk, batches, outputs, comparisons, and attack results.
  current = undefined
  state.ceremony = dealerKeygen(n, t)
  state.ceremonyParams = { n, t }
  state.queued = undefined
  state.spent = undefined
  state.nextBatchId = 1
  state.lastOk = undefined
  state.lastWithheld = undefined
  resetEvaluation()
  $('pre-out').innerHTML = ''
  $('verify-out').innerHTML = ''
  $('break-out').innerHTML = ''
  $('export-out').innerHTML = ''
  verifyBtn.disabled = true
  subsetBtn.disabled = true
  honestRerunBtn.dataset.armed = 'no'

  $('setup-out').innerHTML = `
    <p>Dealt a ${t}-of-${n} sharing. Any ${t} parties can evaluate; ${t - 1} learn nothing.</p>
    <div class="groupkey"><b>Group public key PK</b> ${pointHex(state.ceremony.groupPk)}</div>
    ${partyCards(state.ceremony)}
    <p>Next: parties publish their offline nonce commitments in Exhibit 2.</p>`

  renderRoster()
  renderCheatControls()
  syncThresholdRange()
  setLocked(false)
}

function renderRoster(): void {
  const { ceremony } = state
  if (!ceremony) return
  $('roster-checks').innerHTML = ceremony.parties
    .map(
      (p) => `
      <label><input type="checkbox" name="roster" value="${p.index}" ${
        p.index <= ceremony.t ? 'checked' : ''
      } /> Party ${p.index}</label>`,
    )
    .join('')
  document
    .querySelectorAll<HTMLInputElement>('input[name="roster"]')
    .forEach((el) => el.addEventListener('change', () => syncCheatControls(false)))
}

function selectedRoster(): number[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[name="roster"]:checked')].map((el) =>
    Number(el.value),
  )
}

// ---------------------------------------------------------------------------
// Exhibit 2 — offline preprocessing with a visible queued → spent lifecycle

function publishBatch(): void {
  const { ceremony } = state
  if (!ceremony) return
  const id = state.nextBatchId++
  state.queued = {
    id,
    nonces: new Map(ceremony.parties.map((p) => [p.index, preprocess(p, undefined, id)])),
  }
  renderPreOut()
  setLocked(false)
}

function batchCards(ceremony: KeyCeremony, batch: Batch, spentBy?: number[]): string {
  return partyCards(ceremony, (i) => {
    const np = batch.nonces.get(i)!
    const status =
      spentBy === undefined
        ? chip('ok', '⏳', 'queued')
        : spentBy.includes(i)
          ? chip('warn', '✔', 'spent')
          : chip('ok', '⏳', 'still queued')
    return `<p class="kv"><b>D<sub>${i}</sub></b> ${short(pointHex(np.D))}</p>
            <p class="kv"><b>E<sub>${i}</sub></b> ${short(pointHex(np.E))}</p>
            <p class="kv">${status}</p>`
  })
}

function renderPreOut(): void {
  const { ceremony, queued, spent } = state
  if (!ceremony) return
  let html = ''
  if (spent) {
    html += `
      <h3>Batch #${spent.id} — consumed by the evaluation of “${escapeHtml(spent.message)}”</h3>
      <p>These are the exact commitments that evaluation's binding factors and proof trace back to —
      they stay on screen as evidence. ${chip('warn', '⏱', 'one-time')} A spent slot can never be
      reused; the code hard-refuses a second spend.</p>
      ${batchCards(ceremony, spent, spent.responders)}`
  }
  if (queued) {
    html += `
      <h3>Batch #${queued.id} — queued for the next evaluation</h3>
      <p>Published before that evaluation's message exists${
        spent ? ' (it will serve a future request, not the one above)' : ''
      } — this is the round that naive protocols must run per evaluation, online.</p>
      ${batchCards(ceremony, queued)}`
  } else if (!spent) {
    html = ''
  }
  $('pre-out').innerHTML = html
}

// ---------------------------------------------------------------------------
// Exhibit 3 — stepped evaluation + round ladder

const LADDER_DONE_AT_END = ['icy-0', 'icy-1', 'icy-2']

function setLadder(now: string[], done: string[]): void {
  document.querySelectorAll<HTMLElement>('.ladder [data-rung]').forEach((el) => {
    el.classList.toggle('rung-now', now.includes(el.dataset.rung!))
    el.classList.toggle('rung-done', done.includes(el.dataset.rung!))
  })
}

function resetEvaluation(): void {
  current = undefined
  state.steps = []
  state.ladderRungs = []
  state.stepIndex = 0
  $('eval-steps').innerHTML = ''
  $('eval-out').innerHTML = ''
  setLadder([], [])
  setLocked(false)
}

function buildSteps(tr: Transcript): void {
  const steps: string[] = []
  const rungs: string[][] = []
  const push = (html: string, now: string[]): void => {
    steps.push(html)
    rungs.push(now)
  }

  push(
    `<h3><span class="phase-tag">input</span> Hash the message onto the curve</h3>
     <p>Everyone maps the message to the same point <code>P = HashToGroup(m)</code>. All partials will be
     multiples of this exact point. This walk consumed nonce batch #${tr.batch} — its commitments stay
     visible in Exhibit 2.</p>
     <div class="msg-chips">${msgChip('m', `"${escapeHtml(tr.message)}"`)}${msgChip('P', short(pointHex(tr.input), 16, 8))}</div>`,
    [],
  )

  if (tr.status === 'refused-below-threshold') {
    push(
      `<h3><span class="phase-tag">refused</span> Not enough responders</h3>
       <p>Only ${tr.responders.length} of the required t = ${state.ceremony!.t} parties responded. The
       aggregator emits <em>nothing</em> — a threshold system fails closed rather than producing an
       unverifiable output.</p>`,
      [],
    )
  } else {
    push(
      `<h3><span class="phase-tag">online round 1</span> Broadcast partials and input-base nonces</h3>
       <p>Each participant i derives its binding factor ρ<sub>i</sub> (hash of the message, the roster, and
       every batch-#${tr.batch} commitment), forms its one-time nonce k<sub>i</sub> = d<sub>i</sub> +
       ρ<sub>i</sub>·e<sub>i</sub>, and broadcasts its partial Γ<sub>i</sub> = x<sub>i</sub>·P together with
       R<sub>i</sub><sup>P</sup> = k<sub>i</sub>·P.</p>
       <div class="msg-chips">${tr.partials
         .map((p) => msgChip(`P${p.index}`, `Γ=${short(pointHex(p.gamma), 8, 4)} R=${short(pointHex(p.rP), 8, 4)}`))
         .join('')}</div>`,
      ['icy-1'],
    )
    push(
      `<h3><span class="phase-tag">derived locally</span> One shared challenge for the whole set</h3>
       <p>Anyone can now combine the broadcasts with Lagrange weights λ<sub>i</sub> — and the key-base
       commitments R<sub>i</sub><sup>B</sup> = D<sub>i</sub> + ρ<sub>i</sub>·E<sub>i</sub> come straight
       from offline batch #${tr.batch}. One Fiat–Shamir challenge c covers every party, which is what lets
       t transcripts fold into one constant-size proof.</p>
       <div class="msg-chips">
         ${tr.partials.map((p) => msgChip(`λ${p.index}`, short(scalarHex(p.lambda), 8, 4))).join('')}
         ${msgChip('R_B', short(pointHex(tr.rB!), 10, 5))}${msgChip('R_P', short(pointHex(tr.rP!), 10, 5))}
         ${msgChip('Γ', short(pointHex(tr.gamma!), 10, 5))}${msgChip('c', short(scalarHex(tr.c!), 10, 5))}
       </div>`,
      ['icy-1'],
    )
    push(
      `<h3><span class="phase-tag">online round 2</span> Broadcast responses</h3>
       <p>Each participant answers the shared challenge with z<sub>i</sub> = k<sub>i</sub> +
       c·x<sub>i</sub>. Two rounds total — the commit round happened in the offline batch.</p>
       <div class="msg-chips">${tr.partials
         .map((p) => msgChip(`z${p.index}`, short(scalarHex(p.z), 10, 5)))
         .join('')}</div>`,
      ['icy-2'],
    )

    const checksHtml = tr.partials
      .map((p) =>
        p.check.ok
          ? chip('ok', '✔', `party ${p.index}: DLEQ holds`)
          : chip('bad', '✘', `party ${p.index}: DLEQ FAILS`),
      )
      .join(' ')

    if (tr.status === 'aborted-cheater') {
      push(
        `<h3><span class="phase-tag">checks</span> Per-party DLEQ verification — cheater caught</h3>
         <p>Every partial is checked against that party's public share. The math names the liar:</p>
         <div class="msg-chips">${checksHtml}</div>
         <p>The evaluation aborts with <em>no output at all</em> (fail closed). Rerun with honest parties —
         the outcome cannot be changed by cheating, only delayed.</p>`,
        ['icy-2'],
      )
    } else {
      push(
        `<h3><span class="phase-tag">aggregate</span> Checks pass — fold t transcripts into one proof</h3>
         <p>All partials verify: ${checksHtml}</p>
         <p>Lagrange-weighted sums produce the single proof (Γ, R<sub>B</sub>, R<sub>P</sub>, z) —
         ${PROOF_BYTES} bytes, the same size for any t — and the output β = H(Γ).</p>`,
        ['icy-2'],
      )
    }
  }

  state.steps = steps
  state.ladderRungs = rungs
  state.stepIndex = 0
}

/** Consume the queued batch for an evaluation and queue the next one. */
function consumeBatch(message: string, responders: number[]): Batch {
  const consumed = state.queued!
  state.spent = { ...consumed, message, responders }
  state.queued = undefined
  publishBatch()
  return consumed
}

function startEvaluation(): Transcript | undefined {
  const { ceremony, queued } = state
  if (!ceremony || !queued) return undefined
  const roster = selectedRoster()
  if (roster.length === 0) {
    $('eval-out').innerHTML = verdict(
      'warn',
      '⚠ Pick at least one participant',
      '<p>Select parties above, then step the protocol.</p>',
    )
    return undefined
  }
  const tr = runEvaluation(ceremony, queued.nonces, msgInput.value, roster)
  consumeBatch(tr.message, tr.responders)
  buildSteps(tr)
  return tr
}

function revealStep(): void {
  if (!current) {
    current = startEvaluation()
    if (!current) return
    setLocked(true)
    stepBtn.disabled = false
    runAllBtn.disabled = false
    resetEvalBtn.disabled = false
    $('eval-steps').innerHTML = ''
    $('eval-out').innerHTML = ''
    setLadder([], [])
  }
  if (state.stepIndex >= state.steps.length) return
  const container = $('eval-steps')
  container.querySelectorAll('.step').forEach((el) => el.classList.remove('step-now'))
  const div = document.createElement('div')
  div.className = 'step step-now'
  div.innerHTML = state.steps[state.stepIndex]
  container.appendChild(div)
  const now = state.ladderRungs[state.stepIndex]
  const done = state.ladderRungs.slice(0, state.stepIndex).flat()
  setLadder(now, done.filter((r) => !now.includes(r)))
  state.stepIndex += 1
  if (state.stepIndex === state.steps.length) finishEvaluation()
}

function finishEvaluation(): void {
  if (!current) return
  setLadder([], current.status === 'refused-below-threshold' ? [] : LADDER_DONE_AT_END)
  if (current.status === 'ok') {
    state.lastOk = current
    verifyBtn.disabled = false
    subsetBtn.disabled = false
    honestRerunBtn.dataset.armed = 'yes'
    renderExport(current)
    $('eval-out').innerHTML = `
      <div class="beta-box">
        <h3>β — the group's verifiable random output</h3>
        <p class="beta-hex">${betaHex(current.beta!)}</p>
      </div>
      <p>Proof (Γ, R<sub>B</sub>, R<sub>P</sub>, z) — ${PROOF_BYTES} bytes, constant in t. Take it to
      Exhibit 4, or export it below and verify it anywhere:</p>
      <div class="msg-chips">
        ${msgChip('Γ', short(pointHex(current.proof!.gamma), 16, 8))}
        ${msgChip('R_B', short(pointHex(current.proof!.rB), 16, 8))}
        ${msgChip('R_P', short(pointHex(current.proof!.rP), 16, 8))}
        ${msgChip('z', short(scalarHex(current.proof!.z), 16, 8))}
      </div>`
  } else if (current.status === 'refused-below-threshold') {
    $('eval-out').innerHTML = verdict(
      'warn',
      '⚠ Refused — below threshold',
      `<p>Fewer than t parties participated, so no output exists. That is the fail-closed guarantee:
       a minority cannot produce randomness, honestly or otherwise.</p>`,
    )
  }
  current = undefined
  setLocked(false)
}

function runAllSteps(): void {
  if (!current && state.stepIndex >= state.steps.length && state.steps.length > 0) {
    resetEvaluation()
  }
  do {
    revealStep()
  } while (current && state.stepIndex < state.steps.length)
}

// ---------------------------------------------------------------------------
// Exhibit 4 — public verification, compute both sides, export + workbench

function renderExport(tr: Transcript): void {
  const { ceremony } = state
  if (!ceremony || !tr.beta || !tr.proof) return
  const envelope = serializeEnvelope(ceremony.groupPk, tr.message, tr.beta, tr.proof)
  $('export-out').innerHTML = `
    <p>Everything a stranger needs — construction ID, group key, message, β, and the ${PROOF_BYTES}-byte
    proof. Copy it into the workbench below, another tab, or another machine:</p>
    <textarea class="envelope-box" id="export-box" readonly rows="9"
      aria-label="Exported proof envelope (canonical JSON)">${escapeHtml(envelope)}</textarea>`
}

function runVerify(): void {
  const { ceremony, lastOk } = state
  if (!ceremony || !lastOk?.proof || !lastOk.beta) return
  const res = verify(ceremony.groupPk, utf8ToBytes(lastOk.message), lastOk.beta, lastOk.proof)
  const direct = evaluateDirect(ceremony.dealerSecret, utf8ToBytes(lastOk.message))
  const same = betaHex(lastOk.beta) === bytesToHex(direct.beta)
  const eq = (okFlag: boolean, label: string, formula: string): string =>
    `<p class="eq-row">${
      okFlag ? chip('ok', '✔', label) : chip('bad', '✘', `${label} FAILS`)
    } <code>${formula}</code></p>`
  $('verify-out').innerHTML = `
    ${verdict(
      res.valid ? 'ok' : 'bad',
      res.valid ? '✔ Publicly verified' : '✘ Verification failed',
      `${eq(res.keyEquation, 'key equation', 'z·B = R_B + c·PK')}
       ${eq(res.inputEquation, 'input equation', 'z·P = R_P + c·Γ')}
       ${eq(res.betaMatches, 'output binding', 'β = H(Γ)')}
       <p>Checked with nothing but the group public key, the message, β, and the ${PROOF_BYTES}-byte
       proof.</p>`,
    )}
    <h3>Compute both sides — threshold vs. the dealer's direct evaluation</h3>
    <div class="table-scroll"><table class="compare-table">
      <tr><th scope="row">β from ${lastOk.responders.length} parties (indices ${lastOk.responders.join(', ')})</th>
          <td class="mono">${betaHex(lastOk.beta)}</td></tr>
      <tr><th scope="row">β from sk directly (demo dealer only)</th>
          <td class="mono">${bytesToHex(direct.beta)}</td></tr>
      <tr><th scope="row">Byte-for-byte</th>
          <td>${same ? chip('ok', '✔', 'identical') : chip('bad', '✘', 'MISMATCH')}</td></tr>
    </table></div>`
}

function runSubsetCompare(): void {
  const { ceremony, lastOk, queued } = state
  if (!ceremony || !lastOk?.beta || !queued) return
  const prev = new Set(lastOk.responders)
  const others = ceremony.parties.map((p) => p.index).filter((i) => !prev.has(i))
  if (others.length === 0) {
    $('verify-out').innerHTML = verdict(
      'warn',
      '⚠ Only one possible committee',
      `<p>Every party already participated (t = n, or the full roster ran). Re-run the key ceremony with
       t &lt; n to compare two genuinely different committees.</p>`,
    )
    return
  }
  const roster = [...others, ...lastOk.responders].slice(0, ceremony.t)
  const tr = runEvaluation(ceremony, queued.nonces, lastOk.message, roster)
  consumeBatch(tr.message, tr.responders)
  if (tr.status !== 'ok') return
  const same = betaHex(tr.beta!) === betaHex(lastOk.beta)
  $('verify-out').innerHTML = `
    ${verdict(
      same ? 'ok' : 'bad',
      same ? '✔ Different parties, identical output' : '✘ Outputs differ — this should never happen',
      `<p>For a <em>fixed group key and fixed message</em>, β is fully determined — <em>which</em>
       t parties show up cannot steer it. (What a coalition can still do is refuse to finish, so a real
       beacon must keep the message fixed on retry — see Exhibit 5.)</p>`,
    )}
    <div class="table-scroll"><table class="compare-table">
      <tr><th scope="row">β from parties ${lastOk.responders.join(', ')}</th><td class="mono">${betaHex(lastOk.beta)}</td></tr>
      <tr><th scope="row">β from parties ${tr.responders.join(', ')}</th><td class="mono">${betaHex(tr.beta!)}</td></tr>
      <tr><th scope="row">Byte-for-byte</th><td>${same ? chip('ok', '✔', 'identical') : chip('bad', '✘', 'MISMATCH')}</td></tr>
    </table></div>`
}

function runWorkbench(): void {
  const text = wbInput.value.trim()
  if (text === '') {
    $('wb-out').innerHTML = verdict('warn', '⚠ Nothing to verify', '<p>Paste a proof envelope first.</p>')
    return
  }
  try {
    const { parsed, result } = verifyEnvelope(text)
    const eq = (okFlag: boolean, label: string): string =>
      okFlag ? chip('ok', '✔', label) : chip('bad', '✘', `${label} FAILS`)
    $('wb-out').innerHTML = verdict(
      result.valid ? 'ok' : 'bad',
      result.valid ? '✔ Envelope verifies' : '✘ Envelope is well-formed but does NOT verify',
      `<p>${eq(result.keyEquation, 'key equation')} ${eq(result.inputEquation, 'input equation')}
       ${eq(result.betaMatches, 'β = H(Γ)')}</p>
       <p class="eq-row">message: <code>${escapeHtml(JSON.stringify(parsed.message))}</code></p>
       <p class="eq-row">group key: <code>${pointHex(parsed.groupPk)}</code></p>
       <p>This check used only the envelope's contents — no state from the exhibits above.</p>`,
    )
  } catch (e) {
    const msg = e instanceof EnvelopeError ? e.message : 'unrecognized parser failure'
    $('wb-out').innerHTML = verdict(
      'bad',
      '✘ Rejected before verification',
      `<p>Strict parsing failed — <code>${escapeHtml(msg)}</code>. Malformed data never reaches the
       curve math (fail closed).</p>`,
    )
  }
}

// ---------------------------------------------------------------------------
// Exhibit 5 — break it yourself

const CHEAT_OPTIONS: Array<[CheatMode | 'honest', string]> = [
  ['honest', 'honest'],
  ['corrupt-gamma', 'corrupt partial Γᵢ'],
  ['grind-nonce', 'swap nonce after seeing m'],
  ['withhold-response', 'withhold round 2 (selective abort)'],
  ['absent', 'absent (no response)'],
]

function renderCheatControls(): void {
  const { ceremony } = state
  if (!ceremony) return
  $('cheat-controls').innerHTML = ceremony.parties
    .map(
      (p) => `
      <span class="cheat-item">
        <label for="cheat-${p.index}">Party ${p.index}</label>
        <select id="cheat-${p.index}" data-index="${p.index}">
          ${CHEAT_OPTIONS.map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}
        </select>
      </span>`,
    )
    .join('')
  syncCheatControls(false)
}

/** Cheat selectors only exist for parties actually in the roster. */
function syncCheatControls(locked: boolean): void {
  const roster = new Set(selectedRoster())
  document.querySelectorAll<HTMLSelectElement>('#cheat-controls select').forEach((sel) => {
    const idx = Number(sel.dataset.index)
    const participating = roster.has(idx)
    sel.disabled = locked || !participating
    if (!participating) sel.value = 'honest'
    sel.setAttribute(
      'aria-label',
      participating ? `Behavior of party ${idx}` : `Behavior of party ${idx} (not in the selected roster)`,
    )
  })
}

/** Effective cast: only cheats by parties that are actually participating. */
function selectedCheats(): Map<number, CheatMode> {
  const roster = new Set(selectedRoster())
  const cheats = new Map<number, CheatMode>()
  document.querySelectorAll<HTMLSelectElement>('#cheat-controls select').forEach((sel) => {
    const idx = Number(sel.dataset.index)
    if (roster.has(idx) && sel.value !== 'honest') cheats.set(idx, sel.value as CheatMode)
  })
  return cheats
}

function runBreak(): void {
  const { ceremony, queued } = state
  if (!ceremony || !queued) return
  const cheats = selectedCheats()
  const roster = selectedRoster()
  if (roster.length === 0) {
    $('break-out').innerHTML = verdict(
      'warn',
      '⚠ Pick participants in Exhibit 3',
      '<p>The cast runs against the roster selected above.</p>',
    )
    return
  }
  const tr = runEvaluation(ceremony, queued.nonces, msgInput.value, roster, { cheats })
  consumeBatch(tr.message, tr.responders)
  honestRerunBtn.dataset.armed = 'yes'
  honestRerunBtn.disabled = false

  const cheatSummary =
    cheats.size === 0
      ? '<p>Every participant played honest — so this is just a normal evaluation.</p>'
      : `<p>Effective cast (participants only): ${[...cheats.entries()]
          .map(([i, mode]) => `party ${i} → <em>${CHEAT_OPTIONS.find(([v]) => v === mode)?.[1]}</em>`)
          .join('; ')}.</p>`

  if (tr.status === 'refused-below-threshold') {
    $('break-out').innerHTML = `${cheatSummary}${verdict(
      'warn',
      '⚠ Refused — absences left fewer than t responders',
      `<p>${tr.absent.length} part${tr.absent.length === 1 ? 'y' : 'ies'} went silent and only
       ${tr.responders.length} of t = ${ceremony.t} remained. No output, no guess, no "best effort" —
       the protocol would rather say nothing than say something unverifiable.</p>`,
    )}`
    return
  }

  if (tr.status === 'aborted-withheld') {
    const withholders = `Part${tr.withheld.length === 1 ? 'y' : 'ies'} ${tr.withheld.join(', ')}`

    // Pure withhold: every partial that could be checked passed, so the round-1
    // aggregate really is this message's output and the withholder knows it.
    if (tr.learnedBeta) {
      state.lastWithheld = {
        message: tr.message,
        beta: tr.learnedBeta,
        label: 'β the withholder had already learned',
      }
      $('break-out').innerHTML = `${cheatSummary}${verdict(
        'warn',
        '⚠ Selective abort — output learned, publication censored',
        `<p>${withholders} broadcast round 1, watched everyone else's partials arrive, computed the
         eventual output — and then refused round 2, so the proof cannot be completed with this
         participant set. Every partial in that aggregate that could be checked passed its DLEQ,
         which is why the value below is an output and not merely a number.</p>
         <div class="beta-box"><h3>The β the withholder already knew</h3>
         <p class="beta-hex">${betaHex(tr.learnedBeta)}</p></div>
         <p>This is the honest limit of "no bias": for a fixed key and message no <em>other</em> β can ever
         be produced, but a coalition can still censor publication. A real beacon must therefore keep the
         message fixed on retry and replace the withholder — never roll a fresh candidate output. Press
         “Rerun with honest parties” and compare byte-for-byte.</p>`,
      )}`
      return
    }

    // MIXED cast: a partial in the aggregate the withholder saw fails its DLEQ.
    // H(Γ) over that aggregate is not β — no participant set could ever have
    // published it — so it is reported as what it is, and the page falls back
    // to what the partials that DID verify determine.
    const rows = tr.partials
      .map((p) => {
        const k = p.check.keyEquation ? chip('ok', '✔', 'key eq') : chip('bad', '✘', 'key eq')
        const g = p.check.inputEquation ? chip('ok', '✔', 'input eq') : chip('bad', '✘', 'input eq')
        return `<tr><th scope="row">Party ${p.index}</th><td>${k} ${g}</td>
                <td>${p.check.ok ? chip('ok', '✔', 'verified') : chip('bad', '✘', 'BLAMED')}</td></tr>`
      })
      .concat(
        tr.withheld.map(
          (i) =>
            `<tr><th scope="row">Party ${i}</th><td>${chip('warn', '—', 'no z_i sent')}</td>
             <td>${chip('warn', '—', 'unverifiable')}</td></tr>`,
        ),
      )
      .join('')

    const verified = tr.verifiedPartials ?? []
    const settled =
      tr.verifiedSubsetBeta === undefined
        ? `<p><strong>What this cast can determine: nothing publishable.</strong> Only
           ${verified.length} partial${verified.length === 1 ? '' : 's'} verified but t = ${ceremony.t}
           are needed, and a withheld partial carries no z_i to check. The withholder did not learn an
           output — it learned an aggregate that verification would have thrown away.</p>`
        : `<p><strong>What this cast can determine:</strong> the ${verified.length} partials that did
           verify (part${verified.length === 1 ? 'y' : 'ies'} ${verified.join(', ')}) still reach
           t = ${ceremony.t}, so recomputing Γ over just those — Lagrange weights re-derived for that
           subset — gives a genuine output. That is the value an honest rerun has to reproduce, and it
           is ${
             betaHex(tr.verifiedSubsetBeta) === betaHex(tr.contestedBeta!)
               ? 'identical to'
               : 'different from'
           } the contested aggregate above.</p>
           <div class="beta-box"><h3>β from the partials that verified</h3>
           <p class="beta-hex">${betaHex(tr.verifiedSubsetBeta)}</p></div>`

    if (tr.verifiedSubsetBeta) {
      state.lastWithheld = {
        message: tr.message,
        beta: tr.verifiedSubsetBeta,
        label: 'β from the partials that verified',
      }
    } else {
      state.lastWithheld = undefined
    }

    $('break-out').innerHTML = `${cheatSummary}${verdict(
      'warn',
      '⚠ Selective abort on a contested aggregate — no output was learned',
      `<p>${withholders} refused round 2, but part${tr.blamed.length === 1 ? 'y' : 'ies'}
       ${tr.blamed.join(', ')} also failed the DLEQ check on the partial${
         tr.blamed.length === 1 ? '' : 's'
       } already folded into the round-1 aggregate. So the value the withholder computed is
       <em>not</em> this message's β: it is H(Γ) over an aggregate containing a partial that
       verification rejects, and no participant set could ever have published it.</p>
       <div class="table-scroll"><table class="compare-table"><tr><th scope="col">Party</th><th scope="col">DLEQ checks</th><th scope="col">Verdict</th></tr>${rows}</table></div>
       <div class="beta-box beta-box-contested"><h3>Contested aggregate — H(Γ), not β</h3>
       <p class="beta-hex">${betaHex(tr.contestedBeta!)}</p></div>
       ${settled}
       <p>Selective abort still cannot steer the output. It censors publication, and here it is
       stacked with a corrupted partial that verification names — which is why the honest reading of a
       mixed cast is "nobody learned an output", not "the withholder learned a different one".</p>`,
    )}${partyCards(ceremony, undefined, tr.blamed)}`
    return
  }

  if (tr.status === 'aborted-cheater') {
    const rows = tr.partials
      .map((p) => {
        const k = p.check.keyEquation ? chip('ok', '✔', 'key eq') : chip('bad', '✘', 'key eq')
        const g = p.check.inputEquation ? chip('ok', '✔', 'input eq') : chip('bad', '✘', 'input eq')
        return `<tr><th scope="row">Party ${p.index}</th><td>${k} ${g}</td>
                <td>${p.check.ok ? chip('ok', '✔', 'honest') : chip('bad', '✘', 'BLAMED')}</td></tr>`
      })
      .join('')
    $('break-out').innerHTML = `${cheatSummary}${verdict(
      'bad',
      '✘ Cheating detected — evaluation aborted, cheater named',
      `<p>The two DLEQ equations point straight at the manipulation: a corrupted partial breaks the
       <em>input</em> equation, and a substituted nonce breaks the <em>key</em> equation — a party can
       still <em>try</em> a post-message nonce swap, but no substitution can pass verification against
       the (D, E) slot it committed to before the message existed.</p>
       <div class="table-scroll"><table class="compare-table"><tr><th scope="col">Party</th><th scope="col">DLEQ checks</th><th scope="col">Verdict</th></tr>${rows}</table></div>
       <p>No output was produced. Rerun with honest parties to see that the cheater delayed the beacon
       but could not bend it (same message, same β).</p>`,
    )}${partyCards(ceremony, undefined, tr.blamed)}`
    return
  }

  $('break-out').innerHTML = `${cheatSummary}${verdict(
    'ok',
    '✔ Output produced despite the cast',
    `<p>${
      tr.absent.length > 0
        ? `${tr.absent.length} part${tr.absent.length === 1 ? 'y was' : 'ies were'} absent, but ${tr.responders.length} ≥ t responded — availability is exactly what the threshold buys.`
        : 'All participants responded honestly.'
    }</p>
     <div class="beta-box"><h3>β</h3><p class="beta-hex">${betaHex(tr.beta!)}</p></div>`,
  )}`
  if (!state.lastOk) {
    state.lastOk = tr
    verifyBtn.disabled = false
    subsetBtn.disabled = false
    renderExport(tr)
  }
}

/**
 * What the rerun should reproduce byte-for-byte, for this exact message: an
 * earlier successful β if there is one, otherwise the output the most recent
 * selective abort actually settled — the β a withholder learned from an
 * uncontested aggregate, or, in a mixed cast, the β determined by the partials
 * that verified. Both are real computed values, and neither is ever the
 * contested aggregate from a mixed cast: that value is not an output, so
 * comparing a rerun against it would manufacture a mismatch out of nothing.
 */
function rerunReference(message: string): { beta: string; label: string } | undefined {
  const { lastOk, lastWithheld } = state
  if (lastOk?.beta && lastOk.message === message) {
    return { beta: betaHex(lastOk.beta), label: 'Earlier successful run' }
  }
  if (lastWithheld && lastWithheld.message === message) {
    return { beta: betaHex(lastWithheld.beta), label: lastWithheld.label }
  }
  return undefined
}

function runHonestRerun(): void {
  const { ceremony, queued } = state
  if (!ceremony || !queued) return
  const cheats = selectedCheats()
  const honest = ceremony.parties.map((p) => p.index).filter((i) => !cheats.has(i))
  const roster = honest.slice(0, ceremony.t)
  if (roster.length < ceremony.t) {
    $('break-out').innerHTML = verdict(
      'warn',
      '⚠ Not enough honest parties remain',
      `<p>Only ${roster.length} honest parties are left but t = ${ceremony.t}. If cheaters plus absentees
       reach n − t + 1, the system halts — it still cannot be biased, only stopped.</p>`,
    )
    return
  }
  const tr = runEvaluation(ceremony, queued.nonces, msgInput.value, roster)
  consumeBatch(tr.message, tr.responders)
  if (tr.status !== 'ok') return
  const reference = rerunReference(tr.message)
  const same = reference !== undefined && reference.beta === betaHex(tr.beta!)
  $('break-out').innerHTML = verdict(
    reference !== undefined && !same ? 'bad' : 'ok',
    reference !== undefined && !same ? '✘ Outputs differ — this should never happen' : '✔ Honest threshold delivers',
    `<p>Parties ${tr.responders.join(', ')} produced${
      reference !== undefined
        ? same
          ? ` <strong>the identical β</strong> as the ${reference.label.toLowerCase()} — cheating delayed the beacon, it never steered it.`
          : ' a β that does <strong>not</strong> match the reference for this same message — for a fixed group key and message that is impossible, so treat it as a bug in this demo.'
        : ' a verifiable β. (No earlier β exists for this message yet, so there is nothing to compare it against — run an evaluation or a selective abort on the same message first.)'
    }</p>
     <div class="beta-box"><h3>β</h3><p class="beta-hex">${betaHex(tr.beta!)}</p></div>
     ${
       reference !== undefined
         ? `<div class="table-scroll"><table class="compare-table">
              <tr><th scope="row">${reference.label}</th><td class="mono">${reference.beta}</td></tr>
              <tr><th scope="row">β from parties ${tr.responders.join(', ')}</th><td class="mono">${betaHex(tr.beta!)}</td></tr>
              <tr><th scope="row">Byte-for-byte</th><td>${
                same ? chip('ok', '✔', 'identical') : chip('bad', '✘', 'MISMATCH')
              }</td></tr>
            </table></div>`
         : ''
     }`,
  )
  state.lastOk = tr
  verifyBtn.disabled = false
  subsetBtn.disabled = false
  renderExport(tr)
}

// ---------------------------------------------------------------------------
// Wiring

nInput.addEventListener('input', syncThresholdRange)
tInput.addEventListener('input', syncThresholdRange)
setupBtn.addEventListener('click', runSetup)
preBtn.addEventListener('click', publishBatch)
stepBtn.addEventListener('click', revealStep)
runAllBtn.addEventListener('click', runAllSteps)
resetEvalBtn.addEventListener('click', resetEvaluation)
verifyBtn.addEventListener('click', runVerify)
subsetBtn.addEventListener('click', runSubsetCompare)
breakBtn.addEventListener('click', runBreak)
honestRerunBtn.addEventListener('click', runHonestRerun)
wbVerifyBtn.addEventListener('click', runWorkbench)

honestRerunBtn.dataset.armed = 'no'
syncThresholdRange()
