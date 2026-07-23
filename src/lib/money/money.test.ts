import { describe, expect, it } from 'vitest'
import { addUsd, dec, formatBdt, formatUsd, multiplyUsdByRate } from './money'

// Spec §85: BDT billing calculation, opening balance behavior, decimal safety.
describe('money math', () => {
  describe('multiplyUsdByRate (BDT billing)', () => {
    it('multiplies USD amount by the applied rate', () => {
      expect(multiplyUsdByRate('100', '120').toString()).toBe('12000')
    })

    it('rounds half-up to 2 decimals', () => {
      // 33.333 * 3 = 99.999 -> 100.00
      expect(multiplyUsdByRate('33.333', '3').toString()).toBe('100')
      // 1.005 * 1 -> 1.01 (half-up, not banker's rounding)
      expect(multiplyUsdByRate('1.005', '1').toString()).toBe('1.01')
    })

    it('bills only the requested amount, never the opening balance', () => {
      // A limit request adds 500 USD on top of an opening 2000 USD balance.
      // The BDT charge must be 500 * rate, NOT 2500 * rate (spec §24, §33).
      const requested = '500'
      const rate = '120'
      expect(multiplyUsdByRate(requested, rate).toString()).toBe('60000')
    })

    it('is immune to floating-point drift', () => {
      // 0.1 * 0.2 in float is 0.020000000000000004
      expect(multiplyUsdByRate('0.1', '0.2').toString()).toBe('0.02')
    })
  })

  describe('addUsd (expected new limit)', () => {
    it('adds opening balance to the requested amount', () => {
      // expected_new_limit = opening + requested (spec §22)
      expect(addUsd('2000', '500').toString()).toBe('2500')
    })

    it('avoids float error on fractional dollars', () => {
      expect(addUsd('0.1', '0.2').toString()).toBe('0.3')
    })
  })

  describe('dec', () => {
    it('accepts string, number and Decimal', () => {
      expect(dec('10').plus(dec(5)).toString()).toBe('15')
    })
  })

  describe('formatters', () => {
    it('formats USD with a $ and 2 decimals', () => {
      expect(formatUsd('1234.5')).toBe('$1,234.50')
    })

    it('formats BDT with the ৳ symbol', () => {
      expect(formatBdt('12000')).toBe('৳12,000')
    })

    it('formats BDT string values (NUMERIC comes back as string)', () => {
      expect(formatBdt('99999.99')).toBe('৳99,999.99')
    })
  })
})
