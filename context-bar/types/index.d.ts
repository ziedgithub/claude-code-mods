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

// The agent whose transcript the person opened from the tasks list. `label`: its type, or a
// teammate's name
export type AgentView = { id: string; label: string }
// What a subagent's own requests told: the model and effort its last one named, and the input
// tokens it was answered over (null until its first response) against `window`
export type AgentStats = { model: string; effort: string | null; tokens: number | null; window: number }
// One row of the card over the bar: what fills the window, by category as /context lists it,
// in tokens and in percent of the window. `color`: the theme key /context draws it in
export type ContextRow = { name: string; tokens: number; percent: number; color: string; kind: 'used' | 'free' | 'buffer' }

// warm-compact's own, read while it is loaded and never written: the TTLs as it learned them,
// and what the pause holds if the person stays away. As its contract declares them
export type LearnedTtl = { cache: CacheTtl; renew: CacheTtl | null }
export type Upcoming = { kind: 'compact' | 'renew'; at: number; expiresAt: number }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      fill: ContextFill | null
      model: ModelInfo | null
      asking: Question | null
      cache: CacheInfo | null
      viewing: AgentView | null
      agents: StateFamily<AgentStats | null>
      // What fills the window as the engine last counted it, null before its first count
      breakdown: ContextRow[] | null
    }
    'warm-compact': {
      ttl: LearnedTtl | null
      upcoming: Upcoming | null
    }
  }
}
