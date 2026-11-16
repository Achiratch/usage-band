import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionContextUsage, Timer } from 'claude-code'

import type { Look, Meter, Pause, Snapshot, Trail, Warned } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const trails = atom({ plugin: 'usage-band', key: 'trails' } as const, {})
const warned = atom({ plugin: 'usage-band', key: 'warned' } as const, {})
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)
const paused = atom({ plugin: 'usage-band', key: 'paused' } as const, null)
const lastResumed = atom({ plugin: 'usage-band', key: 'lastResumed' } as const, '')
const isOpen = atom({ plugin: 'usage-band', key: 'isOpen' } as const, false)
const previous = atom({ plugin: 'usage-band', key: 'previous' } as const, {})

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

/** the redesign's calm blue: one hue that reads on deep navy and on charcoal alike */
export const DEFAULT_ACCENT = '#5b6cff'
/** earlier defaults; a stored copy of one means "the default", so it follows the current one */
const OLD_DEFAULT_ACCENTS = ['#6aa9e0', '#7b7bff']
export const DEFAULT_LOOK: Look = { theme: 'mono', accent: DEFAULT_ACCENT, compact: false }
const HEX = /^#[0-9a-f]{6}$/i
const look = atom({ plugin: 'usage-band', key: 'look' } as const, DEFAULT_LOOK)

export const lookOf = async ($: EngineInterface): Promise<Look> => {
  const v = (await $.store.get('look')) as Partial<Look> | undefined
  return {
    theme: v?.theme === 'classic' ? 'classic' : 'mono',
    accent:
      typeof v?.accent === 'string' && HEX.test(v.accent) && !OLD_DEFAULT_ACCENTS.includes(v.accent.toLowerCase())
        ? v.accent
        : DEFAULT_ACCENT,
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

/** where the amber step starts, and the most it waits before the coral one */
export const WARN_AT = 70
export const CRIT_AT = 90

export type Tone = 'calm' | 'warn' | 'crit'
/** three steps: calm, amber from 70, coral from 90 (or 5 under the pause line, if that is lower) */
export const toneOf = (p: number, pauseAt: number): Tone => {
  const crit = Math.min(CRIT_AT, pauseAt - 5)
  return p >= crit ? 'crit' : p >= Math.min(WARN_AT, crit - 1) ? 'warn' : 'calm'
}

const mix = (a: string, b: string, t: number) => {
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const A = p(a)
  const B = p(b)
  return `#${A.map((v, i) => Math.round(v + ((B[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

/** base, its light end, and the value text color of each tone */
export const toneColors = (t: Tone, accent: string) =>
  t === 'crit'
    ? { base: '#ff5a5f', light: '#ff9a9d', text: '#ff9a9d' }
    : t === 'warn'
      ? { base: '#f5a524', light: '#ffc97a', text: '#ffc97a' }
      : { base: accent, light: mix(accent, '#ffffff', 0.35), text: undefined }

/**
 * One meter as the redesign draws it: a thin track at 7% white, a single-hue
 * fill rising in lightness under a soft glow, and a bright 2px leading edge.
 * The fill glides from the last reading (`from`); coral breathes. Motion stops
 * under reduced motion. `tick` draws the amber line on the expanded track.
 */
export const meterSvg = (o: { p: number; from: number; tone: Tone; accent: string; id: string; w: number; h: number; tick?: number; stretch?: boolean }) => {
  const { base, light } = toneColors(o.tone, o.accent)
  const pad = 4
  const H = o.h + pad * 2
  const fw = (Math.max(0, Math.min(100, o.p)) / 100) * o.w
  const start = o.p > 0 ? Math.max(0, Math.min(1, o.from / Math.max(o.p, 0.01))) : 1
  const r = o.h / 2
  const tick = o.tick === undefined ? '' : `<rect x="${((o.tick / 100) * o.w).toFixed(1)}" y="1" width="1" height="${H - 2}" fill="#fff" fill-opacity=".28"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.w} ${H}" width="${o.w}" height="${H}"${o.stretch ? ' preserveAspectRatio="none"' : ''}>
<defs><linearGradient id="f${o.id}" x1="0" x2="1"><stop offset="0" stop-color="${base}" stop-opacity=".3"/><stop offset=".55" stop-color="${base}"/><stop offset="1" stop-color="${light}"/></linearGradient>
<filter id="g${o.id}" x="-10%" y="-200%" width="120%" height="500%"><feGaussianBlur stdDeviation="3"/></filter>
<filter id="e${o.id}" x="-400%" y="-100%" width="900%" height="300%"><feGaussianBlur stdDeviation="2"/></filter></defs>
<style>.grow{transform-origin:0 0;animation:grow .7s cubic-bezier(.22,1,.36,1) both}.edge{animation:edge .7s cubic-bezier(.22,1,.36,1) both}
@keyframes grow{from{transform:scaleX(${start.toFixed(3)})}}@keyframes edge{from{transform:translateX(${(fw * start - fw).toFixed(1)}px)}}
.breathe{animation:breathe 2.4s ease-in-out infinite}@keyframes breathe{0%,100%{opacity:.35}50%{opacity:.85}}
@media (prefers-reduced-motion:reduce){.grow,.edge,.breathe{animation:none}}</style>
<rect x="0" y="${pad}" width="${o.w}" height="${o.h}" rx="${r}" fill="#fff" fill-opacity=".07"/>
${fw > 0 ? `<g class="grow"><rect x="0" y="${pad}" width="${fw.toFixed(1)}" height="${o.h}" rx="${r}" fill="${base}" fill-opacity=".4" filter="url(#g${o.id})"${o.tone === 'crit' ? ' class="breathe"' : ''}/>
<rect x="0" y="${pad}" width="${fw.toFixed(1)}" height="${o.h}" rx="${r}" fill="url(#f${o.id})"/></g>
<g class="edge"><rect x="${(fw - 2).toFixed(1)}" y="${pad - 2}" width="2" height="${o.h + 4}" rx="1" fill="${base}" filter="url(#e${o.id})"/><rect x="${(fw - 2).toFixed(1)}" y="${pad - 2}" width="2" height="${o.h + 4}" rx="1" fill="#fff" fill-opacity=".92"/></g>` : ''}${tick}
</svg>`
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
  tokens: context.tokens,
  window: context.window,
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

/**
 * The status line repeats the band in one line, so it shows only while the band is hidden
 * (or before it has anything to draw); with the band on screen it would sit right under it.
 */
async function syncStatus($: EngineInterface, text?: string) {
  const snap = await read($, snapshot)
  const line = text ?? (snap ? summary(snap, await $.clock.now()) : '')
  $.ui.status((await read($, isHidden)) && line !== '' ? line : undefined)
}

async function refresh($: EngineInterface, snap: Snapshot) {
  const old = await read($, snapshot)
  if (old) {
    const was: Record<string, number> = {}
    if (old.context !== undefined) was.ctx = old.context
    for (const m of old.meters) was[m.kind] = m.percent
    await update($, previous, () => was)
  }
  await update($, snapshot, () => snap)
  const at = await $.clock.now()
  await update($, trails, prev => {
    const next: Record<string, Trail> = {}
    for (const m of snap.meters) next[m.kind] = record(prev[m.kind], m, at)
    return next
  })
  const text = summary(snap, await $.clock.now())
  await syncStatus($, text)

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
    await syncStatus($)
    return { text: hidden ? 'Usage band hidden. Run /usage-band to show it again.' : 'Usage band shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // The terminal has no Svg; there the glyph bar is drawn.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined

    if (snap.context === undefined && snap.meters.length === 0) {
      return <Box key="wait"><Text dimColor>usage · waiting for the first reading</Text></Box>
    }
    const now = await $.clock.now()
    const held = await read($, paused)
    const l = await read($, look)
    const at = await pauseAtOf($)
    const tr = await read($, trails)
    const was = await read($, previous)
    const open = await read($, isOpen)
    const toneFor = (p: number): Tone => (l.theme === 'classic' ? (tone(p) === 'error' ? 'crit' : tone(p) === 'warning' ? 'warn' : 'calm') : toneOf(p, at))
    const colorFor = (t: Tone) => (t === 'crit' ? 'error' : t === 'warn' ? 'warning' : l.accent)

    type Row = { key: string; label: string; name: string; p: number; reset?: string; detail: string }
    const rows: Row[] = []
    if (snap.context !== undefined) {
      // 831k, 1M, 1.2M
      const k = (n: number) => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`)
      rows.push({
        key: 'ctx', label: 'ctx', name: 'Context window', p: snap.context,
        detail: snap.tokens !== undefined && snap.window ? `${k(snap.tokens)} / ${k(snap.window)} tokens` : `${snap.context}% of the window`,
      })
    }
    for (const m of snap.meters) {
      const reset = left(m.resetsAt, now)
      rows.push({
        key: m.kind, label: labelOf(m.kind),
        name: m.kind === 'five_hour' ? '5-hour session' : m.kind === 'seven_day' ? 'Weekly' : 'Spend limit',
        p: m.percent, reset: reset ? reset.replace(/(\d)([hd])(\d)/, '$1$2 $3') : undefined,
        detail: reset ? `resets in ${reset.replace(/(\d)([hd])(\d)/, '$1$2 $3')}` : '',
      })
    }
    const extra = (r: Row) => {
      const m = snap.meters.find(x => x.kind === r.key)
      if (!m || held) return undefined
      const f = forecast(m, tr[m.kind], at, now)
      if (f !== undefined) return `${at}% in ${span(f, now)}`
      const pc = m.kind === 'seven_day' ? pace(m, now) : undefined
      return pc !== undefined && pc >= 10 ? `+${pc} pace` : undefined
    }
    // (not named h: that is the JSX factory)
    const track = (r: Row, w: number, thick: number, tick?: number, stretch = false) => {
      const t = toneFor(r.p)
      if (!Svg) return <Text key={`bar-${r.key}`} color={colorFor(t)}>{bar(r.p)}</Text>
      return (
        <Box key={`bar-${r.key}`} flexShrink={stretch ? 1 : 0} flexGrow={stretch ? 1 : 0}>
          <Svg
            source={meterSvg({ p: r.p, from: was[r.key] ?? 0, tone: t, accent: l.accent, id: `${r.key}${w}`, w, h: thick, tick, stretch })}
            alt={`${r.name} ${r.p}%`}
            width={stretch ? undefined : w}
            height={thick + 8}
            isInteractive
          />
        </Box>
      )
    }
    // Value text: calm stays plain; amber and coral color it, add a dot, and coral is bolder.
    const value = (r: Row) => {
      const t = toneFor(r.p)
      return (
        <Box key={`val-${r.key}`} flexDirection="row" gap={1} flexShrink={0}>
          {t !== 'calm' ? <Text color={colorFor(t)}>●</Text> : null}
          <Text bold tabular color={t === 'calm' ? undefined : colorFor(t)}>{r.p}%</Text>
        </Box>
      )
    }

    if (l.compact) {
      return (
        <Box key="compact" flexDirection="row" columnGap={2} alignItems="center">
          {held ? <Text color="error" bold>⏸</Text> : null}
          {rows.map(r => (
            <Box key={r.key} flexDirection="row" gap={1}>
              <Text dimColor>{r.label}</Text>
              {value(r)}
            </Box>
          ))}
          {held ? <Button key="resume" label="Resume" onPress={() => void resume($, true)} /> : null}
        </Box>
      )
    }

    // Narrow bands keep the values and drop the tracks.
    const narrow = e.props.bodyColumns < 60
    const trackW = Math.max(56, Math.min(110, Math.floor(((e.props.bodyColumns - 40) / Math.max(1, rows.length)) * 3)))
    const cells = rows.map(r => {
      const x = extra(r)
      return (
        <Box key={r.key} flexDirection="row" gap={1} alignItems="center" flexGrow={1} flexShrink={0}>
          <Text dimColor mono size="caption">{r.label}</Text>
          {narrow ? null : track(r, trackW, 4)}
          {value(r)}
          {r.reset ? (
            <Box key={`reset-${r.key}`} flexShrink={0}>
              <Text dimColor size="caption" tabular wrap="truncate">↻ {r.reset}</Text>
            </Box>
          ) : null}
          {x ? <Text color="warning" size="caption" wrap="truncate">{x}</Text> : null}
        </Box>
      )
    })

    const panel = open ? (
      <Box key="panel" flexDirection="column" gap={1} paddingBottom={1}>
        {rows.map(r => (
          <Box key={`d-${r.key}`} flexDirection="column">
            <Box flexDirection="row" gap={2}>
              <Text>{r.name}</Text>
              <Text dimColor mono size="caption">{r.label}</Text>
              <Box flexGrow={1} />
              <Text dimColor tabular>{r.detail}</Text>
              {value(r)}
            </Box>
            {/* Drawn wide and stretched to the panel's width, so it spans it at any size. */}
            {track(r, 1600, 8, WARN_AT, true)}
          </Box>
        ))}
      </Box>
    ) : null

    // A pause gets its own line with Resume, so the meters' row never crowds.
    const pausedRow = held ? (
      <Box key="paused" flexDirection="row" gap={1} alignItems="center">
        <Text color="error" bold>⏸ paused</Text>
        <Text dimColor>{held.auto ? `continues in ${left(held.resetsAt, now)}` : '/usage-band resume'}</Text>
        <Button key="resume" label="Resume" onPress={() => void resume($, true)} />
      </Box>
    ) : null

    return (
      <Box key="band" flexDirection="column" rowGap={1}>
        {panel}
        {pausedRow}
        {/* Cells wrap to a second line when the band is too narrow, rather than overlap. */}
        <Box key="row" flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1} alignItems="center">
          {cells}
          <Box key="actions" flexDirection="row" gap={1} flexShrink={0}>
            <Button key="details" label={open ? 'Less' : 'Details'} plain onPress={() => update($, isOpen, o => !o)} />
            <Button
              key="hide"
              label="Hide"
              onPress={async () => {
                await update($, isHidden, () => true)
                await syncStatus($)
              }}
            />
          </Box>
        </Box>
      </Box>
    )
  })
}
