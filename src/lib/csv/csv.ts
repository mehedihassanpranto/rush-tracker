/**
 * Minimal, dependency-free CSV export for reports (spec §71 "Future exports:
 * CSV"). Client-safe — triggers a browser download from in-memory rows.
 */

/** A plain number ("-500", "1234.50") is data, not a formula. */
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  // Formula injection: a cell starting with = + - @ (or a tab / CR that some
  // spreadsheets skip) runs as a formula when the file is opened — a client
  // named "=HYPERLINK(…)" would. Prefix a quote so it stays text. Real numbers
  // pass untouched so they still add up.
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) {
    s = `'${s}`
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export interface CsvColumn<T> {
  header: string
  value: (row: T) => unknown
}

export function toCsv<T>(rows: Array<T>, columns: Array<CsvColumn<T>>): string {
  const head = columns.map((c) => escapeCell(c.header)).join(',')
  const body = rows
    .map((row) => columns.map((c) => escapeCell(c.value(row))).join(','))
    .join('\r\n')
  return body ? `${head}\r\n${body}` : head
}

export function downloadCsv<T>(
  filename: string,
  rows: Array<T>,
  columns: Array<CsvColumn<T>>,
): void {
  const csv = toCsv(rows, columns)
  // Prepend a UTF-8 BOM so Excel renders ৳ and other non-ASCII correctly.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
