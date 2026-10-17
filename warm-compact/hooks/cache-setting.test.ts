import { expect, test } from 'claude-code/testing'

import { configuredTtl } from './cache-setting'

test('configuredTtl follows Claude Code: the 5-minute switch, then the variable, then the setting', () => {
  expect(configuredTtl(undefined, undefined, undefined)).toBe(null)
  expect(configuredTtl(undefined, undefined, '1h')).toBe('1h')
  expect(configuredTtl(undefined, undefined, '5m')).toBe('5m')
  expect(configuredTtl(undefined, '5m', '1h')).toBe('5m')
  expect(configuredTtl('1', '1h', '1h')).toBe('5m')
  expect(configuredTtl('true', undefined, undefined)).toBe('5m')
  expect(configuredTtl('0', undefined, '1h')).toBe('1h')
  expect(configuredTtl('', 'soon', 'forever')).toBe(null)
})
