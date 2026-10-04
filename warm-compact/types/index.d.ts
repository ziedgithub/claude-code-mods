export type CacheTtl = '5m' | '1h'
// The last main-thread request, which renewed the cache entry the next prompt would read.
// `at`: when it was made, null once a compaction or a /clear changed the prefix.
// `model`: the session's model then, the one the entry belongs to
export type LastRequest = { at: number | null; model: string }
// The renewals keep warm made since the last request: the latest's start, and how many
export type Kept = { at: number; count: number }

// What a compaction's own request was answered over, as the API reports it
export type CompactionUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// One compaction or cache renewal warm-compact made, kept across sessions to tally what
// they saved. `kind`: absent for a compaction.
// `before`, `after`: the conversation's size in tokens either side of a compaction, or the
// size a renewal read (`after` 0).
// `usage`: its request's, when the engine reported one.
// `isReturned`: whether the session went on afterwards with what it kept, which is when the
// re-read it spared would have been paid
export type CompactionRecord = {
  kind?: 'renewal'
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
      // Whether it renews the cache in compaction's place: the footer's second chip and
      // /keep-warm flip it
      isKeepWarm: boolean
      kept: Kept | null
      // When this session's latest compaction or renewal ran, until the session goes on
      pendingRecord: number | null
    }
  }
}
