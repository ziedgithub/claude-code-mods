export type CacheTtl = '5m' | '1h'
// The last main-thread request, which renewed the cache entry the next prompt would read.
// `at`: when it was made, null once a compaction or a /clear changed the prefix.
// `model`: the session's model then, the one the entry belongs to
export type LastRequest = { at: number | null; model: string }

declare module 'claude-code' {
  interface PluginState {
    'warm-compact': {
      last: LastRequest | null
      isTurnRunning: boolean
      // Whether it compacts at all in this session: the footer chip and /warm-compact flip it
      isEnabled: boolean
    }
  }
}
