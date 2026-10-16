import { test, expect, mock } from 'claude-code/testing'

import { bar, due, left, tone } from './register'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }
const NOW = Date.parse('2026-10-15T10:00:00Z')
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString()

const measure = (five: number, seven: number) => ({
  context: { window: 200_000, tokens: 68_000, percent: 34 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: seven, resetsAt: inHours(77) },
    { kind: 'five_hour', percentUsed: five, resetsAt: inHours(2.25) },
  ],
  changed: ['context', 'rateLimits'] as ('context' | 'rateLimits')[],
})

test('helpers: bar, tone, reset countdown, warn-once', async () => {
  expect(bar(0)).toBe('▱▱▱▱▱▱▱▱')
  expect(bar(50)).toBe('▰▰▰▰▱▱▱▱')
  expect(bar(130)).toBe('▰▰▰▰▰▰▰▰')
  expect(tone(10)).toBe('success')
  expect(tone(70)).toBe('warning')
  expect(tone(90)).toBe('error')

  const now = Date.parse('2026-10-15T10:00:00Z')
  expect(left('2026-10-15T12:14:30Z', now)).toBe('2h14m')
  expect(left('2026-10-18T15:00:00Z', now)).toBe('3d5h')
  expect(left('2026-10-15T09:00:00Z', now)).toBe('now')

  const m = { kind: 'five_hour', percent: 83, resetsAt: 'R1' }
  expect(due(m, {})).toBe(80)
  expect(due(m, { five_hour: '80@R1' })).toBe(undefined)
  expect(due({ ...m, percent: 91 }, { five_hour: '80@R1' })).toBe(90)
  expect(due(m, { five_hour: '90@R0' })).toBe(80) // a new window warns again
  expect(due({ ...m, percent: 40 }, {})).toBe(undefined)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band draws meters and toasts once per threshold (${surface})`, async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined } as never
    })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
    mock.clock(on, { now: NOW })

    await $.session.measure(measure(23, 41))
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })

    expect((await ui.find({ key: 'ctx' }))?.text).toContain('34%')
    const five = await ui.find({ key: 'five_hour' })
    expect(five?.text).toContain('5h')
    expect(five?.text).toContain('23%')
    expect(five?.text).toContain('↻ 2h')
    expect((await ui.find({ key: 'seven_day' }))?.text).toContain('41%')
    expect(toasts).toEqual([])

    await $.session.measure(measure(82, 41))
    await $.session.measure(measure(84, 41))
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('5h usage at 82%')

    await $.session.measure(measure(93, 41))
    expect(toasts.length).toBe(2)
    expect(toasts[1]).toContain('🔴')

    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'five_hour' })).toBe(undefined)
  })
}

test('band stays out of the way before any reading', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
  mock.clock(on, { now: NOW })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'hide' })).toBe(undefined)
  expect((await ui.find({ key: 'wait' }))?.text).toContain('waiting')
})
