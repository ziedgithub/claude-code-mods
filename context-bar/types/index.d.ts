// `isEstimate`: the engine's own estimate, as /context makes it, while no response has measured
// the window yet: in a fresh or cleared session, or just after a compaction
export type ContextFill = { percent: number; tokens: number; window: number; isEstimate: boolean }
export type ContextAction = 'compact' | 'clear'
export type Setting = 'model' | 'effort'
// What the footer asks in place of its blocks: to confirm an action, or to pick a setting
export type Question = ContextAction | Setting
// `isEffortPinned`: `/effort` set the level, which then holds for the session across models
export type ModelInfo = { name: string; effort: string | null; isEffortKnown: boolean; isEffortPinned: boolean }

export type CacheTtl = '5m' | '1h'
// `hitPercent`: what the cache served of the first request after the last message.
// `requestAt`: the last main-thread request, null once a compaction changed the prefix.
// `model`: the session's model then, the one the cache entry belongs to.
// `isFork`: that request was a plugin's fork of the conversation (keep warm's renewal), whose
// entry may not last as long as one a request of the conversation leaves
export type CacheInfo = { hitPercent: number; requestAt: number | null; model: string; isFork?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      fill: ContextFill | null
      model: ModelInfo | null
      asking: Question | null
      cache: CacheInfo | null
    }
  }
}
