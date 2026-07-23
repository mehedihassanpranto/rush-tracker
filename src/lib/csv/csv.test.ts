import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'

interface Row {
  name: string
  amount: string
  note: string | null
}

const columns = [
  { header: 'Name', value: (r: Row) => r.name },
  { header: 'Amount', value: (r: Row) => r.amount },
  { header: 'Note', value: (r: Row) => r.note },
]

describe('toCsv', () => {
  it('emits a header row even with no data', () => {
    expect(toCsv<Row>([], columns)).toBe('Name,Amount,Note')
  })

  it('renders one row per record', () => {
    const csv = toCsv<Row>(
      [{ name: 'Acme', amount: '100', note: 'ok' }],
      columns,
    )
    expect(csv).toBe('Name,Amount,Note\r\nAcme,100,ok')
  })

  it('quotes cells containing commas, quotes or newlines', () => {
    const csv = toCsv<Row>(
      [{ name: 'A, B', amount: '1"2', note: 'line\nbreak' }],
      columns,
    )
    expect(csv).toBe('Name,Amount,Note\r\n"A, B","1""2","line\nbreak"')
  })

  it('renders null/undefined as empty cells', () => {
    const csv = toCsv<Row>([{ name: 'X', amount: '5', note: null }], columns)
    expect(csv).toBe('Name,Amount,Note\r\nX,5,')
  })
})
