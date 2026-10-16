export type Meter = { kind: string; percent: number; resetsAt?: string }
export type Snapshot = { context?: number; meters: Meter[] }
/** kind → "<threshold>@<resetsAt>" of the last toast, so a window warns once per reset */
export type Warned = Record<string, string>
/** why work is held: the window that crossed the threshold; `auto` when a reset timer will continue it */
export type Pause = { kind: string; percent: number; pauseAt: number; resetsAt?: string; auto: boolean }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Snapshot | null
      warned: Warned
      isHidden: boolean
      paused: Pause | null
      /** resetsAt of the window last resumed, so a stale reading of it never pauses again */
      lastResumed: string
    }
  }
}
