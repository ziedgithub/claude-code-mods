export type CacheTtl = '5m' | '1h'
// The last main-thread request, which renewed the cache entry the next prompt would read.
// `at`: when it was made, null once a compaction or a /clear changed the prefix.
// `model`: the session's model then, the one the entry belongs to
export type LastRequest = { at: number | null; model: string }

// What a compaction's own request was answered over, as the API reports it
export type CompactionUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// One compaction warm-compact made, kept across sessions to tally what they saved.
// `before`, `after`: the conversation's size in tokens either side of it.
// `usage`: its request's, when the engine reported one.
// `isReturned`: whether the session went on afterwards, which is when the re-read it
// spared would have been paid
export type CompactionRecord = {
  at: number
  sessionId: string
  model: string
  ttl: CacheTtl
  before: number
  after: number
  usage: CompactionUsage | null
  isReturned: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'warm-compact': {
      last: LastRequest | null
      isTurnRunning: boolean
      // Whether it compacts at all in this session: the footer chip and /warm-compact flip it
      isEnabled: boolean
      // When this session's latest compaction ran, until the session goes on after it
      pendingCompaction: number | null
    }
  }
}
