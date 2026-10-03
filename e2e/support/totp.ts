import { createHmac } from 'node:crypto'

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what authenticator apps compute,
 * so tests can "type" a code for an enrolled factor's secret. */
export function totp(base32Secret: string, at: number = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = base32Secret.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
  let bits = ''
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const h = createHmac('sha1', key).update(counter).digest()
  const o = h[h.length - 1] & 0xf
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 1_000_000).padStart(6, '0')
}
