import { formatBdt, formatUsd } from '@/lib/money/money'
import { Card, CardContent, CardDescription } from '@/components/ui/card'
import type { ClientFinancials } from '@/types/domain'

/** Client financial summary cards (spec §34, §66, §69). Ledger-derived. */
export function FinancialSummary({
  financials,
  totalRemainingUsd,
}: {
  financials: ClientFinancials
  /**
   * Sum of Meta spend headroom (spend_cap - amount_spent) across the
   * client's own USD-currency linked ad accounts — not ledger-derived, so
   * it's a separate prop rather than a `ClientFinancials` field. `null`/
   * omitted hides the card entirely (no Meta access, or data not loaded
   * yet) rather than showing a permanent "—".
   */
  totalRemainingUsd?: string | null
}) {
  const cards = [
    { label: 'Total Approved (USD)', value: formatUsd(financials.total_approved_usd) },
    { label: 'Total Billed (BDT)', value: formatBdt(financials.total_debit) },
    { label: 'Total Paid (BDT)', value: formatBdt(financials.total_credit) },
    {
      label: 'Current Due (BDT)',
      value: formatBdt(financials.current_due),
      emphasize: true,
    },
    {
      label: 'Current Due (USD, approx.)',
      value: formatUsd(financials.current_due_usd),
      subValue: "converted at this client's USD rate",
      emphasize: true,
    },
    ...(totalRemainingUsd != null
      ? [
          {
            label: 'Total Remaining',
            value: formatUsd(totalRemainingUsd),
            subValue: 'Meta spend headroom, linked USD accounts',
          },
        ]
      : []),
  ]
  return (
    <div
      className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${cards.length === 6 ? 'xl:grid-cols-6' : 'xl:grid-cols-5'}`}
    >
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="py-4">
            <CardDescription>{c.label}</CardDescription>
            <div
              className={
                c.emphasize
                  ? 'mt-1 text-2xl font-semibold text-foreground'
                  : 'mt-1 text-2xl font-semibold'
              }
            >
              {c.value}
            </div>
            {c.subValue && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {c.subValue}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
