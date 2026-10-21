import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000

const toasts: string[] = []
let onInvalidate = () => {}
let idle: unknown = false

// Stands in for the engine beneath the plugin.
function engine(on: Parameters<Parameters<typeof test>[1]>[1] extends never ? never : any) {
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('command.register', async () => ({ value: {} }))
  on('session.id', async () => ({ value: 's1' }))
  on('ui.invalidate', async () => {
    onInvalidate()
    return { value: undefined }
  })
  on('ui.toast', async (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('settings.read', async () => ({ value: { idleCompaction: idle } }))
  on('ui.render', async ($: any, e: any) => h($.ui.resolve(e).Box, { key: 'engine' }))
}

test('pings before the hour, then stops on a cache miss', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no' })
  const writes: string[] = []
  on('fs.write', async (_$, e) => {
    writes.push(e.text)
    return { value: undefined }
  })
  const forks: number[] = []
  let cacheRead = 9_500
  on('model.fork', async () => {
    forks.push(clock.now())
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 2_000 },
    }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(writes.at(-1)).toBe('{"state":"hot"}\n')

  await clock.advance(49 * MIN)
  expect(forks.length).toBe(0)
  await clock.advance(1 * MIN)
  expect(forks.length).toBe(1)
  expect(writes.at(-1)).toBe('{"state":"hot"}\n')

  cacheRead = 100
  await clock.advance(50 * MIN)
  expect(forks.length).toBe(2)
  expect(writes.at(-1)).toBe('{"state":"cold"}\n')

  await clock.advance(120 * MIN)
  expect(forks.length).toBe(2)
})

test('at the cap the band stays hot until the cache lapses, then goes cold', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no', CLAUDE_CODE_SESSION_HEATING_HOURS_CAP: '1' })
  const writes: string[] = []
  on('fs.write', async (_$, e) => {
    writes.push(e.text)
    return { value: undefined }
  })
  const forks: number[] = []
  on('model.fork', async () => {
    forks.push(clock.now())
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 } } }
  })
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
    }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
  const props = { hasSurvey: false, isWorking: false, maxRows: 3 } as never

  // The ping at 50m is the last before the 1h cap: the cache stays warm until 110m.
  await clock.advance(60 * MIN)
  expect(forks.length).toBe(1)
  const capped = await $.ui.mount({ plugin: 'session-heating', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await capped.find({ text: ' session warm for ~50m' })).not.toBe(undefined)
  expect(await capped.find({ text: 'pings capped' })).not.toBe(undefined)
  await capped.unmount()
  expect(writes.at(-1)).toBe('{"state":"hot"}\n')

  await clock.advance(55 * MIN)
  expect(forks.length).toBe(1)
  expect(writes.at(-1)).toBe('{"state":"cold"}\n')
  const cold = await $.ui.mount({ plugin: 'session-heating', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await cold.find({ text: ' session cold for 5m' })).not.toBe(undefined)
})

test('/session-heating off stops pings', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no' })
  on('fs.write', async () => ({ value: undefined }))
  const forks: number[] = []
  on('model.fork', async () => {
    forks.push(clock.now())
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 } } }
  })
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
    }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
  const ran = await $.command.run({ command: 'session-heating', args: 'off', origin: { kind: 'composer' } } as never)
  expect(ran.text).toBe('Session Heating is off for this session.')
  await clock.advance(120 * MIN)
  expect(forks.length).toBe(0)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band shows only while away (${surface})`, async ($, on) => {
    engine(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no' })
    on('fs.write', async () => ({ value: undefined }))
    on('turn.step', async function* () {
      return {
        turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
        usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
      }
    })
    await $.session.start({ cwd: '/tmp', surface, isInteractive: surface === 'terminal' })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
      // drain
    }
    await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
    const props = { hasSurvey: false, isWorking: false, maxRows: 3 } as never

    const early = await $.ui.mount({ plugin: 'session-heating', surface, component: 'AbovePrompt', props })
    expect(await early.find({ text: /session/ })).toBe(undefined)
    await early.unmount()

    await clock.advance(6 * 60_000)
    const away = await $.ui.mount({ plugin: 'session-heating', surface, component: 'AbovePrompt', props })
    expect(await away.find({ text: ' session warm for 12h 34m' })).not.toBe(undefined)
    expect(await away.find({ text: 'ping in 44m' })).not.toBe(undefined)
    expect(await away.find({ text: '♨' })).not.toBe(undefined)
  })
}

test('band shows clock times with RELATIVE_TIME=no, 12-hour with 24H_CLOCK=no', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {
    HOME: '/nowhere',
    CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no',
    CLAUDE_CODE_SESSION_HEATING_RELATIVE_TIME: 'no',
    CLAUDE_CODE_SESSION_HEATING_24H_CLOCK: 'no',
  })
  on('fs.write', async () => ({ value: undefined }))
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
    }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
  await clock.advance(6 * MIN)
  const props = { hasSurvey: false, isWorking: false, maxRows: 3 } as never
  const away = await $.ui.mount({ plugin: 'session-heating', surface: 'terminal', component: 'AbovePrompt', props })
  const time = '(1[0-2]|[1-9]):[0-5]\\d(am|pm)'
  expect(await away.find({ text: new RegExp(`^ session warm until ${time}$`) })).not.toBe(undefined)
  expect(await away.find({ text: new RegExp(`^ping at ${time}$`) })).not.toBe(undefined)
})

test('band redraws when the away delay ends and on each countdown minute', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no' })
  on('fs.write', async () => ({ value: undefined }))
  const redraws: number[] = []
  onInvalidate = () => redraws.push((clock.now() - 1_000_000) / 1000)
  // The request starts at 0s and the turn ends 20s later: the next ping is due
  // at 50m, so the countdown changes on whole minutes from 0s.
  on('turn.step', async function* () {
    await clock.advance(20_000)
    return {
      turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
    }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
  redraws.length = 0
  await clock.advance(6 * MIN)
  expect(redraws).toEqual([60, 120, 180, 240, 300, 320, 360])
})

test('SHOW_ABOVE_PROMPT_PERMANENTLY=yes shows the band during and right after a turn', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no', CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT_PERMANENTLY: 'yes' })
  on('fs.write', async () => ({ value: undefined }))
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
    }
  })
  const props = { hasSurvey: false, isWorking: false, maxRows: 3 } as never
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
  const after = await $.ui.mount({ plugin: 'session-heating', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await after.find({ text: ' session warm for 12h 40m' })).not.toBe(undefined)
  expect(await after.find({ text: 'ping in 50m' })).not.toBe(undefined)
  await after.unmount()

  await $.turn.start({ text: 'again', turnId: 't2' })
  const during = await $.ui.mount({ plugin: 'session-heating', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await during.find({ text: ' session warm' })).not.toBe(undefined)
  expect(await during.find({ text: /ping/ })).toBe(undefined)
})

test('ABOVE_PROMPT_SHOW_OFF=no draws no band while heating is off', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE: 'no', CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_SHOW_OFF: 'no' })
  on('fs.write', async () => ({ value: undefined }))
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
    }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
  await $.command.run({ command: 'session-heating', args: 'off', origin: { kind: 'composer' } } as never)
  await clock.advance(6 * MIN)
  const props = { hasSurvey: false, isWorking: false, maxRows: 3 } as never
  const away = await $.ui.mount({ plugin: 'session-heating', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await away.find({ text: /session/ })).toBe(undefined)
  expect(await away.find({ text: '◌' })).toBe(undefined)
})

test('warns when idleCompaction is not false', async ($, on) => {
  idle = undefined
  toasts.length = 0
  engine(on)
  mock.env(on, { HOME: '/nowhere' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(toasts.some(t => t.includes('"idleCompaction": false'))).toBe(true)

  idle = false
  toasts.length = 0
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(toasts.length).toBe(0)
})

for (const [battery, argv] of [['no', ['caffeinate', '-s']], ['yes', ['caffeinate', '-i', '-s']]] as const) {
  test(`caffeinate flags with ALSO_ON_BATTERY=${battery}`, async ($, on) => {
    engine(on)
    mock.clock(on, { now: 1_000_000 })
    mock.env(on, { HOME: '/nowhere', CLAUDE_CODE_SESSION_HEATING_CAFFEINATE_ALSO_ON_BATTERY: battery })
    on('fs.write', async () => ({ value: undefined }))
    const spawned: (readonly string[])[] = []
    on('process.spawn', async function* (_$, e) {
      spawned.push(e.argv)
      return { value: { code: 0, signal: null } }
    })
    on('turn.step', async function* () {
      return {
        turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn',
        usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
      }
    })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) {
      // drain
    }
    await $.turn.complete({ turnId: 't1', answer: 'hi', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(spawned).toEqual([argv])
  })
}
