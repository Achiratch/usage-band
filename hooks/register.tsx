import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionContextUsage, Timer } from 'claude-code'

import type { Look, Meter, Pause, Snapshot, Trail, Warned } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const trails = atom({ plugin: 'usage-band', key: 'trails' } as const, {})
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

export const DEFAULT_ACCENT = '#6aa9e0'
export const DEFAULT_LOOK: Look = { theme: 'mono', accent: DEFAULT_ACCENT, compact: false }
const HEX = /^#[0-9a-f]{6}$/i
const look = atom({ plugin: 'usage-band', key: 'look' } as const, DEFAULT_LOOK)

export const lookOf = async ($: EngineInterface): Promise<Look> => {
  const v = (await $.store.get('look')) as Partial<Look> | undefined
  return {
    theme: v?.theme === 'classic' ? 'classic' : 'mono',
    accent: typeof v?.accent === 'string' && HEX.test(v.accent) ? v.accent : DEFAULT_ACCENT,
    compact: v?.compact === true,
  }
}

/** mono: one accent until a meter nears the pause line, then red; classic: traffic light */
export const colorOf = (p: number, look: Look, pauseAt: number) =>
  look.theme === 'classic' ? tone(p) : p >= Math.min(pauseAt - 10, 85) ? 'error' : look.accent

const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
/** readings older than this no longer say much about the current pace */
export const TRAIL_MS = 90 * 60_000
/** a forecast needs at least this much history behind it */
export const MIN_SPAN_MS = 10 * 60_000

/** add a reading to a window's trail; a new window (resetsAt moved) starts a fresh one */
export const record = (t: Trail | undefined, m: Meter, now: number): Trail => {
  const resetsAt = m.resetsAt ?? ''
  const kept = t && t.resetsAt === resetsAt ? t.samples.filter(([at]) => now - at <= TRAIL_MS) : []
  const last = kept[kept.length - 1]
  if (last && last[1] === m.percent && now - last[0] < 60_000) return { resetsAt, samples: kept }
  return { resetsAt, samples: [...kept, [now, m.percent]] }
}

/** ms until the trail's pace reaches `target`, or undefined while there is too little to go on */
export const eta = (samples: [number, number][], target: number) => {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || first === last) return undefined
  const [t0, p0] = first
  const [t1, p1] = last
  if (t1 - t0 < MIN_SPAN_MS || p1 <= p0 || p1 >= target) return undefined
  return ((target - p1) * (t1 - t0)) / (p1 - p0)
}

/** points ahead of (+) or behind (-) an even spend across the window */
export const pace = (m: Meter, now: number) => {
  const span = WINDOW_MS[m.kind]
  if (!span || !m.resetsAt) return undefined
  const elapsed = Math.min(1, Math.max(0, 1 - (Date.parse(m.resetsAt) - now) / span))
  return Math.round(m.percent - elapsed * 100)
}

/** "38m", "2h05m": a duration in the reset countdown's own format */
export const span = (ms: number, now: number) => left(new Date(now + ms).toISOString(), now)

/** the forecast worth showing for a meter: reaches the pause line before its window resets */
export const forecast = (m: Meter, t: Trail | undefined, pauseAt: number, now: number) => {
  if (!t || !m.resetsAt) return undefined
  const ms = eta(t.samples, pauseAt)
  if (ms === undefined || now + ms >= Date.parse(m.resetsAt)) return undefined
  return ms
}

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
  $.ui.toast(`⏸ ${labelOf(p.kind)} usage at ${p.percent}%, work paused: ${tail}`, { timeoutMs: 10_000 })
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
  const at = await $.clock.now()
  await update($, trails, prev => {
    const next: Record<string, Trail> = {}
    for (const m of snap.meters) next[m.kind] = record(prev[m.kind], m, at)
    return next
  })
  const text = summary(snap, await $.clock.now())
  $.ui.status(text === '' ? undefined : text)

  const w = await read($, warned)
  for (const m of snap.meters) {
    const t = due(m, w)
    if (t === undefined) continue
    const tail = m.resetsAt ? `, resets in ${left(m.resetsAt, await $.clock.now())}` : ''
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
    const stored = await lookOf($)
    await update($, look, () => stored)
    const u = await $.session.usage()
    await refresh($, toSnapshot(u.context, u.rateLimits))
    const held = await read($, paused)
    if (held) await arm($, held)
    await $.command.register({
      name: 'usage-band',
      description: 'Usage band: status · pause-at <N> · resume · cancel · theme mono|classic · accent <#hex> · compact · (no args) toggle',
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
    if (cmd === 'theme' || cmd === 'accent' || cmd === 'compact') {
      const l = { ...(await lookOf($)) }
      if (cmd === 'theme') {
        if (arg !== 'mono' && arg !== 'classic') return { text: `Usage: /usage-band theme mono|classic (now ${l.theme})` }
        l.theme = arg
      } else if (cmd === 'accent') {
        if (arg === 'default') l.accent = DEFAULT_ACCENT
        else if (arg && HEX.test(arg)) l.accent = arg.toLowerCase()
        else return { text: `Usage: /usage-band accent <#rrggbb|default> (now ${l.accent})` }
      } else l.compact = !l.compact
      await $.store.set('look', l)
      await update($, look, () => l)
      return { text: `usage-band look: ${l.theme}, accent ${l.accent}${l.compact ? ', compact' : ''} (every session).` }
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
      const tr = await read($, trails)
      const at = await pauseAtOf($)
      for (const m of live.meters) {
        const r = left(m.resetsAt, now)
        const f = forecast(m, tr[m.kind], at, now)
        const pc = m.kind === 'seven_day' ? pace(m, now) : undefined
        lines.push(
          `${dot(m.percent)} ${labelOf(m.kind).padEnd(3)} ${bar(m.percent, 10)} ${m.percent}%${r ? `  ↻ ${r}` : ''}` +
            (f !== undefined ? `  · ${at}% in ${span(f, now)} at this pace` : '') +
            (pc !== undefined ? `  · ${pc > 0 ? `${pc} pts ahead of` : `${-pc} pts under`} an even week` : ''),
        )
      }
      const l = await read($, look)
      lines.push(`look: ${l.theme}, accent ${l.accent}${l.compact ? ', compact' : ''}`)
      if (live.meters.length === 0) lines.push('rate limits: none reported yet (needs Pro/Max and one reply in this session)')
      const p = await read($, paused)
      lines.push(
        p
          ? `⏸ paused: ${labelOf(p.kind)} at ${p.percent}%, ${p.auto ? `continues in ${left(p.resetsAt, now)}` : 'waiting for /usage-band resume'}`
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
    const l = await read($, look)
    const at = await pauseAtOf($)
    const tr = await read($, trails)
    const col = (p: number) => colorOf(p, l, at)

    if (l.compact) {
      return (
        <Box key="compact" flexDirection="row" columnGap={2} alignItems="center">
          {held ? <Text color="error" bold>⏸</Text> : null}
          {snap.context !== undefined ? <Text key="ctx" dimColor>ctx {snap.context}%</Text> : null}
          {snap.meters.map(m => (
            <Box key={m.kind} flexDirection="row" gap={1}>
              <Text dimColor>{labelOf(m.kind)}</Text>
              <Text color={col(m.percent)} bold>{m.percent}%</Text>
            </Box>
          ))}
          {held ? <Button key="resume" label="Resume" onPress={() => void resume($, true)} /> : null}
        </Box>
      )
    }

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
          <Text color={l.theme === 'classic' ? tone(snap.context) : l.accent}>{bar(snap.context)}</Text>
          <Text bold>{snap.context}%</Text>
        </Box>,
      )
    }
    for (const m of snap.meters) {
      const reset = left(m.resetsAt, now)
      const f = held ? undefined : forecast(m, tr[m.kind], at, now)
      const pc = m.kind === 'seven_day' ? pace(m, now) : undefined
      parts.push(
        <Box key={m.kind} flexDirection="row" gap={1}>
          <Text dimColor>{labelOf(m.kind)}</Text>
          <Text color={col(m.percent)}>{bar(m.percent)}</Text>
          <Text bold>{m.percent}%</Text>
          {reset ? <Text dimColor>↻ {reset}</Text> : null}
          {f !== undefined ? <Text color="warning">{at}% in {span(f, now)}</Text> : null}
          {f === undefined && pc !== undefined && pc >= 10 ? <Text color="warning">+{pc} pace</Text> : null}
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
