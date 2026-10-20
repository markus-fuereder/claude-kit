export type HeatState = 'hot' | 'cold' | 'off'

/** Why heating stopped and the cache is left to lapse. */
export type ColdReason = 'miss' | 'slept' | 'cap' | 'error'

/** What the band and the statusline state file show. */
export type HeatView = {
  state: HeatState
  /** When the next ping is due, in $.clock.now() milliseconds; 0 when none. */
  nextPingAt: number
  pings: number
  maxPings: number
  /** When the hours cap ends heating. */
  until: number
  /** When the cache lapsed or will lapse, for the cold state. */
  lapsedAt: number
  reason: ColdReason | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-heating': { isEnabled: boolean; view: HeatView }
  }
}
