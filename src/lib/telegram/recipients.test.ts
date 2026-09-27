import { describe, expect, it } from 'vitest'
import { parseStartToken, telegramDeepLink } from './recipients'

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
