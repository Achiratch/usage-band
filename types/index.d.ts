export type Meter = { kind: string; percent: number; resetsAt?: string }
export type Snapshot = { context?: number; meters: Meter[] }
/** kind → "<threshold>@<resetsAt>" of the last toast, so a window warns once per reset */
export type Warned = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snapshot: Snapshot | null; warned: Warned; isHidden: boolean }
  }
}
