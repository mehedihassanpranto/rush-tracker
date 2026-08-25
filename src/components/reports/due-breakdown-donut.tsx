import { useState } from 'react'
import { dec, formatBdt } from '@/lib/money/money'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type SegmentKey = 'paid' | 'due'

/**
 * Billed = Paid + Current Due (ledger-derived, spec §35) — so a chart of
 * all three as independent slices would double-count the total. This
 * shows the two real parts of the whole (Paid, Due) as a donut, with
 * Billed as the center total — the only version of "a pie for billed,
 * paid and due" that isn't mathematically misleading.
 */
export function DueBreakdownDonut({
  totalBilled,
  totalPaid,
  totalDue,
}: {
  totalBilled: string
  totalPaid: string
  totalDue: string
}) {
  const [hovered, setHovered] = useState<SegmentKey | null>(null)

  // Current due can include small negative/credit balances at the
  // individual-client level; clamp the aggregate shown in the chart to
  // >= 0 so a slice never has "negative" visual length. The underlying
  // report table below always shows the exact per-client figures.
  const paid = dec(totalPaid).lt(0) ? dec(0) : dec(totalPaid)
  const due = dec(totalDue).lt(0) ? dec(0) : dec(totalDue)
  const whole = paid.plus(due)

  const paidFrac = whole.gt(0) ? paid.div(whole).toNumber() : 0
  const dueFrac = whole.gt(0) ? due.div(whole).toNumber() : 0
  const paidPct = Math.round(paidFrac * 100)
  const duePct = 100 - paidPct

  const size = 220
  const r = 80
  const strokeWidth = 26
  const circumference = 2 * Math.PI * r
  const gap = whole.gt(0) ? 3 : 0
  const drawable = circumference - gap * 2
  const paidLen = drawable * paidFrac
  const dueLen = drawable * dueFrac

  const segments: Array<{
    key: SegmentKey
    label: string
    value: ReturnType<typeof dec>
    pct: number
    color: string
    dasharray: string
    dashoffset: number
  }> = [
    {
      key: 'paid',
      label: 'Paid',
      value: paid,
      pct: paidPct,
      color: 'var(--chart-paid)',
      dasharray: `${paidLen} ${circumference - paidLen}`,
      dashoffset: 0,
    },
    {
      key: 'due',
      label: 'Current Due',
      value: due,
      pct: duePct,
      color: 'var(--chart-due)',
      dasharray: `${dueLen} ${circumference - dueLen}`,
      dashoffset: -(paidLen + gap),
    },
  ]

  const active = segments.find((s) => s.key === hovered)

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">Billed vs. Paid &amp; Due</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
          <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg
              viewBox={`0 0 ${size} ${size}`}
              width={size}
              height={size}
              role="img"
              aria-label={`Of ${formatBdt(totalBilled)} billed: ${formatBdt(totalPaid)} paid (${paidPct}%), ${formatBdt(totalDue)} due (${duePct}%)`}
            >
              <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={strokeWidth}
                />
                {segments.map((s) => (
                  <circle
                    key={s.key}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={hovered === s.key ? strokeWidth + 4 : strokeWidth}
                    strokeDasharray={s.dasharray}
                    strokeDashoffset={s.dashoffset}
                    tabIndex={0}
                    role="graphics-symbol"
                    aria-label={`${s.label}: ${formatBdt(s.value.toFixed(2))} (${s.pct}%)`}
                    className="cursor-pointer outline-none transition-[stroke-width]"
                    onMouseEnter={() => setHovered(s.key)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(s.key)}
                    onBlur={() => setHovered(null)}
                  />
                ))}
              </g>
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              {active ? (
                <>
                  <span className="text-xs text-muted-foreground">{active.label}</span>
                  <span className="text-xl font-semibold text-foreground">
                    {formatBdt(active.value.toFixed(2))}
                  </span>
                  <span className="text-xs text-muted-foreground">{active.pct}%</span>
                </>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">Total Billed</span>
                  <span className="text-xl font-semibold text-foreground">
                    {formatBdt(totalBilled)}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="w-full max-w-xs space-y-3">
            {segments.map((s) => (
              <div
                key={s.key}
                tabIndex={0}
                role="button"
                aria-label={`${s.label}: ${formatBdt(s.value.toFixed(2))} (${s.pct}%)`}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
                onMouseEnter={() => setHovered(s.key)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(s.key)}
                onBlur={() => setHovered(null)}
              >
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <span
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.label}
                </span>
                <span className="text-sm text-muted-foreground">
                  {formatBdt(s.value.toFixed(2))}{' '}
                  <span className="text-xs">({s.pct}%)</span>
                </span>
              </div>
            ))}
            <div className="border-t pt-2 text-xs text-muted-foreground">
              Total billed {formatBdt(totalBilled)} = paid + current due, summed
              across every client.
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
