/**
 * Minimal, dependency-free CSV export for reports (spec §71 "Future exports:
 * CSV"). Client-safe — triggers a browser download from in-memory rows.
 */

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
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
