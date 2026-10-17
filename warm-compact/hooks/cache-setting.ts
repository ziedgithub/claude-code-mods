// Claude Code picks how long the main conversation stays cached: an hour on a Claude
// subscription within its limits, five minutes otherwise. Someone can pick for it, and what they
// pick wins, in this order: FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, then
// `promptCacheTtl` in the settings. Five minutes, kept alive by Claude Code's own touches, holds
// the conversation for its requests, but its compactions read none of it

import type { CacheTtl } from '../types'

export const TTL_SETTING = 'promptCacheTtl'

export const FIVE_MINUTES_TEXT = `Warm compact: Claude Code is set to cache the conversation for 5 minutes, which compactions can't read from, so it stands down.`

// Said with a stand-down when the choice was left to Claude Code
export const HINT_TEXT = `"${TTL_SETTING}": "1h" in your settings can fix this`

// As Claude Code reads a boolean variable
const isSet = (value: string | undefined): boolean => value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())

// The TTL picked for Claude Code, or null when it is left to choose
export const configuredTtl = (force5m: string | undefined, envTtl: string | undefined, setting: unknown): CacheTtl | null => {
  if (isSet(force5m)) return '5m'
  if (envTtl === '5m' || envTtl === '1h') return envTtl
  return setting === '5m' || setting === '1h' ? setting : null
}
