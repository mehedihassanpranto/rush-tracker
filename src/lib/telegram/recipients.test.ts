import { describe, expect, it } from 'vitest'
import {
  botKindFor,
  parseStartToken,
  recipientTypesForBot,
  telegramDeepLink,
} from './recipients'

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF1234'

describe('parseStartToken', () => {
  it('reads the payload from a DM /start', () => {
    expect(parseStartToken(`/start ${TOKEN}`)).toBe(TOKEN)
  })

  it('reads the payload from a group /start@Bot', () => {
    expect(parseStartToken(`/start@RushTrackerBot ${TOKEN}`)).toBe(TOKEN)
  })

  it('rejects a bare /start, other commands, and junk payloads', () => {
    expect(parseStartToken('/start')).toBeNull()
    expect(parseStartToken(`/help ${TOKEN}`)).toBeNull()
    expect(parseStartToken('/start short')).toBeNull()
    expect(parseStartToken(`/start ${TOKEN} extra`)).toBeNull()
    expect(parseStartToken(`/start ${TOKEN.slice(0, 20)}'; drop`)).toBeNull()
    expect(parseStartToken(undefined)).toBeNull()
  })
})

describe('telegramDeepLink', () => {
  it('uses start for a private chat and startgroup for a group', () => {
    expect(telegramDeepLink('Bot', TOKEN, 'private')).toBe(`https://t.me/Bot?start=${TOKEN}`)
    expect(telegramDeepLink('Bot', TOKEN, 'group')).toBe(`https://t.me/Bot?startgroup=${TOKEN}`)
  })
})

describe('botKindFor / recipientTypesForBot', () => {
  it('routes platform_admin to the platform bot, everyone else to the shared one', () => {
    expect(botKindFor('platform_admin')).toBe('platform')
    expect(botKindFor('agency')).toBe('shared')
    expect(botKindFor('client')).toBe('shared')
  })

  it('is the exact inverse of botKindFor for every recipient type', () => {
    const all: Array<'platform_admin' | 'agency' | 'client'> = [
      'platform_admin',
      'agency',
      'client',
    ]
    for (const type of all) {
      expect(recipientTypesForBot(botKindFor(type))).toContain(type)
    }
  })

  it('never lets the two bots claim overlapping recipient types', () => {
    const shared = new Set(recipientTypesForBot('shared'))
    const platform = new Set(recipientTypesForBot('platform'))
    for (const t of shared) expect(platform.has(t)).toBe(false)
  })
})
