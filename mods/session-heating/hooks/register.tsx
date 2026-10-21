import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ColdReason, HeatState, HeatView } from '../types'

// Session Heating keeps the session's prompt cache warm while you're away.
//
// The main conversation's cache lives one hour from the start of the last
// request that wrote or read it. After each main-thread turn, a ping forks
// the session (the same request /btw makes: the session's own prefix plus one
// tool-less question, never added to the transcript) shortly before that hour
// runs out, and each ping that reads the cache restarts the hour. A ping that
// reads less than HIT_RATIO of the last turn's cached prefix means the cache
// was already gone: heating stops instead of paying to rebuild it.
//
// Requires "idleCompaction": false in settings.json. Idle compaction compacts
// an idle session shortly before its cache expires, replacing the transcript
// with a summary: the prefix the pings keep warm would never be read again.
// Threshold auto-compaction is a separate setting and keeps working.
// session.start checks the merged settings and toasts when this is missing.

const MINUTE = 60_000
const TTL_MS = 60 * MINUTE
// The band shows only while you're away: hidden during a main-thread turn and
// for AWAY_MS after it ends. While away it redraws the moment a countdown
// shows a new minute, so its countdowns stay current.
const AWAY_MS = 5 * MINUTE
const RETRY_MS = 2 * MINUTE
const HIT_RATIO = 0.9
const PING_PROMPT = 'Reply with exactly: ok'

const isEnabled = atom({ plugin: 'session-heating', key: 'isEnabled' } as const, true)
const view = atom({ plugin: 'session-heating', key: 'view' } as const, {
  state: 'off',
  nextPingAt: 0,
  warmUntil: 0,
  lapsedAt: 0,
  reason: null,
} as HeatView)

// The statusline's 256-color codes as hex: RED 167, SKY 45, GREY 242.
const COLOR: Record<HeatState, string> = { hot: '#d75f5f', cold: '#00d7ff', off: '#6c6c6c' }
const UNICODE: Record<HeatState, string> = { hot: '♨', cold: '❆', off: '◌' }
// md-radiator, md-snowflake, md-radiator_off
const NERD: Record<HeatState, string> = { hot: '󰐸', cold: '󰜗', off: '󰫘' }

type Config = {
  intervalMs: number
  capHours: number
  caffeinate: boolean
  caffeinateOnBattery: boolean
  nerdFont: boolean
  showBand: boolean
  compact: boolean
  showOff: boolean
  relativeTime: boolean
  clock24h: boolean
  showToast: boolean
}

const DEFAULT_CONFIG: Config = {
  intervalMs: 50 * MINUTE,
  capHours: 12,
  caffeinate: true,
  caffeinateOnBattery: false,
  nerdFont: false,
  showBand: true,
  compact: false,
  showOff: true,
  relativeTime: true,
  clock24h: true,
  showToast: true,
}

// What one session's heating knows; register() makes one per module load.
type Heat = {
  config: Config
  // A person is at the session: the REPL, or a terminal or desktop surface
  // attached. -p and SDK runs that never attach a surface never heat.
  isEligible: boolean
  isBusy: boolean
  // End of the last main-thread turn: the start of "away" for the band and cap.
  doneAt: number
  // Start of the last request that read or wrote the main cache.
  anchorAt: number
  // How much of the last main-thread request the cache held.
  prefixTokens: number
  pingTimer: Timer | null
  tickTimer: Timer | null
  caffeine: AsyncGenerator<unknown, unknown> | null
}

// A switch takes 1/yes or 0/no; unset keeps the default, anything else warns.
function flag(name: string, value: string | undefined, fallback: boolean, problems: string[]) {
  if (value === undefined || value === '') return fallback
  if (value === '1' || value === 'yes') return true
  if (value === '0' || value === 'no') return false
  problems.push(`${name}=${value} is not yes/no, using ${fallback ? 'yes' : 'no'}`)

  return fallback
}

// A whole number outside min–max is clamped to the nearest limit; anything
// that isn't a whole number falls back to the default. Both warn.
function whole(name: string, value: string | undefined, fallback: number, min: number, max: number, problems: string[]) {
  if (value === undefined || value === '') return fallback
  if (!/^-?\d+$/.test(value.trim())) {
    problems.push(`${name}=${value} is not a whole number, using ${fallback}`)

    return fallback
  }
  const number = Number(value)
  const clamped = Math.min(max, Math.max(min, number))
  if (clamped !== number) problems.push(`${name}=${value} is out of range ${min}–${max}, using ${clamped}`)

  return clamped
}

async function loadConfig($: EngineInterface, problems: string[]): Promise<Config> {
  const minutes = await $.env.get('CLAUDE_CODE_SESSION_HEATING_MINUTES')
  const hours = await $.env.get('CLAUDE_CODE_SESSION_HEATING_HOURS_CAP')
  const caffeinate = await $.env.get('CLAUDE_CODE_SESSION_HEATING_CAFFEINATE')
  const caffeinateOnBattery = await $.env.get('CLAUDE_CODE_SESSION_HEATING_CAFFEINATE_ALSO_ON_BATTERY')
  const nerdFont = await $.env.get('CLAUDE_CODE_SESSION_HEATING_NERD_FONT')
  const showBand = await $.env.get('CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT')
  const compact = await $.env.get('CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_COMPACT')
  const showOff = await $.env.get('CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_SHOW_OFF')
  const relativeTime = await $.env.get('CLAUDE_CODE_SESSION_HEATING_RELATIVE_TIME')
  const clock24h = await $.env.get('CLAUDE_CODE_SESSION_HEATING_24H_CLOCK')
  const showToast = await $.env.get('CLAUDE_CODE_SESSION_HEATING_SHOW_TOAST')

  return {
    intervalMs: whole('CLAUDE_CODE_SESSION_HEATING_MINUTES', minutes, 50, 29, 59, problems) * MINUTE,
    capHours: whole('CLAUDE_CODE_SESSION_HEATING_HOURS_CAP', hours, 12, 1, 32, problems),
    caffeinate: flag('CLAUDE_CODE_SESSION_HEATING_CAFFEINATE', caffeinate, true, problems),
    caffeinateOnBattery: flag(
      'CLAUDE_CODE_SESSION_HEATING_CAFFEINATE_ALSO_ON_BATTERY',
      caffeinateOnBattery,
      false,
      problems,
    ),
    nerdFont: flag('CLAUDE_CODE_SESSION_HEATING_NERD_FONT', nerdFont, false, problems),
    showBand: flag('CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT', showBand, true, problems),
    compact: flag('CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_COMPACT', compact, false, problems),
    showOff: flag('CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_SHOW_OFF', showOff, true, problems),
    relativeTime: flag('CLAUDE_CODE_SESSION_HEATING_RELATIVE_TIME', relativeTime, true, problems),
    clock24h: flag('CLAUDE_CODE_SESSION_HEATING_24H_CLOCK', clock24h, true, problems),
    showToast: flag('CLAUDE_CODE_SESSION_HEATING_SHOW_TOAST', showToast, true, problems),
  }
}

// A clock time: "14:52", or "2:52pm" with the 24-hour clock off.
function clockTime(heat: Heat, ms: number) {
  const date = new Date(ms)
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  if (!heat.config.clock24h) return `${hours % 12 || 12}:${minutes}${hours < 12 ? 'am' : 'pm'}`

  return `${String(hours).padStart(2, '0')}:${minutes}`
}

// A span as the band shows it: "45m", "2h 5m", "<1m".
function span(ms: number) {
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`

  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`
}

// Time left until a moment, rounded up so the count reaches "<1m" only in the
// last minute.
function until(at: number, now: number) {
  return at - now < MINUTE ? '<1m' : span(Math.ceil((at - now) / MINUTE) * MINUTE)
}

function capMs(heat: Heat) {
  return heat.config.capHours * 60 * MINUTE
}

function toast($: EngineInterface, heat: Heat, text: string) {
  if (heat.config.showToast) $.ui.toast(`Session Heating: ${text}`)
}

// The band reads the atom; the statusline reads the state file.
async function writeStateFile($: EngineInterface, sessionId: string, state: HeatState) {
  const home = await $.env.get('HOME')
  if (home) await $.fs.write(`${home}/.claude/session-heating/${sessionId}.json`, `${JSON.stringify({ state })}\n`)
}

async function setView($: EngineInterface, heat: Heat, next: HeatView) {
  await update($, view, () => next)
  await writeStateFile($, await $.session.id(), next.state)
  await redrawLater($, heat)
}

// Redraws the band when the away delay ends and each time its countdown
// shows a new minute: a countdown to `at` changes whenever the time left
// crosses a whole minute.
async function redrawLater($: EngineInterface, heat: Heat) {
  heat.tickTimer?.cancel()
  heat.tickTimer = null
  if (heat.isBusy || heat.doneAt === 0) return
  const now = await $.clock.now()
  const v = await read($, view)
  const at = v.state === 'hot' ? v.nextPingAt || v.warmUntil : v.state === 'cold' ? v.lapsedAt : 0
  let wait = at ? (((at - now) % MINUTE) + MINUTE) % MINUTE || MINUTE : Infinity
  if (now < heat.doneAt + AWAY_MS) wait = Math.min(wait, heat.doneAt + AWAY_MS - now)
  if (wait === Infinity) return
  heat.tickTimer = $.clock.after(wait, () => {
    $.ui.invalidate('ui.render')
    void redrawLater($, heat).catch(() => {})
  })
}

function cancelPing(heat: Heat) {
  heat.pingTimer?.cancel()
  heat.pingTimer = null
}

// caffeinate -s holds off system sleep on AC power only; -i adds idle sleep on
// any power source, battery included. Ending the loop kills it.
function startCaffeine($: EngineInterface, heat: Heat) {
  if (heat.caffeine || !heat.config.caffeinate) return
  const child = $.process.spawn({
    argv: heat.config.caffeinateOnBattery ? ['caffeinate', '-i', '-s'] : ['caffeinate', '-s'],
  }) as AsyncGenerator<unknown, unknown>
  heat.caffeine = child
  void (async () => {
    try {
      for await (const _ of child) {
        // caffeinate writes nothing; the loop only keeps it alive.
      }
    } catch {
      // No caffeinate on this machine: heating goes on without it.
    } finally {
      if (heat.caffeine === child) heat.caffeine = null
    }
  })()
}

function stopCaffeine(heat: Heat) {
  const child = heat.caffeine
  heat.caffeine = null
  void child?.return(undefined)
}

async function goCold($: EngineInterface, heat: Heat, reason: ColdReason | null, lapsedAt: number) {
  cancelPing(heat)
  stopCaffeine(heat)
  await setView($, heat, { ...(await read($, view)), state: 'cold', nextPingAt: 0, lapsedAt, reason })
  if (reason === 'miss') toast($, heat, 'the cache was already gone, heating stopped')
  if (reason === 'slept') toast($, heat, 'the machine slept past the cache lifetime, heating stopped')
}

// No more pings, but the cache stays warm until an hour after its last read:
// the band stays hot, naming why, and goes cold when the cache lapses.
async function stopHeating($: EngineInterface, heat: Heat, reason: 'cap' | 'error') {
  cancelPing(heat)
  stopCaffeine(heat)
  if (reason === 'cap') toast($, heat, `reached the ${heat.config.capHours}h cap, heating stopped`)
  if (reason === 'error') toast($, heat, 'pings failed, heating stopped')
  const lapsesAt = heat.anchorAt + TTL_MS
  const now = await $.clock.now()
  if (now >= lapsesAt) return goCold($, heat, reason, lapsesAt)
  heat.pingTimer = $.clock.after(lapsesAt - now, () => {
    void goCold($, heat, reason, lapsesAt).catch(() => {})
  })
  await setView($, heat, { state: 'hot', nextPingAt: 0, warmUntil: lapsesAt, lapsedAt: 0, reason })
}

// When the cache lapses if every ping until the hours cap reads it: an hour
// after the last ping due before the cap, or after the current anchor when
// none is.
function warmUntil(heat: Heat, nextPingAt: number) {
  const interval = heat.config.intervalMs
  const later = Math.max(0, Math.ceil((heat.doneAt + capMs(heat) - nextPingAt) / interval))

  return nextPingAt + (later - 1) * interval + TTL_MS
}

async function schedule($: EngineInterface, heat: Heat, at: number) {
  if (at - heat.doneAt >= capMs(heat)) return stopHeating($, heat, 'cap')
  cancelPing(heat)
  const now = await $.clock.now()
  pingLater($, heat, Math.max(0, at - now))
  await setView($, heat, {
    state: 'hot',
    nextPingAt: at,
    warmUntil: warmUntil(heat, at),
    lapsedAt: 0,
    reason: null,
  })
}

async function ping($: EngineInterface, heat: Heat) {
  heat.pingTimer = null
  if (heat.isBusy || !(await read($, isEnabled))) return
  const startedAt = await $.clock.now()
  // Timers don't run while the machine sleeps: a ping due during sleep fires
  // after wake, and past the TTL it would only pay to rebuild the cache.
  if (startedAt - heat.anchorAt >= TTL_MS) return goCold($, heat, 'slept', heat.anchorAt + TTL_MS)
  if (startedAt - heat.doneAt >= capMs(heat)) return stopHeating($, heat, 'cap')

  const reply = await $.model.fork({ prompt: PING_PROMPT })
  // A turn started meanwhile: it refreshes the cache and re-arms heating.
  if (heat.isBusy) return
  if (!reply.isAnswered) {
    // After /clear there is no conversation, so nothing to keep warm.
    if (reply.reason === 'nothing-to-fork') return goCold($, heat, null, 0)
    if (startedAt + 2 * RETRY_MS < heat.anchorAt + TTL_MS) {
      pingLater($, heat, RETRY_MS)

      return
    }

    return stopHeating($, heat, 'error')
  }
  if (heat.prefixTokens > 0 && reply.usage.cache_read_input_tokens < heat.prefixTokens * HIT_RATIO) {
    return goCold($, heat, 'miss', startedAt)
  }
  heat.anchorAt = startedAt
  await schedule($, heat, heat.anchorAt + heat.config.intervalMs)
}

// Runs a ping from a timer: a ping that throws (a refused request, a failed
// write) stops heating instead of leaving an unhandled rejection behind.
function pingLater($: EngineInterface, heat: Heat, ms: number) {
  heat.pingTimer = $.clock.after(ms, () => {
    void ping($, heat).catch(() => stopHeating($, heat, 'error').catch(() => {}))
  })
}

// Arms heating after a turn, or after /session-heating on.
async function arm($: EngineInterface, heat: Heat) {
  if (!heat.isEligible || heat.anchorAt === 0 || !(await read($, isEnabled))) return
  if ((await $.clock.now()) - heat.anchorAt >= TTL_MS) return goCold($, heat, 'slept', heat.anchorAt + TTL_MS)
  startCaffeine($, heat)
  await schedule($, heat, heat.anchorAt + heat.config.intervalMs)
}

export const register: Register = on => {
  const heat: Heat = {
    config: DEFAULT_CONFIG,
    isEligible: false,
    isBusy: false,
    doneAt: 0,
    anchorAt: 0,
    prefixTokens: 0,
    pingTimer: null,
    tickTimer: null,
    caffeine: null,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const problems: string[] = []
    heat.config = await loadConfig($, problems)
    heat.isEligible = heat.isEligible || e.isInteractive || e.surface !== null
    await $.command.register({
      name: 'session-heating',
      description: 'Turn Session Heating on or off for this session',
      argumentHint: '[on|off]',
    })
    for (const problem of problems) toast($, heat, problem)
    // Idle compaction replaces the transcript shortly before the cache would
    // expire, so the prefix heating keeps warm would never be read again.
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (heat.isEligible && settings.idleCompaction !== false) {
      toast($, heat, 'set "idleCompaction": false in settings.json, or idle compaction discards the warm cache')
    }

    return started
  })

  on('session.attach', ($, e, next) => {
    if (e.surface === 'terminal' || e.surface === 'desktop') heat.isEligible = true

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (!e.agentId) {
      heat.isBusy = true
      cancelPing(heat)
      stopCaffeine(heat)
      heat.tickTimer?.cancel()
      heat.tickTimer = null
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  // Times each main-thread request from its start, as the cache TTL counts.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    if (result.usage) {
      heat.anchorAt = startedAt
      heat.prefixTokens = result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (!e.agentId) {
      heat.isBusy = false
      heat.doneAt = await $.clock.now()
      await arm($, heat)
      await redrawLater($, heat)
    }

    return completed
  })

  on('session.end', async ($, e, next) => {
    cancelPing(heat)
    stopCaffeine(heat)
    heat.tickTimer?.cancel()
    heat.tickTimer = null
    await writeStateFile($, e.sessionId, 'off')
    // After /clear the process goes on under a new session with no cache yet.
    heat.anchorAt = 0
    heat.prefixTokens = 0
    heat.doneAt = 0

    return next(e)
  })

  on('command.run', { command: 'session-heating' }, async ($, e) => {
    const arg = e.args.trim()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isEnabled))
    await update($, isEnabled, () => isOn)
    if (!isOn) {
      cancelPing(heat)
      stopCaffeine(heat)
      await setView($, heat, { ...(await read($, view)), state: 'off', nextPingAt: 0 })

      return { text: 'Session Heating is off for this session.' }
    }
    if (!heat.isBusy) await arm($, heat)
    // Nothing to keep warm yet (no turn since start or reload): show it as on;
    // the next turn arms it.
    const current = await read($, view)
    if (current.state === 'off') await setView($, heat, { ...current, state: 'hot', nextPingAt: 0, warmUntil: 0, reason: null })

    return { text: 'Session Heating is on for this session.' }
  }).catch(() => ({ text: 'Session Heating could not change its state.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!heat.config.showBand || !heat.isEligible || e.props.hasSurvey || heat.isBusy || heat.doneAt === 0) return next(e)
    const now = await $.clock.now()
    if (now - heat.doneAt < AWAY_MS) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    if (v.state === 'off' && !heat.config.showOff) return next(e)
    const icon = (e.surface === 'terminal' && heat.config.nerdFont ? NERD : UNICODE)[v.state]
    const why: Record<ColdReason, string> = {
      miss: 'cache miss',
      slept: 'machine slept',
      cap: 'pings capped',
      error: 'pings failed',
    }
    const rel = heat.config.relativeTime
    const ping = rel ? `ping in ${until(v.nextPingAt, now)}` : `ping at ${clockTime(heat, v.nextPingAt)}`
    // ~ once pings have stopped: the cache is not documented to live the full hour.
    const about = v.reason ? '~' : ''
    const warm = rel ? `for ${about}${until(v.warmUntil, now)}` : `until ${about}${clockTime(heat, v.warmUntil)}`
    const cold = rel ? `for ${span(now - v.lapsedAt)}` : `since ${clockTime(heat, v.lapsedAt)}`

    const full: Record<HeatState, string> = {
      hot: v.warmUntil ? `session warm ${warm}` : 'session warm',
      cold: v.lapsedAt ? `session cold ${cold}` : 'session cold',
      off: 'session heating off',
    }
    const compact: Record<HeatState, string> = {
      hot: v.warmUntil ? `warm ${warm}` : 'warm',
      cold: v.lapsedAt ? `cold ${cold}` : 'cold',
      off: 'off',
    }
    // The full band's right end. Reaching the cap is how heating ends: the
    // cold band doesn't repeat it.
    const detail: Record<HeatState, string> = {
      hot: v.nextPingAt ? ping : v.reason ? why[v.reason] : '',
      cold: v.reason && v.reason !== 'cap' ? why[v.reason] : '',
      off: '',
    }
    const text = (heat.config.compact ? compact : full)[v.state]
    const right = heat.config.compact ? '' : detail[v.state]

    return (
      // One blank row above: the recap row above the band has no margin below it.
      <Box marginTop={1} width={e.props.bodyColumns} justifyContent="space-between">
        <Box>
          <Text color={COLOR[v.state]}>{icon}</Text>
          <Text dimColor> {text}</Text>
        </Box>
        {right && <Text dimColor>{right}</Text>}
      </Box>
    )
  })
}
