import { describe, expect, it } from 'vitest'
import { accountsOffRate } from './usd-rate'

describe('accountsOffRate', () => {
  const accounts = [
    { id: 'a', usd_rate: '130.0000' },
    { id: 'b', usd_rate: 131 },
    { id: 'c', usd_rate: '134.0000' },
    { id: 'd', usd_rate: '0.0000' },
    { id: 'e', usd_rate: null },
  ]

  it('picks the accounts with their own, different rate', () => {
    expect(accountsOffRate(accounts, '134').map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('leaves unset accounts alone — they already follow the client', () => {
    expect(accountsOffRate(accounts, '130').map((a) => a.id)).toEqual(['b', 'c'])
  })

  it('compares numerically, not as text', () => {
    expect(accountsOffRate([{ usd_rate: '134.0000' }], 134)).toEqual([])
  })

  it('never rewrites accounts to a zero or invalid rate', () => {
    expect(accountsOffRate(accounts, 0)).toEqual([])
    expect(accountsOffRate(accounts, '')).toEqual([])
  })
})
