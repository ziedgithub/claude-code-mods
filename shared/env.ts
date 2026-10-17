// The master copy, kept at the repository's root: each mod that uses it holds a copy under
// hooks/shared/, as a mod loads and installs on its own. Edit it here, then run
// scripts/sync-shared.sh

// KEY=value lines as the shell sources them: comments, blank lines and `export` skipped, one
// pair of surrounding quotes taken off
export const parseEnv = (text: string): Record<string, string> => {
  const vars: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const [, key, rest] = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim().replace(/^export\s+/, '')) ?? []
    if (key === undefined) continue
    const value = (rest ?? '').trim()
    vars[key] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
  }
  return vars
}
