export type Meter = { kind: string; percent: number; resetsAt?: string }
export type Snapshot = { context?: number; meters: Meter[] }
/** kind → "<threshold>@<resetsAt>" of the last toast, so a window warns once per reset */
export type Warned = Record<string, string>
/** why work is held: the window that crossed the threshold; `auto` when a reset timer will continue it */
export type Pause = { kind: string; percent: number; pauseAt: number; resetsAt?: string; auto: boolean }
/** readings of one window, `[ms, percent]`, kept while its resetsAt holds; feeds the burn-rate forecast */
export type Trail = { resetsAt: string; samples: [number, number][] }
/** how the band is drawn, kept in the store so it holds across sessions */
export type Look = { theme: 'mono' | 'classic'; accent: string; compact: boolean }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Snapshot | null
      warned: Warned
      isHidden: boolean
      paused: Pause | null
      /** resetsAt of the window last resumed, so a stale reading of it never pauses again */
      lastResumed: string
      /** kind → its readings in the current window */
      trails: Record<string, Trail>
      /** the store's look, mirrored here so a change redraws the band */
      look: Look
    }
  }
}
