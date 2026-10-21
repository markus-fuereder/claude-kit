export type HeatState = 'hot' | 'cold' | 'off'

/** Why heating stopped and the cache is left to lapse. */
export type ColdReason = 'miss' | 'slept' | 'cap' | 'error'

/** What the band and the statusline state file show. */
export type HeatView = {
  state: HeatState
  /** When the next ping is due, in $.clock.now() milliseconds; 0 when none. */
  nextPingAt: number
  /** When the cache lapses if every ping until the hours cap reads it. */
  warmUntil: number
  /** When the cache lapsed, for the cold state. */
  lapsedAt: number
  /** Why heating stopped: while hot after the cap or failed pings, then cold. */
  reason: ColdReason | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-heating': { isEnabled: boolean; view: HeatView }
  }
}
