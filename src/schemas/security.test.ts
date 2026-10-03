import { describe, expect, it } from 'vitest'
import { changeEmailSchema, confirmEmailChangeSchema } from './security'

describe('changeEmailSchema', () => {
  it('trims and lower-cases the new address', () => {
    const r = changeEmailSchema.parse({ new_email: '  New.Person@Example.COM ', current_password: 'x' })
    expect(r.new_email).toBe('new.person@example.com')
  })

  it('rejects a malformed address and a missing password', () => {
    expect(changeEmailSchema.safeParse({ new_email: 'not-an-email', current_password: 'x' }).success).toBe(false)
    expect(changeEmailSchema.safeParse({ new_email: 'a@b.co', current_password: '' }).success).toBe(false)
  })
})

describe('confirmEmailChangeSchema', () => {
  it('accepts both token shapes Supabase sends (plain hex and pkce_-prefixed)', () => {
    const hex = 'a'.repeat(56)
    expect(confirmEmailChangeSchema.safeParse({ token_hash: hex }).success).toBe(true)
    expect(confirmEmailChangeSchema.safeParse({ token_hash: `pkce_${hex}` }).success).toBe(true)
  })

  it('rejects empty or odd input', () => {
    expect(confirmEmailChangeSchema.safeParse({ token_hash: '' }).success).toBe(false)
    expect(confirmEmailChangeSchema.safeParse({ token_hash: 'abc def<script>' }).success).toBe(false)
  })
})
