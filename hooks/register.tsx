import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionContextUsage } from 'claude-code'

import type { Meter, Snapshot, Warned } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const warned = atom({ plugin: 'usage-band', key: 'warned' } as const, {})
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const THRESHOLDS = [90, 80]
const WIDTH = 8

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

export const summary = (snap: Snapshot, now: number) => {
  const parts: string[] = []
  if (snap.context !== undefined) parts.push(`ctx ${snap.context}%`)
  for (const m of snap.meters) {
    const r = left(m.resetsAt, now)
    parts.push(`${LABEL[m.kind] ?? m.kind} ${bar(m.percent, 5)} ${m.percent}%${r ? ` ↻${r}` : ''}`)
  }
  return parts.join(' · ')
}

async function refresh($: EngineInterface, snap: Snapshot) {
  await update($, snapshot, () => snap)
  const text = summary(snap, await $.clock.now())
  $.ui.status(text === '' ? undefined : text)

  const w = await read($, warned)
  for (const m of snap.meters) {
    const t = due(m, w)
    if (t === undefined) continue
    const label = LABEL[m.kind] ?? m.kind
    const tail = m.resetsAt ? ` — resets in ${left(m.resetsAt, await $.clock.now())}` : ''
    $.ui.toast(`${t >= 90 ? '🔴' : '🟡'} ${label} usage at ${m.percent}%${tail}`)
    await update($, warned, prev => ({ ...prev, [m.kind]: `${t}@${m.resetsAt ?? ''}` }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    await refresh($, toSnapshot(u.context, u.rateLimits))
    await $.command.register({ name: 'usage-band', description: 'Toggle the usage band; "/usage-band status" shows what it sees' })
    return r
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, toSnapshot(e.context, e.rateLimits))
    return next(e)
  })

  on('command.run', { command: 'usage-band' }, async ($, e) => {
    if (e.args.trim() === 'status') {
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
        const label = (LABEL[m.kind] ?? m.kind).padEnd(3)
        lines.push(`${dot(m.percent)} ${label} ${bar(m.percent, 10)} ${m.percent}%${r ? `  ↻ ${r}` : ''}`)
      }
      if (live.meters.length === 0) lines.push('rate limits: none reported yet (needs Pro/Max and one reply in this session)')
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

    const parts = []
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
          <Text dimColor>{LABEL[m.kind] ?? m.kind}</Text>
          <Text color={tone(m.percent)}>{bar(m.percent)}</Text>
          <Text bold>{m.percent}%</Text>
          {reset ? <Text dimColor>↻ {reset}</Text> : null}
        </Box>,
      )
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        {parts}
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
