import { describe, expect, it } from 'vitest'
import { mergeAllowedHosts, normalizeAllowedHost, parseAllowedHostList } from './sandbox-hosts'

describe('normalizeAllowedHost', () => {
  it('trims and lowercases a bare host', () => {
    expect(normalizeAllowedHost('  GitHub.com ')).toBe('github.com')
  })

  it('extracts the hostname from a pasted URL', () => {
    expect(normalizeAllowedHost('https://GitHub.com/foo/bar?x=1')).toBe('github.com')
  })

  it('drops a port and path from a bare entry', () => {
    expect(normalizeAllowedHost('example.com:8080/api')).toBe('example.com')
  })

  it('drops trailing dots', () => {
    expect(normalizeAllowedHost('example.com.')).toBe('example.com')
  })

  it('rejects blanks, spaces and junk', () => {
    expect(normalizeAllowedHost('   ')).toBeNull()
    expect(normalizeAllowedHost('has space.com')).toBeNull()
    expect(normalizeAllowedHost('http://')).toBeNull()
  })
})

describe('parseAllowedHostList', () => {
  it('normalizes, dedupes and preserves order', () => {
    expect(parseAllowedHostList(['B.com', 'a.com', 'b.com'])).toEqual(['b.com', 'a.com'])
  })

  it('accepts a newline / comma separated string', () => {
    expect(parseAllowedHostList('a.com\nb.com,c.com')).toEqual(['a.com', 'b.com', 'c.com'])
  })

  it('ignores non-strings and bad entries', () => {
    expect(parseAllowedHostList([42, 'ok.com', null, '  '])).toEqual(['ok.com'])
  })

  it('returns [] for undefined / non-list values', () => {
    expect(parseAllowedHostList(undefined)).toEqual([])
    expect(parseAllowedHostList({ nope: true })).toEqual([])
  })
})

describe('mergeAllowedHosts', () => {
  it('keeps defaults first and dedupes extras against them', () => {
    expect(
      mergeAllowedHosts(['api.openai.com', 'registry.npmjs.org'], ['Registry.NPMJS.org', 'github.com']),
    ).toEqual(['api.openai.com', 'registry.npmjs.org', 'github.com'])
  })
})
