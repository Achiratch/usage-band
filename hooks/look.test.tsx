import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_LOOK, MIN_SPAN_MS, colorOf, eta, forecast, pace, record } from './register'

const NOW = Date.parse('2026-10-15T10:00:00Z')
const MIN = 60_000
const HOUR = 3_600_000
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }

const measure = (five: number, seven: number, fiveReset = NOW + 3 * HOUR, sevenReset = NOW + 2 * 24 * HOUR) => ({
  context: { window: 200_000, tokens: 80_000, percent: 40 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: new Date(fiveReset).toISOString() },
    { kind: 'seven_day', percentUsed: seven, resetsAt: new Date(sevenReset).toISOString() },
  ],
  changed: ['rateLimits'] as ('context' | 'rateLimits')[],
})

const world = (on: On) => {
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('process.spawn', async function* () { return { value: { code: 0 } } as never })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
  mock.store(on)
  return mock.clock(on, { now: NOW })
}

const say = async ($: { command: { run: (a: never) => Promise<unknown> } }, args: string) =>
  String(((await $.command.run({ command: 'usage-band', args } as never)) as { text?: string }).text)

test('colors: mono keeps one accent until near the pause line; classic is a traffic light', () => {
  const mono = DEFAULT_LOOK
  expect(colorOf(41, mono, 95)).toBe('#6aa9e0')
  expect(colorOf(84, mono, 95)).toBe('#6aa9e0')
  expect(colorOf(85, mono, 95)).toBe('error')
  expect(colorOf(72, mono, 80)).toBe('error')
  expect(colorOf(41, { ...mono, accent: '#e07a5f' }, 95)).toBe('#e07a5f')
  expect(colorOf(41, { ...mono, theme: 'classic' }, 95)).toBe('success')
  expect(colorOf(70, { ...mono, theme: 'classic' }, 95)).toBe('warning')
})

test('forecast: needs ten minutes of rising readings, and only shows before the reset', () => {
  expect(eta([[NOW, 40]], 95)).toBe(undefined)
  expect(eta([[NOW, 40], [NOW + MIN_SPAN_MS - 1, 50]], 95)).toBe(undefined)
  // 10 points in 20 minutes: 45 more points takes 90 minutes
  expect(eta([[NOW, 40], [NOW + 20 * MIN, 50]], 95)).toBe(90 * MIN)
  expect(eta([[NOW, 50], [NOW + 20 * MIN, 50]], 95)).toBe(undefined)

  const m = { kind: 'five_hour', percent: 50, resetsAt: new Date(NOW + 20 * MIN + 2 * HOUR).toISOString() }
  const trail = { resetsAt: m.resetsAt, samples: [[NOW, 40], [NOW + 20 * MIN, 50]] as [number, number][] }
  expect(forecast(m, trail, 95, NOW + 20 * MIN)).toBe(90 * MIN)
  const soon = { ...m, resetsAt: new Date(NOW + 20 * MIN + HOUR).toISOString() }
  expect(forecast(soon, { ...trail, resetsAt: soon.resetsAt }, 95, NOW + 20 * MIN)).toBe(undefined)
})

test('trail: a new window starts over, old readings drop, repeats are skipped', () => {
  const m = { kind: 'five_hour', percent: 40, resetsAt: 'R1' }
  let t = record(undefined, m, NOW)
  t = record(t, m, NOW + 30_000)
  expect(t.samples.length).toBe(1)
  t = record(t, { ...m, percent: 42 }, NOW + 5 * MIN)
  expect(t.samples.length).toBe(2)
  t = record(t, { ...m, percent: 43 }, NOW + 94 * MIN) // the 40 is now 94 min old, past the 90 min trail
  expect(t.samples.map(s => s[1])).toEqual([42, 43])
  expect(record(t, { ...m, resetsAt: 'R2', percent: 2 }, NOW + 95 * MIN).samples).toEqual([[NOW + 95 * MIN, 2]])
})

test('pace: points ahead of an even spend across the week', () => {
  const twoDaysLeft = { kind: 'seven_day', percent: 93, resetsAt: new Date(NOW + 2 * 24 * HOUR).toISOString() }
  expect(pace(twoDaysLeft, NOW)).toBe(22) // 5 of 7 days gone = 71%
  expect(pace({ ...twoDaysLeft, percent: 60 }, NOW)).toBe(-11)
  expect(pace({ kind: 'spend_limit', percent: 50 }, NOW)).toBe(undefined)
})

test('theme, accent and compact persist and validate', async ($, on) => {
  world(on)
  on('session.usage', () => ({ value: { context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('session.surfaces', () => ({ value: [] }) as never)
  expect(await say($, 'theme neon')).toContain('Usage:')
  expect(await say($, 'accent blue')).toContain('Usage:')
  expect(await say($, 'theme classic')).toContain('classic')
  expect(await say($, 'accent #E07A5F')).toContain('#e07a5f')
  expect(await say($, 'compact')).toContain('compact')
  expect(await say($, 'status')).toContain('look: classic, accent #e07a5f, compact')
  expect(await say($, 'accent default')).toContain('#6aa9e0')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band: forecast, weekly pace, and compact mode (${surface})`, async ($, on) => {
    const clock = world(on)
    await $.session.measure(measure(40, 91))
    await clock.advance(20 * MIN)
    await $.session.measure(measure(50, 91))

    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect((await ui.find({ key: 'five_hour' }))?.text).toContain('95% in 1h30m')
    // 7d: flat, so no forecast, but 91% with 2 days left is well ahead of an even week
    expect((await ui.find({ key: 'seven_day' }))?.text).toContain('pace')

    await say($, 'compact')
    const c = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect((await c.find({ key: 'five_hour' }))?.text).toContain('50%')
    expect((await c.find({ key: 'five_hour' }))?.text).not.toContain('▰')
  })
}
