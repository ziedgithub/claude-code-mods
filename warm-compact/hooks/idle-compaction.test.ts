import { expect, test } from 'claude-code/testing'

import { settingsPath, withIdleCompactionOff } from './idle-compaction'

test('the user settings are under CLAUDE_CONFIG_DIR, or else ~/.claude', () => {
  expect(settingsPath(undefined, '/home/me')).toBe('/home/me/.claude/settings.json')
  expect(settingsPath('', '/home/me')).toBe('/home/me/.claude/settings.json')
  expect(settingsPath('/etc/claude/', '/home/me')).toBe('/etc/claude/settings.json')
})

test('the switch is added off, the other settings kept in their order', () => {
  expect(withIdleCompactionOff('{"model":"opus","idleCompaction":true}')).toBe('{\n  "model": "opus",\n  "idleCompaction": false\n}\n')
  expect(withIdleCompactionOff('{}')).toBe('{\n  "idleCompaction": false\n}\n')
})

test('a file already off, or not a JSON object, is left alone', () => {
  expect(withIdleCompactionOff('{"idleCompaction":false}')).toBe(null)
  expect(withIdleCompactionOff('{ "model": ')).toBe(null)
  expect(withIdleCompactionOff('[]')).toBe(null)
})
