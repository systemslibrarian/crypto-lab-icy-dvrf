import './style.css'
import { bytesToHex } from './dvrf/group.ts'
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
import { utf8ToBytes } from './dvrf/group.ts'
import { escapeHtml, pointHex, scalarHex, short } from './ui/format.ts'

// ---------------------------------------------------------------------------
// State

interface AppState {
  ceremony?: KeyCeremony
  nonces: Map<number, NoncePair>
  batchNo: number
  /** Last successful honest evaluation (feeds Exhibits 4 and 5). */
  lastOk?: Transcript
  steps: string[]
  ladderRungs: string[][]
  stepIndex: number
}

const state: AppState = { nonces: new Map(), batchNo: 0, steps: [], ladderRungs: [], stepIndex: 0 }

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

// ---------------------------------------------------------------------------
// Small render helpers

function chip(kind: 'ok' | 'bad' | 'warn', icon: string, label: string): string {
  return `<span class="chip chip-${kind}"><span aria-hidden="true">${icon}</span> ${label}</span>`
}

function verdict(kind: 'ok' | 'bad' | 'warn', title: string, body: string): string {
  return `<div class="verdict verdict-${kind}"><h4>${title}</h4>${body}</div>`
}

function msgChip(label: string, value: string): string {
  return `<span class="msg-chip"><b>${label}</b> ${value}</span>`
}

function partyCards(ceremony: KeyCeremony, extras?: (i: number) => string, blamed: number[] = []): string {
  return `<div class="party-grid">${ceremony.parties
    .map(
      (p) => `
      <div class="party-card${blamed.includes(p.index) ? ' blamed' : ''}">
        <h4>Party ${p.index}${blamed.includes(p.index) ? ` ${chip('bad', '✘', 'blamed')}` : ''}</h4>
        <p class="kv"><b>PK<sub>${p.index}</sub></b> ${short(pointHex(p.pk))}</p>
        ${extras ? extras(p.index) : ''}
      </div>`,
    )
    .join('')}</div>`
}

// ---------------------------------------------------------------------------
// Exhibit 1 — key ceremony

function syncThresholdRange(): void {
  const n = Number(nInput.value)
  tInput.max = String(n)
  if (Number(tInput.value) > n) tInput.value = String(n)
  $('n-value').textContent = nInput.value
  $('t-value').textContent = tInput.value
}

function runSetup(): void {
  const n = Number(nInput.value)
  const t = Number(tInput.value)
  state.ceremony = dealerKeygen(n, t)
  state.nonces = new Map()
  state.batchNo = 0
  state.lastOk = undefined
  resetEvaluation()
  $('pre-out').innerHTML = ''
  $('verify-out').innerHTML = ''
  $('break-out').innerHTML = ''
  preBtn.disabled = false
  stepBtn.disabled = true
  runAllBtn.disabled = true
  resetEvalBtn.disabled = true
  verifyBtn.disabled = true
  subsetBtn.disabled = true
  breakBtn.disabled = true
  honestRerunBtn.disabled = true

  $('setup-out').innerHTML = `
    <p>Dealt a ${t}-of-${n} sharing. Any ${t} parties can evaluate; ${t - 1} learn nothing.</p>
    <div class="groupkey"><b>Group public key PK</b> ${pointHex(state.ceremony.groupPk)}</div>
    ${partyCards(state.ceremony)}
    <p>Next: parties publish their offline nonce commitments in Exhibit 2.</p>`

  renderRoster()
  renderCheatControls()
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
}

function selectedRoster(): number[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[name="roster"]:checked')].map((el) =>
    Number(el.value),
  )
}

// ---------------------------------------------------------------------------
// Exhibit 2 — offline preprocessing

function publishBatch(announce: boolean): void {
  const { ceremony } = state
  if (!ceremony) return
  state.batchNo += 1
  state.nonces = new Map(ceremony.parties.map((p) => [p.index, preprocess(p)]))
  const cards = partyCards(ceremony, (i) => {
    const np = state.nonces.get(i)!
    return `<p class="kv"><b>D<sub>${i}</sub></b> ${short(pointHex(np.D))}</p>
            <p class="kv"><b>E<sub>${i}</sub></b> ${short(pointHex(np.E))}</p>`
  })
  $('pre-out').innerHTML = `
    <p>Batch #${state.batchNo} published — one nonce pair per party, ${
      announce ? 'before any message exists. ' : ''
    }${chip('warn', '⏱', 'one-time use')} Each pair is spent by its first evaluation; a fresh batch is
    published automatically afterwards, exactly as a FROST deployment queues nonces in advance.</p>
    ${cards}`
  stepBtn.disabled = false
  runAllBtn.disabled = false
  resetEvalBtn.disabled = false
  breakBtn.disabled = false
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
  state.steps = []
  state.ladderRungs = []
  state.stepIndex = 0
  $('eval-steps').innerHTML = ''
  $('eval-out').innerHTML = ''
  setLadder([], [])
}

function buildSteps(tr: Transcript): void {
  const steps: string[] = []
  const rungs: string[][] = []
  const push = (html: string, now: string[]): void => {
    steps.push(html)
    rungs.push(now)
  }

  push(
    `<h4><span class="phase-tag">input</span> Hash the message onto the curve</h4>
     <p>Everyone maps the message to the same point <code>P = HashToGroup(m)</code>. All partials will be
     multiples of this exact point.</p>
     <div class="msg-chips">${msgChip('m', `"${escapeHtml(tr.message)}"`)}${msgChip('P', short(pointHex(tr.input), 16, 8))}</div>`,
    [],
  )

  if (tr.status === 'refused-below-threshold') {
    push(
      `<h4><span class="phase-tag">refused</span> Not enough responders</h4>
       <p>Only ${tr.responders.length} of the required t = ${state.ceremony!.t} parties responded. The
       aggregator emits <em>nothing</em> — a threshold system fails closed rather than producing an
       unverifiable output.</p>`,
      [],
    )
  } else {
    push(
      `<h4><span class="phase-tag">online round 1</span> Broadcast partials and input-base nonces</h4>
       <p>Each participant i derives its binding factor ρ<sub>i</sub> (hash of the message, the roster, and
       every preprocessed commitment), forms its one-time nonce k<sub>i</sub> = d<sub>i</sub> +
       ρ<sub>i</sub>·e<sub>i</sub>, and broadcasts its partial Γ<sub>i</sub> = x<sub>i</sub>·P together with
       R<sub>i</sub><sup>P</sup> = k<sub>i</sub>·P.</p>
       <div class="msg-chips">${tr.partials
         .map((p) => msgChip(`P${p.index}`, `Γ=${short(pointHex(p.gamma), 8, 4)} R=${short(pointHex(p.rP), 8, 4)}`))
         .join('')}</div>`,
      ['icy-1'],
    )
    push(
      `<h4><span class="phase-tag">derived locally</span> One shared challenge for the whole set</h4>
       <p>Anyone can now combine the broadcasts with Lagrange weights λ<sub>i</sub> — and the key-base
       commitments R<sub>i</sub><sup>B</sup> = D<sub>i</sub> + ρ<sub>i</sub>·E<sub>i</sub> come straight
       from the <em>offline</em> batch. One Fiat–Shamir challenge c covers every party, which is what lets
       t transcripts fold into one constant-size proof.</p>
       <div class="msg-chips">
         ${tr.partials.map((p) => msgChip(`λ${p.index}`, short(scalarHex(p.lambda), 8, 4))).join('')}
         ${msgChip('R_B', short(pointHex(tr.rB!), 10, 5))}${msgChip('R_P', short(pointHex(tr.rP!), 10, 5))}
         ${msgChip('Γ', short(pointHex(tr.gamma!), 10, 5))}${msgChip('c', short(scalarHex(tr.c!), 10, 5))}
       </div>`,
      ['icy-1'],
    )
    push(
      `<h4><span class="phase-tag">online round 2</span> Broadcast responses</h4>
       <p>Each participant answers the shared challenge with z<sub>i</sub> = k<sub>i</sub> +
       c·x<sub>i</sub>. Two rounds total — the commit round happened yesterday, offline.</p>
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
        `<h4><span class="phase-tag">checks</span> Per-party DLEQ verification — cheater caught</h4>
         <p>Every partial is checked against that party's public share. The math names the liar:</p>
         <div class="msg-chips">${checksHtml}</div>
         <p>The evaluation aborts with <em>no output at all</em> (fail closed). Rerun with honest parties —
         the outcome cannot be changed by cheating, only delayed.</p>`,
        ['icy-2'],
      )
    } else {
      push(
        `<h4><span class="phase-tag">aggregate</span> Checks pass — fold t transcripts into one proof</h4>
         <p>All partials verify: ${checksHtml}</p>
         <p>Lagrange-weighted sums produce the single proof (Γ, R<sub>B</sub>, R<sub>P</sub>, z) and the
         output β = H(Γ). The proof is the same size for any t.</p>`,
        ['icy-2'],
      )
    }
  }

  state.steps = steps
  state.ladderRungs = rungs
  state.stepIndex = 0
}

function startEvaluation(): Transcript | undefined {
  const { ceremony } = state
  if (!ceremony) return undefined
  if (state.nonces.size === 0) publishBatch(false)
  const roster = selectedRoster()
  if (roster.length === 0) {
    $('eval-out').innerHTML = verdict('warn', '⚠ Pick at least one participant', '<p>Select parties above, then step the protocol.</p>')
    return undefined
  }
  const tr = runEvaluation(ceremony, state.nonces, msgInput.value, roster)
  publishBatch(false) // nonces are one-time: queue the next batch, like a FROST deployment
  buildSteps(tr)
  return tr
}

let current: Transcript | undefined

function revealStep(): void {
  if (!current) {
    current = startEvaluation()
    if (!current) return
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
  setLadder([], LADDER_DONE_AT_END)
  if (current.status === 'ok') {
    state.lastOk = current
    verifyBtn.disabled = false
    subsetBtn.disabled = false
    honestRerunBtn.disabled = false
    $('eval-out').innerHTML = `
      <div class="beta-box">
        <h4>β — the group's verifiable random output</h4>
        <p class="beta-hex">${betaHex(current.beta!)}</p>
      </div>
      <p>Proof (Γ, R<sub>B</sub>, R<sub>P</sub>, z) — constant size, take it to Exhibit 4:</p>
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
}

function runAllSteps(): void {
  if (!current && state.stepIndex >= state.steps.length) {
    resetEvaluation()
  }
  const total = () => state.steps.length
  do {
    revealStep()
  } while (current && state.stepIndex < total())
}

// ---------------------------------------------------------------------------
// Exhibit 4 — public verification, compute both sides

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
       <p>Checked with nothing but the group public key, the message, β, and the four-value proof.</p>`,
    )}
    <h3>Compute both sides — threshold vs. the dealer's direct evaluation</h3>
    <table class="compare-table">
      <tr><th scope="row">β from ${lastOk.responders.length} parties (indices ${lastOk.responders.join(', ')})</th>
          <td class="mono">${betaHex(lastOk.beta)}</td></tr>
      <tr><th scope="row">β from sk directly (demo dealer only)</th>
          <td class="mono">${bytesToHex(direct.beta)}</td></tr>
      <tr><th scope="row">Byte-for-byte</th>
          <td>${same ? chip('ok', '✔', 'identical') : chip('bad', '✘', 'MISMATCH')}</td></tr>
    </table>`
}

function runSubsetCompare(): void {
  const { ceremony, lastOk } = state
  if (!ceremony || !lastOk?.beta) return
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
  if (state.nonces.size === 0) publishBatch(false)
  const tr = runEvaluation(ceremony, state.nonces, lastOk.message, roster)
  publishBatch(false)
  if (tr.status !== 'ok') return
  const same = betaHex(tr.beta!) === betaHex(lastOk.beta)
  $('verify-out').innerHTML = `
    ${verdict(
      same ? 'ok' : 'bad',
      same ? '✔ Different parties, identical output' : '✘ Outputs differ — this should never happen',
      `<p>A VRF output is a deterministic function of the group key and the message — <em>which</em>
       t parties show up cannot steer it. That is why "wait for a better committee" is not an attack.</p>`,
    )}
    <table class="compare-table">
      <tr><th scope="row">β from parties ${lastOk.responders.join(', ')}</th><td class="mono">${betaHex(lastOk.beta)}</td></tr>
      <tr><th scope="row">β from parties ${tr.responders.join(', ')}</th><td class="mono">${betaHex(tr.beta!)}</td></tr>
      <tr><th scope="row">Byte-for-byte</th><td>${same ? chip('ok', '✔', 'identical') : chip('bad', '✘', 'MISMATCH')}</td></tr>
    </table>`
}

// ---------------------------------------------------------------------------
// Exhibit 5 — break it yourself

const CHEAT_OPTIONS: Array<[CheatMode | 'honest', string]> = [
  ['honest', 'honest'],
  ['corrupt-gamma', 'corrupt partial Γᵢ'],
  ['grind-nonce', 'swap nonce after seeing m'],
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
}

function selectedCheats(): Map<number, CheatMode> {
  const cheats = new Map<number, CheatMode>()
  document.querySelectorAll<HTMLSelectElement>('#cheat-controls select').forEach((sel) => {
    if (sel.value !== 'honest') cheats.set(Number(sel.dataset.index), sel.value as CheatMode)
  })
  return cheats
}

function runBreak(): void {
  const { ceremony } = state
  if (!ceremony) return
  if (state.nonces.size === 0) publishBatch(false)
  const cheats = selectedCheats()
  const roster = selectedRoster()
  if (roster.length === 0) {
    $('break-out').innerHTML = verdict('warn', '⚠ Pick participants in Exhibit 3', '<p>The cast runs against the roster selected above.</p>')
    return
  }
  const tr = runEvaluation(ceremony, state.nonces, msgInput.value, roster, { cheats })
  publishBatch(false)
  honestRerunBtn.disabled = false

  const cheatSummary =
    cheats.size === 0
      ? '<p>Everyone played honest — so this is just a normal evaluation.</p>'
      : `<p>Cast: ${[...cheats.entries()]
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
       <em>input</em> equation, and a swapped nonce breaks the <em>key</em> equation because the
       preprocessed commitment (D, E) had already pinned the nonce before the message existed.</p>
       <table class="compare-table"><tr><th scope="col">Party</th><th scope="col">DLEQ checks</th><th scope="col">Verdict</th></tr>${rows}</table>
       <p>No output was produced. Rerun with honest parties to see that the cheater delayed the beacon
       but could not bend it.</p>`,
    )}${partyCards(ceremony, undefined, tr.blamed)}`
    return
  }

  $('break-out').innerHTML = `${cheatSummary}${verdict(
    'ok',
    '✔ Output produced despite the cast',
    `<p>${
      tr.absent.length > 0
        ? `${tr.absent.length} part${tr.absent.length === 1 ? 'y was' : 'ies were'} absent, but ${tr.responders.length} ≥ t responded — availability is exactly what the threshold buys.`
        : 'All selected parties responded honestly.'
    }</p>
     <div class="beta-box"><h4>β</h4><p class="beta-hex">${betaHex(tr.beta!)}</p></div>`,
  )}`
  if (!state.lastOk) state.lastOk = tr
}

function runHonestRerun(): void {
  const { ceremony, lastOk } = state
  if (!ceremony) return
  if (state.nonces.size === 0) publishBatch(false)
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
  const tr = runEvaluation(ceremony, state.nonces, msgInput.value, roster)
  publishBatch(false)
  if (tr.status !== 'ok') return
  const reference = lastOk && lastOk.message === tr.message ? betaHex(lastOk.beta!) : undefined
  const same = reference !== undefined && reference === betaHex(tr.beta!)
  $('break-out').innerHTML = verdict(
    'ok',
    '✔ Honest majority delivers',
    `<p>Parties ${tr.responders.join(', ')} produced${
      reference !== undefined
        ? same
          ? ' <strong>the identical β</strong> the honest run produced earlier — cheating delayed the beacon, it never steered it.'
          : ' a β for this message.'
        : ' a verifiable β.'
    }</p>
     <div class="beta-box"><h4>β</h4><p class="beta-hex">${betaHex(tr.beta!)}</p></div>
     ${reference !== undefined ? `<p>Earlier honest run: ${same ? chip('ok', '✔', 'byte-for-byte identical') : chip('warn', '⚠', 'different message')}</p>` : ''}`,
  )
  state.lastOk = tr
  verifyBtn.disabled = false
  subsetBtn.disabled = false
}

// ---------------------------------------------------------------------------
// Wiring

nInput.addEventListener('input', syncThresholdRange)
tInput.addEventListener('input', syncThresholdRange)
setupBtn.addEventListener('click', runSetup)
preBtn.addEventListener('click', () => publishBatch(true))
stepBtn.addEventListener('click', revealStep)
runAllBtn.addEventListener('click', runAllSteps)
resetEvalBtn.addEventListener('click', () => {
  current = undefined
  resetEvaluation()
})
verifyBtn.addEventListener('click', runVerify)
subsetBtn.addEventListener('click', runSubsetCompare)
breakBtn.addEventListener('click', runBreak)
honestRerunBtn.addEventListener('click', runHonestRerun)

syncThresholdRange()
