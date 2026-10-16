import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CONTINUE_PROMPT, RESUME_SLACK_MS, decide } from './register'

const NOW = Date.parse('2026-10-15T10:00:00Z')
const HOUR = 3_600_000
const at = (ms: number) => new Date(NOW + ms).toISOString()
const FIVE_RESET = at(2 * HOUR)
const SEVEN_RESET = at(77 * HOUR)

const measure = (five: number, seven: number, fiveReset = FIVE_RESET) => ({
  context: { window: 200_000, tokens: 68_000, percent: 34 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: fiveReset },
    { kind: 'seven_day', percentUsed: seven, resetsAt: SEVEN_RESET },
  ],
  changed: ['rateLimits'] as ('context' | 'rateLimits')[],
})

type Ran = { deny?: string; isError?: boolean; text?: string }
const blocked = (r: unknown) => (r as Ran).deny !== undefined || (r as Ran).isError === true
const reason = (r: unknown) => String((r as Ran).deny ?? (r as Ran).text)

/** the engine beneath: records toasts, prompts and caffeinate runs; answers tools */
const world = (on: On) => {
  const seen = { toasts: [] as string[], prompts: [] as string[], spawns: [] as string[][], tools: 0 }
  on('ui.toast', ($, e) => { seen.toasts.push(e.text); return { value: undefined } as never })
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => { seen.prompts.push(e.text); return { text: e.text } })
  on('process.spawn', async function* ($, e) { seen.spawns.push([...e.argv]); return { value: { code: 0 } } as never })
  on('tool.call', () => { seen.tools++; return { result: 'ok' } as never })
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  return { seen, clock }
}

test('decide: threshold, 7d wins and never auto-continues, resumed window skipped', () => {
  const five = { kind: 'five_hour', percent: 96, resetsAt: 'R5' }
  const seven = { kind: 'seven_day', percent: 97, resetsAt: 'R7' }
  expect(decide([{ ...five, percent: 94 }], 95, '')).toBe(undefined)
  expect(decide([five], 95, '')).toEqual({ kind: 'five_hour', percent: 96, pauseAt: 95, resetsAt: 'R5', auto: true })
  expect(decide([five, seven], 95, '')?.kind).toBe('seven_day')
  expect(decide([five, seven], 95, '')?.auto).toBe(false)
  expect(decide([five], 95, 'R5')).toBe(undefined)
  expect(decide([{ kind: 'five_hour', percent: 99 }], 95, '')?.auto).toBe(false) // no reset time known
})

test('5h at 95%: tools are denied, then the reset continues the task', async ($, on) => {
  const { seen, clock } = world(on)

  await $.session.measure(measure(90, 40))
  expect(blocked(await $.tool.call({ tool: 'Bash', command: 'ls' } as never))).toBe(false)
  expect(seen.tools).toBe(1)

  await $.session.measure(measure(95, 40))
  expect(seen.toasts.some(t => t.includes('work paused') && t.includes('2h00m'))).toBe(true)
  expect(seen.spawns[0]?.[0]).toBe('caffeinate')

  const denied = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(blocked(denied)).toBe(true)
  expect(reason(denied)).toContain('Stop here')
  expect(seen.tools).toBe(1)

  // a later reading of the same window does not pause twice
  await $.session.measure(measure(97, 40))
  expect(seen.toasts.filter(t => t.includes('work paused')).length).toBe(1)

  await clock.advance(2 * HOUR)
  expect(seen.prompts).toEqual([])
  await clock.advance(RESUME_SLACK_MS)
  await clock.advance(1) // the send rides its own timer
  expect(seen.prompts).toEqual([CONTINUE_PROMPT])

  // tools work again, and a stale reading of the old window does not pause again
  await $.session.measure(measure(97, 40))
  expect(blocked(await $.tool.call({ tool: 'Bash', command: 'ls' } as never))).toBe(false)
  // a new window that fills up pauses again
  await $.session.measure(measure(96, 40, at(7 * HOUR)))
  expect(seen.toasts.filter(t => t.includes('work paused')).length).toBe(2)
})

test('7d at the threshold: pauses without a timer until /usage-band resume', async ($, on) => {
  const { seen, clock } = world(on)
  await $.session.measure(measure(30, 96))
  expect(seen.spawns).toEqual([])
  expect(blocked(await $.tool.call({ tool: 'Read', file_path: '/tmp/x' } as never))).toBe(true)

  await clock.advance(80 * HOUR)
  expect(seen.prompts).toEqual([])

  const out = await $.command.run({ command: 'usage-band', args: 'resume' } as never)
  expect(String((out as { text?: string }).text)).toContain('continue')
  await clock.advance(1) // the send rides its own timer
  expect(seen.prompts).toEqual([CONTINUE_PROMPT])
  expect(blocked(await $.tool.call({ tool: 'Read', file_path: '/tmp/x' } as never))).toBe(false)
})

test('pause-at sets the threshold; cancel lifts the pause without sending', async ($, on) => {
  const { seen, clock } = world(on)
  const set = await $.command.run({ command: 'usage-band', args: 'pause-at 80' } as never)
  expect(String((set as { text?: string }).text)).toContain('80%')
  expect(String(((await $.command.run({ command: 'usage-band', args: 'pause-at 0' } as never)) as { text?: string }).text)).toContain('Usage:')

  await $.session.measure(measure(82, 10))
  expect(blocked(await $.tool.call({ tool: 'Bash', command: 'ls' } as never))).toBe(true)

  await $.command.run({ command: 'usage-band', args: 'cancel' } as never)
  expect(blocked(await $.tool.call({ tool: 'Bash', command: 'ls' } as never))).toBe(false)
  await clock.advance(3 * HOUR)
  expect(seen.prompts).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band shows the pause and a Resume button (${surface})`, async ($, on) => {
    const { seen, clock } = world(on)
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
    await $.session.measure(measure(96, 40))
    const ui = await $.ui.mount({
      plugin: 'usage-band', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
    })
    expect((await ui.find({ key: 'paused' }))?.text).toContain('continues in 2h')
    await ui.press({ key: 'resume' })
    await clock.advance(1) // the send rides its own timer
    expect(seen.prompts).toEqual([CONTINUE_PROMPT])
    expect(await ui.find({ key: 'paused' })).toBe(undefined)
  })
}
