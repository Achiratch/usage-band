import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionContextUsage, Timer } from 'claude-code'

import type { Meter, Pause, Snapshot, Warned } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const warned = atom({ plugin: 'usage-band', key: 'warned' } as const, {})
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)
const paused = atom({ plugin: 'usage-band', key: 'paused' } as const, null)
const lastResumed = atom({ plugin: 'usage-band', key: 'lastResumed' } as const, '')

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const THRESHOLDS = [90, 80]
const WIDTH = 8

export const DEFAULT_PAUSE_AT = 95
/** wait a minute past the reset so the first reading is of the new window */
export const RESUME_SLACK_MS = 60_000
export const CONTINUE_PROMPT =
  'The usage limit window has reset. Continue the task you were working on before usage-band paused it: first re-check where you stopped, then carry on.'

/** green < 60 ≤ yellow < 85 ≤ red, as theme keys so they follow light/dark */
export const tone = (p: number) => (p >= 85 ? 'error' : p >= 60 ? 'warning' : 'success')

export const bar = (p: number, w = WIDTH) => {
  const filled = Math.max(0, Math.min(w, Math.round((Math.min(p, 100) / 100) * w)))
  return '▰'.repeat(filled) + '▱'.repeat(w - filled)
}

/** ms until reset → "2h14m", "3d5h", "12m" */
export const left = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return 'now'
  const m = Math.floor(ms / 60000)
  const h = Math.floor(m / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${m}m`
}

export const toSnapshot = (context: SessionContextUsage, limits: SessionRateLimit[]): Snapshot => ({
  context: context.percent,
  meters: limits
    .map((l): Meter => ({ kind: l.kind, percent: Math.round(l.percentUsed), resetsAt: l.resetsAt }))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)),
})

/** the highest threshold a meter has crossed that it has not yet warned for in this window */
export const due = (m: Meter, w: Warned) => {
  const hit = THRESHOLDS.find(t => m.percent >= t)
  if (hit === undefined) return undefined
  const prev = w[m.kind]
  const [prevT, prevReset] = prev ? prev.split('@') : []
  const sameWindow = prevReset === (m.resetsAt ?? '')
  if (sameWindow && Number(prevT) >= hit) return undefined
  return hit
}

/**
 * Whether to hold work: a meter at or past `pauseAt`, in a window not already resumed.
 * A 7-day or spend window wins over the 5-hour one and never continues by itself
 * (its reset can be days away); the 5-hour one continues when it resets.
 */
export const decide = (meters: Meter[], pauseAt: number, resumed: string): Pause | undefined => {
  const over = meters.filter(m => m.percent >= pauseAt && !(m.resetsAt && m.resetsAt === resumed))
  const long = over.find(m => m.kind !== 'five_hour')
  const hit = long ?? over.find(m => m.kind === 'five_hour')
  if (!hit) return undefined
  return { kind: hit.kind, percent: hit.percent, pauseAt, resetsAt: hit.resetsAt, auto: !long && !!hit.resetsAt }
}

export const summary = (snap: Snapshot, now: number) => {
  const parts: string[] = []
  if (snap.context !== undefined) parts.push(`ctx ${snap.context}%`)
  for (const m of snap.meters) {
    const r = left(m.resetsAt, now)
    parts.push(`${LABEL[m.kind] ?? m.kind} ${bar(m.percent, 5)} ${m.percent}%${r ? ` ↻${r}` : ''}`)
  }
  return parts.join(' · ')
}

const labelOf = (kind: string) => LABEL[kind] ?? kind

export const pauseAtOf = async ($: EngineInterface) => {
  const v = Number(await $.store.get('pauseAt'))
  return Number.isFinite(v) && v >= 1 && v <= 100 ? v : DEFAULT_PAUSE_AT
}

/** what the model reads on a denied tool, and the toast's tail */
export const holdMessage = (p: Pause, now: number) =>
  `usage-band: ${labelOf(p.kind)} usage is at ${p.percent}% (pause threshold ${p.pauseAt}%), so tools are paused. ` +
  `Stop here and do not retry: tell the user in one or two lines where you stopped and what is left. ` +
  (p.auto
    ? `Work continues automatically when the window resets in ${left(p.resetsAt, now)}.`
    : `The user continues with /usage-band resume.`)

// the module's own handles; a reload drops them and session.start arms them again
let timer: Timer | undefined
let awake: AsyncGenerator<unknown, unknown> | undefined

const stopAwake = () => {
  const s = awake
  awake = undefined
  if (s) void s.return(undefined).catch(() => {})
}

/** keep the Mac from idle-sleeping while a reset is awaited, so the timer fires on time */
const stayAwake = ($: EngineInterface, ms: number) => {
  stopAwake()
  const s = $.process.spawn({ argv: ['caffeinate', '-i', '-t', String(Math.ceil(ms / 1000))] })
  awake = s
  void (async () => {
    try {
      for await (const _ of s) { /* drain */ }
    } catch { /* no caffeinate (not macOS): the timer still runs */ }
    if (awake === s) awake = undefined
  })()
}

const disarm = () => {
  timer?.cancel()
  timer = undefined
  stopAwake()
}

async function arm($: EngineInterface, p: Pause) {
  disarm()
  if (!p.auto || !p.resetsAt) return
  const ms = Math.max(0, Date.parse(p.resetsAt) - (await $.clock.now())) + RESUME_SLACK_MS
  timer = $.clock.after(ms, () => void resume($, true))
  stayAwake($, ms)
}

async function pause($: EngineInterface, p: Pause) {
  await update($, paused, () => p)
  const now = await $.clock.now()
  const tail = p.auto ? `continues automatically in ${left(p.resetsAt, now)}` : 'run /usage-band resume to continue'
  $.ui.toast(`⏸ ${labelOf(p.kind)} usage at ${p.percent}% — work paused; ${tail}`, { timeoutMs: 10_000 })
  await arm($, p)
}

/** lift the hold; `send` asks the model to carry on */
async function resume($: EngineInterface, send: boolean) {
  const p = await read($, paused)
  disarm()
  if (!p) return false
  await update($, paused, () => null)
  if (p.resetsAt) await update($, lastResumed, () => p.resetsAt ?? '')
  $.ui.toast(send ? '▶ usage-band: continuing the paused task' : '▶ usage-band: pause lifted')
  // from its own timer, not the caller's hook: a command.run holds the turn the prompt would wait on
  if (send) $.clock.after(0, () => void $.prompt.submit({ text: CONTINUE_PROMPT }).catch(() => {}))
  return true
}

async function refresh($: EngineInterface, snap: Snapshot) {
  await update($, snapshot, () => snap)
  const text = summary(snap, await $.clock.now())
  $.ui.status(text === '' ? undefined : text)

  const w = await read($, warned)
  for (const m of snap.meters) {
    const t = due(m, w)
    if (t === undefined) continue
    const tail = m.resetsAt ? ` — resets in ${left(m.resetsAt, await $.clock.now())}` : ''
    $.ui.toast(`${t >= 90 ? '🔴' : '🟡'} ${labelOf(m.kind)} usage at ${m.percent}%${tail}`)
    await update($, warned, prev => ({ ...prev, [m.kind]: `${t}@${m.resetsAt ?? ''}` }))
  }

  if ((await read($, paused)) !== null) return
  const p = decide(snap.meters, await pauseAtOf($), await read($, lastResumed))
  if (p) await pause($, p)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    await refresh($, toSnapshot(u.context, u.rateLimits))
    const held = await read($, paused)
    if (held) await arm($, held)
    await $.command.register({
      name: 'usage-band',
      description: 'Usage band: status · pause-at <N> · resume · cancel · (no args) toggle the band',
    })
    return r
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, toSnapshot(e.context, e.rateLimits))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const p = await read($, paused)
    if (p === null) return next(e)
    return { deny: holdMessage(p, await $.clock.now()) }
  }).catch(($, e, next) => next(e)) // a failing gate never blocks tools

  on('command.run', { command: 'usage-band' }, async ($, e) => {
    const [cmd = '', arg] = e.args.trim().split(/\s+/)

    if (cmd === 'pause-at') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1 || n > 100) return { text: `Usage: /usage-band pause-at <1-100> (now ${await pauseAtOf($)}%)` }
      await $.store.set('pauseAt', n)
      return { text: `usage-band pauses work at ${n}% from now on (every session).` }
    }
    if (cmd === 'resume') {
      return { text: (await resume($, true)) ? 'Pause lifted; asking Claude to continue.' : 'Nothing is paused.' }
    }
    if (cmd === 'cancel') {
      return { text: (await resume($, false)) ? 'Pause lifted; nothing sent. Tools work again.' : 'Nothing is paused.' }
    }

    if (cmd === 'status') {
      const u = await $.session.usage()
      const live = toSnapshot(u.context, u.rateLimits)
      await refresh($, live)
      const surfaces = await $.session.surfaces()
      const now = await $.clock.now()
      const dot = (p: number) => (p >= 85 ? '🔴' : p >= 60 ? '🟡' : '🟢')
      const lines: string[] = []
      if (live.context !== undefined) lines.push(`${dot(live.context)} ctx  ${bar(live.context, 10)} ${live.context}%`)
      for (const m of live.meters) {
        const r = left(m.resetsAt, now)
        lines.push(`${dot(m.percent)} ${labelOf(m.kind).padEnd(3)} ${bar(m.percent, 10)} ${m.percent}%${r ? `  ↻ ${r}` : ''}`)
      }
      if (live.meters.length === 0) lines.push('rate limits: none reported yet (needs Pro/Max and one reply in this session)')
      const p = await read($, paused)
      lines.push(
        p
          ? `⏸ paused: ${labelOf(p.kind)} at ${p.percent}% — ${p.auto ? `continues in ${left(p.resetsAt, now)}` : 'waiting for /usage-band resume'}`
          : `pause threshold: ${await pauseAtOf($)}%`,
      )
      if (surfaces.length === 0) lines.push('(this window draws no mod UI; the live band shows in Claude Code)')
      return { text: lines.join('\n') }
    }

    const hidden = await update($, isHidden, h => !h)
    return { text: hidden ? 'Usage band hidden. Run /usage-band to show it again.' : 'Usage band shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    if (snap.context === undefined && snap.meters.length === 0) {
      return <Box key="wait"><Text dimColor>usage · waiting for the first reading</Text></Box>
    }
    const now = await $.clock.now()
    const held = await read($, paused)

    const parts = []
    if (held) {
      parts.push(
        <Box key="paused" flexDirection="row" gap={1}>
          <Text color="error" bold>⏸ paused</Text>
          <Text dimColor>{held.auto ? `continues in ${left(held.resetsAt, now)}` : '/usage-band resume'}</Text>
        </Box>,
      )
    }
    if (snap.context !== undefined) {
      parts.push(
        <Box key="ctx" flexDirection="row" gap={1}>
          <Text dimColor>ctx</Text>
          <Text color={tone(snap.context)}>{bar(snap.context)}</Text>
          <Text bold>{snap.context}%</Text>
        </Box>,
      )
    }
    for (const m of snap.meters) {
      const reset = left(m.resetsAt, now)
      parts.push(
        <Box key={m.kind} flexDirection="row" gap={1}>
          <Text dimColor>{labelOf(m.kind)}</Text>
          <Text color={tone(m.percent)}>{bar(m.percent)}</Text>
          <Text bold>{m.percent}%</Text>
          {reset ? <Text dimColor>↻ {reset}</Text> : null}
        </Box>,
      )
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        {parts}
        {held ? <Button key="resume" label="Resume" onPress={() => void resume($, true)} /> : null}
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
