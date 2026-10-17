// Claude Code compacts an idle session on its own too, about 54 minutes into an hour-long
// cache. It arms once per request of the main conversation, and a renewal is a fork, which
// does not count as one: it would compact whatever keep warm did, and before warm compact's
// own turn. Its one switch is `idleCompaction` in the settings, absent meaning on, so the mod
// turns it off in the user's settings while it is installed

export const SETTING = 'idleCompaction'

export const OFF_TEXT = `warm-compact turned off Claude Code's own idle compaction ("${SETTING}": false in your user settings), so the two never compact the same pause.`

// The user settings file, where the engine keeps them: under CLAUDE_CONFIG_DIR, or ~/.claude
export const settingsPath = (configDir: string | undefined, home: string): string =>
  `${configDir !== undefined && configDir !== '' ? configDir.replace(/\/+$/, '') : `${home}/.claude`}/settings.json`

// The settings file with the switch off, or null when it already is, or when the file is not a
// JSON object, which is left as it stands rather than rewritten
export const withIdleCompactionOff = (text: string): string | null => {
  let settings: unknown
  try {
    settings = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  if ((settings as Record<string, unknown>)[SETTING] === false) return null
  return `${JSON.stringify({ ...settings, [SETTING]: false }, null, 2)}\n`
}
